# Qwen3 English Teaching Voice

Independent FastAPI voice-cloning service for English Teaching Voice only, using
`Qwen/Qwen3-TTS-12Hz-0.6B-Base`. This branch does not integrate the service with
Sahaya. Future callers communicate over localhost HTTP; Next.js never imports
the model libraries. There is no model or provider fallback.

## Runtime Compatibility

The supplied GPU proof of concept used Python 3.11.15, `qwen-tts==0.1.1`,
`torch==2.14.0+cu130`, `fastapi==0.141.1`, `uvicorn==0.53.0`, and
`soundfile==0.14.0`. The validated Qwen3-TTS source checkout was
`bc0e9c715411758c2e0f4709275201bf27de931b`; it is not vendored here.

The Tesla T4 validated path currently uses FP32. FP16 was unstable in testing
(NaN/Inf probabilities and CUDA assertions). This service fixes the model dtype
to `torch.float32`, with `attn_implementation=None`. It does not offer FP16,
BF16, quantization, or optimization switches. `flash-attn` is not required for
correctness. SoX warnings did not prevent the tested generation path, so SoX
is not a mandatory service dependency.

`requirements.txt` records the known package versions. A compatible CUDA
PyTorch build must already be supplied by the GPU runtime environment; no
generic CUDA wheel command is prescribed. Pydantic 2 and NumPy are direct
service dependencies, with no experimentally established exact pins supplied.
A fresh plain-pip installation and this HTTP wrapper have not been runtime
validated. Dependency installation, model downloads, and inference belong to
the later isolated GPU test, not the local Mac authoring workflow.

## Configuration And Startup

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWEN3_TTS_MODEL` | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | Compatible Base voice-cloning model |
| `QWEN3_TTS_SERVICE_HOST` | `127.0.0.1` | Localhost-only binding by default |
| `QWEN3_TTS_SERVICE_PORT` | `8771` | HTTP port |
| `QWEN3_TTS_DEVICE` | `cuda:0` | Logical device passed to the model loader |
| `CUDA_VISIBLE_DEVICES` | External process setting | Physical GPUs exposed to the process |

Conceptual startup in a prepared, appropriate GPU server environment:

```bash
cd services/qwen3-voice-cloning
CUDA_VISIBLE_DEVICES=1 python service.py
```

Here physical GPU 1 becomes logical `cuda:0`. The service does not select a
physical GPU. Run one process with one worker: profiles and locks are in memory.
No service or model should be started on the local Mac for this task.

The first valid synthesis loads the model once and may download model artifacts
on that GPU server. Health/profile requests do not load it. Load failure is
latched and reported until restart; there is no automatic retry or fallback.
The service's logs omit narration, reference transcripts, and raw exception
messages. Third-party model output should also be reviewed during GPU testing.

## API

`GET /health` returns `ok`, `provider`, `modelLoaded`, `modelLoading`, `model`,
`device`, `dtype`, `profileCount`, `modelLoadSeconds`, and a sanitized `error`.
Before the first synthesis, `ok` and `modelLoaded` are false, and load time/error
are null. HTTP 200 means the service is reachable; inspect `ok` for readiness.
Model-load timing covers the last load attempt, including a failed attempt.

```bash
curl --fail-with-body http://127.0.0.1:8771/health
```

`POST /profiles` registers an existing, readable, nonempty WAV and its exact
reference transcript. Supply a server-local path; URLs and audio uploads are
not accepted. IDs are 1-128 ASCII letters, digits, underscores, or hyphens,
starting with a letter or digit. `en` and `English` are accepted, case-insensitively.
The caller must supply an accurate transcript and an English reference; the
service cannot verify what language was actually spoken.

Replace the example path and transcript with a real, consented recording:

```bash
curl --fail-with-body http://127.0.0.1:8771/profiles \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"vcp_example","referenceAudioPath":"/path/to/reference.wav","referenceText":"Exact transcript of the enrollment recording.","language":"en"}'
```

Response: `{"providerReferenceId":"vcp_example"}`. Re-registering the same ID
replaces its in-memory registration. The reference is not copied; keep the
file unchanged and accessible for the lifetime of the profile.

`POST /synthesize` uses the registered audio and exact transcript for full ICL
cloning: `x_vector_only_mode=False`, `language="English"`. Narration and
transcript are checked for blank content but are otherwise passed unchanged.

```bash
curl --fail-with-body http://127.0.0.1:8771/synthesize \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"vcp_example","text":"Today we will study neural networks.","language":"en"}' \
  --output qwen3-example.wav
```

Success returns `Content-Type: audio/wav`, mono PCM16, at the authoritative
sample rate returned by Qwen. Check the HTTP status before treating output as
WAV. The service rejects empty/nonfinite waveforms. Generation is serialized;
overlapping requests receive 429, without a queue. Logs report profile ID,
language, text character count, generation seconds, output seconds, and RTF
(generation seconds / output seconds). Timing includes WAV serialization but
excludes model loading and reference validation.

`DELETE /profiles/{profile_id}` removes registration, not the audio file:

```bash
curl --fail-with-body -X DELETE http://127.0.0.1:8771/profiles/vcp_example
```

Response: `{"ok":true}`, including when the valid ID was already absent.
An in-flight synthesis retains its profile snapshot and may finish after deletion.

## Errors And Limitations

- 422: missing/invalid request fields, blank text/transcript, unsupported language.
- 400: invalid reference file, invalid deletion ID, or reference-language mismatch.
- 404: unknown synthesis profile.
- 429: generation already in progress.
- 503: unavailable audio dependency or model-load failure; inspect health.
- 500: generation or WAV serialization failed; no fallback is attempted.

Profiles disappear on restart. There is no enrollment UI, storage integration,
authentication, text splitting, retry queue, or application routing here.
This is a trusted localhost service; callers control enrollment consent and
file access. Do not expose it directly to untrusted clients.
