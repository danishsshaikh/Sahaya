FROM manimcommunity/manim:v0.22.1@sha256:af29da8765a26ab1f9f1d61d401e95d50520753634ed8e343fd5c05283a459e7
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir jsonschema==4.26.0 attrs==25.4.0 jsonschema-specifications==2025.9.1 referencing==0.37.0 rpds-py==0.30.0 \
    && install -d -o 1000 -g 1000 /artifacts /opt/sahaya-manim
WORKDIR /opt/sahaya-manim
COPY *.py plan-v1.json ./
COPY fixtures ./fixtures
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 shell_escape=f openin_any=p openout_any=p
USER 1000:1000
EXPOSE 8780
CMD ["python", "server.py"]
