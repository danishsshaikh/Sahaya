# Deploy Sahaya with Podman

This is the first-class path for a university Linux server that already uses Podman. Docker and a
Compose provider are not required. Sahaya uses native Podman commands because `podman compose` is a
wrapper around an external provider and GPU/CDI feature support depends on that provider.

## Prerequisites

- Linux with Podman 4.4 or newer; current Podman 5.x is recommended.
- Rootless subuid/subgid configuration and cgroup v2.
- A user-writable persistent directory.
- For GPU modes: university-installed NVIDIA driver and NVIDIA Container Toolkit with CDI.
- Pinned model source checkouts and downloaded checkpoints.

Check the host without changing it:

```bash
podman --version
podman info --format '{{.Host.CgroupsVersion}}'
scripts/deployment-preflight.sh --runtime podman --mode basic
```

## NVIDIA CDI

NVIDIA recommends CDI for Podman. With NVIDIA Container Toolkit 1.18+, the administrator-managed
`nvidia-cdi-refresh` service normally creates `/var/run/cdi/nvidia.yaml`. A developer should only
inspect it:

```bash
nvidia-ctk cdi list
nvidia-ctk --debug cdi list
```

University IT—not an unprivileged Sahaya setup script—must install drivers/toolkit, repair CDI, or
restart `nvidia-cdi-refresh.service`. Select one explicit device per service in `.env`:

```env
PODMAN_GEMMA_GPU_DEVICE=nvidia.com/gpu=0
PODMAN_MING_GPU_DEVICE=nvidia.com/gpu=1
PODMAN_QWEN_GPU_DEVICE=nvidia.com/gpu=2
```

These are examples only. Use names actually returned by `nvidia-ctk cdi list`; a stable GPU UUID is
preferable when the CDI list exposes it. The preflight rejects `nvidia.com/gpu=all`.

To verify visibility inside a container, explicitly pull or pre-approve the configured small CUDA
probe image, then run:

```bash
podman pull docker.io/nvidia/cuda:12.4.1-base-ubuntu22.04
deploy/podman/sahaya-podman --mode ming gpu-check
```

`gpu-check` uses `--pull=never` and tests only configured CDI devices. Pin an image digest through
`NVIDIA_CUDA_PROBE_IMAGE` when institutional policy requires immutable image inputs.

On SELinux hosts the native launcher disables label separation only for NVIDIA GPU containers,
matching NVIDIA's documented Podman CDI example. Application data mounts use shared relabeling.
Do not change global SELinux policy automatically. If device access depends on a supplementary
group and the host uses `crun`, university IT may approve `PODMAN_KEEP_GROUPS=true`.

The application data mount uses Podman's `:U` ownership adjustment for its non-root UID. Keep
`SAHAYA_DATA_DIR` dedicated to Sahaya: `:U` recursively changes ownership within the rootless user
namespace. Backup uses `podman unshare` so those mapped IDs remain readable without sudo.

## Model preparation

Containers do not download checkpoints at startup. Prepare the selected models first:

```bash
mkdir -p .models/sources .models/gemma .models/ming3-tts .models/qwen3-tts

git clone https://github.com/inclusionAI/Ming-3.0-tts.git .models/sources/ming3-tts
git -C .models/sources/ming3-tts checkout <reviewed-commit>
hf download inclusionAI/Ming-3.0-tts-0.5b --local-dir .models/ming3-tts

git clone https://github.com/QwenLM/Qwen3-TTS.git .models/sources/qwen3-tts
git -C .models/sources/qwen3-tts checkout <reviewed-commit>
hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base --local-dir .models/qwen3-tts
```

Place an authorized Gemma GGUF in `.models/gemma` and set `GEMMA_GGUF_FILE`. Check each upstream
license/model card and any access terms before downloading. Source revisions are deliberately
operator-pinned because this repository has not yet established target-host-validated upstream
commits for Ming and Qwen.

Raw parameter counts are not reliable VRAM requirements. GGUF quantization/context materially change
Gemma memory. Ming's upstream documentation reports high-memory test hardware but no minimum. Qwen
also needs runtime headroom beyond weight bytes. Measure idle GPU memory and peak loading/inference
on the actual host. Do not co-locate models until their combined peaks are known.

For disk planning, run `du -sh` on each completed checkpoint and source directory, then reserve
additional space for CUDA/Python images and the persistent Hugging Face cache. This repository does
not claim a fixed disk or VRAM minimum that has not been measured.

### What happens on a new server

1. `build` creates the app/Ming/Qwen images from this repository and the pinned source contexts; it
   pulls the configured llama.cpp/PostgreSQL images when selected.
2. The administrator or developer separately downloads model checkpoints into the configured host
   directories. Preflight never downloads them.
3. `start` mounts checkpoints read-only and mounts the dedicated data/cache directories persistently.
4. Each GPU service receives exactly the configured CDI device.
5. Containers start on private DNS names without publishing inference ports.
6. Each Python/llama.cpp process loads weights into its assigned GPU memory.
7. Container health remains `starting` until the real `/health` endpoint reports readiness.
8. Sahaya connects using `llama-gemma`, `ming3-tts`, or `qwen3-tts`; it never uses another
   container's `127.0.0.1`.
