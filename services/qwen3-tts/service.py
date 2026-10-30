from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import threading
import time
import traceback
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from transformers import StoppingCriteria, StoppingCriteriaList

try:
    from qwen_tts import Qwen3TTSModel
except Exception as exc:  # pragma: no cover - surfaced by health/model load
    Qwen3TTSModel = None
    QWEN_IMPORT_ERROR = exc
else:
    QWEN_IMPORT_ERROR = None


MODEL_ID = os.getenv("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
ATTENTION_IMPLEMENTATION = os.getenv(
    "QWEN3_TTS_ATTENTION_IMPLEMENTATION", "flash_attention_2"
)
PROFILE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
CLONE_MODES = {"speaker-embedding", "icl"}
app = FastAPI(title="Sahaya Qwen3-TTS Teaching Voice Service")
log = logging.getLogger("sahaya.qwen3_tts")

state_lock = threading.Lock()
model: Any | None = None
model_error: str | None = None


class FairGenerationQueue:
    """FIFO admission for the single model slot shared by every HTTP caller."""

    def __init__(self, max_pending: int) -> None:
        self._condition = threading.Condition()
        self._active = False
        self._waiters: deque[object] = deque()
        self._max_pending = max_pending

    def acquire(self, timeout_seconds: float) -> float | None:
        started_at = time.monotonic()
        deadline = started_at + timeout_seconds
        token = object()
        with self._condition:
            if len(self._waiters) >= self._max_pending:
                return None
            self._waiters.append(token)
            while self._active or self._waiters[0] is not token:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._waiters.remove(token)
                    self._condition.notify_all()
                    return None
                self._condition.wait(remaining)
            self._waiters.popleft()
            self._active = True
        return time.monotonic() - started_at

    def release(self) -> None:
        with self._condition:
            if not self._active:
                raise RuntimeError("Qwen3-TTS generation slot was not acquired")
            self._active = False
            self._condition.notify_all()


SYNTHESIS_REQUEST_DEADLINE_SECONDS = min(
    165.0,
    max(15.0, float(os.getenv("QWEN3_TTS_SYNTHESIS_DEADLINE_SECONDS", "165"))),
)
QUEUE_WAIT_SECONDS = min(
    30.0, max(1.0, float(os.getenv("QWEN3_TTS_QUEUE_WAIT_SECONDS", "30")))
)
MAX_PENDING_GENERATIONS = max(1, int(os.getenv("QWEN3_TTS_MAX_PENDING", "64")))
SYNTHESIS_RESPONSE_GRACE_SECONDS = min(
    SYNTHESIS_REQUEST_DEADLINE_SECONDS - 1.0,
    max(1.0, float(os.getenv("QWEN3_TTS_RESPONSE_GRACE_SECONDS", "5"))),
)
MAX_NEW_TOKENS = min(
    2048, max(64, int(os.getenv("QWEN3_TTS_MAX_NEW_TOKENS", "512")))
)
generation_queue = FairGenerationQueue(MAX_PENDING_GENERATIONS)


@dataclass(frozen=True)
class VoicePrompt:
    reference_audio: Path
    reference_text: str
    prompts: dict[str, Any]


profiles: dict[str, VoicePrompt] = {}


class ProfileCreateRequest(BaseModel):
    profileId: str = Field(min_length=1, max_length=128)
    referenceAudioPath: str = Field(min_length=1)
    referenceText: str = Field(min_length=1)
    referenceLanguage: str = "en"
    cloneMode: str = "speaker-embedding"

    @field_validator("profileId")
    @classmethod
    def validate_profile_id(cls, value: str) -> str:
        if not PROFILE_ID_PATTERN.fullmatch(value):
            raise ValueError("invalid profile ID")
        return value

    @field_validator("referenceText")
    @classmethod
    def validate_reference_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("reference transcript is required")
        return text

    @field_validator("referenceLanguage")
    @classmethod
    def validate_reference_language(cls, value: str) -> str:
        if value.strip().lower() not in {"en", "english"}:
            raise ValueError("Qwen3-TTS preview requires an English reference transcript")
        return "en"

    @field_validator("cloneMode")
    @classmethod
    def validate_clone_mode(cls, value: str) -> str:
        if value not in CLONE_MODES:
            raise ValueError("unsupported Qwen3-TTS clone mode")
        return value


class SynthesizeRequest(BaseModel):
    profileId: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1)
    language: str = "en"
    cloneMode: str = "speaker-embedding"

    @field_validator("profileId")
    @classmethod
    def validate_profile_id(cls, value: str) -> str:
        if not PROFILE_ID_PATTERN.fullmatch(value):
            raise ValueError("invalid profile ID")
        return value

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("preview text is required")
        # Preserve the exact chunk. The application deliberately assigns boundary
        # whitespace to one chunk so joining every request recreates the source text.
        return value

    @field_validator("language")
    @classmethod
    def validate_language(cls, value: str) -> str:
        if value.strip().lower() not in {"en", "english"}:
            raise ValueError("Qwen3-TTS preview currently supports English text only")
        return "en"

    @field_validator("cloneMode")
    @classmethod
    def validate_clone_mode(cls, value: str) -> str:
        if value not in CLONE_MODES:
            raise ValueError("unsupported Qwen3-TTS clone mode")
        return value


