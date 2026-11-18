# Sahaya container deployment: getting started

Sahaya turns a topic or document into an interactive classroom with slides, activities, narration,
and optional authorized Teaching Voice cloning. The same repository supports Docker and Podman;
neither runtime depends on the other.

## Choose a deployment mode

| Mode | Application | LLM | Teaching Voice | Local GPU services |
| --- | --- | --- | --- | --- |
| `basic` | Sahaya | Hosted provider, including Nemotron | Hosted providers if configured | None |
| `ming` | Sahaya | Hosted provider | Ming (default for new English profiles) | Ming |
| `gemma-ming` | Sahaya | Local Gemma and/or hosted tiers | Ming | Gemma + Ming |
| `full` | Sahaya | Local Gemma and optional hosted tiers | Ming + Qwen | Gemma + Ming + Qwen |

PostgreSQL and video rendering are optional. No mode starts every GPU model implicitly.

## Common preparation

```bash
git clone https://github.com/danishsshaikh/Sahaya.git
cd Sahaya
cp .env.example .env
chmod 600 .env
```

Edit `.env`. For the easiest no-GPU setup, configure one hosted LLM. The Sahaya router supports the
verified sequence `primary -> optional secondary -> fallback`; all three configured roles are
OpenAI-compatible endpoints. When `LLM_ROUTER_ENABLED=true`, the fallback model and base URL are
required even if the primary is healthy.

Hosted Nemotron example:

```env
LLM_ROUTER_ENABLED=true
LLM_ROUTER_PRIMARY_MODEL=openai:nvidia/nemotron-3-ultra-550b-a55b
LLM_ROUTER_PRIMARY_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_ROUTER_PRIMARY_API_KEY=replace-on-the-server
LLM_ROUTER_PRIMARY_LOCAL=false

LLM_ROUTER_SECONDARY_MODEL=openai:nvidia/nemotron-3-super-120b-a12b
LLM_ROUTER_SECONDARY_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_ROUTER_SECONDARY_API_KEY=replace-on-the-server
LLM_ROUTER_SECONDARY_LOCAL=false

# Required final tier. This example deliberately uses the hosted Super endpoint.
LLM_ROUTER_FALLBACK_MODEL=openai:nvidia/nemotron-3-super-120b-a12b
LLM_ROUTER_FALLBACK_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_ROUTER_FALLBACK_API_KEY=replace-on-the-server
LLM_ROUTER_FALLBACK_LOCAL=false
```

Credential values are server-only. Never place them in `NEXT_PUBLIC_*` variables or build arguments.

## Option A: Docker

```bash
scripts/deployment-preflight.sh --runtime docker --mode basic
docker compose config --quiet
docker compose up --build --wait
curl --fail http://127.0.0.1:3000/api/health
```

See [DEPLOY_WITH_DOCKER.md](DEPLOY_WITH_DOCKER.md) for local models and profiles.

## Option B: Podman

Podman is the recommended path for a rootless university Linux account. It uses native Podman
commands for GPU services instead of depending on an external Compose provider.

```bash
deploy/podman/sahaya-podman --mode basic preflight
deploy/podman/sahaya-podman --mode basic build
deploy/podman/sahaya-podman --mode basic start
deploy/podman/sahaya-podman status
curl --fail http://127.0.0.1:3000/api/health
```

See [DEPLOY_WITH_PODMAN.md](DEPLOY_WITH_PODMAN.md) and the
[university administrator guide](UNIVERSITY_DEPLOYMENT.md).

## First functional checks

1. Open `http://127.0.0.1:3000`.
2. Sign in and generate one short classroom with the configured LLM.
3. For a GPU voice mode, wait until the Ming health response reports `ok: true` and
   `modelLoaded: true`.
4. Record or upload only authorized reference audio, create a Teaching Voice, and generate one short
   narration preview.
5. Do not call paid providers or create remote voice clones merely to test container startup.

Passing configuration or health checks does not prove acceptable model latency, pronunciation,
speaker similarity, or GPU capacity. Those require an explicit authorized live test.
