# Teaching Voice Integration

Each private, owner-scoped profile represents one reference language. New English
enrollments use `chatterbox`; new Hindi and Marathi enrollments use `indicf5`.
Stored `profile.provider` controls preview, synthesis, recovery, and deletion.
Absent provider metadata and retired `qwen3` metadata resolve to Chatterbox.
Unknown IDs fail and no provider fallback is permitted.

Legacy Qwen3 profiles remain usable only when their private normalized reference
WAV is still present. The first new Chatterbox preview or synthesis registers
that same reference with Chatterbox and persists Chatterbox metadata. Historical
lesson audio and assets are not regenerated or deleted. Stored Qwen previews are
not presented as Chatterbox previews.

## Language And Profile Lifecycle

The homepage selects `teacherVoiceProfileId` before outline generation infers
the classroom's `languageDirective`. The session copies that ID into the stage;
regeneration uses the stage's ID and language. There is no existing automatic
language-aware profile re-resolution.

Teaching Voice now looks up profiles by the chosen language. The existing GET
endpoint accepts optional `language`; no-query clients retain the previous
latest-profile response shape. Optional `profileId` plus `language` validates a
specific ready profile, used immediately after outline language inference.
An ambiguous or mismatched narration language stops generation. It does not
choose another profile. Synthesis repeats the check, including for later edits.
An old Chatterbox caller without a language can still use the saved language;
IndicF5 synthesis requires an explicit, resolvable target language.

The UI records an approved paragraph in the selected reference language and
sends its versioned phrase ID and exact displayed text. The server checks both
against the approved phrase and persists `referenceText` verbatim. Changing
language discards the local candidate recording. The profile's reference
language cannot be changed through preview settings. Hindi/Marathi previews
use Devanagari. Chatterbox controls are available on English profiles.

Replacement targets the latest ready profile in the same language. The prior
profile is retired only after the replacement preview is accepted, with a
second language check before cleanup. Other language profiles remain intact.
Old JSON files without `referenceText` remain valid for Chatterbox. IndicF5
profiles without it fail explicitly and need re-enrollment.

## HTTP Boundary

Model logic stays in the existing independent Python services. Reference paths
are resolved from the existing application storage keys to absolute paths; the
application and Python services must see the same reference files.

| Provider | URL default | Timeout environment variable | Default |
| --- | --- | --- | --- |
| Chatterbox | `VOICE_CLONING_BASE_URL` | `VOICE_CLONING_TIMEOUT_MS` | 120000 ms |
| IndicF5 | `http://127.0.0.1:8772` | `INDICF5_VOICE_CLONING_TIMEOUT_MS` | 900000 ms |

The IndicF5 URL can be overridden by `INDICF5_VOICE_CLONING_BASE_URL`.
Transport and model-load failures are errors.

The adapters keep timeouts active through response-body reading. A missing
service registration permits one registration from persisted reference metadata
and one retry on that same provider. Other failures do not retry automatically.
Client-side Teaching Voice requests disable generic generation retries and
ordinary narrator fallback. Missing Teaching Voice audio does not trigger
browser speech. Normal TTS requests retain their existing behavior.

Speech actions do not have a universal length cap (`splitLongSpeechActions`
currently caps only GLM). The 10/15 minute defaults allow for slow T4 generation
and cold loads but cannot guarantee arbitrary-length requests. The enrollment
and TTS route duration allowance is 960 seconds. This is an allowance, not a
proxy timeout configuration; the isolated self-hosted GPU test must check its
HTTP timeout limits. Increasing provider timeouts beyond it requires reviewing
that allowance too. Teaching Voice speech actions within a scene are serial;
Chatterbox classroom narration runs through an owner-scoped, idempotent,
single-worker resource queue. Each completed clip is downloaded, attached, and
persisted independently while later clips remain queued. IndicF5 retains its
existing request behavior.

## Indic Text Boundary

Only the IndicF5 adapter normalizes the ephemeral outgoing TTS string. Longest
technical phrases match before tokens, case-insensitively with Unicode word
boundaries. Hindi and Marathi mappings include neural networks, training,
training process, prediction, loss function, backpropagation, gradient descent,
and internal weights. Unknown words and existing Devanagari are unchanged.
This is a small dictionary, not general transliteration. Saved narration,
slides, and displayed text are untouched. Chatterbox bypasses it.

## Validation Status

Focused tests cover provider routing, enrollment, queue admission, profile
migration, mastering, and narration attachment. Deployment still requires a
manual preview and classroom listening check against the configured Chatterbox
service because automated tests do not establish perceptual voice quality.
