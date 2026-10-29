# Teaching Voice Integration

Each private, owner-scoped profile represents one reference language. The simplified
English homepage workflow stores the authorized recording, generates a Qwen3-TTS
1.7B sample, requires a successful Resemble Enhance result, and activates Qwen with
that enhancement mode. Only after the enhanced sample is saved does the explicit
Generate Voice action make that profile the account's active English voice. It
does not generate an extra Chatterbox sample. Existing
provider-specific and IndicF5 enrollment APIs remain available to their existing
callers. Stored `profile.provider` remains the compatibility and lifecycle provider;
`activeEngine` and the engine-specific enhancement mode determine classroom synthesis.
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

Teaching Voice looks up profiles by their recorded reference language. The existing GET
endpoint accepts optional `language`; no-query clients retain the previous
latest-profile response shape. Optional `profileId` plus `language` validates a
specific ready profile, used immediately after outline language inference.
An ambiguous or mismatched IndicF5 narration language stops generation. It does
not choose another profile. Chatterbox keeps the English reference language in
`profile.language` and stores the faculty-selected English or Hindi synthesis
language in `profile.languageId`. Classroom narration uses that saved Chatterbox
selection even when the unchanged lesson text is English. IndicF5 synthesis
continues to require an explicit target matching its Hindi or Marathi reference.

The homepage records one approved English paragraph and sends its versioned phrase
ID and exact displayed text. Alternatively, it stores the exact authorized upload
and requires an explicit, editable transcript; server transcription may populate
the field but is never treated as unreviewable ground truth. The server checks the
recorded phrase against the approved text and persists `referenceText` verbatim.
Preview settings do not change the reference language or require re-enrollment. An English-reference
Chatterbox profile can preview English text with English or Hindi synthesis, and
Hindi text with Hindi synthesis. These comparisons can affect pronunciation and
do not guarantee a particular accent. Hindi/Marathi IndicF5 previews use
Devanagari.

Homepage re-recording or upload creates a new profile and preserves previous
profiles and original recordings. An existing authorized English profile can be
explicitly upgraded to enhanced Qwen without replacing its reference. Old JSON
files without `referenceText` remain valid for Chatterbox, but cannot be upgraded
to Qwen until an accurate transcript is available. IndicF5 profiles without the
required transcript fail explicitly and need re-enrollment.

## Selecting An Existing Profile

Use the owner-scoped terminal utility when an older ready profile should become
the account's default Teaching Voice. Run it in the same application environment
as Sahaya so `OPENMAIC_AUTH_DATA_DIR` and `VOICE_CLONING_STORAGE_DIR` resolve to
the deployed private data stores.

List the account's profiles, including their immutable creation time and provider
compatibility:

```sh
pnpm voice-profile list --user <faculty-email-or-user-id>
```

After confirming that the intended profile is owned by that account and marked
ready, activate it by ID:

```sh
pnpm voice-profile activate --user <faculty-email-or-user-id> --profile vcp_RYn-oAtrY3ptceg6
```

Activation validates the account, profile ownership, readiness, and readable
owner-scoped reference audio. It updates only the account-level Teaching Voice
pointer. It does not alter profile timestamps, delete or recreate audio, or
change any existing course-specific profile binding.

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
