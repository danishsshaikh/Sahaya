# syntax=docker/dockerfile:1.7

# The official Ming source is supplied as the `ming-source` BuildKit context.
# Keeping it outside this repository makes the exact upstream revision an
# explicit operator choice and prevents runtime source/model downloads.
ARG TTS_CUDA_BASE_IMAGE=pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime
FROM ${TTS_CUDA_BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/opt/ming3-tts

RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      libsndfile1 \
      python3-dev && \
    rm -rf /var/lib/apt/lists/*

COPY --from=ming-source / /opt/ming3-tts
RUN test -f /opt/ming3-tts/requirements.txt && \
    python -m pip install --no-cache-dir -r /opt/ming3-tts/requirements.txt

WORKDIR /srv/sahaya/ming3-tts
COPY services/ming3-tts/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY services/ming3-tts/conditioning.py services/ming3-tts/service.py ./

EXPOSE 8773
CMD ["python", "service.py"]
