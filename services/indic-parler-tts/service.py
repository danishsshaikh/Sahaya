from __future__ import annotations

import io
import logging
import os
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field


MODEL_ID = "ai4bharat/indic-parler-tts"
SERVICE_NAME = "indic-parler-tts"

MAX_TEXT_CHARS = int(os.getenv("INDIC_PARLER_MAX_TEXT_CHARS", "4000"))
MAX_DESCRIPTION_CHARS = int(os.getenv("INDIC_PARLER_MAX_DESCRIPTION_CHARS", "1200"))
DEVICE_SETTING = os.getenv("INDIC_PARLER_DEVICE", "auto").strip().lower() or "auto"
DTYPE_SETTING = os.getenv("INDIC_PARLER_DTYPE", "auto").strip().lower() or "auto"

app = FastAPI(title="Indic Parler-TTS Experimental Service")
log = logging.getLogger("sahaya.indic_parler_tts")

_load_lock = threading.Lock()
_generation_lock = threading.Lock()
_runtime: "IndicParlerRuntime | None" = None
_model_error: str | None = None


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    description: str = Field(min_length=1, max_length=MAX_DESCRIPTION_CHARS)


@dataclass(frozen=True)
class IndicParlerRuntime:
    model: Any
    tokenizer: Any
    description_tokenizer: Any
    torch: Any
    soundfile: Any
    device: str
    dtype: str
    sample_rate: int


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "model": MODEL_ID,
        "model_loaded": _runtime is not None,
    }


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    text = req.text.strip()
    description = req.description.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if not description:
        raise HTTPException(status_code=400, detail="description is required")

    if not _generation_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Indic Parler-TTS service is busy")

    started = time.perf_counter()
    try:
        runtime = get_runtime()
        log.info(
            "Indic Parler-TTS generation start textLen=%s descriptionLen=%s device=%s dtype=%s",
            len(text),
            len(description),
            runtime.device,
            runtime.dtype,
        )
        audio = generate_audio(runtime, text, description)
        payload = serialize_wav(runtime.soundfile, audio, runtime.sample_rate)
        duration_ms = int((time.perf_counter() - started) * 1000)
        log.info("Indic Parler-TTS generation complete durationMs=%s", duration_ms)
        return Response(content=payload, media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as exc:
        log.error(
            "Indic Parler-TTS generation failed errorType=%s message=%s\n%s",
            type(exc).__name__,
            str(exc),
            traceback.format_exc(),
        )
        raise HTTPException(status_code=500, detail="Indic Parler-TTS generation failed")
    finally:
        _generation_lock.release()


def get_runtime() -> IndicParlerRuntime:
    global _model_error, _runtime
    if _runtime is not None:
        return _runtime

    with _load_lock:
        if _runtime is not None:
            return _runtime

        started = time.perf_counter()
        log.info("Loading Indic Parler-TTS model")
        try:
            runtime = load_runtime()
        except Exception as exc:
            _model_error = f"{type(exc).__name__}: {exc}"
            log.error("Indic Parler-TTS model load failed:\n%s", traceback.format_exc())
            raise HTTPException(status_code=503, detail="Indic Parler-TTS model failed to load")

        _runtime = runtime
        _model_error = None
        duration_ms = int((time.perf_counter() - started) * 1000)
        log.info(
            "Loaded Indic Parler-TTS model durationMs=%s device=%s dtype=%s sampleRate=%s",
            duration_ms,
            runtime.device,
            runtime.dtype,
            runtime.sample_rate,
        )
        return runtime


def load_runtime() -> IndicParlerRuntime:
    import soundfile
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer

    device = resolve_device(torch)
    torch_dtype = resolve_dtype(torch, device)

    from_pretrained_kwargs: dict[str, Any] = {}
    if torch_dtype is not None:
        from_pretrained_kwargs["torch_dtype"] = torch_dtype

    model = ParlerTTSForConditionalGeneration.from_pretrained(
        MODEL_ID,
        **from_pretrained_kwargs,
    ).to(device)
    model.eval()

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    description_tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)

    sample_rate = int(model.config.sampling_rate)
    return IndicParlerRuntime(
        model=model,
        tokenizer=tokenizer,
        description_tokenizer=description_tokenizer,
        torch=torch,
        soundfile=soundfile,
        device=device,
        dtype=DTYPE_SETTING,
        sample_rate=sample_rate,
    )


def resolve_device(torch: Any) -> str:
    if DEVICE_SETTING == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if DEVICE_SETTING.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("INDIC_PARLER_DEVICE requests CUDA, but CUDA is not available")
    if DEVICE_SETTING not in {"cpu", "cuda"} and not DEVICE_SETTING.startswith("cuda:"):
        raise RuntimeError("INDIC_PARLER_DEVICE must be auto, cpu, cuda, or a CUDA device string")
    return DEVICE_SETTING


def resolve_dtype(torch: Any, device: str) -> Any | None:
    if DTYPE_SETTING == "auto":
        return None
    dtype_by_name = {
        "float32": torch.float32,
        "fp32": torch.float32,
        "float16": torch.float16,
        "fp16": torch.float16,
        "bfloat16": torch.bfloat16,
        "bf16": torch.bfloat16,
    }
    dtype = dtype_by_name.get(DTYPE_SETTING)
    if dtype is None:
        raise RuntimeError("INDIC_PARLER_DTYPE must be auto, float32, float16, or bfloat16")
    if device == "cpu" and dtype in {torch.float16, torch.bfloat16}:
        raise RuntimeError("float16/bfloat16 inference requires a compatible accelerator")
    return dtype


def generate_audio(runtime: IndicParlerRuntime, text: str, description: str) -> Any:
    description_inputs = runtime.description_tokenizer(description, return_tensors="pt").to(
        runtime.device,
    )
    prompt_inputs = runtime.tokenizer(text, return_tensors="pt").to(runtime.device)

    with runtime.torch.inference_mode():
        generation = runtime.model.generate(
            input_ids=description_inputs.input_ids,
            attention_mask=description_inputs.attention_mask,
            prompt_input_ids=prompt_inputs.input_ids,
            prompt_attention_mask=prompt_inputs.attention_mask,
        )
    return generation.detach().cpu().numpy().squeeze()


def serialize_wav(soundfile: Any, audio: Any, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    try:
        soundfile.write(buffer, audio, sample_rate, format="WAV")
    except Exception as exc:
        log.error("Indic Parler-TTS WAV serialization failed: %s", exc)
        raise HTTPException(status_code=500, detail="failed to serialize generated audio")
    return buffer.getvalue()


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("INDIC_PARLER_LOG_LEVEL", "INFO").upper())
    port = int(os.getenv("INDIC_PARLER_TTS_PORT", "8770"))
    host = os.getenv("INDIC_PARLER_TTS_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port)
