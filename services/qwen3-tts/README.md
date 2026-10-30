# Qwen3-TTS 1.7B Teaching Voice Service

This localhost-only service adds `Qwen/Qwen3-TTS-12Hz-1.7B-Base` as a selectable
Teaching Voice engine and preview option. It does not enroll or replace a Teaching
Voice profile. Sahaya supplies the existing private reference WAV and its exact saved
transcript, and stores engine selection separately from the enrollment provider.

The service uses the already validated POC checkout, Python environment, and cached
model. It sets `local_files_only=True`; the startup command also forces Hugging Face
and Transformers offline mode so deployment cannot download another model.

## Start On GPU 1

From the deployed Sahaya repository root, run one persistent process:

```bash
CUDA_VISIBLE_DEVICES=1 \
HF_HUB_OFFLINE=1 \
TRANSFORMERS_OFFLINE=1 \
PYTHONPATH=/home/danish/projects/qwen3-tts-poc/Qwen3-TTS-pr355 \
QWEN3_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base \
QWEN3_TTS_SERVICE_HOST=127.0.0.1 \
QWEN3_TTS_SERVICE_PORT=8771 \
/home/danish/projects/qwen3-tts-poc/.venv/bin/python \
  services/qwen3-tts/service.py
```

Physical GPU 1 becomes logical `cuda:0` inside the process. Keep one worker: the
loaded model, cached voice-clone prompts, and generation lock are process-local.

Check readiness after startup:

```bash
curl --fail-with-body http://127.0.0.1:8771/health
```

`ok: true` and `modelLoaded: true` confirm that the cached model loaded. Registered
prompts are rebuilt from the unchanged reference WAV and transcript after a restart.

## Clone Prompt

Normal Sahaya preview and classroom generation always use `speaker-embedding`. It sets
`x_vector_only_mode=True`, so Qwen receives the speaker embedding but does not continue from the
reference speech codes or transcript.

The service retains internal support for `icl` regression testing. ICL sets
`x_vector_only_mode=False` and uses the exact saved enrollment transcript with the reference speech
codes. It can improve similarity, but Qwen's upstream
  [reference-tail echo issue](https://github.com/QwenLM/Qwen3-TTS/issues/341) can repeat the end
  of the enrollment recording before the requested text.

The service caches prompts in memory. Sahaya does not trim generated beginnings because the echo
duration is variable and fixed trimming can remove genuine narration words.

## Sahaya Configuration

```bash
QWEN3_TTS_PREVIEW_ENABLED=true
QWEN3_TTS_CLASSROOM_ENABLED=true
QWEN3_TTS_BASE_URL=http://127.0.0.1:8771
QWEN3_TTS_TIMEOUT_MS=180000
# Application-side exact-text chunk limit and bounded model service controls
# (defaults shown).
QWEN3_TTS_CHUNK_CHARACTERS=220
QWEN3_TTS_QUEUE_WAIT_SECONDS=30
QWEN3_TTS_MAX_PENDING=64
QWEN3_TTS_SYNTHESIS_DEADLINE_SECONDS=165
QWEN3_TTS_RESPONSE_GRACE_SECONDS=5
QWEN3_TTS_MAX_NEW_TOKENS=512
QWEN3_TTS_BUSY_MAX_RETRIES=1
QWEN3_TTS_BUSY_MAX_WAIT_MS=90000
```

Every profile-registration and synthesis request shares this one FIFO model
slot. Sahaya's in-process FIFO wait happens before the HTTP deadline begins.
The Python queue covers other application processes and has its own bounded
30-second admission wait. Keep `QWEN3_TTS_TIMEOUT_MS` above the service request
deadline so the service can return a useful `504` instead of leaving an
unobserved generation running after the adapter has stopped waiting.
The service caps queue wait at 30 seconds and its total synthesis deadline at
165 seconds even if stale deployment variables still contain larger values.

Narration over the configured chunk limit is split at sentence, clause, or word
boundaries without trimming or rewriting its characters. Chunk requests are
admitted separately for fairness. Their PCM16 WAV data is concatenated in the
original order without inserted silence, then Sahaya runs the requested
Resemble Enhance pass once on the complete result. No partial set of chunks is
persisted.

Each inference passes an explicit `max_new_tokens` cap and a wall-clock stopping
criterion to upstream Qwen generation. A deadline or disconnected caller asks
generation to stop at the next autoregressive step; partial audio is discarded.
Reaching the output-token cap is also treated as an incomplete result and its
partial waveform is discarded rather than enhanced or marked voiced.
The generation slot remains owned until the model call has actually returned.
A hard CUDA/kernel hang cannot be safely killed from the Python thread; that
case remains an operator-visible service fault rather than a falsely released
GPU lock.

The simplified homepage Teaching Voice workflow requires every relevant gate:
`QWEN3_TTS_PREVIEW_ENABLED=true`, `QWEN3_TTS_CLASSROOM_ENABLED=true`,
`VOICE_ENHANCEMENT_ENABLED=true`, `VOICE_ENHANCEMENT_PREVIEW_ENABLED=true`, and
`VOICE_ENHANCEMENT_CLASSROOM_ENABLED=true`. The profile is not marked ready if
enhancement fails, and classroom narration does not silently fall back to original
Qwen audio. Advanced comparison tools retain their explicit engine and output
selection behavior.

Enhanced is produced from the Qwen waveform. Unlike Chatterbox, the Qwen result is
not passed through the Chatterbox-specific EQ, silence removal, compression, or
loudness mastering preset before enhancement.

The service currently accepts English reference transcripts and English preview
text only. Sahaya deliberately uses the profile's reference language and saved
`referenceText`, not Chatterbox's separate synthesis-conditioning `languageId`.
Thus an English recording whose Chatterbox accent setting is `hi` remains valid
without rewriting profile metadata.

For new enrollments, Sahaya stores the server-owned paragraph text only when it exactly matches the
displayed enrollment phrase. This verifies the saved transcript contract, but it cannot prove that
the faculty member spoke every displayed word. Existing recordings should be checked manually when
comparing ICL because an acoustic/transcript mismatch can further reduce ICL quality.