def validate_reference(path_value: str) -> Path:
    path = Path(path_value).resolve()
    if not path.is_file() or path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="reference audio not found")
    try:
        info = sf.info(path)
    except Exception:
        raise HTTPException(status_code=400, detail="reference audio is not a readable WAV") from None
    if info.frames <= 0 or info.samplerate <= 0 or info.channels <= 0:
        raise HTTPException(status_code=400, detail="reference audio is empty")
    return path


def require_model() -> Any:
    if model is None:
        raise HTTPException(status_code=503, detail="Qwen3-TTS model is not loaded")
    return model


def acquire_generation_slot(operation: str) -> float:
    waited_seconds = generation_queue.acquire(QUEUE_WAIT_SECONDS)
    if waited_seconds is None:
        log.warning(
            "Qwen3-TTS queue wait timed out operation=%s queueWaitSeconds=%.1f",
            operation,
            QUEUE_WAIT_SECONDS,
        )
        raise HTTPException(
            status_code=429,
            detail="Qwen3-TTS queue wait timed out; retry this narration",
            headers={"Retry-After": "5"},
        )
    if waited_seconds > 0.001:
        log.info(
            "Qwen3-TTS queue admitted operation=%s waitedMs=%d",
            operation,
            round(waited_seconds * 1000),
        )
    return waited_seconds


class GenerationStopSignal(StoppingCriteria):
    """Cooperatively stop autoregressive generation without releasing its GPU slot."""

    def __init__(
        self,
        deadline: float,
        cancellation: threading.Event,
        max_steps: int,
    ) -> None:
        self.deadline = deadline
        self.cancellation = cancellation
        self.max_steps = max_steps
        self.observed_steps = 0
        self.reason: str | None = None

    def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
        del input_ids, scores, kwargs
        self.observed_steps += 1
        if self.cancellation.is_set():
            self.reason = "caller-disconnected"
            return True
        if time.monotonic() >= self.deadline:
            self.reason = "deadline-exceeded"
            return True
        if self.observed_steps >= self.max_steps:
            self.reason = "output-token-limit"
            return True
        return False


async def wait_for_inference(
    operation: Any,
    request: Request,
    stop_signal: GenerationStopSignal,
) -> Any:
    """Keep awaiting the worker after disconnect so its model slot stays accurate."""

    task = asyncio.create_task(asyncio.to_thread(operation))
    disconnect_logged = False
    while not task.done():
        done, _ = await asyncio.wait({task}, timeout=0.25)
        if task in done:
            break
        if not disconnect_logged and await request.is_disconnected():
            stop_signal.cancellation.set()
            disconnect_logged = True
    return await task


def load_model() -> None:
    global model, model_error
    if Qwen3TTSModel is None:
        model_error = f"qwen_tts import failed: {type(QWEN_IMPORT_ERROR).__name__}"
        log.error("Qwen3-TTS import failed", exc_info=QWEN_IMPORT_ERROR)
        return
    try:
        model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation=ATTENTION_IMPLEMENTATION,
            local_files_only=True,
        )
        model_error = None
        log.info(
            "Qwen3-TTS model loaded model=%s device=cuda:0 attention=%s "
            "queueWaitSeconds=%.1f requestDeadlineSeconds=%.1f maxNewTokens=%d",
            MODEL_ID,
            ATTENTION_IMPLEMENTATION,
            QUEUE_WAIT_SECONDS,
            SYNTHESIS_REQUEST_DEADLINE_SECONDS,
            MAX_NEW_TOKENS,
        )
    except Exception as exc:  # pragma: no cover - depends on prepared GPU runtime
        model = None
        model_error = type(exc).__name__
        log.error("Qwen3-TTS model load failed:\n%s", traceback.format_exc())


