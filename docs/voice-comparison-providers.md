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

Sarvam voice creation requires a separate explicit disclosure and consent. Sahaya sends the current
faculty reference WAV to Sarvam once, stores the returned voice identifier in that owner's private
voice profile, and reuses it for later previews. The identifier is never returned to the browser and
does not replace the local Chatterbox or Qwen registration. Sahaya does not automatically delete the
remote Sarvam voice.

Bodhan is preset-voice synthesis. Sahaya sends only the comparison text, selected language, voice,
and style; it never sends faculty reference audio to Bodhan.

Preview cache files remain owner-scoped under `VOICE_CLONING_STORAGE_DIR`, with private directory and
file permissions. Cache keys include profile version, provider, language, exact text, and relevant
generation settings. Cached audio is never shared across owners.

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
