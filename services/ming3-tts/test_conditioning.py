from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from conditioning import (
    ACOUSTIC_REFERENCE,
    SPEAKER_EMBEDDING_ONLY,
    prepare_speaker_embedding,
    requires_speaker_embedding,
    speaker_embedding_path,
    synthesis_kwargs,
)


class FakeMingModel:
    def __init__(self) -> None:
        self.loaded: list[str] = []
        self.prepare_prompt_called = False

    def _load_prompt(self, path: str):
        self.loaded.append(path)
        return "unused-waveform", ["owner-private-speaker-embedding"]

    def prepare_prompt(self, *_args, **_kwargs):
        self.prepare_prompt_called = True
        raise AssertionError("speaker extraction must not encode prompt latents")


class MingConditioningTests(unittest.TestCase):
    def test_acoustic_registration_does_not_require_eager_speaker_extraction(self) -> None:
        self.assertFalse(requires_speaker_embedding(ACOUSTIC_REFERENCE))
        self.assertTrue(requires_speaker_embedding(SPEAKER_EMBEDDING_ONLY))

    def test_rejects_directory_reference_before_official_soundfile_loading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            model = FakeMingModel()
            reference = Path(directory)
            destination = Path(directory) / "embedding.pt"

            with self.assertRaisesRegex(ValueError, "non-empty reference audio file"):
                prepare_speaker_embedding(
                    model,
                    reference,
                    destination,
                    lambda _payload, _path: None,
                )
            self.assertEqual(model.loaded, [])

    def test_extracts_and_reuses_one_owner_scoped_embedding_without_prompt_latents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "owner" / "reference.wav"
            reference.parent.mkdir()
            reference.write_bytes(b"authorized-reference-bytes")
            destination = speaker_embedding_path(
                root / "derived", "ming_owner_profile", reference
            )
            model = FakeMingModel()
            saved: list[dict[str, object]] = []

            def save(payload: dict[str, object], path: Path) -> None:
                saved.append(payload)
                path.write_bytes(b"serialized-private-embedding")

            self.assertTrue(prepare_speaker_embedding(model, reference, destination, save))
            self.assertEqual(model.loaded, [str(reference)])
            self.assertFalse(model.prepare_prompt_called)
            self.assertEqual(
                saved, [{"spk_emb": "owner-private-speaker-embedding"}]
            )
            self.assertTrue(
                destination.is_relative_to(
                    (root / "derived" / "ming_owner_profile").resolve()
                )
            )
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

            self.assertFalse(prepare_speaker_embedding(model, reference, destination, save))
            self.assertEqual(model.loaded, [str(reference)])
            self.assertEqual(len(saved), 1)

    def test_speaker_only_generation_excludes_acoustic_audio_and_reference_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            embedding = Path(directory) / "embedding.pt"
            embedding.write_bytes(b"private-embedding")
            request = synthesis_kwargs(
                mode=SPEAKER_EMBEDDING_ONLY,
                text="Exact synthesis text.",
                output_path=Path("/private/output.wav"),
                reference_audio=Path("/private/reference.wav"),
                reference_text="Private reference transcript.",
                speaker_embedding=embedding,
            )

            self.assertEqual(request["spk_emb_path"], str(embedding))
            self.assertNotIn("prompt_wav_path", request)
            self.assertNotIn("prompt_text", request)
            self.assertEqual(request["cfg"], 2.0)
            self.assertEqual(request["sigma"], 0.25)
            self.assertEqual(request["temperature"], 0.0)

    def test_acoustic_rollback_mode_retains_official_prompt_contract(self) -> None:
        request = synthesis_kwargs(
            mode=ACOUSTIC_REFERENCE,
            text="Exact synthesis text.",
            output_path=Path("/private/output.wav"),
            reference_audio=Path("/private/reference.wav"),
            reference_text="Private reference transcript.",
            speaker_embedding=None,
        )

        self.assertEqual(request["prompt_wav_path"], "/private/reference.wav")
        self.assertEqual(request["prompt_text"], "Private reference transcript.")
        self.assertNotIn("spk_emb_path", request)


if __name__ == "__main__":
    unittest.main()
