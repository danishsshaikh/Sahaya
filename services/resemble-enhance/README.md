# Resemble Enhance worker

Sahaya uses the official MIT-licensed
[`resemble-ai/resemble-enhance`](https://github.com/resemble-ai/resemble-enhance) implementation as
an optional second-stage processor for Chatterbox WAV output. The worker is a persistent child
process connected to the Sahaya server over stdin/stdout. It does not open another TCP port.

## Isolation and installation

Use a dedicated Python 3.10 or 3.11 virtual environment. Do not install this dependency into the
working Chatterbox environment or change Chatterbox's Torch/CUDA packages.

```bash
python3.10 -m venv /opt/sahaya/resemble-enhance-venv
/opt/sahaya/resemble-enhance-venv/bin/pip install --upgrade pip
# Install the CUDA-specific torch and torchaudio wheels approved for the target host first.
/opt/sahaya/resemble-enhance-venv/bin/pip install -r services/resemble-enhance/requirements.txt
```

The requirements file pins official Resemble Enhance source commit
`8e978149bfe8abab3eb77d965d579a111afdb0ff`. Its upstream requirements specify Python 3.10+,
Torch/Torchaudio 2.1.1+, DeepSpeed 0.12.4+, and the associated scientific Python stack. Record the
target host's exact CUDA-specific `pip freeze` after installation. Model artifacts are downloaded by
the official loader into its user cache; they must not be stored in this repository.

## Readiness check

```bash
/opt/sahaya/resemble-enhance-venv/bin/python \
  services/resemble-enhance/worker.py --device cuda --health
```

Success prints one JSON line with `"event":"healthy"` and `"modelLoaded":true`. Run this before
enabling Sahaya so the model download and load happen during an approved deployment window.

## Activation

Set `VOICE_ENHANCEMENT_ENABLED=true`, point `RESEMBLE_ENHANCE_PYTHON` at the isolated interpreter,
and leave `VOICE_ENHANCEMENT_MAX_CONCURRENCY=1`. Preview comparison is enabled independently with
`VOICE_ENHANCEMENT_PREVIEW_ENABLED`. Classroom narration additionally requires
`VOICE_ENHANCEMENT_CLASSROOM_ENABLED=true` and a faculty profile whose saved mode is Enhanced.

Hindi and English-text/Hindi-synthesis enhancement remain disabled unless
`VOICE_ENHANCEMENT_HINDI_ENABLED=true`. Enhancement never changes the Chatterbox language or text.

For immediate rollback, set `VOICE_ENHANCEMENT_ENABLED=false` and restart only the Sahaya
application process during an approved deployment. Standard Chatterbox mastering remains the
automatic per-clip fallback for worker startup, timeout, inference, validation, or mastering errors.

## Scheduling and diagnostics

The default worker pool has one warm process and one in-flight enhancement. Classroom clips run in
the existing concurrency-one Teaching Voice queue, which serializes each clip's complete synthesis
and enhancement job. Enrollment previews use a separate request path and can overlap a classroom
job, so verify combined VRAM use before enabling previews for a live deployment. A timeout sends
SIGTERM and then SIGKILL if required; the next request receives a fresh worker.

Search application logs for `[VoiceEnhancement]` and `[VoiceEnhancementWorker]`. Completion logs
include inference and total latency. Bypass logs include the failure reason while narration returns
the original mastered Chatterbox clip. Confirm Chatterbox separately through its existing `/health`
endpoint and generate one standard preview after enabling the worker.

Do not raise enhancement concurrency or enable classroom/Hindi processing until latency, VRAM,
pronunciation, accent, and speaker similarity have been evaluated on the target GPU.
