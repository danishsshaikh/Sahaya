#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUNTIME=auto
MODE=basic
ENV_FILE="$ROOT_DIR/.env"
errors=0
warnings=0

usage() {
  printf '%s\n' \
    'Usage: scripts/deployment-preflight.sh [options]' \
    '' \
    '  --runtime auto|docker|podman' \
    '  --mode basic|ming|gemma-ming|full' \
    '  --env-file PATH' \
    '' \
    'This command is read-only: it does not pull images, download models, change' \
    'GPU permissions, create containers, or print credential values.'
}

while (($#)); do
  case "$1" in
    --runtime)
      RUNTIME=${2:-}
      shift 2
      ;;
    --mode)
      MODE=${2:-}
      shift 2
      ;;
    --env-file)
      ENV_FILE=${2:-}
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  basic | ming | gemma-ming | full) ;;
  *)
    printf 'ERROR: unsupported mode %s\n' "$MODE" >&2
    exit 2
    ;;
esac

ok() { printf 'OK: %s\n' "$1"; }
warn() {
  printf 'WARN: %s\n' "$1"
  warnings=$((warnings + 1))
}
fail() {
  printf 'ERROR: %s\n' "$1" >&2
  errors=$((errors + 1))
}

env_value() {
  local key=$1 default_value=${2:-} line value
  if [[ ! -f "$ENV_FILE" ]]; then
    printf '%s' "$default_value"
    return
  fi
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    printf '%s' "$default_value"
    return
  fi
  value=${line#*=}
  value=${value%$'\r'}
  if [[ ${#value} -ge 2 ]]; then
    if [[ ${value:0:1} == '"' && ${value: -1} == '"' ]]; then
      value=${value:1:${#value}-2}
    elif [[ ${value:0:1} == "'" && ${value: -1} == "'" ]]; then
      value=${value:1:${#value}-2}
    fi
  fi
  printf '%s' "$value"
}

env_present() {
  [[ -f "$ENV_FILE" ]] && grep -Eq "^[[:space:]]*$1=" "$ENV_FILE"
}

resolve_path() {
  if [[ "$1" == /* ]]; then printf '%s' "$1"; else printf '%s/%s' "$ROOT_DIR" "${1#./}"; fi
}

require_env() {
  local key=$1
  if [[ -z $(env_value "$key") ]]; then
    fail "$key is required for this configuration."
  else
    ok "$key is configured (value hidden)."
  fi
}

check_remote_key() {
  local key=$1 base_url=$2
  if [[ -n $(env_value "$key") ]]; then
    ok "$key is configured (value hidden)."
  elif [[ "$base_url" == https://integrate.api.nvidia.com/* ]]; then
    fail "$key is required by the configured NVIDIA hosted API endpoint."
  else
    warn "$key is empty; confirm that this non-local endpoint is intentionally keyless."
  fi
}

require_dir() {
  local label=$1 path=$2
  if [[ ! -d "$path" ]]; then
    fail "$label directory does not exist: $path"
  elif [[ ! -r "$path" ]]; then
    fail "$label directory is not readable: $path"
  else
    ok "$label directory is readable: $path"
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  fail "environment file not found: $ENV_FILE (copy .env.example to .env first)"
else
  ok "environment file found: $ENV_FILE"
fi

if [[ "$RUNTIME" == auto ]]; then
  if command -v podman >/dev/null 2>&1; then
    RUNTIME=podman
  elif command -v docker >/dev/null 2>&1; then
    RUNTIME=docker
  else
    fail 'neither Podman nor Docker is installed'
  fi
fi

case "$RUNTIME" in
  podman)
    if command -v podman >/dev/null 2>&1; then
      podman_version_text=$(podman --version 2>/dev/null || true)
      podman_version=$(grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' <<<"$podman_version_text" | head -n 1 || true)
      if [[ -z "$podman_version" ]]; then
        fail 'Podman version could not be determined.'
      else
        podman_major=${podman_version%%.*}
        podman_minor=${podman_version#*.}
        podman_minor=${podman_minor%%.*}
        if ((podman_major < 4 || (podman_major == 4 && podman_minor < 4))); then
          fail "Podman $podman_version is too old; Sahaya requires 4.4+ and recommends current 5.x."
        else
          ok "Podman found: $podman_version_text"
        fi
      fi
      cgroups=$(podman info --format '{{.Host.CgroupsVersion}}' 2>/dev/null || true)
      if [[ "$cgroups" == v2 ]]; then
        ok 'Podman uses cgroup v2 (required for Quadlet).'
      else
        warn "Podman cgroup version is '${cgroups:-unknown}'; rootless Quadlet requires cgroup v2."
      fi
      if podman compose version >/dev/null 2>&1; then
        warn 'A Podman Compose provider exists, but Sahaya GPU startup uses native Podman/CDI instead.'
      else
        ok 'Podman Compose is not required by the Sahaya native Podman deployment.'
      fi
    else
      fail 'Podman was selected but is not installed'
    fi
    ;;
  docker)
    if command -v docker >/dev/null 2>&1; then
      ok "Docker found: $(docker --version 2>/dev/null || printf 'version unavailable')"
      if docker compose version >/dev/null 2>&1; then
        ok "Docker Compose found: $(docker compose version 2>/dev/null)"
      else
        fail 'Docker Compose v2 is required for the Docker deployment'
      fi
    else
      fail 'Docker was selected but is not installed'
    fi
    ;;
  *)
    fail "runtime must be auto, docker, or podman (received: $RUNTIME)"
    ;;
esac

data_dir=$(resolve_path "$(env_value SAHAYA_DATA_DIR "${XDG_DATA_HOME:-$HOME/.local/share}/sahaya")")
if [[ -e "$data_dir" && ! -w "$data_dir" ]]; then
  fail "persistent data directory is not writable: $data_dir"
else
  ok "persistent data directory is writable or can be created: $data_dir"
fi

port=$(env_value SAHAYA_HTTP_PORT 3000)
if ! [[ "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
  fail "SAHAYA_HTTP_PORT must be a TCP port (received: $port)"
elif command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
  warn "TCP port $port is already listening; choose another SAHAYA_HTTP_PORT or verify it is Sahaya."
else
  ok "application port $port is not reported as busy."
fi

router_enabled=$(env_value LLM_ROUTER_ENABLED false)
if [[ "$router_enabled" == true ]]; then
  require_env LLM_ROUTER_PRIMARY_MODEL
  require_env LLM_ROUTER_PRIMARY_BASE_URL
  require_env LLM_ROUTER_FALLBACK_MODEL
  require_env LLM_ROUTER_FALLBACK_BASE_URL
  primary_local=$(env_value LLM_ROUTER_PRIMARY_LOCAL false)
  if [[ "$primary_local" != true ]]; then
    check_remote_key LLM_ROUTER_PRIMARY_API_KEY "$(env_value LLM_ROUTER_PRIMARY_BASE_URL)"
  fi
  fallback_local=$(env_value LLM_ROUTER_FALLBACK_LOCAL false)
  if [[ "$fallback_local" != true ]]; then
    check_remote_key LLM_ROUTER_FALLBACK_API_KEY "$(env_value LLM_ROUTER_FALLBACK_BASE_URL)"
  fi
  if [[ -n $(env_value LLM_ROUTER_SECONDARY_MODEL) ]]; then
    secondary_local=$(env_value LLM_ROUTER_SECONDARY_LOCAL false)
    secondary_base=$(env_value LLM_ROUTER_SECONDARY_BASE_URL "$(env_value LLM_ROUTER_PRIMARY_BASE_URL)")
    if [[ "$secondary_local" != true ]]; then
      if ! env_present LLM_ROUTER_SECONDARY_API_KEY; then
        ok 'LLM_ROUTER_SECONDARY_API_KEY is absent and will inherit the primary key.'
      elif [[ -z $(env_value LLM_ROUTER_SECONDARY_API_KEY) ]]; then
        warn 'LLM_ROUTER_SECONDARY_API_KEY is explicitly empty, so the secondary request is keyless.'
      else
        check_remote_key LLM_ROUTER_SECONDARY_API_KEY "$secondary_base"
      fi
    fi
  fi
else
  if [[ -z $(env_value OPENAI_API_KEY) && -z $(env_value ANTHROPIC_API_KEY) && -z $(env_value GOOGLE_API_KEY) ]]; then
    warn 'No common hosted LLM credential is configured and the Sahaya LLM router is disabled.'
  else
    ok 'At least one common hosted LLM credential is configured (value hidden).'
  fi
fi

needs_ming=false
needs_gemma=false
needs_qwen=false
case "$MODE" in
  ming) needs_ming=true ;;
  gemma-ming)
    needs_ming=true
    needs_gemma=true
    ;;
  full)
    needs_ming=true
    needs_gemma=true
    needs_qwen=true
    ;;
esac

if [[ "$needs_ming" == true ]]; then
  ming_source=$(resolve_path "$(env_value MING3_TTS_SOURCE_DIR "$ROOT_DIR/.models/sources/ming3-tts")")
  ming_model=$(resolve_path "$(env_value MING3_TTS_MODEL_DIR "$ROOT_DIR/.models/ming3-tts")")
  require_dir 'Ming source' "$ming_source"
  require_dir 'Ming model' "$ming_model"
fi

if [[ "$needs_qwen" == true ]]; then
  qwen_source=$(resolve_path "$(env_value QWEN3_TTS_SOURCE_DIR "$ROOT_DIR/.models/sources/qwen3-tts")")
  qwen_model=$(resolve_path "$(env_value QWEN3_TTS_MODEL_DIR "$ROOT_DIR/.models/qwen3-tts")")
  require_dir 'Qwen source' "$qwen_source"
  require_dir 'Qwen model' "$qwen_model"
fi

if [[ "$needs_gemma" == true ]]; then
  gemma_dir=$(resolve_path "$(env_value GEMMA_MODEL_DIR "$ROOT_DIR/.models/gemma")")
  gemma_file=$(env_value GEMMA_GGUF_FILE gemma.gguf)
  require_dir 'Gemma model' "$gemma_dir"
  if [[ ! -r "$gemma_dir/$gemma_file" ]]; then
    fail "Gemma GGUF is missing or unreadable: $gemma_dir/$gemma_file"
  else
    ok "Gemma GGUF is readable: $gemma_dir/$gemma_file"
  fi
fi

if [[ "$MODE" != basic ]]; then
  if [[ "$RUNTIME" == podman ]]; then
    if ! command -v nvidia-ctk >/dev/null 2>&1; then
      fail 'nvidia-ctk is required to verify Podman CDI devices; ask university IT to install NVIDIA Container Toolkit'
    else
      cdi_list=$(nvidia-ctk cdi list 2>/dev/null || true)
      if [[ -z "$cdi_list" ]]; then
        fail 'NVIDIA CDI returned no devices; university IT must verify the driver and nvidia-cdi-refresh service'
      else
        ok 'NVIDIA CDI devices are discoverable.'
      fi
      for pair in \
        "Gemma:PODMAN_GEMMA_GPU_DEVICE:$needs_gemma" \
        "Ming:PODMAN_MING_GPU_DEVICE:$needs_ming" \
        "Qwen:PODMAN_QWEN_GPU_DEVICE:$needs_qwen"; do
        IFS=: read -r label key required <<<"$pair"
        [[ "$required" == true ]] || continue
        device=$(env_value "$key")
        if [[ -z "$device" ]]; then
          fail "$key must name one CDI device allocated to $label (for example nvidia.com/gpu=0)."
        elif [[ "$device" == *'=all' ]]; then
          fail "$key must select an explicit allocated device; '=all' is forbidden on shared servers."
        elif [[ "$device" != nvidia.com/gpu=* ]]; then
          fail "$key is not an NVIDIA CDI device name: $device"
        elif [[ -n "${cdi_list:-}" ]] && ! grep -Fxq "$device" <<<"$cdi_list"; then
          fail "$key requests $device, which is absent from nvidia-ctk cdi list."
        else
          ok "$key selects an available explicit CDI device: $device"
        fi
      done
    fi
  elif [[ "$RUNTIME" == docker ]]; then
    for pair in \
      "Gemma:GEMMA_GPU_DEVICE:$needs_gemma" \
      "Ming:MING3_GPU_DEVICE:$needs_ming" \
      "Qwen:QWEN3_TTS_GPU_DEVICE:$needs_qwen"; do
      IFS=: read -r label key required <<<"$pair"
      [[ "$required" == true ]] || continue
      device=$(env_value "$key")
      if [[ -z "$device" || "$device" == all ]]; then
        fail "$key must select one explicit GPU assigned to $label; do not use all."
      else
        ok "$key explicitly selects GPU $device for $label."
      fi
    done
  fi
fi

printf '\nPreflight summary: %d error(s), %d warning(s).\n' "$errors" "$warnings"
if ((errors > 0)); then exit 1; fi
