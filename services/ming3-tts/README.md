# Ming 3.0 TTS 0.5B preview service

This is an isolated, loopback-only service for experimental English Teaching Voice previews. It
uses the official `inclusionAI/Ming-3.0-tts-0.5b` inference implementation and does not alter the
Qwen3-TTS or Chatterbox environments.

Ming is not a raw-audio path. The official runtime decodes the reference with SoundFile and
downmixes/resamples it for conditioning. The service does not overwrite the saved reference. Its
output is the WAV written by the official runtime, with no Sahaya enhancement, normalization,
transcoding, or other post-processing.

Two internal conditioning modes are supported:

- `acoustic-reference` (default): the official prompt WAV + transcript path. Upstream creates both
  VAE prompt latents and a CAMPPlus speaker embedding.
- `speaker-embedding-only`: extracts the official 192-dimensional CAMPPlus embedding once, stores
  it privately under `MING3_TTS_EMBEDDING_ROOT` (by default beneath the private reference root), and
  calls upstream with `spk_emb_path` only. No prompt WAV or reference transcript is passed to
  synthesis, so upstream leaves `prompt_latent` and `prompt_text` as `None`.

The default intentionally remains `acoustic-reference` until an authorized listener confirms that
speaker-only conditioning removes the observed leakage without unacceptable similarity loss. After
that validation, set `MING3_TTS_CONDITIONING_MODE=speaker-embedding-only` in both the Sahaya server
and this service. This is an internal deployment setting, not a user-facing toggle. Cache keys
separate the two modes; existing acoustic previews remain restorable.

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
MING3_TTS_EMBEDDING_ROOT=/path/to/private/ming-speaker-embeddings \
MING3_TTS_CONDITIONING_MODE=acoustic-reference \
MING3_TTS_DEVICE=cuda:0 \
python service.py
curl --fail http://127.0.0.1:8773/health
```

Then configure Sahaya with `MING3_TTS_PREVIEW_ENABLED=true` and the loopback service URL. The app
registers only an owner-scoped opaque profile ID, sends one English synthesis request, and stores the
returned WAV only in the existing owner-scoped comparison cache. The reference transcript and
preview text are not written to service logs.

The service deliberately uses the official TTS defaults (`cfg=2`, `sigma=0.25`, `temperature=0`,
trailing-silence trim enabled) and `raw_text=True` for a single direct request. Those settings are
explicitly identical in both conditioning modes. Do not attribute warbling to CFG, VAE decoding,
or PyTorch SDPA without an A/B result. The upstream 0.5B documentation says FlashAttention is
optional and SDPA is supported, so installing FlashAttention is not a prerequisite for this test.
A real GPU test must use an authorized faculty recording and should record peak VRAM, model load
time, synthesis latency, and audio duration without committing the recording, embedding, weights,
or output.

After the service is healthy, run exactly one explicit test. Keep both paths outside the repository:

```bash
python /path/to/Sahaya/services/ming3-tts/smoke_test.py \
  --reference /private/authorized/reference.wav \
  --reference-text 'The exact authorized reference transcript.' \
  --text "Newton's first law states that an object remains at rest unless acted upon by an external force." \
  --conditioning-mode compare \
  --output /private/ming-test/output.wav
```

Comparison mode creates `output.acoustic-reference.wav` and
`output.speaker-embedding-only.wav`; it refuses to overwrite either file. Both use the exact same
reference, reference transcript, target text, checkpoint, official generation settings, and WAV
output format. Listen blind if possible and record separately: (1) any reference phrase/audio at the
start, (2) speaker similarity, (3) pronunciation, and (4) continuous warbling. Do not trim or
post-process either file. If speaker-only fixes leakage but warbling remains in both variants, retain
the official generation defaults and report the artifact as a likely model/reference/runtime issue
until a controlled model-authorized parameter study exists.

Run `nvidia-smi` in a separate terminal before model load and during synthesis. Do not stop or
restart a shared process for this comparison. The script reports synthesis latency and audio
duration. Listening quality remains subjective and must not be presented as an objective benchmark.
