#!/usr/bin/env bash
# Run manually on Linux as the designated executor account, with the service stopped.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P)
policy=${1:-/etc/sahaya-manim/bubblewrap.json}
socket_dir=${2:-/run/sahaya-manim}
exec python3 "$repo/services/manim-renderer/bubblewrap_broker.py" verify "$policy" "$socket_dir"
