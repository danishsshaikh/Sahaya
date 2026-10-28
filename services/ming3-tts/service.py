from __future__ import annotations

import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from conditioning import (
    ACOUSTIC_REFERENCE,
    CONDITIONING_MODES,
    GENERATION_CONFIG_ID,
    parse_conditioning_mode,
    prepare_speaker_embedding,
    reference_preparation,
    requires_speaker_embedding,
    speaker_embedding_path,
    synthesis_kwargs,
)


MODEL_ID = os.getenv("MING3_TTS_MODEL", "inclusionAI/Ming-3.0-tts-0.5b")
DEVICE = os.getenv("MING3_TTS_DEVICE", "cuda:0")
OFFICIAL_REPOSITORY = os.getenv("MING3_TTS_REPOSITORY_DIR", "").strip()
REFERENCE_ROOT_VALUE = os.getenv("MING3_TTS_REFERENCE_ROOT", "").strip()
REFERENCE_ROOT = Path(REFERENCE_ROOT_VALUE).resolve() if REFERENCE_ROOT_VALUE else None
EMBEDDING_ROOT_VALUE = os.getenv("MING3_TTS_EMBEDDING_ROOT", "").strip()
EMBEDDING_ROOT = (
    Path(EMBEDDING_ROOT_VALUE).resolve()
    if EMBEDDING_ROOT_VALUE
    else (REFERENCE_ROOT / ".ming3-speaker-embeddings" if REFERENCE_ROOT else None)
)
try:
    DEFAULT_CONDITIONING_MODE = parse_conditioning_mode(
        os.getenv("MING3_TTS_CONDITIONING_MODE", ACOUSTIC_REFERENCE)
    )
except ValueError as exc:
    DEFAULT_CONDITIONING_MODE = ACOUSTIC_REFERENCE
    CONDITIONING_CONFIG_ERROR = str(exc)
else:
    CONDITIONING_CONFIG_ERROR = None
PROFILE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

if OFFICIAL_REPOSITORY:
    sys.path.insert(0, str(Path(OFFICIAL_REPOSITORY).resolve()))

try:
    from ming_tts import MingTTS
except Exception as exc:  # pragma: no cover - reported by /health on the GPU host
    MingTTS = None
    MING_IMPORT_ERROR = exc
else:
    MING_IMPORT_ERROR = None


app = FastAPI(title="Sahaya Ming 3.0 TTS 0.5B Preview Service")
log = logging.getLogger("sahaya.ming3_tts")
generation_lock = threading.Lock()
state_lock = threading.Lock()
model: Any | None = None
model_error: str | None = None


@dataclass(frozen=True)
class VoicePrompt:
    reference_audio: Path
    reference_text: str
    speaker_embedding: Path | None


profiles: dict[str, VoicePrompt] = {}


class ProfileCreateRequest(BaseModel):
    profileId: str = Field(min_length=1, max_length=128)
    referenceAudioPath: str = Field(min_length=1)
    referenceText: str = Field(min_length=1)
    referenceLanguage: str = "en"
    conditioningMode: str = DEFAULT_CONDITIONING_MODE

    @field_validator("profileId")
    @classmethod
    def validate_profile_id(cls, value: str) -> str:
        if not PROFILE_ID_PATTERN.fullmatch(value):
            raise ValueError("invalid profile ID")
        return value

    @field_validator("referenceText")
    @classmethod
    def validate_reference_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("reference transcript is required")
        return value

    @field_validator("referenceLanguage")
    @classmethod
    def validate_reference_language(cls, value: str) -> str:
        if value.strip().lower() not in {"en", "english"}:
            raise ValueError("Ming 3.0 TTS preview requires an English reference")
        return "en"

    @field_validator("conditioningMode")
    @classmethod
    def validate_conditioning_mode(cls, value: str) -> str:
        return parse_conditioning_mode(value)


class SynthesizeRequest(BaseModel):
    profileId: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=1000)
    language: str = "en"
    conditioningMode: str = DEFAULT_CONDITIONING_MODE

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
        return value

    @field_validator("language")
    @classmethod
    def validate_language(cls, value: str) -> str:
        if value.strip().lower() not in {"en", "english"}:
            raise ValueError("Ming 3.0 TTS preview currently supports English text only")
        return "en"

    @field_validator("conditioningMode")
    @classmethod
    def validate_conditioning_mode(cls, value: str) -> str:
        return parse_conditioning_mode(value)