9. An operator performs one explicit lesson and narration request. Startup health alone is not an
   inference-quality or performance test.

## Deployment modes

### Mode 1: basic, hosted APIs only

```bash
deploy/podman/sahaya-podman --mode basic preflight
deploy/podman/sahaya-podman --mode basic build
deploy/podman/sahaya-podman --mode basic start
```

### Mode 2: hosted LLM plus Ming

Enable the voice feature flags and Ming variables in `.env`, select one CDI device, then:

```bash
deploy/podman/sahaya-podman --mode ming preflight
deploy/podman/sahaya-podman --mode ming build
deploy/podman/sahaya-podman --mode ming start
```

### Mode 3: local Gemma plus Ming

Set the local fallback to `http://llama-gemma:8080/v1`, select two explicitly assigned CDI devices
(or one only after capacity testing), then:

```bash
deploy/podman/sahaya-podman --mode gemma-ming preflight
deploy/podman/sahaya-podman --mode gemma-ming build
deploy/podman/sahaya-podman --mode gemma-ming start
deploy/podman/sahaya-podman status
```

### Mode 4: full local GPU set

Set all three CDI device variables and use `--mode full`. This adds Qwen Original. Qwen Enhanced
still requires the Resemble Enhance child-process environment inside the app container; it is not
bundled in the lightweight application image and must not be advertised as ready based only on Qwen
health.

```bash
deploy/podman/sahaya-podman --mode full preflight
deploy/podman/sahaya-podman --mode full build
deploy/podman/sahaya-podman --mode full start
deploy/podman/sahaya-podman status
```

Optional PostgreSQL and video rendering are enabled independently:

```env
SAHAYA_WITH_POSTGRES=true
PERSISTENCE_POSTGRES_PASSWORD=replace-with-a-private-password
DATABASE_URL=postgres://openmaic:replace-with-a-private-password@postgres:5432/openmaic

SAHAYA_WITH_VIDEO=true
```

Server-backed browser persistence also requires the documented `NEXT_PUBLIC_PERSISTENCE` build flag
and matching runtime token. The optional renderer adds only `CAP_NET_ADMIN` for its existing egress
lockdown; no Sahaya container runs privileged.

## Health and operations

```bash
deploy/podman/sahaya-podman status
deploy/podman/sahaya-podman logs sahaya-app
podman logs sahaya-ming3-tts
podman healthcheck run sahaya-app
podman healthcheck run sahaya-ming3-tts
deploy/podman/sahaya-podman restart
deploy/podman/sahaya-podman stop
```

Inference containers are attached only to the internal `sahaya-inference` network and have no host
port. The application also joins an outbound network for hosted APIs. Container `127.0.0.1` never
means another container. Use `llama-gemma`, `ming3-tts`, and `qwen3-tts` DNS names. A host-operated
service can use Podman's `host.containers.internal` alias when the host permits it.

## Rootless Quadlet and reboot startup

After building images and passing preflight:

```bash
# If the interactive manager was used first, stop it and remove only its
# containers before switching ownership to Quadlet. Do not remove data paths.
deploy/podman/sahaya-podman stop
podman rm sahaya-app sahaya-ming3-tts
deploy/podman/sahaya-podman --mode ming quadlet-install
systemctl --user status sahaya-app.service
journalctl --user -u sahaya-app.service -f
```

The installer writes only Sahaya units below `~/.config/containers/systemd/sahaya`, references the
private `.env` file, and starts the user service. Quadlet requires cgroup v2. Reboot startup before
login additionally requires user lingering; only university IT should run
`loginctl enable-linger <user>` under local policy. Without lingering, services start with the user
session. Generated Quadlets use explicit CDI devices and never request all GPUs.

The supplied Quadlet installer covers the application and selected Gemma/Ming/Qwen services. Keep
optional PostgreSQL/video under the interactive native manager unless university IT reviews and
adds equivalent institution-managed units; the installer does not falsely promise reboot startup
for those optional containers.

## Troubleshooting

- **CDI device absent:** compare `.env` with `nvidia-ctk cdi list`; ask IT to inspect
  `nvidia-cdi-refresh.service` after driver/MIG changes.
- **Permission denied on a GPU:** verify the account's assigned device/group and `crun`; do not chmod
  `/dev/nvidia*` globally.
- **Model unhealthy:** inspect its container log, mounted checkpoint, pinned source revision, and
  CUDA/Torch compatibility.
- **Feature hidden:** `NEXT_PUBLIC_*` flags require rebuilding the app image.
- **Port busy:** change `SAHAYA_HTTP_PORT`; do not stop an unknown process.
- **Host path denied by SELinux:** keep Sahaya data in its dedicated directory and ask IT to approve
  labeling. Never relabel broad system or home directories.

Podman and NVIDIA references:

- <https://docs.podman.io/en/stable/markdown/podman-compose.1.html>
- <https://docs.podman.io/en/stable/markdown/podman-systemd.unit.5.html>
- <https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html>
