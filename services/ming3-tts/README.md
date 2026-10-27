# Ming 3.0 TTS 0.5B preview service

This is an isolated, loopback-only service for experimental English Teaching Voice previews. It
uses the official `inclusionAI/Ming-3.0-tts-0.5b` inference implementation and does not alter the
Qwen3-TTS or Chatterbox environments.

Ming is not a raw-audio path. The official runtime decodes the reference with SoundFile, downmixes
multi-channel input, resamples it to 16 kHz for speaker embeddings and the model sample rate for
prompt latents, and front-pads it for model alignment. The service does not overwrite the saved
reference. Its output is the WAV written by the official runtime, with no Sahaya enhancement,
normalization, transcoding, or other post-processing.

## Isolated setup

Run these commands in an operator-selected external directory, not inside the Sahaya repository.
Check GPU capacity and other users' processes first.

```bash
nvidia-smi
mkdir -p /srv/sahaya-models/ming3
cd /srv/sahaya-models/ming3
git clone https://github.com/inclusionAI/Ming-3.0-tts.git source
python3.10 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r source/requirements.txt
pip install -r /path/to/Sahaya/services/ming3-tts/requirements.txt
HF_HOME=/srv/sahaya-models/huggingface \
  hf download inclusionAI/Ming-3.0-tts-0.5b --local-dir model
```

The official project currently documents successful testing on H800 80 GB and H20 96 GB hardware,
but does not publish a minimum or expected VRAM figure for the 0.5B model. Do not infer VRAM from the
checkpoint download size. Measure it on an otherwise safely available GPU.

## Start and validate

Select an idle GPU without changing global CUDA configuration. Process-scoped
`CUDA_VISIBLE_DEVICES` remaps that GPU to `cuda:0` inside this one service.

```bash
cd /path/to/Sahaya/services/ming3-tts
source /srv/sahaya-models/ming3/venv/bin/activate
CUDA_VISIBLE_DEVICES=<safe-gpu-index> \
MING3_TTS_REPOSITORY_DIR=/srv/sahaya-models/ming3/source \
MING3_TTS_MODEL=/srv/sahaya-models/ming3/model \
MING3_TTS_REFERENCE_ROOT=/path/to/private/voice-cloning-storage \
MING3_TTS_DEVICE=cuda:0 \
python service.py
curl --fail http://127.0.0.1:8773/health
```

Then configure Sahaya with `MING3_TTS_PREVIEW_ENABLED=true` and the loopback service URL. The app
registers only an owner-scoped opaque profile ID, sends one English synthesis request, and stores the
returned WAV only in the existing owner-scoped comparison cache. The reference transcript and
preview text are not written to service logs.

The service deliberately uses the official TTS defaults (`cfg=2`, `sigma=0.25`, `temperature=0`,
trailing-silence trim enabled) and `raw_text=True` for a single direct request. A real GPU test must
use an authorized faculty recording and should record peak VRAM, model load time, synthesis latency,
and audio duration without committing the recording, weights, or output.

After the service is healthy, run exactly one explicit test. Keep both paths outside the repository:

```bash
python /path/to/Sahaya/services/ming3-tts/smoke_test.py \
  --reference /private/authorized/reference.wav \
  --reference-text 'The exact authorized reference transcript.' \
  --text "Newton's first law states that an object remains at rest unless acted upon by an external force." \
  --output /private/ming-test/output.wav
```

Run `nvidia-smi` in a separate terminal before model load, during synthesis, and after stopping only
this Ming process. The script reports synthesis latency and audio duration. Listening quality remains
subjective and must not be presented as an objective benchmark.