def validate_reference(path_value: str) -> Path:
    path = Path(path_value).resolve()
    if REFERENCE_ROOT is None:
        raise HTTPException(status_code=503, detail="Ming reference root is not configured")
    if not path.is_relative_to(REFERENCE_ROOT):
        raise HTTPException(status_code=403, detail="reference audio is outside the allowed root")
    if not path.is_file() or path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="reference audio not found")
    try:
        info = sf.info(path)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="reference audio is not readable by the official Ming soundfile backend",
        ) from None
    if info.frames <= 0 or info.samplerate <= 0 or info.channels <= 0:
        raise HTTPException(status_code=400, detail="reference audio is empty")
    return path


def require_model() -> Any:
    if model is None:
        raise HTTPException(status_code=503, detail="Ming 3.0 TTS model is not loaded")
    return model


def save_speaker_embedding(payload: dict[str, Any], path: Path) -> None:
    import torch

    torch.save(payload, path)


def load_model() -> None:
    global model, model_error
    if CONDITIONING_CONFIG_ERROR is not None:
        model_error = CONDITIONING_CONFIG_ERROR
        log.error("Ming 3.0 TTS conditioning configuration is invalid")
        return
    if REFERENCE_ROOT is None:
        model_error = "MING3_TTS_REFERENCE_ROOT is not configured"
        log.error("Ming 3.0 TTS reference root is not configured")
        return
    if MingTTS is None:
        model_error = f"ming_tts import failed: {type(MING_IMPORT_ERROR).__name__}"
        log.error("Ming 3.0 TTS import failed", exc_info=MING_IMPORT_ERROR)
        return
    try:
        # raw_text=True is used per request, so the optional FST normalizer is disabled.
        model = MingTTS(MODEL_ID, device=DEVICE, text_normalization=False, cache_prompts=True)
        model_error = None
        log.info("Ming 3.0 TTS model loaded model=%s device=%s", MODEL_ID, DEVICE)
    except Exception as exc:  # pragma: no cover - depends on prepared GPU runtime
        model = None
        model_error = type(exc).__name__
        log.error("Ming 3.0 TTS model load failed:\n%s", traceback.format_exc())


@app.on_event("startup")
def startup() -> None:
    load_model()


@app.get("/health")
def health() -> dict[str, Any]:
    with state_lock:
        profile_count = len(profiles)
    return {
        "ok": model is not None,
        "provider": "ming3-tts",
        "modelLoaded": model is not None,
        "model": MODEL_ID,
        "device": DEVICE,
        "profileCount": profile_count,
        "referenceRootConfigured": REFERENCE_ROOT is not None,
        "embeddingRootConfigured": EMBEDDING_ROOT is not None,
        "defaultConditioningMode": DEFAULT_CONDITIONING_MODE,
        "conditioningModes": list(CONDITIONING_MODES),
        "generationConfig": GENERATION_CONFIG_ID,
        "error": model_error,
    }


@app.post("/profiles")
def create_profile(req: ProfileCreateRequest) -> dict[str, Any]:
    reference = validate_reference(req.referenceAudioPath)
    conditioning_mode = parse_conditioning_mode(req.conditioningMode)
    embedding: Path | None = None
    embedding_prepared = False
    if requires_speaker_embedding(conditioning_mode):
        active_model = require_model()
        if EMBEDDING_ROOT is None:
            raise HTTPException(status_code=503, detail="Ming embedding root is not configured")
        EMBEDDING_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(EMBEDDING_ROOT, 0o700)
        embedding = speaker_embedding_path(EMBEDDING_ROOT, req.profileId, reference)
        if not generation_lock.acquire(blocking=False):
            raise HTTPException(status_code=429, detail="Ming 3.0 TTS preview service is busy")
        try:
            embedding_prepared = prepare_speaker_embedding(
                active_model,
                reference,
                embedding,
                save_speaker_embedding,
            )
        finally:
            generation_lock.release()
    prompt = VoicePrompt(
        reference_audio=reference,
        reference_text=req.referenceText,
        speaker_embedding=embedding,
    )
    with state_lock:
        profiles[req.profileId] = prompt
    log.info(
        "Ming voice prompt registered profileId=%s conditioningMode=%s "
        "speakerEmbeddingPrepared=%s",
        req.profileId,
        req.conditioningMode,
        embedding_prepared,
    )
    return {
        "providerReferenceId": req.profileId,
        "referencePreparation": reference_preparation(conditioning_mode),
        "defaultConditioningMode": DEFAULT_CONDITIONING_MODE,
        "speakerEmbeddingPrepared": embedding_prepared,
        "generationConfig": GENERATION_CONFIG_ID,
    }


