#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MODE=${SAHAYA_MODE:-}
ENV_FILE="$ROOT_DIR/.env"
DATA_DIR=${SAHAYA_DATA_DIR:-}
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd/sahaya
APP_IMAGE=${SAHAYA_APP_IMAGE:-localhost/sahaya-app:local}
MING_IMAGE=${SAHAYA_MING_IMAGE:-localhost/sahaya-ming3-tts:local}
QWEN_IMAGE=${SAHAYA_QWEN_IMAGE:-localhost/sahaya-qwen3-tts:local}
MANIM_IMAGE=${SAHAYA_MANIM_IMAGE:-localhost/sahaya-manim:local}

while (($#)); do
  case "$1" in
    --mode) MODE=${2:-}; shift 2 ;;
    --env-file) ENV_FILE=${2:-}; shift 2 ;;
    --data-dir) DATA_DIR=${2:-}; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v podman >/dev/null 2>&1 || { printf 'Podman is required.\n' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { printf 'systemd user services are required for Quadlet.\n' >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { printf 'Environment file not found: %s\n' "$ENV_FILE" >&2; exit 1; }

env_value() {
  local key=$1 default_value=${2:-} line value
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)
  if [[ -z "$line" ]]; then printf '%s' "$default_value"; return; fi
  value=${line#*=}
  value=${value%$'\r'}
  if [[ ${#value} -ge 2 && ${value:0:1} == '"' && ${value: -1} == '"' ]]; then
    value=${value:1:${#value}-2}
  elif [[ ${#value} -ge 2 && ${value:0:1} == "'" && ${value: -1} == "'" ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}

resolve_path() {
  if [[ "$1" == /* ]]; then printf '%s' "$1"; else printf '%s/%s' "$ROOT_DIR" "${1#./}"; fi
}

DATA_DIR=$(resolve_path "${DATA_DIR:-$(env_value SAHAYA_DATA_DIR "${XDG_DATA_HOME:-$HOME/.local/share}/sahaya")}")
MODE=${MODE:-$(env_value SAHAYA_MODE basic)}
case "$MODE" in basic | ming | gemma-ming | full) ;; *) printf 'Unsupported mode: %s\n' "$MODE" >&2; exit 2 ;; esac

needs_ming() { [[ "$MODE" == ming || "$MODE" == gemma-ming || "$MODE" == full ]]; }
needs_gemma() { [[ "$MODE" == gemma-ming || "$MODE" == full ]]; }
needs_qwen() { [[ "$MODE" == full ]]; }
with_manim() { [[ $(env_value OPENMAIC_ENABLE_MANIM false) == true ]]; }
quadlet_gpu_args() {
  local device=$1
  if [[ $(env_value PODMAN_KEEP_GROUPS false) == true ]]; then
    printf '%s' "--device=$device --group-add=keep-groups"
  else
    printf '%s' "--device=$device"
  fi
}

for value in "$ENV_FILE" "$DATA_DIR"; do
  if [[ "$value" == *$'\n'* || "$value" == *'%'* || "$value" == *'"'* ]]; then
    printf 'Quadlet paths may not contain a newline, percent sign, or double quote: %s\n' "$value" >&2
    exit 1
  fi
done

"$ROOT_DIR/scripts/deployment-preflight.sh" --runtime podman --mode "$MODE" --env-file "$ENV_FILE"
podman image exists "$APP_IMAGE" || { printf 'Build %s before installing Quadlet.\n' "$APP_IMAGE" >&2; exit 1; }
if needs_ming; then podman image exists "$MING_IMAGE" || { printf 'Build %s first.\n' "$MING_IMAGE" >&2; exit 1; }; fi
if needs_qwen; then podman image exists "$QWEN_IMAGE" || { printf 'Build %s first.\n' "$QWEN_IMAGE" >&2; exit 1; }; fi
if with_manim; then podman image exists "$MANIM_IMAGE" || { printf 'Build %s first.\n' "$MANIM_IMAGE" >&2; exit 1; }; fi
for container in sahaya-app sahaya-llama-gemma sahaya-ming3-tts sahaya-qwen3-tts sahaya-manim; do
  if podman container exists "$container" 2>/dev/null; then
    printf '%s\n' \
      "Existing container $container would conflict with Quadlet." \
      'Stop it and explicitly remove only that container (persistent bind-mounted data is separate), then retry.' >&2
    exit 1
  fi
done

mkdir -p "$UNIT_DIR" "$DATA_DIR/app" "$DATA_DIR/cache/huggingface"
chmod 700 "$UNIT_DIR" "$DATA_DIR" "$DATA_DIR/app"

# Remove only Sahaya-managed definitions so changing modes cannot leave a stale
# GPU service enabled. Images, containers, model files and persistent data are
# not removed.
rm -f "$UNIT_DIR"/sahaya-*.container "$UNIT_DIR"/sahaya-*.network

cat >"$UNIT_DIR/sahaya-app.network" <<'EOF'
[Network]
NetworkName=sahaya-app
Driver=bridge
EOF

cat >"$UNIT_DIR/sahaya-inference.network" <<'EOF'
[Network]
NetworkName=sahaya-inference
Driver=bridge
Internal=true
EOF

dependencies='sahaya-app-network.service sahaya-inference-network.service'
wants=''
manim_app_config=''
if with_manim; then
  mkdir -p "$DATA_DIR/manim"
  cat >"$UNIT_DIR/sahaya-manim.network" <<'EOF'
[Network]
NetworkName=sahaya-manim
Driver=bridge
Internal=true
EOF
  cat >"$UNIT_DIR/sahaya-manim-egress.network" <<'EOF'
[Network]
NetworkName=sahaya-manim-egress
Driver=bridge
EOF
  (
    umask 077
    printf '%s\n' "MANIM_RENDERER_TOKEN=$(env_value MANIM_RENDERER_TOKEN)" \
      "MANIM_SANDBOX_URL=$(env_value MANIM_SANDBOX_URL)" \
      "MANIM_SANDBOX_TOKEN=$(env_value MANIM_SANDBOX_TOKEN)" >"$UNIT_DIR/sahaya-manim.env"
  )
  chmod 600 "$UNIT_DIR/sahaya-manim.env"
  cat >"$UNIT_DIR/sahaya-manim.container" <<EOF
[Unit]
Description=Sahaya Manim visualization renderer
After=sahaya-manim-network.service sahaya-manim-egress-network.service

[Container]
ContainerName=sahaya-manim
Image=$MANIM_IMAGE
EnvironmentFile="$UNIT_DIR/sahaya-manim.env"
Environment=HOME=/tmp
Environment=XDG_CACHE_HOME=/tmp
Environment=MANIM_CAPTURE_REJECTED_PLANS=$(env_value MANIM_CAPTURE_REJECTED_PLANS false)
Environment=MANIM_QUEUE_CONCURRENCY=$(env_value MANIM_QUEUE_CONCURRENCY 1)
Environment=MANIM_QUEUE_CAPACITY=$(env_value MANIM_QUEUE_CAPACITY 8)
Environment=MANIM_RENDER_TIMEOUT_SECONDS=$(env_value MANIM_RENDER_TIMEOUT_SECONDS 120)
Environment=MANIM_MAX_DURATION=$(env_value MANIM_MAX_DURATION 90)
Environment=MANIM_MAX_ARTIFACT_BYTES=$(env_value MANIM_MAX_ARTIFACT_BYTES 50331648)
Environment=MANIM_STORAGE_LIMIT_BYTES=$(env_value MANIM_STORAGE_LIMIT_BYTES 10737418240)
Network=sahaya-manim.network
Network=sahaya-manim-egress.network
NetworkAlias=manim-renderer
Volume="$DATA_DIR/manim:/artifacts:U,Z"
PodmanArgs=--cap-drop=ALL --security-opt=no-new-privileges --read-only --cpus=$(env_value MANIM_CPU_LIMIT 2) --memory=$(env_value MANIM_MEMORY_LIMIT 2g) --pids-limit=$(env_value MANIM_PID_LIMIT 128) --tmpfs=/tmp:size=$(env_value MANIM_TMPFS_SIZE 512m),mode=1777
RunInit=true
HealthCmd=python /opt/sahaya-manim/healthcheck.py
HealthInterval=15s
HealthTimeout=5s
HealthRetries=5

[Service]
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  dependencies+=" sahaya-manim.service"
  wants+=" sahaya-manim.service"
  manim_app_config=$'Network=sahaya-manim.network\nEnvironment=MANIM_RENDERER_URL=http://manim-renderer:8780'
fi
if needs_gemma; then dependencies+=" sahaya-gemma.service"; wants+=" sahaya-gemma.service"; fi
if needs_ming; then dependencies+=" sahaya-ming.service"; wants+=" sahaya-ming.service"; fi
if needs_qwen; then dependencies+=" sahaya-qwen.service"; wants+=" sahaya-qwen.service"; fi

bind=$(env_value SAHAYA_HTTP_BIND 127.0.0.1)
port=$(env_value SAHAYA_HTTP_PORT 3000)
cat >"$UNIT_DIR/sahaya-app.container" <<EOF
[Unit]
Description=Sahaya application
After=$dependencies
Requires=sahaya-app-network.service sahaya-inference-network.service
Wants=$wants

[Container]
ContainerName=sahaya-app
Image=$APP_IMAGE
EnvironmentFile="$ENV_FILE"
Environment=MANIM_SANDBOX_URL=
Environment=MANIM_SANDBOX_TOKEN=
Environment=OPENMAIC_AUTH_DATA_DIR=/app/data/auth
Environment=VOICE_CLONING_STORAGE_DIR=/app/data/voice-cloning
Environment=TEACHING_VOICE_JOB_ARTIFACT_DIR=/app/data/voice-cloning/teaching-voice-job-artifacts-v1
Environment=MING3_TTS_BASE_URL=http://ming3-tts:8773
Environment=QWEN3_TTS_BASE_URL=http://qwen3-tts:8771
Network=sahaya-app.network
Network=sahaya-inference.network
$manim_app_config
PublishPort=$bind:$port:3000
Volume="$DATA_DIR/app:/app/data:U,z"
RunInit=true
HealthCmd=wget -q -O /dev/null http://127.0.0.1:3000/api/health
HealthInterval=15s
HealthTimeout=5s
HealthRetries=10
HealthStartPeriod=45s

[Service]
Restart=on-failure
TimeoutStartSec=300

[Install]
WantedBy=default.target
EOF

if needs_gemma; then
  gemma_dir=$(resolve_path "$(env_value GEMMA_MODEL_DIR "$ROOT_DIR/.models/gemma")")
  gemma_file=$(env_value GEMMA_GGUF_FILE gemma.gguf)
  gemma_device=$(env_value PODMAN_GEMMA_GPU_DEVICE)
  llama_image=$(env_value LLAMA_CPP_IMAGE ghcr.io/ggml-org/llama.cpp:server-cuda)
  cat >"$UNIT_DIR/sahaya-gemma.container" <<EOF
[Unit]
Description=Sahaya Gemma llama.cpp service
After=sahaya-inference-network.service
Requires=sahaya-inference-network.service

[Container]
ContainerName=sahaya-llama-gemma
Image=$llama_image
Network=sahaya-inference.network
NetworkAlias=llama-gemma
PodmanArgs=$(quadlet_gpu_args "$gemma_device")
SecurityLabelDisable=true
Volume="$gemma_dir:/models:ro"
Exec=--model /models/$gemma_file --host 0.0.0.0 --port 8080 --n-gpu-layers $(env_value GEMMA_GPU_LAYERS 99) --ctx-size $(env_value GEMMA_CONTEXT_SIZE 8192)
HealthCmd=curl --fail --silent http://127.0.0.1:8080/health
HealthInterval=15s
HealthTimeout=5s
HealthRetries=20
HealthStartPeriod=120s

[Service]
Restart=on-failure
TimeoutStartSec=900

[Install]
WantedBy=default.target
EOF
fi

if needs_ming; then
  ming_model=$(resolve_path "$(env_value MING3_TTS_MODEL_DIR "$ROOT_DIR/.models/ming3-tts")")
  ming_device=$(env_value PODMAN_MING_GPU_DEVICE)
  cat >"$UNIT_DIR/sahaya-ming.container" <<EOF
[Unit]
Description=Sahaya Ming 3.0 TTS service
After=sahaya-inference-network.service
Requires=sahaya-inference-network.service

[Container]
ContainerName=sahaya-ming3-tts
Image=$MING_IMAGE
Network=sahaya-inference.network
NetworkAlias=ming3-tts
PodmanArgs=$(quadlet_gpu_args "$ming_device")
SecurityLabelDisable=true
ShmSize=2g
Environment=HF_HOME=/cache/huggingface
Environment=MING3_TTS_HOST=0.0.0.0
Environment=MING3_TTS_PORT=8773
Environment=MING3_TTS_REPOSITORY_DIR=/opt/ming3-tts
Environment=MING3_TTS_MODEL=/models/ming3-tts
Environment=MING3_TTS_REFERENCE_ROOT=/app/data/voice-cloning
Environment=MING3_TTS_EMBEDDING_ROOT=/app/data/voice-cloning/.ming3-speaker-embeddings
Environment=MING3_TTS_CONDITIONING_MODE=$(env_value MING3_TTS_CONDITIONING_MODE acoustic-reference)
Environment=MING3_TTS_DEVICE=cuda:0
Volume="$ming_model:/models/ming3-tts:ro"
Volume="$DATA_DIR/app:/app/data:z"
Volume="$DATA_DIR/cache/huggingface:/cache/huggingface:z"
HealthCmd=python -c "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8773/health'))['ok']"
HealthInterval=20s
HealthTimeout=10s
HealthRetries=30
HealthStartPeriod=180s

[Service]
Restart=on-failure
TimeoutStartSec=900

[Install]
WantedBy=default.target
EOF
fi

if needs_qwen; then
  qwen_model=$(resolve_path "$(env_value QWEN3_TTS_MODEL_DIR "$ROOT_DIR/.models/qwen3-tts")")
  qwen_device=$(env_value PODMAN_QWEN_GPU_DEVICE)
  cat >"$UNIT_DIR/sahaya-qwen.container" <<EOF
[Unit]
Description=Sahaya Qwen3-TTS service
After=sahaya-inference-network.service
Requires=sahaya-inference-network.service

[Container]
ContainerName=sahaya-qwen3-tts
Image=$QWEN_IMAGE
Network=sahaya-inference.network
NetworkAlias=qwen3-tts
PodmanArgs=$(quadlet_gpu_args "$qwen_device")
SecurityLabelDisable=true
ShmSize=2g
Environment=HF_HOME=/cache/huggingface
Environment=HF_HUB_OFFLINE=1
Environment=TRANSFORMERS_OFFLINE=1
Environment=QWEN3_TTS_SERVICE_HOST=0.0.0.0
Environment=QWEN3_TTS_SERVICE_PORT=8771
Environment=QWEN3_TTS_MODEL=/models/qwen3-tts
Environment=QWEN3_TTS_ATTENTION_IMPLEMENTATION=$(env_value QWEN3_TTS_ATTENTION_IMPLEMENTATION eager)
Environment=QWEN3_TTS_QUEUE_WAIT_SECONDS=$(env_value QWEN3_TTS_QUEUE_WAIT_SECONDS 30)
Environment=QWEN3_TTS_MAX_PENDING=$(env_value QWEN3_TTS_MAX_PENDING 64)
Environment=QWEN3_TTS_SYNTHESIS_DEADLINE_SECONDS=$(env_value QWEN3_TTS_SYNTHESIS_DEADLINE_SECONDS 165)
Environment=QWEN3_TTS_RESPONSE_GRACE_SECONDS=$(env_value QWEN3_TTS_RESPONSE_GRACE_SECONDS 5)
Environment=QWEN3_TTS_MAX_NEW_TOKENS=$(env_value QWEN3_TTS_MAX_NEW_TOKENS 512)
Volume="$qwen_model:/models/qwen3-tts:ro"
Volume="$DATA_DIR/app:/app/data:ro,z"
Volume="$DATA_DIR/cache/huggingface:/cache/huggingface:z"
HealthCmd=python -c "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8771/health'))['ok']"
HealthInterval=20s
HealthTimeout=10s
HealthRetries=30
HealthStartPeriod=180s

[Service]
Restart=on-failure
TimeoutStartSec=900

[Install]
WantedBy=default.target
EOF
fi

systemctl --user daemon-reload
systemctl --user start sahaya-app.service

linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)
if [[ "$linger" != yes ]]; then
  printf '%s\n' \
    'Quadlets are installed and started for this user.' \
    'Automatic startup before login is NOT active because user lingering is disabled.' \
    'University IT may enable it with: loginctl enable-linger <user>'
else
  printf 'Quadlets installed. User lingering is enabled for reboot startup.\n'
fi
printf 'Inspect with: systemctl --user status sahaya-app.service\n'
