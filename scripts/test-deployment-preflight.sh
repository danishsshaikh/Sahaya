#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sahaya-preflight.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/bin" "$TEST_DIR/models/gemma" "$TEST_DIR/models/ming-source" \
  "$TEST_DIR/models/ming" "$TEST_DIR/models/qwen-source" "$TEST_DIR/models/qwen" "$TEST_DIR/data"
touch "$TEST_DIR/models/gemma/gemma.gguf"

cat >"$TEST_DIR/bin/podman" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo 'podman version 5.4.0' ;;
  info) echo 'v2' ;;
  compose) exit 1 ;;
  *) exit 0 ;;
esac
EOF

cat >"$TEST_DIR/bin/nvidia-ctk" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-} ${2:-}" == 'cdi list' ]]; then
  printf '%s\n' nvidia.com/gpu=0 nvidia.com/gpu=1 nvidia.com/gpu=2
fi
EOF

cat >"$TEST_DIR/bin/ss" <<'EOF'
#!/usr/bin/env bash
printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\n'
EOF
chmod +x "$TEST_DIR/bin/podman" "$TEST_DIR/bin/nvidia-ctk" "$TEST_DIR/bin/ss"

cat >"$TEST_DIR/basic.env" <<EOF
SAHAYA_DATA_DIR=$TEST_DIR/data
SAHAYA_HTTP_PORT=3099
LLM_ROUTER_ENABLED=true
LLM_ROUTER_PRIMARY_MODEL=openai:nvidia/nemotron-3-ultra-550b-a55b
LLM_ROUTER_PRIMARY_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_ROUTER_PRIMARY_API_KEY=test-only
LLM_ROUTER_PRIMARY_LOCAL=false
LLM_ROUTER_FALLBACK_MODEL=openai:nvidia/nemotron-3-super-120b-a12b
LLM_ROUTER_FALLBACK_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_ROUTER_FALLBACK_API_KEY=test-only
LLM_ROUTER_FALLBACK_LOCAL=false
EOF

PATH="$TEST_DIR/bin:$PATH" "$ROOT_DIR/scripts/deployment-preflight.sh" \
  --runtime podman --mode basic --env-file "$TEST_DIR/basic.env" >/dev/null

cat "$TEST_DIR/basic.env" >"$TEST_DIR/full.env"
cat >>"$TEST_DIR/full.env" <<EOF
GEMMA_MODEL_DIR=$TEST_DIR/models/gemma
GEMMA_GGUF_FILE=gemma.gguf
MING3_TTS_SOURCE_DIR=$TEST_DIR/models/ming-source
MING3_TTS_MODEL_DIR=$TEST_DIR/models/ming
QWEN3_TTS_SOURCE_DIR=$TEST_DIR/models/qwen-source
QWEN3_TTS_MODEL_DIR=$TEST_DIR/models/qwen
PODMAN_GEMMA_GPU_DEVICE=nvidia.com/gpu=0
PODMAN_MING_GPU_DEVICE=nvidia.com/gpu=1
PODMAN_QWEN_GPU_DEVICE=nvidia.com/gpu=2
EOF

PATH="$TEST_DIR/bin:$PATH" "$ROOT_DIR/scripts/deployment-preflight.sh" \
  --runtime podman --mode full --env-file "$TEST_DIR/full.env" >/dev/null

sed 's#PODMAN_MING_GPU_DEVICE=nvidia.com/gpu=1#PODMAN_MING_GPU_DEVICE=nvidia.com/gpu=all#' \
  "$TEST_DIR/full.env" >"$TEST_DIR/invalid.env"
if PATH="$TEST_DIR/bin:$PATH" "$ROOT_DIR/scripts/deployment-preflight.sh" \
  --runtime podman --mode full --env-file "$TEST_DIR/invalid.env" >/dev/null 2>&1; then
  printf 'Expected explicit-GPU validation to reject nvidia.com/gpu=all.\n' >&2
  exit 1
fi

cp "$TEST_DIR/basic.env" "$TEST_DIR/manim.env"
cat >>"$TEST_DIR/manim.env" <<'EOF'
OPENMAIC_ENABLE_MANIM=true
MANIM_RENDERER_TOKEN=renderer-test-token-123456789
EOF
PATH="$TEST_DIR/bin:$PATH" "$ROOT_DIR/scripts/deployment-preflight.sh" \
  --runtime podman --mode basic --env-file "$TEST_DIR/manim.env" >"$TEST_DIR/manim.log"
if grep -q 'renderer-test-token-123456789' "$TEST_DIR/manim.log"; then
  printf 'The Manim token must not appear in preflight output.\n' >&2
  exit 1
fi
grep -q 'administrator-approved HTTPS sandbox broker' "$TEST_DIR/manim.log"
cat >>"$TEST_DIR/manim.env" <<'EOF'
MANIM_SANDBOX_URL=https://manim-sandbox.example.invalid
MANIM_SANDBOX_TOKEN=synthetic-sandbox-private-test-123456789
EOF
PATH="$TEST_DIR/bin:$PATH" "$ROOT_DIR/scripts/deployment-preflight.sh" \
  --runtime podman --mode basic --env-file "$TEST_DIR/manim.env" >"$TEST_DIR/manim-configured.log"
grep -q 'Manim broker settings present' "$TEST_DIR/manim-configured.log"
if grep -q 'synthetic-sandbox-private-test' "$TEST_DIR/manim-configured.log"; then
  printf 'The sandbox token must not appear in preflight output.\n' >&2
  exit 1
fi
printf 'Deployment preflight tests passed, including required Manim sandbox configuration.\n'