@app.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str) -> dict[str, bool]:
    with state_lock:
        removed = profiles.pop(profile_id, None)
    if removed is not None:
        if removed.speaker_embedding is not None:
            shutil.rmtree(removed.speaker_embedding.parent, ignore_errors=True)
    return {"deleted": removed is not None}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    active_model = require_model()
    with state_lock:
        prompt = profiles.get(req.profileId)
    if prompt is None:
        raise HTTPException(status_code=404, detail="voice profile not found")
    if not generation_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Ming 3.0 TTS preview service is busy")

    started = time.monotonic()
    request_id = f"ming_{uuid.uuid4().hex[:16]}"
    conditioning_mode = parse_conditioning_mode(req.conditioningMode)
    output_path: Path | None = None
    try:
        embedding = prompt.speaker_embedding
        if requires_speaker_embedding(conditioning_mode) and (
            embedding is None or not embedding.is_file() or embedding.stat().st_size == 0
        ):
            if EMBEDDING_ROOT is None:
                raise HTTPException(status_code=503, detail="Ming embedding root is not configured")
            EMBEDDING_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(EMBEDDING_ROOT, 0o700)
            embedding = speaker_embedding_path(EMBEDDING_ROOT, req.profileId, prompt.reference_audio)
            prepare_speaker_embedding(
                active_model,
                prompt.reference_audio,
                embedding,
                save_speaker_embedding,
            )
            prompt = VoicePrompt(
                reference_audio=prompt.reference_audio,
                reference_text=prompt.reference_text,
                speaker_embedding=embedding,
            )
            with state_lock:
                profiles[req.profileId] = prompt
        with tempfile.NamedTemporaryFile(
            prefix="sahaya-ming-", suffix=".wav", delete=False
        ) as out:
            output_path = Path(out.name)
        active_model.synthesize(
            **synthesis_kwargs(
                mode=conditioning_mode,
                text=req.text,
                output_path=output_path,
                reference_audio=prompt.reference_audio,
                reference_text=prompt.reference_text,
                speaker_embedding=embedding,
            )
        )
        audio = output_path.read_bytes()
        if not audio:
            raise RuntimeError("Ming returned empty audio")
        sf.info(output_path)
        elapsed_ms = round((time.monotonic() - started) * 1000)
        log.info(
            "Ming preview generated profileId=%s conditioningMode=%s "
            "generationConfig=%s characters=%d latencyMs=%d requestId=%s",
            req.profileId,
            conditioning_mode,
            GENERATION_CONFIG_ID,
            len(req.text),
            elapsed_ms,
            request_id,
        )
        return Response(
            content=audio,
            media_type="audio/wav",
            headers={
                "X-Request-Id": request_id,
                "X-Reference-Preparation": reference_preparation(conditioning_mode),
                "X-Ming-Conditioning-Mode": conditioning_mode,
                "X-Ming-Generation-Config": GENERATION_CONFIG_ID,
                "Cache-Control": "private, no-store",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.error(
            "Ming preview failed profileId=%s error=%s",
            req.profileId,
            type(exc).__name__,
        )
        raise HTTPException(status_code=502, detail="Ming 3.0 TTS generation failed") from exc
    finally:
        if output_path is not None:
            output_path.unlink(missing_ok=True)
        generation_lock.release()


if __name__ == "__main__":
    uvicorn.run(
        "service:app",
        host=os.getenv("MING3_TTS_HOST", "127.0.0.1"),
        port=int(os.getenv("MING3_TTS_PORT", "8773")),
        workers=1,
    )
