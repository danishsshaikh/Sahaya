from __future__ import annotations

import io
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

MODEL_ID = os.getenv("INDICF5_MODEL", "ai4bharat/IndicF5")
DEFAULT_SAMPLE_RATE = 24000
app = FastAPI(title="Sahaya IndicF5 Teaching Voice")
log = logging.getLogger("sahaya.indicf5_voice_cloning")

generation_lock = threading.Lock()
state_lock = threading.Lock()
profiles: dict[str, VoiceProfile] = {}
runtime: Runtime | None = None
model_error: str | None = None
model_loading = False
model_load_seconds: float | None = None


@dataclass(frozen=True)
class VoiceProfile:
    reference_audio: Path
    reference_text: str
    language: str


@dataclass(frozen=True)
class Runtime:
    model: Any
    torch: Any
    numpy: Any
    soundfile: Any


def validate_profile_id(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value) is None:
        raise ValueError("profile ID must be 1-128 ASCII letters, digits, underscores or hyphens")
    return value


class ProfileCreateRequest(BaseModel):
    profileId: str
    referenceAudioPath: str = Field(min_length=1)
    referenceText: str = Field(min_length=1)
    language: str

    @field_validator("profileId")
    @classmethod
    def check_id(cls, value: str) -> str:
        return validate_profile_id(value)

    @field_validator("referenceAudioPath", "referenceText")
    @classmethod
    def check_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value cannot be blank")
        return value

    @field_validator("language")
    @classmethod
    def check_language(cls, value: str) -> str:
        return normalize_language(value)


class SynthesizeRequest(BaseModel):
    profileId: str
    text: str = Field(min_length=1)
    language: str

    @field_validator("profileId")
    @classmethod
    def check_id(cls, value: str) -> str:
        return validate_profile_id(value)

    @field_validator("text")
    @classmethod
    def check_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text cannot be blank")
        return value

    @field_validator("language")
    @classmethod
    def check_language(cls, value: str) -> str:
        return normalize_language(value)


def validate_reference(value: str) -> Path:
    try:
        reference = Path(value).resolve(strict=True)
        if not reference.is_file() or reference.suffix.lower() != ".wav":
            raise ValueError("reference must be a WAV file")
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(status_code=400, detail="reference must be an existing WAV file") from None
    try:
        import soundfile
    except (ImportError, OSError):
        raise HTTPException(status_code=503, detail="soundfile dependency unavailable") from None
    try:
        info = soundfile.info(str(reference))
        if info.format not in {"WAV", "WAVEX", "RF64"} or info.frames <= 0:
            raise ValueError("invalid WAV")
    except Exception:
        raise HTTPException(status_code=400, detail="reference must be a readable, nonempty WAV") from None
    return reference


@app.post("/profiles")
def create_profile(req: ProfileCreateRequest) -> dict[str, str]:
    reference = validate_reference(req.referenceAudioPath)
    with state_lock:
        profiles[req.profileId] = VoiceProfile(reference, req.referenceText, req.language)
    return {"providerReferenceId": req.profileId}


