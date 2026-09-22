# IndicF5 Hindi And Marathi Teaching Voice

Independent FastAPI voice-cloning service for Hindi and Marathi Teaching Voice,
using `ai4bharat/IndicF5`. It is not integrated with Sahaya in this branch.
Future application callers use localhost HTTP; model libraries stay in Python.
There is no provider or model fallback.

## Runtime Compatibility

The supplied GPU proof of concept used Python 3.11 and the IndicF5 source commit
`13f7c4d627cc10111aea8fe9c0039462cacacdc7` (`f5_tts==0.1.0`), with
`torch==2.14.0+cu130`, `torchaudio==2.11.0+cu130`,
`torchcodec==0.16.0+cu130`, and `transformers==4.49.0`.

The Transformers 4.49.0 compatibility pin is mandatory: the tested 5.17.0
environment failed loading with a Vocos/torchaudio CPU/meta-device error.
The service uses `AutoModel.from_pretrained(..., trust_remote_code=True)`;
the remote implementation handles CUDA selection internally. It deliberately
does not call `model.to("cuda")`.

The [official model card](https://huggingface.co/ai4bharat/IndicF5) documents
Git installation and the callable model API. The requirements pin that Git
dependency to the supplied validated source commit and preserve
`torchcodec==0.16.0` and `transformers==4.49.0`. The Git commit pins the Python
package source, not the Hugging Face model's remote code or weights.

A compatible CUDA stack must be provided and checked on the GPU server; no
generic CUDA wheel URL or installation command is prescribed. The reported
Torch/torchaudio versions are observations from the supplied POC, not a tested
clean-install compatibility guarantee. HTTP/audio package versions in this
requirements file are reused from the supplied Qwen POC. Pydantic 2 and NumPy
are direct service dependencies. A fresh installation and this HTTP wrapper
have not been runtime validated. No packages or model artifacts need to be
installed or downloaded on the local Mac for authoring.

## Configuration And Startup

| Variable | Default | Meaning |
| --- | --- | --- |
| `INDICF5_MODEL` | `ai4bharat/IndicF5` | Compatible callable model |
| `INDICF5_SERVICE_HOST` | `127.0.0.1` | Localhost-only binding by default |
| `INDICF5_SERVICE_PORT` | `8772` | HTTP port |
| `CUDA_VISIBLE_DEVICES` | External process setting | Physical GPUs visible to the model |

Conceptual startup in a prepared, appropriate GPU server environment:

```bash
cd services/indicf5-voice-cloning
CUDA_VISIBLE_DEVICES=1 python service.py
```

Physical GPU 1 becomes logical `cuda:0`. No physical GPU ID is hardcoded.
Use one process with one worker because profiles and generation locks are
in memory. Arrange model access and acceptance of its conditions on the GPU
server before testing; never put credentials in the repository.

The first valid synthesis loads the model once and may download artifacts on
the GPU server. Health/profile requests do not load it. Loading failure remains
visible until restart, with no automatic retry or fallback. Service logs omit
full transcripts, narration, and raw exception messages. Review third-party
model output separately during GPU testing.

## API

`GET /health` returns `ok`, `provider`, `modelLoaded`, `modelLoading`, `model`,
`profileCount`, `modelLoadSeconds`, and a sanitized `error`. Before the first
synthesis, `ok` and `modelLoaded` are false, and load time/error are null.
HTTP 200 indicates reachability, not model readiness. Load time covers the
last attempt, including failures.

```bash
curl --fail-with-body http://127.0.0.1:8772/health
```

`POST /profiles` requires a server-local, readable, nonempty WAV and its exact
transcript. IDs are 1-128 ASCII letters, digits, underscores, or hyphens,
starting with a letter or digit. Language aliases `hi`/`Hindi` and `mr`/`Marathi`
are case-insensitive and normalized to `hi`/`mr`.

Replace each example path and transcript with the actual consented recording:

```bash
curl --fail-with-body http://127.0.0.1:8772/profiles \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"vcp_hindi","referenceAudioPath":"/path/to/hindi-reference.wav","referenceText":"Exact Hindi transcript spoken in the reference recording.","language":"hi"}'

curl --fail-with-body http://127.0.0.1:8772/profiles \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"vcp_marathi","referenceAudioPath":"/path/to/marathi-reference.wav","referenceText":"Exact Marathi transcript spoken in the reference recording.","language":"Marathi"}'
```

Returns `{"providerReferenceId":"vcp_hindi"}` or the requested Marathi ID.
Registering an existing ID replaces it. Files are not copied; keep reference
audio unchanged and available. The service enforces matching profile/target
language labels but cannot determine what was actually spoken in a recording.

`POST /synthesize` uses exactly the received narration text and registered
reference transcript, with no transliteration or whitespace rewriting.
The following JSON Unicode escapes decode into Devanagari narration:

```bash
curl --fail-with-body http://127.0.0.1:8772/synthesize \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"vcp_hindi","text":"\u0906\u091c \u0939\u092e \u0938\u0940\u0916\u0947\u0902\u0917\u0947\u0964","language":"hi"}' \
  --output indicf5-hindi.wav

curl --fail-with-body http://127.0.0.1:8772/synthesize \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"vcp_marathi","text":"\u0906\u091c \u0906\u092a\u0923 \u0936\u093f\u0915\u0923\u093e\u0930 \u0906\u0939\u094b\u0924.","language":"mr"}' \
  --output indicf5-marathi.wav
```

Success returns `Content-Type: audio/wav`, mono PCM16. The tested bare waveform
API uses 24 kHz. Explicit `(audio, sample_rate)` output or a model
`target_sample_rate` attribute takes precedence when available. Invalid/empty
or nonfinite waveforms are rejected. Check HTTP status before using the output
as WAV. Generation is serialized; overlapping requests receive 429 without a
queue. Logs include profile ID, language, text character count, generation
seconds, output seconds, and RTF (generation seconds / output seconds).
Timing includes serialization but excludes model loading/reference validation.

`DELETE /profiles/{profile_id}` removes only the in-memory profile:

```bash
curl --fail-with-body -X DELETE http://127.0.0.1:8772/profiles/vcp_hindi
```

Returns `{"ok":true}`, even if the valid ID was already absent. Reference files
are never deleted. An in-flight synthesis retains its profile snapshot.

## Quality And Text Preparation

The supplied experiments found English references poor for Hindi synthesis;
native Hindi and native Marathi references produced good same-language results,
including long-form narration. Exact reference transcripts are required.

Raw Latin English technical words embedded in Devanagari can synthesize poorly.
Callers should normalize those technical terms into appropriate Devanagari
phonetic forms. This normalization belongs to a future caller/application
TTS-only layer; displayed lesson text should stay untouched. This service does
NOT alter incoming narration text or implement transliteration.

Inference is currently slower than real time on the tested T4 configuration.
One Hindi test measured approximately RTF 5.28. One long-form Marathi output
was 90.579 seconds, mono PCM16 at 24 kHz. These are supplied POC observations,
not measurements of this wrapper or throughput guarantees. No performance
optimization is included.

## Errors And Limitations

- 422: missing/invalid fields, blank transcript/text, unsupported language.
- 400: invalid reference WAV/deletion ID or mismatched target/reference language.
- 404: unknown synthesis profile.
- 429: generation already in progress.
- 503: missing audio dependency or model-load failure; inspect health.
- 500: generation or WAV serialization failed; no fallback is attempted.

Profiles disappear on restart. There is no authentication, file upload,
enrollment UI, persistent profile store, text splitting, queue, or application
routing. This is a trusted localhost service: callers manage enrollment consent
and file access. Do not expose it directly to untrusted clients.
