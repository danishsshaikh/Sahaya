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
```

Resemble Enhanced comparison additionally follows the existing preview gates:
`VOICE_ENHANCEMENT_ENABLED=true` and `VOICE_ENHANCEMENT_PREVIEW_ENABLED=true`.
`VOICE_ENHANCEMENT_CLASSROOM_ENABLED` remains independent and can stay `false`.
Set it to `true` only when faculty should be able to select Enhanced Qwen audio for classroom
narration. Original Qwen classroom audio does not require Resemble Enhance.

Qwen Original remains the selected preview by default. Enhanced is produced from the same Qwen
waveform and remains optional. Unlike Chatterbox, Qwen's enhanced result is not passed through the
Chatterbox-specific EQ, silence removal, compression, or loudness mastering preset.

The service currently accepts English reference transcripts and English preview
text only. Sahaya deliberately uses the profile's reference language and saved
`referenceText`, not Chatterbox's separate synthesis-conditioning `languageId`.
Thus an English recording whose Chatterbox accent setting is `hi` remains valid
without rewriting profile metadata.

For new enrollments, Sahaya stores the server-owned paragraph text only when it exactly matches the
displayed enrollment phrase. This verifies the saved transcript contract, but it cannot prove that
the faculty member spoke every displayed word. Existing recordings should be checked manually when
comparing ICL because an acoustic/transcript mismatch can further reduce ICL quality.
