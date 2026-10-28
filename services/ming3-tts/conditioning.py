from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path
from typing import Any, Callable, Literal, cast


ConditioningMode = Literal["acoustic-reference", "speaker-embedding-only"]
ACOUSTIC_REFERENCE: ConditioningMode = "acoustic-reference"
SPEAKER_EMBEDDING_ONLY: ConditioningMode = "speaker-embedding-only"
CONDITIONING_MODES = (ACOUSTIC_REFERENCE, SPEAKER_EMBEDDING_ONLY)

# These are the documented Ming 3.0 TTS 0.5B defaults. Keep them explicit so
# an A/B changes only conditioning, not generation behavior.
OFFICIAL_GENERATION_SETTINGS = {
    "cfg": 2.0,
    "sigma": 0.25,
    "temperature": 0.0,
}
GENERATION_CONFIG_ID = "ming-0.5b-official-defaults-v1"


def parse_conditioning_mode(value: str | None) -> ConditioningMode:
    normalized = (value or ACOUSTIC_REFERENCE).strip().lower()
    if normalized not in CONDITIONING_MODES:
        raise ValueError(f"unsupported Ming conditioning mode: {value!r}")
    return cast(ConditioningMode, normalized)


def requires_speaker_embedding(mode: ConditioningMode) -> bool:
    return mode == SPEAKER_EMBEDDING_ONLY


def speaker_embedding_path(root: Path, profile_id: str, reference: Path) -> Path:
    stat = reference.stat()
    fingerprint = hashlib.sha256(
        f"{reference.resolve()}\0{stat.st_size}\0{stat.st_mtime_ns}".encode("utf-8")
    ).hexdigest()[:24]
    return root.resolve() / profile_id / f"{fingerprint}.pt"


def prepare_speaker_embedding(
    model: Any,
    reference: Path,
    destination: Path,
    save_embedding: Callable[[dict[str, Any], Path], None],
) -> bool:
    """Extract one official CAMPPlus embedding and publish it atomically.

    The upstream ``_load_prompt`` helper performs only WAV loading, channel
    conversion/resampling and speaker extraction. It does not call
    ``encode_prompt_latent``. Existing derived embeddings are reused.
    """
    if destination.is_file() and destination.stat().st_size > 0:
        return False
    if not reference.is_file() or reference.stat().st_size == 0:
        raise ValueError("Ming speaker extraction requires a non-empty reference audio file")
    if not hasattr(model, "_load_prompt"):
        raise RuntimeError("installed Ming runtime does not support speaker extraction")
    _waveform, embeddings = model._load_prompt(str(reference))
    if not isinstance(embeddings, list) or len(embeddings) != 1:
        raise RuntimeError("Ming speaker extraction returned an invalid embedding set")

    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination.parent, 0o700)
    temporary = destination.with_name(f"{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        save_embedding({"spk_emb": embeddings[0]}, temporary)
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise RuntimeError("Ming speaker embedding serialization returned an empty file")
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def synthesis_kwargs(
    *,
    mode: ConditioningMode,
    text: str,
    output_path: Path,
    reference_audio: Path,
    reference_text: str,
    speaker_embedding: Path | None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "task": "TTS",
        "language_id": "English",
        "text": text,
        "use_spk_emb": True,
        "raw_text": True,
        "output_path": str(output_path),
        **OFFICIAL_GENERATION_SETTINGS,
    }
    if mode == SPEAKER_EMBEDDING_ONLY:
        # In upstream Ming this branch loads only ``spk_emb``. Because no
        # prompt WAV/text is passed, ``prompt_latent`` remains None.
        if speaker_embedding is None or not speaker_embedding.is_file():
            raise ValueError("Ming speaker-only conditioning requires a prepared embedding")
        request["spk_emb_path"] = str(speaker_embedding)
    else:
        request["prompt_wav_path"] = str(reference_audio)
        request["prompt_text"] = reference_text
    return request


def reference_preparation(mode: ConditioningMode) -> str:
    if mode == SPEAKER_EMBEDDING_ONLY:
        return "official-campplus-16khz-speaker-embedding-only"
    return "official-runtime-mono-resample-and-front-pad"
