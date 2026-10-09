# Teaching Voice Chatterbox Voice-Cloning Service

This service is intentionally separate from the Next.js app. The application talks to it
through the voice-cloning provider interface and never imports Chatterbox,
PyTorch, or CUDA libraries.

## Start

```bash
cd services/voice-cloning
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
CHATTERBOX_T3_MODEL=v3 VOICE_CLONING_SERVICE_PORT=8765 python chatterbox_service.py
```

`setuptools<81` is required for the Perth/pkg_resources compatibility path used
by Chatterbox 0.1.7 in the tested HPC environment. Do not remove it unless the
installed Chatterbox/Perth versions are upgraded and startup is revalidated.

`CHATTERBOX_T3_MODEL` controls only the service default. Persisted Teaching Voice
profiles send their selected `v2` or `v3` model variant with each trusted
server-to-service request, so per-profile choice overrides the service default.

The installed `chatterbox-tts==0.1.7` package verified during development exposes
`ChatterboxMultilingualTTS.from_pretrained(device)` and hardcodes the V2 T3
checkpoint. Newer Chatterbox sources expose `from_pretrained(device,
t3_model="v3")`. The service uses that API when available and otherwise uses a
bounded compatibility loader for V3.

## Enrollment Audio

New Teaching Voice enrollments use one short teaching paragraph, targeting about ten
seconds of continuous natural speech. Existing profiles made with the older
three-recording flow remain compatible because they already point at a private
canonical `reference.wav`.

The Next.js app validates and preprocesses the uploaded paragraph before the
Chatterbox service sees it:

- rejects empty, too-short, too-long, too-quiet, mostly silent, clipped, or
  undecodable recordings with user-facing re-record guidance
- trims only leading and trailing silence
- applies conservative FFmpeg noise cleanup and loudness normalization
- stores a private mono 24 kHz PCM WAV reference

Processing settings live in `lib/voice-cloning/audio-validation.ts`. The denoise
and mastering filters are intentionally restrained: they improve reference
cleanliness and playback consistency, but they do not guarantee accent identity
or speaker similarity and must not be treated as voice conversion.

Generated Chatterbox preview and classroom/editor narration audio pass through
the same clarity mastering preset before the application stores or returns it:
a 70 Hz high-pass, gentle low-mid reduction, subtle presence lift, light
compression, loudness normalization, and peak limiting. IndicF5 keeps the
standard mastering preset. Export reuses generated audio and does not process it
again.

Set the Next.js app environment:

```bash
NEXT_PUBLIC_FEATURE_VOICE_CLONING=true
VOICE_CLONING_PROVIDER=chatterbox
VOICE_CLONING_BASE_URL=http://127.0.0.1:8765
```

Check health:

```bash
curl http://127.0.0.1:8765/health
```

Monitor GPU memory separately with `nvidia-smi` during enrollment and synthesis.
