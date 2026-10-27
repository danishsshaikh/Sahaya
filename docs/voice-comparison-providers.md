# Teaching Voice comparison providers

Sahaya can compare its existing local Teaching Voice engines with two experimental, metered API
providers. Sarvam AI and Bodhan Indic-Speak are preview-only and cannot become the active classroom
engine.

## Configuration

Both providers are disabled by default. Configure server-side values only:

```dotenv
SARVAM_VOICE_CLONING_ENABLED=true
SARVAM_API_KEY=...
SARVAM_API_BASE_URL=https://api.sarvam.ai
SARVAM_TIMEOUT_MS=120000
SARVAM_MAX_CONCURRENCY=1

BODHAN_TTS_ENABLED=true
BODHAN_API_KEY=...
BODHAN_API_BASE_URL=https://api.bodhan.ai/v1
BODHAN_TIMEOUT_MS=120000
BODHAN_MAX_CONCURRENCY=2
```

Restart the Sahaya web process after changing its environment. No local model or GPU process is
required for either provider.

## Privacy and storage

Sarvam voice creation requires a separate explicit disclosure and consent. New Teaching Voice
enrollments retain the exact uploaded recording beside the processed Chatterbox/IndicF5
`reference.wav`. Sahaya uploads that exact source only when it is in a Sarvam-supported format; it
does not trim, enhance, resample, or transcode the file. Legacy profiles do not have this original
source and must be re-recorded before a new raw-reference clone can be created.

The returned voice identifier is stored in that owner's private voice profile and reused. Existing
legacy Sarvam identifiers remain preserved; a separate raw-reference clone is created only through
the explicit opt-in control, which warns about quota and cost. The identifier is never returned to
the browser, does not replace a local registration, and is not automatically deleted.

Raw Sarvam preview requests send the exact comparison text in one request (maximum 1000
characters), request WAV, and explicitly disable provider VAD, text normalization, and QC. Sahaya
base64-decodes, validates, caches, and serves the returned WAV bytes without signal processing or
re-encoding. Sarvam's own documented voice-creation flow still validates, transcribes, clones, and
may improve the reference internally; Sahaya cannot disable or audit those provider-side steps.

Bodhan is preset-voice synthesis. Sahaya sends only the comparison text, selected language, voice,
and style; it never sends faculty reference audio to Bodhan.

Preview cache files remain owner-scoped under `VOICE_CLONING_STORAGE_DIR`, with private directory and
file permissions. Cache keys include profile version, provider, language, exact text, output codec,
processing mode, and relevant generation settings. Legacy processed Sarvam cache entries cannot
match raw-preview keys. Cached audio is never shared across owners.

## Provider contracts

- Sarvam: `POST /voices/create` and `POST /voices/clone`, authenticated with
  `api-subscription-key`. References:
  [Create Voice](https://docs.sarvam.ai/api-reference/voice-cloning/create-voice),
  [Clone](https://docs.sarvam.ai/api-reference/voice-cloning/clone), and
  [supported languages](https://docs.sarvam.ai/api/api-guides-tutorials/voice-cloning/supported-languages).
- Bodhan: `POST /v1/audio/speech` using model `indic-speak`, authenticated with a Bearer API key.
  References: [API documentation](https://console.bodhan.ai/api-docs/) and
  [Indic-Speak model card](https://huggingface.co/bodhan-ai/indic-speak).

Automated tests mock these APIs. A deployment must still validate authenticated synthesis, account
permissions, provider retention terms, billing limits, pronunciation, and returned audio with its own
credentials before wider faculty access.