@app.on_event("startup")
def startup() -> None:
    load_model()


@app.get("/health")
def health() -> dict[str, Any]:
    with state_lock:
        profile_count = len(profiles)
    return {
        "ok": model is not None,
        "provider": "qwen3-tts",
        "modelLoaded": model is not None,
        "model": MODEL_ID,
        "device": "cuda:0",
        "attentionImplementation": ATTENTION_IMPLEMENTATION,
        "queueWaitSeconds": QUEUE_WAIT_SECONDS,
        "synthesisDeadlineSeconds": SYNTHESIS_REQUEST_DEADLINE_SECONDS,
        "maxNewTokens": MAX_NEW_TOKENS,
        "profileCount": profile_count,
        "error": model_error,
    }


@app.post("/profiles")
def create_profile(req: ProfileCreateRequest) -> dict[str, str]:
    active_model = require_model()
    reference = validate_reference(req.referenceAudioPath)
    with state_lock:
        existing = profiles.get(req.profileId)
    if (
        existing is not None
        and existing.reference_audio == reference
        and existing.reference_text == req.referenceText
        and req.cloneMode in existing.prompts
    ):
        return {"providerReferenceId": req.profileId}

    acquire_generation_slot("profile-registration")
    try:
        with state_lock:
            existing = profiles.get(req.profileId)
        if (
            existing is not None
            and existing.reference_audio == reference
            and existing.reference_text == req.referenceText
            and req.cloneMode in existing.prompts
        ):
            return {"providerReferenceId": req.profileId}
        x_vector_only = req.cloneMode == "speaker-embedding"
        prompt = active_model.create_voice_clone_prompt(
            ref_audio=str(reference),
            ref_text=None if x_vector_only else req.referenceText,
            x_vector_only_mode=x_vector_only,
        )
        with state_lock:
            previous_prompts = (
                existing.prompts
                if existing is not None
                and existing.reference_audio == reference
                and existing.reference_text == req.referenceText
                else {}
            )
            profiles[req.profileId] = VoicePrompt(
                reference,
                req.referenceText,
                {**previous_prompts, req.cloneMode: prompt},
            )
        log.info(
            "Qwen3-TTS prompt cached profileId=%s cloneMode=%s",
            req.profileId,
            req.cloneMode,
        )
        return {"providerReferenceId": req.profileId}
    except Exception as exc:
        log.error(
            "Qwen3-TTS prompt creation failed profileId=%s errorType=%s",
            req.profileId,
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="voice prompt creation failed") from None
    finally:
        generation_queue.release()


@app.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str) -> dict[str, bool]:
    if not PROFILE_ID_PATTERN.fullmatch(profile_id):
        raise HTTPException(status_code=400, detail="invalid profile ID")
    with state_lock:
        profiles.pop(profile_id, None)
    return {"ok": True}


