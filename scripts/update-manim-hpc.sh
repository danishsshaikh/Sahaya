#!/usr/bin/env bash
# Standalone Sahaya upgrade. Run from the HPC checkout with the fetched revision as argument.
set -Eeuo pipefail
set +x
umask 077

repo=$(git rev-parse --show-toplevel)
cd "$repo"
test "$(git branch --show-current)" = feat/manim-integration
git diff --quiet
git diff --cached --quiet
old=$(git rev-parse HEAD)
target=$(git rev-parse "${1:-HEAD}^{commit}")
git merge-base --is-ancestor "$old" "$target"

renderer=sahaya-manim-hpc
session=openmaic-llm-test
image="$renderer:${target:0:12}"
stamp=$(date +%Y%m%d%H%M%S)
backup="$renderer-before-$stamp"
staged="$renderer-next-$stamp"
work=$(mktemp -d)
exit_on_error=1
app_stopped=false
renderer_state=unchanged
pane=
rollback=
renderer_env="$work/renderer.env"
client_env="$work/app.env"
socket_dir=${MANIM_BWRAP_SOCKET_DIR:-/run/sahaya-manim}

docker volume inspect "$renderer" >/dev/null
test "$(docker inspect -f '{{.State.Running}}' "$renderer")" = true
restart=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}{{if .HostConfig.RestartPolicy.MaximumRetryCount}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}{{end}}' "$renderer")
restart=${restart:-no}

port_free() {
  python3 -c 'import socket; s=socket.socket(); s.settimeout(.4); raise SystemExit(s.connect_ex(("127.0.0.1",3003)) == 0)'
}
ready() {
  local count
  for count in {1..50}; do
    if ! tmux has-session -t "=$session" 2>/dev/null ||
        [[ $(tmux display-message -p -t "$pane" '#{pane_dead}') == 1 ]]; then
      return 1
    fi
    if curl -fsS --max-time 3 http://127.0.0.1:3003/api/health |
        python3 -c 'import json,sys; d=json.load(sys.stdin); status=d.get("status",d.get("data",{}).get("status")); assert status=="ok"; print("Sahaya HTTP ready ("+str(d.get("version",d.get("data",{}).get("version","unknown")))+")")' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
launch_app() {
  local directory=$1 command
  # Quote paths independently. The env file is mode 600 and populated from the
  # original app process before the tmux pane is stopped.
  printf -v command 'exec bash %q %q %q' "$work/launch" "$directory" "$client_env"
  tmux respawn-pane -k -t "$pane" "$command"
}
cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0 && exit_on_error)); then
    printf 'Upgrade failed. Restoring the previous services.\n' >&2
    if $app_stopped && [[ -n "$pane" ]]; then
      tmux respawn-pane -k -t "$pane" 'exec sleep 86400' 2>/dev/null || true
    fi
    case "$renderer_state" in
      staged) docker rm "$staged" >/dev/null 2>&1 || true ;;
      stopped) docker rm "$staged" >/dev/null 2>&1 || true; docker start "$renderer" >/dev/null || true ;;
      saved) docker rm -f "$staged" >/dev/null 2>&1 || true
             docker rename "$backup" "$renderer" && docker start "$renderer" >/dev/null || true ;;
      replaced) docker rm -f "$renderer" >/dev/null 2>&1 || true
                docker rename "$backup" "$renderer" && docker start "$renderer" >/dev/null || true ;;
    esac
    if $app_stopped && [[ -n "$pane" ]]; then
      local restore="$repo"
      if [[ $(git rev-parse HEAD) != "$old" ]]; then
        rollback="$(dirname "$repo")/OpenMAIC-manim-rollback-$stamp"
        if git worktree add --detach "$rollback" "$old"; then
          for config in .env .env.local .env.development .env.development.local server-providers.yml; do
            if [[ -e "$repo/$config" && ! -e "$rollback/$config" ]]; then
              ln -s "$repo/$config" "$rollback/$config"
            fi
          done
          restore="$rollback"
        else
          printf 'Could not stage the prior app revision %s.\n' "$old" >&2
          restore=
        fi
      fi
      if [[ -n "$restore" ]] &&
          (cd "$restore" && { [[ "$restore" == "$repo" ]] || pnpm install --offline --frozen-lockfile; } &&
           pnpm rebuild:workspace && pnpm check:workspace-build) &&
          launch_app "$restore" && ready; then
        printf 'Previous app restored from %s.\n' "$restore" >&2
      else
        printf 'Previous renderer was retained. Restore app revision %s and check tmux before retrying.\n' "$old" >&2
      fi
    fi
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

