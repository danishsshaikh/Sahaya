#!/usr/bin/env bash
# Check sequencing and rollback without talking to Docker, tmux or any service.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export TEST_ROOT="$ROOT"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
export PATH="$fixture/bin:$PATH"

cat >"$fixture/bin/git" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  'rev-parse --show-toplevel') printf '%s\n' "$TEST_ROOT" ;;
  'branch --show-current') echo feat/manim-integration ;;
  'rev-parse HEAD') echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  'rev-parse '*'^'*| 'rev-parse '*'{commit}') echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  'archive '*) tar -c -C "$TEST_ROOT" services/manim-renderer ;;
  'merge --ff-only '*) echo 'merge revision' >> "$TRACE" ;;
  *) exit 0 ;;
esac
MOCK
cat >"$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s %s\n' "$1" "$2" >> "$TRACE"
case "$*" in
  'inspect --format '*json*) echo '{"Config":{"Env":[]},"Mounts":[],"HostConfig":{}}' ;;
  'inspect -f '*State.Running*) echo true ;;
  'inspect -f '*RestartPolicy*) echo unless-stopped ;;
esac
MOCK
cat >"$fixture/bin/python3" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == '-' ]]; then
  if [[ "$2" == */previous.json ]]; then
    echo 'broker preflight' >> "$TRACE"
    printf '2000' > "$5"
    printf 'MANIM_SANDBOX_SOCKET=/run/sahaya-manim/broker.sock\n' > "$3"
    [[ "$CASE" != unavailable ]]
    exit
  fi
  printf 'MANIM_RENDERER_TOKEN=synthetic-renderer-token-123456\n' > "${@: -1}"
elif [[ "$*" == *Sahaya\ HTTP* ]]; then
  [[ "$CASE" != app-failure ]]
fi
MOCK
cat >"$fixture/bin/tmux" <<'MOCK'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TRACE"
case "$*" in
  *pane_id*) echo '%3' ;;
  *pane_pid*) echo '123' ;;
  *pane_dead*) echo '0' ;;
esac
MOCK
cat >"$fixture/bin/pnpm" <<'MOCK'
#!/usr/bin/env bash
printf 'pnpm %s\n' "$*" >> "$TRACE"
MOCK
cat >"$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
echo '{"status":"ok"}'
MOCK
printf '#!/usr/bin/env bash\nexit 0\n' >"$fixture/bin/sleep"
chmod +x "$fixture/bin/"*
run() {
  export CASE="$1" TRACE="$fixture/$1.trace"
  bash "$ROOT/scripts/update-manim-hpc.sh" FETCH_HEAD >"$fixture/$1.output" 2>&1
}

if run unavailable; then
  printf 'Expected missing isolation to block the upgrade.\n' >&2
  exit 1
fi
! grep -Eq 'respawn-pane|pnpm rebuild|docker stop' "$TRACE"
run success
stop=$(grep -nF 'exec sleep 86400' "$TRACE" | head -1 | cut -d: -f1)
build=$(grep -nF 'pnpm rebuild:workspace' "$TRACE" | cut -d: -f1)
test "$stop" -lt "$build"
grep -q 'docker update --restart=no' "$TRACE"
grep -q 'docker exec --user' "$TRACE"
grep -q 'is ready in openmaic-llm-test' "$fixture/success.output"

if run app-failure; then
  printf 'Expected failed HTTP readiness to fail the upgrade.\n' >&2
  exit 1
fi
grep -q 'docker rm -f' "$TRACE"
test "$(grep -c '^docker start sahaya-manim-hpc' "$TRACE")" -ge 2
! grep -q 'is ready in openmaic-llm-test' "$fixture/app-failure.output"
printf 'Standalone Manim update tests passed.\n'
