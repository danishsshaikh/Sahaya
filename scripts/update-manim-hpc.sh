#!/usr/bin/env bash
# Update the standalone Manim renderer and its existing local Next.js tmux pane.
set -euo pipefail
set +x

cd "$(git rev-parse --show-toplevel)"
test "$(git branch --show-current)" = feat/manim-integration

renderer=sahaya-manim-hpc
image="${renderer}:$(git rev-parse --short HEAD)"
backup="$renderer-before-$(date +%Y%m%d%H%M%S)"
staged="$backup-next"
pane=$(tmux display-message -p -t openmaic-llm-test '#{pane_id}')
test -n "$pane"
docker volume inspect "$renderer" >/dev/null
test "$(docker inspect -f '{{.State.Running}}' "$renderer")" = true
restart=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}{{if .HostConfig.RestartPolicy.MaximumRetryCount}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}{{end}}' "$renderer")
restart=${restart:-no}

umask 077
env_file=$(mktemp)
state=preparing
cleanup() {
  local status=$?
  rm -f "$env_file"
  if ((status == 0)); then return; fi
  case "$state" in
    preparing) ;;
    staged) docker rm "$staged" >/dev/null 2>&1 || true ;;
    stopped)
      docker rm "$staged" >/dev/null 2>&1 || true
      docker start "$renderer" >/dev/null || true ;;
    saved)
      docker rm -f "$staged" >/dev/null 2>&1 || true
      docker rename "$backup" "$renderer" && docker start "$renderer" >/dev/null || true ;;
    replaced)
      docker rm -f "$renderer" >/dev/null 2>&1 || true
      docker rename "$backup" "$renderer" && docker start "$renderer" >/dev/null || true ;;
  esac
}
trap cleanup EXIT

docker inspect --format '{{json .Config.Env}}' "$renderer" | python3 -c '
import json, os, re, sys
values = dict(entry.split("=", 1) for entry in json.load(sys.stdin))
assert re.fullmatch(r"[A-Za-z0-9_-]{24,128}", values.get("MANIM_RENDERER_TOKEN", "")), "Missing renderer token"
assert values.get("MANIM_ARTIFACT_DIR", "/artifacts") == "/artifacts", "Unexpected artifact path"
capture = os.getenv("MANIM_CAPTURE_REJECTED_PLANS")
if capture is not None:
    assert capture in {"true", "false"}, "Capture must be true or false"
    values["MANIM_CAPTURE_REJECTED_PLANS"] = capture
values["HOME"] = values["XDG_CACHE_HOME"] = "/tmp"
for key, value in values.items():
    if key.startswith("MANIM_") or key in {"HOME", "XDG_CACHE_HOME"}:
        assert "\n" not in value and "\r" not in value, "Invalid renderer environment"
        print(f"{key}={value}")
' > "$env_file"

# The active deployment stays online while the workspace and image build.
pnpm rebuild:workspace
pnpm check:workspace-build
docker build -t "$image" services/manim-renderer
docker create --name "$staged" --restart "$restart" --init \
  --publish 127.0.0.1:8780:8780 --volume "$renderer:/artifacts" \
  --env-file "$env_file" --read-only --tmpfs /tmp:size=512m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges \
  --cpus 2 --memory 2g --pids-limit 128 \
  --health-cmd 'python /opt/sahaya-manim/healthcheck.py' "$image" >/dev/null
state=staged

docker stop "$renderer" >/dev/null
state=stopped
docker rename "$renderer" "$backup"
state=saved
docker rename "$staged" "$renderer"
state=replaced
docker start "$renderer" >/dev/null

ready=false
for _ in {1..30}; do
  if docker exec "$renderer" python -c '
import json, os
from urllib.request import Request, urlopen
request = Request("http://127.0.0.1:8780/ready", headers={
    "Authorization": "Bearer " + os.environ["MANIM_RENDERER_TOKEN"],
    "X-Manim-Owner": "0" * 64,
})
with urlopen(request, timeout=2) as response:
    assert json.load(response)["validationProtocol"] == 3
' 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true
docker update --restart=no "$backup" >/dev/null
state=ready

# Restart only the host app through the original session, retaining its shell environment.
tmux send-keys -t "$pane" C-c
python3 - <<'PY'
import socket, time
for _ in range(40):
    with socket.socket() as connection:
        connection.settimeout(0.5)
        if connection.connect_ex(("127.0.0.1", 3003)) != 0:
            break
    time.sleep(0.5)
else:
    raise SystemExit("Port 3003 is still in use. Check the openmaic-llm-test pane before restarting Next.js.")
PY
tmux send-keys -t "$pane" 'cd /home/danish/projects/OpenMAIC-llm-test && pnpm dev --hostname 0.0.0.0 --port 3003' C-m
printf 'Renderer ready on protocol 3. Previous container retained as %s.\n' "$backup"
