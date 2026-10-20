from __future__ import annotations

import io
import logging
import os
import re
import threading
import traceback
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
app = FastAPI(title="Sahaya Qwen3-TTS Preview Service")
log = logging.getLogger("sahaya.qwen3_tts_preview")

generation_lock = threading.Lock()
state_lock = threading.Lock()
model: Any | None = None
model_error: str | None = None


@dataclass(frozen=True)
class VoicePrompt:
    reference_audio: Path
    reference_text: str
    prompt: Any


profiles: dict[str, VoicePrompt] = {}


class ProfileCreateRequest(BaseModel):
    profileId: str = Field(min_length=1, max_length=128)
    referenceAudioPath: str = Field(min_length=1)
    referenceText: str = Field(min_length=1)
    referenceLanguage: str = "en"

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


class SynthesizeRequest(BaseModel):
    profileId: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1)
    language: str = "en"

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
    ):
        return {"providerReferenceId": req.profileId}

    if not generation_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Qwen3-TTS preview service is busy")
    try:
        prompt = active_model.create_voice_clone_prompt(
            ref_audio=str(reference),
            ref_text=req.referenceText,
            x_vector_only_mode=False,
        )
        with state_lock:
            profiles[req.profileId] = VoicePrompt(reference, req.referenceText, prompt)
        return {"providerReferenceId": req.profileId}
    except Exception as exc:
        log.error(
            "Qwen3-TTS prompt creation failed profileId=%s errorType=%s",
            req.profileId,
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="voice prompt creation failed") from None
    finally:
        generation_lock.release()


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
    validate_reference(str(profile.reference_audio))
    if not generation_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Qwen3-TTS preview service is busy")
    try:
        with torch.inference_mode():
            waveforms, sample_rate = active_model.generate_voice_clone(
                text=req.text,
                language="English",
                voice_clone_prompt=profile.prompt,
            )
        if waveforms is None or len(waveforms) == 0:
            raise ValueError("model returned no audio")
        payload = serialize_wav(waveforms[0], int(sample_rate))
        log.info(
            "Qwen3-TTS preview completed profileId=%s textChars=%d outputBytes=%d",
            req.profileId,
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
        generation_lock.release()


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
