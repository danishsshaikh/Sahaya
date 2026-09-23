# Indic Parler standard TTS

`indic-parler-tts` is an optional normal narration provider, not Teaching Voice.
Kokoro and all existing providers remain available. No global default changes.

Configure `TTS_INDIC_PARLER_BASE_URL=http://127.0.0.1:8770` in the isolated
test deployment, or configure `tts.indic-parler-tts.baseUrl` in server provider
YAML. No API key is required. The normal server-provider discovery endpoint
advertises availability without exposing the server URL. Alternatively, enter
an explicit Base URL in Settings; client-supplied local URLs require the existing
`ALLOW_LOCAL_NETWORKS=true` policy. A registry default alone does not enable it.

Select Indic Parler in the standard voice picker. Its three app-side choices map
verbatim to the English, Hindi and Marathi descriptions documented in
`services/indic-parler-tts/README.md`. The default is the English description.
These are description choices, NOT named speakers or service-side voice IDs;
there is no fixed speaker catalog or built-in default description in the service.
Choose the description matching the narration language. Only these three
manually validated languages are exposed; no broader language claims are made.

The adapter sends `POST /synthesize` with exactly `{ text, description }`.
It sends no language, model, voice, speed, authentication, or cloning fields.
The existing service runs `ai4bharat/indic-parler-tts` and returns `audio/wav`.
`GET /health` reports service identity and `model_loaded`; lazy loading is normal
and the adapter does not reject an unloaded model via a health preflight.

The normal TTS timeout/cancellation and audio-validation mechanisms apply.
Indic Parler defaults to 900000 ms, overridable by `TTS_INDIC_PARLER_TIMEOUT_MS`,
then the shared `TTS_REQUEST_TIMEOUT_MS`. Other providers retain their defaults.
The existing TTS API route has a 960-second allowance; proxy/deployment limits
must also permit the chosen budget. No inference or timing guarantee is implied.

Normal scene speech is split at the service's default 4000-character limit and
serialized within a scene. Concurrent scenes/users or discussion prefetch may
still receive the service's explicit 429 busy response. No cross-provider retry,
queue, service change, or silent Kokoro substitution is introduced. If the
service operator lowers its text limit, requests exceeding it fail explicitly.

On isolated port 3003, select each description, preview with matching-language
text, generate a new ordinary (non-Teaching-Voice) course, and compare with a
separate Kokoro course. Existing course voice bindings remain authoritative.
Check WAV playback, cold/warm latency, long narration, and busy/error handling.
Do not attach a Teaching Voice profile for this comparison: explicit Teaching
Voice still bypasses normal TTS. The reported Teaching Voice "class" prefix
issue is outside this integration and remains unfixed here.