def serialize_wav(waveform: Any, sample_rate: int) -> bytes:
    if torch.is_tensor(waveform):
        waveform = waveform.detach().cpu().float().numpy()
    audio = np.asarray(waveform, dtype=np.float32).squeeze()
    if audio.ndim != 1 or audio.size == 0 or not np.isfinite(audio).all():
        raise ValueError("model returned invalid mono audio")
    if sample_rate <= 0:
        raise ValueError("model returned invalid sample rate")
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest, request: Request) -> Response:
    request_started_at = time.monotonic()
    active_model = require_model()
    with state_lock:
        profile = profiles.get(req.profileId)
    if profile is None:
        raise HTTPException(status_code=404, detail="voice profile not found")
    prompt = profile.prompts.get(req.cloneMode)
    if prompt is None:
        raise HTTPException(status_code=404, detail="voice clone mode is not registered")
    validate_reference(str(profile.reference_audio))
    queue_wait_seconds = await asyncio.to_thread(acquire_generation_slot, "synthesis")
    cancellation = threading.Event()
    inference_deadline = (
        request_started_at
        + SYNTHESIS_REQUEST_DEADLINE_SECONDS
        - SYNTHESIS_RESPONSE_GRACE_SECONDS
    )
    stop_signal = GenerationStopSignal(inference_deadline, cancellation, MAX_NEW_TOKENS)
    inference_started_at = time.monotonic()
    log.info(
        "Qwen3-TTS inference started profileId=%s cloneMode=%s textChars=%d "
        "queueWaitMs=%d maxNewTokens=%d attention=%s",
        req.profileId,
        req.cloneMode,
        len(req.text),
        round(queue_wait_seconds * 1000),
        MAX_NEW_TOKENS,
        ATTENTION_IMPLEMENTATION,
    )
    try:
        if await request.is_disconnected():
            cancellation.set()
            raise HTTPException(status_code=499, detail="Qwen3-TTS caller disconnected")

        def run_inference() -> Any:
            with torch.inference_mode():
                return active_model.generate_voice_clone(
                    text=req.text,
                    language="English",
                    voice_clone_prompt=prompt,
                    max_new_tokens=MAX_NEW_TOKENS,
                    stopping_criteria=StoppingCriteriaList([stop_signal]),
                )

        waveforms, sample_rate = await wait_for_inference(run_inference, request, stop_signal)
        inference_duration_seconds = time.monotonic() - inference_started_at
        if stop_signal.reason == "caller-disconnected":
            log.warning(
                "Qwen3-TTS inference cancelled profileId=%s cloneMode=%s textChars=%d "
                "inferenceMs=%d reason=caller-disconnected",
                req.profileId,
                req.cloneMode,
                len(req.text),
                round(inference_duration_seconds * 1000),
            )
            raise HTTPException(status_code=499, detail="Qwen3-TTS caller disconnected")
        if stop_signal.reason == "deadline-exceeded" or time.monotonic() >= inference_deadline:
            log.warning(
                "Qwen3-TTS inference timed out profileId=%s cloneMode=%s textChars=%d "
                "inferenceMs=%d maxNewTokens=%d",
                req.profileId,
                req.cloneMode,
                len(req.text),
                round(inference_duration_seconds * 1000),
                MAX_NEW_TOKENS,
            )
            raise HTTPException(
                status_code=504,
                detail="Qwen3-TTS inference timed out before complete audio was produced",
            )
        if stop_signal.reason == "output-token-limit":
            log.warning(
                "Qwen3-TTS output token limit reached profileId=%s cloneMode=%s textChars=%d "
                "inferenceMs=%d maxNewTokens=%d",
                req.profileId,
                req.cloneMode,
                len(req.text),
                round(inference_duration_seconds * 1000),
                MAX_NEW_TOKENS,
            )
            raise HTTPException(
                status_code=504,
                detail="Qwen3-TTS reached its output token limit before complete audio was produced",
            )
        if waveforms is None or len(waveforms) == 0:
            raise ValueError("model returned no audio")
        payload = serialize_wav(waveforms[0], int(sample_rate))
        waveform = waveforms[0]
        if torch.is_tensor(waveform):
            audio_samples = int(waveform.numel())
        else:
            audio_samples = int(np.asarray(waveform).size)
        audio_duration_seconds = audio_samples / int(sample_rate)
        log.info(
            "Qwen3-TTS inference completed profileId=%s cloneMode=%s textChars=%d "
            "inferenceMs=%d audioDurationSeconds=%.3f outputBytes=%d",
            req.profileId,
            req.cloneMode,
            len(req.text),
            round(inference_duration_seconds * 1000),
            audio_duration_seconds,
            len(payload),
        )
        return Response(content=payload, media_type="audio/wav")
    except HTTPException as exc:
        if exc.status_code == 499 and stop_signal.reason is None:
            log.warning(
                "Qwen3-TTS inference cancelled profileId=%s cloneMode=%s textChars=%d "
                "inferenceMs=%d reason=caller-disconnected-before-start",
                req.profileId,
                req.cloneMode,
                len(req.text),
                round((time.monotonic() - inference_started_at) * 1000),
            )
        raise
    except Exception as exc:
        log.error(
            "Qwen3-TTS inference failed profileId=%s cloneMode=%s textChars=%d "
            "inferenceMs=%d errorType=%s",
            req.profileId,
            req.cloneMode,
            len(req.text),
            round((time.monotonic() - inference_started_at) * 1000),
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="voice synthesis failed") from None
    finally:
        generation_queue.release()


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("QWEN3_TTS_SERVICE_HOST", "127.0.0.1"),
        port=int(os.getenv("QWEN3_TTS_SERVICE_PORT", "8771")),
        workers=1,
    )
