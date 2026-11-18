# Deploy Sahaya with Docker

Docker remains the simplest option for a developer workstation or institution already operating
Docker Engine. It is independent of the Podman deployment.

## Prerequisites

- Docker Engine with Compose v2.
- For optional GPU profiles: an NVIDIA driver, NVIDIA Container Toolkit, and an explicitly allocated
  device visible to Docker.
- Model files and pinned upstream source checkouts for every selected local model.

## Basic, no-GPU deployment

```bash
cp .env.example .env
chmod 600 .env
# Configure a hosted LLM and any hosted speech providers in .env.
scripts/deployment-preflight.sh --runtime docker --mode basic
docker compose config --quiet
docker compose up --build --wait
```

Only `openmaic` starts by default. Its host port binds to `127.0.0.1:3000` unless changed.

## Optional profiles

```bash
# Ming only
docker compose --profile gpu-ming up --build --wait

# Local Gemma and Ming
docker compose --profile gpu-gemma --profile gpu-ming up --build --wait

# Full local model set
docker compose --profile gpu-gemma --profile gpu-ming --profile gpu-qwen up --build --wait

# Add either optional subsystem when required
docker compose --profile server-persistence --profile video-export up --build --wait
```

Use `GEMMA_GPU_DEVICE`, `MING3_GPU_DEVICE`, and `QWEN3_TTS_GPU_DEVICE` to select only allocated
devices. Docker Compose accepts device IDs supported by the installed NVIDIA runtime; use UUIDs when
the host/runtime supports them and university IT assigns by UUID. Never select all GPUs on a shared
server.

The root README contains the model download commands and exact mount variables. The model services
publish no host ports and are reachable only through Compose DNS on the internal inference network.

Run preflight with the equivalent mode before each configuration:

```bash
scripts/deployment-preflight.sh --runtime docker --mode ming
scripts/deployment-preflight.sh --runtime docker --mode gemma-ming
scripts/deployment-preflight.sh --runtime docker --mode full
```

Docker mode 5 is not a single all-model command: select only profiles that match allocated hardware.
For example, a Docker equivalent of Podman's `gemma-ming` mode is:

```bash
docker compose --profile gpu-gemma --profile gpu-ming up --build --wait
docker compose exec openmaic wget -qO- http://llama-gemma:8080/health
docker compose exec openmaic wget -qO- http://ming3-tts:8773/health
```

## Operations

```bash
docker compose ps
docker compose logs --tail=100 openmaic
docker compose restart openmaic
docker compose stop
docker compose start
docker compose up --build --wait
```

`docker compose down` removes containers and networks but retains named volumes. Do not add `-v`
unless permanent deletion of Sahaya data and PostgreSQL storage is explicitly intended.

## Validation boundary

The repository validates Compose structure, feature build arguments, private networking, health
checks, and persistent mounts. GPU image/CUDA/model compatibility still requires testing on the
target Linux/NVIDIA host. A successful YAML render is not a successful inference test.
