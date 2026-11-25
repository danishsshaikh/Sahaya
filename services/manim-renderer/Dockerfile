# The publisher validates and stores media. Generated Python only runs in the separate sandbox image.
FROM manimcommunity/manim:v0.22.1@sha256:af29da8765a26ab1f9f1d61d401e95d50520753634ed8e343fd5c05283a459e7
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 1000 -g 1000 /artifacts /opt/sahaya-manim
WORKDIR /opt/sahaya-manim
COPY server.py native_contract.py native_artifact.py sandbox_client.py healthcheck.py ./
RUN chmod 0644 /opt/sahaya-manim/*.py
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
RUN test -r /opt/sahaya-manim/healthcheck.py
EXPOSE 8780
CMD ["python", "server.py"]
