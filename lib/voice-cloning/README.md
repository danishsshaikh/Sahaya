# Teaching Voice Integration

Each private, owner-scoped profile represents one reference language. New English
enrollments use `qwen3`; new Hindi and Marathi enrollments use `indicf5`.
Stored `profile.provider` controls preview, synthesis, recovery, and deletion.
Only absent legacy provider metadata defaults to Chatterbox. Unknown IDs fail.
No stored profiles are migrated and no provider fallback is permitted.

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
new Qwen3/IndicF5 synthesis requires an explicit, resolvable target language.

The UI records an approved paragraph in the selected reference language and
sends its versioned phrase ID and exact displayed text. The server checks both
against the approved phrase and persists `referenceText` verbatim. Changing
language discards the local candidate recording. The profile's reference
language cannot be changed through preview settings. Hindi/Marathi previews
use Devanagari. Chatterbox controls remain available only on legacy profiles.

Replacement targets the latest ready profile in the same language. The prior
profile is retired only after the replacement preview is accepted, with a
second language check before cleanup. Other language profiles remain intact.
Old JSON files without `referenceText` remain valid for Chatterbox. New provider
profiles without it fail explicitly and need re-enrollment.

## HTTP Boundary

The Qwen3 and IndicF5 adapters share their identical HTTP transport contract.
Model logic stays in the existing independent Python services. Reference paths
are resolved from the existing application storage keys to absolute paths;
the application and Python services must see the same reference files.

| Provider | URL default | Timeout environment variable | Default |
| --- | --- | --- | --- |
| Qwen3 | `http://127.0.0.1:8771` | `QWEN3_VOICE_CLONING_TIMEOUT_MS` | 600000 ms |
| IndicF5 | `http://127.0.0.1:8772` | `INDICF5_VOICE_CLONING_TIMEOUT_MS` | 900000 ms |

URLs can be overridden by `QWEN3_VOICE_CLONING_BASE_URL` and
`INDICF5_VOICE_CLONING_BASE_URL`. The existing Chatterbox configuration remains
unchanged. A successful lazy-service health response with no error is usable
even when its model is not loaded. Transport and model-load failures are errors.

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
concurrent scenes/users can still receive an explicit busy error from the
single-generation services. No queue or new chunking scheme is introduced.

## Indic Text Boundary

Only the IndicF5 adapter normalizes the ephemeral outgoing TTS string. Longest
technical phrases match before tokens, case-insensitively with Unicode word
boundaries. Hindi and Marathi mappings include neural networks, training,
training process, prediction, loss function, backpropagation, gradient descent,
and internal weights. Unknown words and existing Devanagari are unchanged.
This is a small dictionary, not general transliteration. Saved narration,
slides, and displayed text are untouched. Qwen3 and Chatterbox bypass it.

## Validation Status

This integration is authored and reviewed statically. Tests, type checking,
builds, applications, models, and services were deliberately not executed on
the local Mac. Focused regression test sources are provided for later execution.
No dependencies were installed, no model artifacts downloaded, and no server
access was used. Runtime correctness remains to be checked in the isolated
Sahaya test checkout before further integration or rollout.