docker inspect --format '{{json .}}' "$renderer" >"$work/previous.json"
python3 - "$work/previous.json" "$renderer_env" "$socket_dir" "$work/socket-gid" <<'PYCODE'
import json, os, re, socket, stat, sys
from http.client import HTTPConnection
from pathlib import Path

previous, target, directory, group_file = sys.argv[1:]
with open(previous) as handle:
    current = json.load(handle)
    values = dict(entry.split("=", 1) for entry in current["Config"]["Env"])
assert any(m.get("Type")=="volume" and m.get("Name")=="sahaya-manim-hpc" and m.get("Destination")=="/artifacts"
           for m in current["Mounts"]), "Unexpected publisher artifact mount"
assert current["HostConfig"]["PortBindings"].get("8780/tcp") == [{"HostIp":"127.0.0.1", "HostPort":"8780"}], "Unexpected publisher port binding"
for name in ("MANIM_SANDBOX_TOKEN", "MANIM_CAPTURE_REJECTED_PLANS"):
    if name in os.environ:
        values[name] = os.environ[name]
assert re.fullmatch(r"[A-Za-z0-9_-]{24,128}", values.get("MANIM_RENDERER_TOKEN", "")), "Missing publisher token"
assert values.get("MANIM_ARTIFACT_DIR", "/artifacts") == "/artifacts"
values.pop("MANIM_SANDBOX_URL", None)
values["MANIM_SANDBOX_SOCKET"] = "/run/sahaya-manim/broker.sock"
token = values.get("MANIM_SANDBOX_TOKEN", "")
assert re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token), "Set the approved MANIM_SANDBOX_TOKEN."
folder = Path(directory)
broker = folder / "broker.sock"
try:
    assert re.fullmatch(r"/[A-Za-z0-9/_.-]+", directory) and folder == folder.resolve(strict=True)
    assert stat.S_IMODE(folder.stat().st_mode) & 0o777 == 0o750
    assert set(item.name for item in folder.iterdir()) <= {"broker.sock", "broker.lock"}
    info = broker.lstat()
    assert stat.S_ISSOCK(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o660
    assert info.st_gid == folder.stat().st_gid and info.st_uid == folder.stat().st_uid
    assert info.st_gid != 0
except (AssertionError, OSError):
    raise SystemExit("The approved private Bubblewrap socket directory is unavailable or invalid.") from None

class UnixHTTP(HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(broker))

try:
    connection = UnixHTTP("localhost", timeout=5)
    try:
        connection.request("GET", "/ready", headers={"Authorization": "Bearer " + token})
        with connection.getresponse() as response:
            assert response.status == 200
            ready = json.loads(response.read(4096))
    finally:
        connection.close()
    assert (ready["isolation"], ready["backend"], ready["protocol"], ready["manimVersion"]) == (
        "verified", "bubblewrap", 1, "0.22.1")
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", ready["image"])
except Exception:
    raise SystemExit("The approved local Bubblewrap executor did not pass readiness.") from None
Path(group_file).write_text(str(info.st_gid))
with open(target, "w") as output:
    for name, value in values.items():
        if name.startswith("MANIM_"):
            assert "\n" not in value and "\r" not in value
            print(f"{name}={value}", file=output)
    print("HOME=/tmp\nXDG_CACHE_HOME=/tmp", file=output)
print("Approved local Bubblewrap executor verified.")
PYCODE
socket_gid=$(cat "$work/socket-gid")
[[ "$socket_gid" =~ ^[1-9][0-9]*$ ]]

mkdir "$work/image"
git archive "$target" services/manim-renderer | tar -x -C "$work/image"
docker build -t "$image" "$work/image/services/manim-renderer"
docker create --name "$staged" --restart "$restart" --init \
  --publish 127.0.0.1:8780:8780 --volume "$renderer:/artifacts" \
  --mount "type=bind,src=$socket_dir,dst=/run/sahaya-manim,readonly" --group-add "$socket_gid" \
  --env-file "$renderer_env" --read-only --tmpfs /tmp:size=512m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges \
  --cpus 2 --memory 2g --pids-limit 128 \
  --health-cmd 'python /opt/sahaya-manim/healthcheck.py' "$image" >/dev/null
renderer_state=staged

if ! tmux has-session -t "=$session" 2>/dev/null; then
  port_free || { printf 'Port 3003 is in use outside %s.\n' "$session" >&2; exit 1; }
  tmux new-session -d -s "$session" -c "$repo" 'exec sleep 86400'
fi
pane=$(tmux display-message -p -t "$session" '#{pane_id}')
pane_pid=$(tmux display-message -p -t "$pane" '#{pane_pid}')
test -n "$pane"
tmux set-window-option -t "$pane" remain-on-exit on

# Recover startup environment from the running Next process or its tmux pane.
# Existing dotenv files remain in place. Do not give the app the broker token.
python3 - "$pane_pid" "$renderer_env" "$client_env" <<'PY'
import os, re, shlex, sys
from pathlib import Path
pid, publisher, target = sys.argv[1:]
pids = [pid]
for parent in pids:
    children = Path(f"/proc/{parent}/task/{parent}/children")
    if children.is_file() and len(pids) < 64:
        pids.extend(children.read_text().split()[:64 - len(pids)])
for candidate in reversed(pids):
    entry = Path(f"/proc/{candidate}/environ")
    if not entry.is_file():
        continue
    values = dict(item.split("=", 1) for item in entry.read_bytes().decode(errors="surrogateescape").split("\0") if "=" in item)
    break
else:
    values = {}
excluded = {"_", "PWD", "OLDPWD", "SHLVL", "TMUX", "TMUX_PANE", "BASH_ENV", "ENV", "MANIM_SANDBOX_URL", "MANIM_SANDBOX_TOKEN", "MANIM_SANDBOX_SOCKET"}
with open(publisher) as source:
    publisher_values = dict(line.rstrip("\n").split("=", 1) for line in source)
values.update({"OPENMAIC_ENABLE_MANIM":"true", "MANIM_RENDERER_URL":"http://127.0.0.1:8780",
               "MANIM_RENDERER_TOKEN":publisher_values["MANIM_RENDERER_TOKEN"]})
with open(target, "w", errors="surrogateescape") as output:
    for name, value in values.items():
        if name not in excluded and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            print(f"export {name}={shlex.quote(value)}", file=output)
PY
cat >"$work/launch" <<'LAUNCH'
#!/usr/bin/env bash
set -e
cd "$1"
source "$2"
exec pnpm dev --hostname 0.0.0.0 --port 3003
LAUNCH

# Keep the session alive independently of the foreground pnpm/Next process.
app_stopped=true
tmux respawn-pane -k -t "$pane" 'exec sleep 86400'
for _ in {1..30}; do
  if port_free; then break; fi
  sleep 1
done
port_free
git merge --ff-only "$target"
pnpm rebuild:workspace
pnpm check:workspace-build

docker stop "$renderer" >/dev/null
renderer_state=stopped
docker rename "$renderer" "$backup"
renderer_state=saved
docker rename "$staged" "$renderer"
renderer_state=replaced
docker start "$renderer" >/dev/null

publisher_ready=false
for _ in {1..30}; do
  if docker exec "$renderer" python -c '
import json, os
from urllib.request import Request, urlopen
request = Request("http://127.0.0.1:8780/ready", headers={
    "Authorization": "Bearer " + os.environ["MANIM_RENDERER_TOKEN"],
    "X-Manim-Owner": "0" * 64,
})
with urlopen(request, timeout=3) as response:
    ready=json.load(response)
    assert ready["protocol"]==4 and ready["secureExecution"] and ready["isolation"]=="verified" and ready["backend"]=="bubblewrap"
    print("Publisher ready: "+ready["version"]+" (verified Bubblewrap)")
' 2>/dev/null; then
    publisher_ready=true
    break
  fi
  sleep 1
done
test "$publisher_ready" = true
docker exec --user 1000:1000 "$renderer" python /opt/sahaya-manim/healthcheck.py
launch_app "$repo"
ready
docker update --restart=no "$backup" >/dev/null
exit_on_error=0
printf 'Sahaya %s is ready in %s on port 3003. Previous renderer: %s.\n' "${target:0:12}" "$session" "$backup"