@app.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str) -> dict[str, bool]:
    try:
        validate_profile_id(profile_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid profile ID") from None
    with state_lock:
        profiles.pop(profile_id, None)
    return {"ok": True}


def get_runtime() -> Runtime:
    # Only called while holding generation_lock; failures stay latched until restart.
    global runtime, model_error, model_loading, model_load_seconds
    with state_lock:
        if runtime is not None:
            return runtime
        if model_error is not None:
            raise HTTPException(status_code=503, detail=model_error)
        model_loading = True
    started = time.perf_counter()
    try:
        loaded = load_runtime()
    except Exception as exc:
        error = f"model loading failed ({type(exc).__name__}); check runtime dependencies and model access, then restart"
        with state_lock:
            model_error = error
        log.error("Model load failed errorType=%s", type(exc).__name__)
        raise HTTPException(status_code=503, detail=error) from None
    else:
        with state_lock:
            runtime = loaded
        return loaded
    finally:
        with state_lock:
            model_loading = False
            model_load_seconds = round(time.perf_counter() - started, 3)


def serialize_wav(active: Runtime, audio: Any, sample_rate: int) -> tuple[bytes, float]:
    if active.torch.is_tensor(audio):
        audio = audio.detach().cpu().numpy()
    audio = active.numpy.asarray(audio)
    # Integer samples need scaling before conversion to soundfile's float input.
    if audio.dtype == active.numpy.int16:
        audio = audio.astype("float32") / 32768.0
    elif active.numpy.issubdtype(audio.dtype, active.numpy.integer):
        raise ValueError("unsupported integer audio dtype")
    else:
        audio = audio.astype("float32", copy=False)
    if audio.ndim == 2 and 1 in audio.shape:
        audio = audio.reshape(-1)
    if audio.ndim != 1 or audio.size == 0 or not active.numpy.isfinite(audio).all():
        raise ValueError("model returned invalid mono audio")
    if sample_rate <= 0:
        raise ValueError("model returned invalid sample rate")
    buffer = io.BytesIO()
    active.soundfile.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue(), len(audio) / sample_rate


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    with state_lock:
        profile = profiles.get(req.profileId)
    if profile is None:
        raise HTTPException(status_code=404, detail="voice profile not found")
    if profile.language != req.language:
        raise HTTPException(status_code=400, detail="target language must match reference language")
    validate_reference(str(profile.reference_audio))
    if not generation_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="voice cloning service is busy")
    try:
        active = get_runtime()
        started = time.perf_counter()
        with active.torch.inference_mode():
            audio, sample_rate = generate_audio(active, profile, req.text)
        payload, output_seconds = serialize_wav(active, audio, sample_rate)
        generation_seconds = time.perf_counter() - started
        log.info(
            "Synthesis profileId=%s language=%s textChars=%d generationSeconds=%.3f outputSeconds=%.3f rtf=%.3f",
            req.profileId, req.language, len(req.text), generation_seconds,
            output_seconds, generation_seconds / output_seconds,
        )
        return Response(content=payload, media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as exc:
        # Dependency exceptions may contain input text; never emit their messages.
        log.error("Synthesis failed profileId=%s errorType=%s", req.profileId, type(exc).__name__)
        raise HTTPException(status_code=500, detail="voice synthesis or WAV serialization failed") from None
    finally:
        generation_lock.release()


def normalize_language(value: str) -> str:
    language = {"hi": "hi", "hindi": "hi", "mr": "mr", "marathi": "mr"}.get(
        value.strip().lower()
    )
    if language is None:
        raise ValueError("IndicF5 Teaching Voice supports Hindi (hi) and Marathi (mr) only")
    return language


@app.get("/health")
def health() -> dict[str, Any]:
    with state_lock:
        return {
            "ok": runtime is not None,
            "provider": "indicf5",
            "modelLoaded": runtime is not None,
            "modelLoading": model_loading,
            "model": MODEL_ID,
            "profileCount": len(profiles),
            "modelLoadSeconds": model_load_seconds,
            "error": model_error,
        }


def load_runtime() -> Runtime:
    import numpy
    import soundfile
    import torch
    from transformers import AutoModel

    # The validated remote implementation selects its CUDA device internally.
    model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
    return Runtime(model, torch, numpy, soundfile)


def generate_audio(active: Runtime, profile: VoiceProfile, text: str) -> tuple[Any, int]:
    audio = active.model(
        text,
        ref_audio_path=str(profile.reference_audio),
        ref_text=profile.reference_text,
    )
    # The validated API returns a bare waveform at 24 kHz. Prefer explicit rate
    # metadata if a compatible model revision returns a (waveform, rate) pair.
    if isinstance(audio, tuple) and len(audio) == 2:
        audio, sample_rate = audio
    else:
        sample_rate = getattr(active.model, "target_sample_rate", DEFAULT_SAMPLE_RATE)
    return audio, int(sample_rate)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(
        app,
        host=os.getenv("INDICF5_SERVICE_HOST", "127.0.0.1"),
        port=int(os.getenv("INDICF5_SERVICE_PORT", "8772")),
    )
