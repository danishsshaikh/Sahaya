# Indic Parler-TTS Experimental Service

## What This Is

This is an isolated FastAPI service for evaluating
`ai4bharat/indic-parler-tts` as a multilingual, descriptive normal TTS provider
for Sahaya.

It is intended for manual server-side GPU testing before any product
integration.

## What This Is Not

- It does not replace Kokoro.
- It does not replace Chatterbox.
- It does not perform voice cloning.
- It is not wired into Sahaya narration, provider routing, settings, or UI.

## Current Architecture

```text
Kokoro
-> existing normal TTS

Chatterbox
-> Teaching Voice cloning

Indic Parler-TTS
-> isolated experimental multilingual/descriptive normal TTS
```

## Server Requirements

- Python environment
- Compatible PyTorch/CUDA install for the target GPU server
- Hugging Face access accepted for `ai4bharat/indic-parler-tts`
- Hugging Face authentication configured on the server
- Model download on first server-side load
- GPU strongly recommended

Do not place Hugging Face tokens in source code, this README, shell history, or
committed environment files.

## Service API

### `GET /health`

Returns safe service state:

```json
{
  "status": "ok",
  "service": "indic-parler-tts",
  "model": "ai4bharat/indic-parler-tts",
  "model_loaded": false
}
```

`model_loaded` changes to `true` after the model has loaded in this process.

### `POST /synthesize`

Request:

```json
{
  "text": "Today we are going to learn how transformers work.",
  "description": "An Indian English teacher speaks clearly at a moderate pace with a calm and engaging delivery. The recording is clean and close."
}
```

Response:

```text
Content-Type: audio/wav
```

The service keeps `text` and `description` separate. Speaker, delivery, pitch,
pace, expressivity, accent, and recording-quality experiments should be written
in `description`, following the model card examples.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `INDIC_PARLER_TTS_HOST` | `127.0.0.1` | Bind host |
| `INDIC_PARLER_TTS_PORT` | `8770` | Development default port; override on the server |
| `INDIC_PARLER_DEVICE` | `auto` | `auto`, `cpu`, `cuda`, or a CUDA device string controlled by the process environment |
| `INDIC_PARLER_DTYPE` | `auto` | `auto`, `float32`, `float16`, or `bfloat16` |
| `INDIC_PARLER_MAX_TEXT_CHARS` | `4000` | Maximum transcript length |
| `INDIC_PARLER_MAX_DESCRIPTION_CHARS` | `1200` | Maximum voice description length |
| `INDIC_PARLER_LOG_LEVEL` | `INFO` | Python log level |

Do not hardcode a physical GPU number in this service. Use
`CUDA_VISIBLE_DEVICES` outside the process to expose the desired GPU, then use
`INDIC_PARLER_DEVICE=cuda` or leave it as `auto`.

## Startup

From a pulled server worktree:

```bash
cd services/indic-parler-tts
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Accept the Hugging Face model access conditions for
`ai4bharat/indic-parler-tts`, authenticate on the server using the operator's
approved Hugging Face mechanism, then start the service:

```bash
CUDA_VISIBLE_DEVICES=<gpu> \
INDIC_PARLER_TTS_PORT=<port> \
INDIC_PARLER_DEVICE=cuda \
python service.py
```

The model is loaded lazily on the first `/synthesize` call. The first synthesis
may download model files into the server's Hugging Face cache.

## Smoke Tests

Health:

```bash
curl http://127.0.0.1:<port>/health
```

English:

```bash
curl -X POST http://127.0.0.1:<port>/synthesize \
  -H 'Content-Type: application/json' \
  --data '{"text":"Today we are going to learn how transformers work.","description":"An Indian English teacher speaks clearly at a moderate pace with a calm and engaging delivery. The recording is clean and close."}' \
  --output /tmp/indic-parler-english.wav
```

Hindi:

```bash
curl -X POST http://127.0.0.1:<port>/synthesize \
  -H 'Content-Type: application/json' \
  --data '{"text":"आज हम ट्रांसफॉर्मर मॉडल कैसे काम करते हैं यह समझेंगे।","description":"A Hindi teacher speaks clearly at a moderate pace with a calm classroom delivery. The recording is clean and close."}' \
  --output /tmp/indic-parler-hindi.wav
```

Marathi:

```bash
curl -X POST http://127.0.0.1:<port>/synthesize \
  -H 'Content-Type: application/json' \
  --data '{"text":"आज आपण ट्रान्सफॉर्मर मॉडेल कसे काम करते ते शिकणार आहोत.","description":"A Marathi teacher speaks clearly at a moderate pace with an engaging classroom delivery. The recording is clean and close."}' \
  --output /tmp/indic-parler-marathi.wav
```

## Later Server Test Workflow

Pull the branch, create an isolated Python environment, install requirements,
authorize Hugging Face access, choose a GPU with `CUDA_VISIBLE_DEVICES`, start
the service, run `/health`, synthesize WAV files, measure VRAM before and after
model load, measure cold and warm latency, measure real-time factor, and listen
for English, Indian-English, Hindi, Marathi, technical vocabulary, numbers,
acronyms, and long narration stability.

Do not change Kokoro while running these experiments.
