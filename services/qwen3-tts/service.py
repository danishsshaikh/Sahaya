from __future__ import annotations

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
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

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


QUEUE_WAIT_SECONDS = max(1.0, float(os.getenv("QWEN3_TTS_QUEUE_WAIT_SECONDS", "120")))
MAX_PENDING_GENERATIONS = max(1, int(os.getenv("QWEN3_TTS_MAX_PENDING", "64")))
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
        text = value.strip()
        if not text:
            raise ValueError("preview text is required")
        return text

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


def acquire_generation_slot(operation: str) -> None:
    waited_seconds = generation_queue.acquire(QUEUE_WAIT_SECONDS)
    if waited_seconds is None:
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
        log.info("Qwen3-TTS model loaded model=%s device=cuda:0", MODEL_ID)
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
def synthesize(req: SynthesizeRequest) -> Response:
    active_model = require_model()
    with state_lock:
        profile = profiles.get(req.profileId)
    if profile is None:
        raise HTTPException(status_code=404, detail="voice profile not found")
    prompt = profile.prompts.get(req.cloneMode)
    if prompt is None:
        raise HTTPException(status_code=404, detail="voice clone mode is not registered")
    validate_reference(str(profile.reference_audio))
    acquire_generation_slot("synthesis")
    try:
        with torch.inference_mode():
            waveforms, sample_rate = active_model.generate_voice_clone(
                text=req.text,
                language="English",
                voice_clone_prompt=prompt,
            )
        if waveforms is None or len(waveforms) == 0:
            raise ValueError("model returned no audio")
        payload = serialize_wav(waveforms[0], int(sample_rate))
        log.info(
            "Qwen3-TTS preview completed profileId=%s cloneMode=%s textChars=%d outputBytes=%d",
            req.profileId,
            req.cloneMode,
            len(req.text),
            len(payload),
        )
        return Response(content=payload, media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as exc:
        log.error(
            "Qwen3-TTS synthesis failed profileId=%s errorType=%s",
            req.profileId,
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="voice synthesis failed") from None
    finally:
        generation_queue.release()


@app.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str) -> dict[str, bool]:
    if not PROFILE_ID_PATTERN.fullmatch(profile_id):
        raise HTTPException(status_code=400, detail="invalid profile ID")
    with state_lock:
        profiles.pop(profile_id, None)
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("QWEN3_TTS_SERVICE_HOST", "127.0.0.1"),
        port=int(os.getenv("QWEN3_TTS_SERVICE_PORT", "8771")),
        workers=1,
    )
