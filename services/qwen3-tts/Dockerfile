# syntax=docker/dockerfile:1.7

# The validated Qwen source checkout is supplied as the `qwen-source` BuildKit
# context. The service itself enforces local_files_only=True, so the model must
# also be mounted at runtime and can never be fetched implicitly.
ARG TTS_CUDA_BASE_IMAGE=pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime
FROM ${TTS_CUDA_BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      libsndfile1 \
      python3-dev && \
    rm -rf /var/lib/apt/lists/*

COPY --from=qwen-source / /opt/qwen3-tts
RUN test -f /opt/qwen3-tts/pyproject.toml -o -f /opt/qwen3-tts/setup.py && \
    python -m pip install --no-cache-dir -e /opt/qwen3-tts

WORKDIR /srv/sahaya/qwen3-tts
COPY services/qwen3-tts/service.py ./service.py

EXPOSE 8771
CMD ["python", "service.py"]
