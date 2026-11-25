# Native Manim visualizations in Sahaya

Select **Visualization** in the existing outline editor to animate a mathematical, scientific, or conceptual process. The classroom player keeps its separate narration track, captions, seeking, playback speed, fullscreen, and video download. Pro mode supports preview, replacement, and individual regeneration. Applying a replacement publishes a checked video before switching the saved scene. Existing MP4s and posters remain readable from the original artifact volume, including courses created by the retired JSON compositor. Historical artifacts retain their original cues. New rendering of a historical scene generates native Python. Full lecture video export for visualization courses is still presented as unavailable.

## Architecture

```mermaid
flowchart LR
  Outline["Course outline"] --> Agent["Manim coding agent"]
  Skill["Task-scoped skill and references"] --> Agent
  Context7["Optional pinned Context7"] --> Agent
  Agent --> Publisher["Private publisher and job queue"]
  Publisher --> Broker["Local executor via private Unix socket"]
  Broker --> Worker["Disposable Bubblewrap Cairo worker"]
  Worker --> Publisher
  Publisher --> Agent
  Publisher --> Store["Owner-scoped MP4, poster, source, cues"]
  Store --> Voice["Existing Teaching Voice and measured audio"]
  Voice --> Publisher
  Store --> Classroom["Classroom"]
  Voice --> Classroom
```

The agent uses the existing scene-content model routing and activates only for Visualization generation and regeneration. It sends a restricted tool request through native function calling on the verified direct OpenAI transports. The routed Nemotron and Gemma transports use the equivalent validated JSON envelope. The envelope carries Python source and cue metadata. The source itself uses native Manim, with one predictable `GeneratedScene` entry point. The controller checks Python without importing it, starts a preview, relays bounded errors, rejects duplicate source and repeated errors, and decides whether to publish. The previous JSON animation schema, patcher, and compositor have been retired.

The builtin [Manim skill](../skills/sahaya-manim/SKILL.md) follows Agent Skills frontmatter. The runtime activates its main instructions, selects relevant local references, and loads additional references on a legitimate tool request or a render failure. This context is scoped to one execution. The source-first authoring pattern and topical reference organization draw on two MIT-licensed Manim skills. Sahaya authors its own instructions and execution adapter. [Agent Skills specification](https://agentskills.io/specification) · [Yusuke710/manim-skill](https://github.com/Yusuke710/manim-skill) · [ManimCE Best Practices](https://github.com/adithya-s-k/manim_skill/tree/main/skills/manimce-best-practices)

Context7 offers MCP, a CLI, and REST. Sahaya uses the REST context operation with library ID `/manimcommunity/manim/v0.22.1`. It sends fixed generic API topics and caches accepted snippets for 12 hours. A returned version mismatch, unavailable release, missing key, or network failure uses the local references. This keeps deployment independent of the indexed version. Exact version availability under the deployment’s Context7 credentials remains to be checked. The agent treats returned snippets as reference data. [Context7 Manim library](https://context7.com/manimcommunity/manim) · [Context7 REST version behavior](https://context7.com/docs/api-guide#use-specific-versions) · [Manim Community v0.22.1](https://docs.manim.community/en/stable/changelog/0.22.1-changelog.html)

## Execution and university prerequisites

The HPC publisher retains the existing artifact volume and connects to an unprivileged executor on the same host through an authenticated Unix socket. The publisher container mounts the private socket directory read-only. Neither the app nor the executor requires the Docker socket. Bubblewrap constructs a fresh mount namespace from a reviewed, read-only Manim runtime filesystem exported from the pinned worker image. Generated Python does not receive either service's socket, the repository, home directories, credentials or the artifact volume. Sources and bounded MP4 output move through pipes. The publisher independently decodes and validates the media before committing it.

### Runtime security requirements

The supplied Ubuntu 20.04 build `0.4.0-1ubuntu4.1` is ineligible. Upstream fixed CVE-2026-87766 in 0.12.0. Ubuntu's USN-8779-2 reverted its initial fix, including the Focal ESM update. The successful `env -i` tests on 0.4.0 establish basic namespace functionality. The executor requires an administrator-reviewed, non-set-ID Bubblewrap 0.12.0 or newer with an exact approved binary digest. It launches with an empty host environment and also uses the supported `--clearenv` flag. Build and verify patched binaries in a user-local staging directory against Focal's ABI. An administrator then copies the reviewed build into a protected path. This path needs no changes to the system package or Docker daemon. [Upstream advisory](https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx) · [Ubuntu regression notice](https://ubuntu.com/security/notices/USN-8779-2) · [Bubblewrap security model](https://github.com/containers/bubblewrap/blob/main/SECURITY.md)

The dedicated account needs Linux Python 3.10+ with pidfd support, an approved libseccomp 2.6.2 or newer, and FFmpeg/ffprobe for the trusted startup fixture. These tools can be provisioned alongside the executor in an administrator-reviewed directory. Manim, Cairo, TeX and fonts come from the extracted image. User namespaces must be available to the service account on the actual kernel. Bubblewrap shares the host kernel. The university must review that exposure, the seccomp policy, and the account's cgroup and filesystem access. [libseccomp security releases](https://github.com/seccomp/libseccomp/releases) · [Bubblewrap isolation options](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)

The executor supports **one** active local worker. It starts a trusted launcher behind a pipe gate, verifies its migration into dedicated CPU, memory and PID cgroup v1 leaves, then releases it to Bubblewrap. The administrator provisions those leaves and delegates only writes to their `cgroup.procs` files to the executor account. The administrator owns the leaves and limit files. Use canonical paths on the real kernel controller mounts and keep the leaves empty of other services or descendants. Example caps are `cpu.cfs_period_us=100000`, `cpu.cfs_quota_us=200000`, `memory.limit_in_bytes=2147483648`, `memory.memsw.limit_in_bytes=2147483648`, and `pids.max=128`. The memory+swap controller must be present and enforced. When the host lacks delegation or a required controller, generation stays disabled. [Linux CPU bandwidth](https://docs.kernel.org/scheduler/sched-bwc.html) · [Linux cgroup v1 memory controller](https://docs.kernel.org/admin-guide/cgroup-v1/memory.html) · [Linux PID controller](https://docs.kernel.org/admin-guide/cgroup-v1/pids.html)

The worker gets isolated user, PID, IPC, UTS, mount, network and cgroup namespaces. It has a 512 MiB private tmpfs, a read-only runtime and proc mount, and four standard character devices for null, zero and randomness. It runs as namespace UID/GID 1000 with no effective capabilities. Bubblewrap disallows nested user namespaces, and a seccomp filter blocks namespace syscalls, new-namespace clone flags, sockets and sensitive kernel interfaces. Python and TeX run inside this environment, with TeX shell escape disabled. Deadlines, cancellation and pipe limits terminate work and drain the job's dedicated cgroups using pidfds. Failed cleanup blocks further launches.

### Provision and verify on the university host

Build and export a trusted Manim runtime using the approved branch source. The image is a staging artifact and does not run generated Python under ordinary Docker.

```bash
docker build -f services/manim-renderer/Dockerfile.sandbox -t sahaya-manim-worker:0.22.1 services/manim-renderer
docker image inspect --format '{{.Id}}' sahaya-manim-worker:0.22.1
worker=$(docker create sahaya-manim-worker:0.22.1)
docker export "$worker" > sahaya-manim-worker-rootfs.tar
docker rm "$worker"
sha256sum sahaya-manim-worker-rootfs.tar
```

The administrator extracts this verified archive into a new protected root-owned directory such as `/opt/sahaya-manim/rootfs-0.22.1`. Normalize ownership recursively without following symlinks, remove group/other write and set-ID bits from files and directories, and keep `dev`, `proc`, and `tmp` present and empty. The runtime tree permits regular files, directories, and internal symlink paths resolved by the sandbox. It must contain no mounted subtrees, special files, app configuration or host credentials. Publish and treat the tree as immutable.

Separately provision `/run/sahaya-manim` mode 0750, owned by the executor account with a dedicated non-root group. Use that group as the executor's primary group or set the directory's setgid bit (mode 2750). The directory contains only the socket and its lock file. Give the deployment operator access through the dedicated group. The update script maps that group into the publisher, whose UID stays 1000. Keep the directory in place across executor restarts so the publisher sees the replacement socket.

The administrator maintains a protected policy at `/etc/sahaya-manim/bubblewrap.json`. Populate it with the observed image ID, SHA-256 of the final Bubblewrap executable, and actual canonical controller paths.

```json
{
  "approved": false,
  "binary": "/opt/sahaya-manim/bin/bwrap",
  "binary_sha256": "<64 hex digits>",
  "libseccomp": "/opt/sahaya-manim/lib/libseccomp.so.2.6.2",
  "rootfs": "/opt/sahaya-manim/rootfs-0.22.1",
  "image": "sha256:<worker image ID>",
  "cgroups": {
    "cpu": "/sys/fs/cgroup/cpu,cpuacct/sahaya-manim",
    "memory": "/sys/fs/cgroup/memory/sahaya-manim",
    "pids": "/sys/fs/cgroup/pids/sahaya-manim"
  }
}
```

Run verification as the executor account on the host with the executor stopped and the reviewed release files available:

```bash
/usr/bin/bwrap --version
dpkg-query -W bubblewrap
bash scripts/verify-manim-bubblewrap.sh /etc/sahaya-manim/bubblewrap.json /run/sahaya-manim
```

The standalone verification uses synthetic canaries and a fixed Manim scene. It checks namespace and host process visibility, policy limits and group membership, socket and environment isolation, syscall restrictions, scratch capacity, timeouts, cancellation, descendant cleanup, and frame-derived output. These checks verify the configured controls within their scope. They do not constitute an administrator security review or a load test.

After accepting the residual kernel risk and the verification evidence, the administrator sets `approved` to `true` and starts the executor with its protected `MANIM_SANDBOX_TOKEN` environment variable as the designated account:

```bash
python3 services/manim-renderer/bubblewrap_broker.py serve /etc/sahaya-manim/bubblewrap.json /run/sahaya-manim
```

Use the reviewed release's service code and trusted service environment. The executor repeats technical verification before serving. The publisher's authenticated `/ready` reports protocol 4 with backend `bubblewrap` and `isolation: verified`. Its `/health` remains liveness only. A local socket failure cannot switch the publisher to an HTTPS transport. The previous gVisor broker remains optional on deployments explicitly configured for HTTPS. [gVisor Docker runtime documentation](https://gvisor.dev/docs/user_guide/quick_start/docker/)

Artifact storage keeps Python source, timing, render metadata and media distinct. Cache keys include the canonical request, immutable worker image, publisher revision and limits, under an owner directory. Temporary editor previews expire after two hours. Unpublished checks and failed attempts are cleaned up. Durable course media is preserved. The storage quota blocks further publication until an administrator can review stored usage and course references.

## Teaching Voice

Sahaya adopts the duration-tracker approach of Manim Voiceover. The plugin itself is not a runtime dependency. Its v0.3.7 package metadata broadly accepts Manim versions, so that metadata alone does not establish compatibility with the pinned Cairo renderer. Keeping voice synthesis in Sahaya also permits offline renders and the current Teaching Voice providers. [Manim Voiceover v0.3.7](https://voiceover.manim.community/en/stable/) · [Plugin package metadata](https://github.com/ManimCommunity/manim-voiceover/blob/v0.3.7/pyproject.toml) · [Manim v0.22.1 Cairo implementation](https://github.com/ManimCommunity/manim/blob/v0.22.1/manim/renderer/cairo_renderer.py)

Generated scenes call `with self.cue("id"):` around native animations. The adapter tracks emitted frames and pads short cues against measured narration. On the classroom paths with a server voice, a playable preview can appear while the trusted app synthesizes the audio. The app then promotes the source to a final silent render using measured durations, without a model call. When recorded audio fits an existing final render, the player can reuse it. When synthesis or exact retiming fails, playable media and adaptive pacing remain available. Faculty can use preview and regeneration in Pro mode to render again with the currently selected voice. The headless content path can publish a silent final without a browser narration pass.

New native results are labeled illustrative. Skill guidance calls for formula, unit, axis and boundary checks, and the regression suite independently verifies numerical relationships for diffraction and the retained numerical helpers. A successful render is a media result. Faculty review remains necessary for the generated scientific and visual claims.

## Configuration and rollout

The app uses `OPENMAIC_ENABLE_MANIM`, `MANIM_RENDERER_URL`, `MANIM_RENDERER_TOKEN`, and optionally `CONTEXT7_API_KEY`. Defaults are four active agents per app process, three normal model turns, two correction turns after a candidate fails validation or rendering, two Context7 lookups, three previews, and two final attempts. A malformed submission can unlock one extra format-repair turn when the configured authoring limit is at least three, within the five-turn authoring ceiling. `MANIM_AGENT_CORRECTION_CALLS` accepts up to four repair turns. The entire agent invocation is capped at eight model turns. On an authoring turn the model supplies the ordered cue array as `# sahaya-cues:`, a `# sahaya-scene:` mode, and Python imports and a top-level `animate(self)` function. Sahaya appends the cue-enabled `GeneratedScene` and its `construct` method. The modes are `standard`, `moving-camera`, and `three-d`. The extractor also accepts a single Python fence or a legacy complete Python module and source-and-cue envelope. It preserves the Python source, including physical line breaks, indentation and LaTeX escapes. It requests retransmission when a source appears to have been encoded twice. It requires authored cue metadata before submission. Native tool submissions remain supported on the existing allowlist. Later turns continue from the last successful routing tier. The HPC publisher uses `MANIM_SANDBOX_SOCKET` and `MANIM_SANDBOX_TOKEN`. Its queue defaults to one worker and eight active jobs. The executor defaults to a 45-second preview and 105-second final attempt, configurable with `MANIM_SANDBOX_PREVIEW_SECONDS` and `MANIM_SANDBOX_FINAL_SECONDS`. The optional gVisor backend uses `MANIM_SANDBOX_URL`. [Environment examples](../.env.example)

### Dedicated model and deadlines

Set these in the application environment to run Manim on the verified HPC Gemma endpoint. Use the exact Gemma ID reported by `/v1/models` after the `openai:` prefix.

```dotenv
MANIM_MODEL_PRIMARY_MODEL=openai:<exact-gemma-model-id>
MANIM_MODEL_PRIMARY_BASE_URL=http://127.0.0.1:24181/v1
MANIM_MODEL_PRIMARY_LOCAL=true
MANIM_MODEL_PRIMARY_LLAMA_CPP=true
MANIM_MODEL_ENABLE_THINKING=false
MANIM_AGENT_DEADLINE_SECONDS=900
```

A dedicated tier can also set `MANIM_MODEL_PRIMARY_API_KEY` and `MANIM_MODEL_PRIMARY_TIMEOUT_SECONDS`. Optional `MANIM_MODEL_SECONDARY_*` and `MANIM_MODEL_FALLBACK_*` use the same fields, with their own model and base URL. Leaving the Manim primary unset uses the existing model resolution and global route, with the Manim phase limits still applied. Ordinary generation continues using its own settings.

| Scope | Default | Environment variable |
| --- | ---: | --- |
| Overall self-hosted job | 900 s | `MANIM_AGENT_DEADLINE_SECONDS` |
| Documentation lookup time | 8 s | `MANIM_AGENT_DOCUMENTATION_SECONDS` |
| One local inference attempt | 300 s | `MANIM_AGENT_INFERENCE_SECONDS` |
| One remote inference attempt | 45 s | `MANIM_AGENT_REMOTE_INFERENCE_SECONDS` |
| Initial authoring inference across turns | 480 s | `MANIM_AGENT_AUTHORING_SECONDS` |
| Correction inference across turns | 220 s | `MANIM_AGENT_CORRECTION_SECONDS` |
| Publisher preview, including queuing and verification | 90 s | `MANIM_AGENT_PREVIEW_SECONDS` |
| Publisher final, including queuing and verification | 160 s | `MANIM_AGENT_FINAL_SECONDS` |

The overall deadline includes every phase. Manim holds the next preview and final windows before calling a model and gives an alternate route part of the remaining inference window. Shorter job deadlines proportionally reduce the render reserves. The self-hosted Next.js process uses the full configured deadline. Vercel deployments cap Manim at 275 seconds within the scene-content route's 300-second platform limit. [Next.js route duration](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#maxduration)

HPC reported an 8,192-token Gemma context. The default request allows 3,072 completion tokens, including any reasoning, and fits the prompt to a conservative byte estimate. The prompt prioritizes an example matching the title or teaching objective and trims additional examples and generic context first. Repair prompts show an editable, explicitly numbered source window and can include the full candidate when it fits. A repair reply contains up to three disjoint line edits. The application applies them to its stored candidate, keeps the cue metadata and managed wrapper, and validates the whole result before rendering. Large scenes keep their existing source even when the model can see only the repair window. Set `MANIM_AGENT_CONTEXT_TOKENS`, `MANIM_AGENT_COMPLETION_TOKENS`, or `MANIM_AGENT_PROMPT_BYTES` to tune it. Use the diagnostic's actual prompt tokens, completion tokens, and `completionTokensPerSecond` to tune inference time. At 3,072 tokens, a 300-second window requires roughly 10 tokens/s before prompt and queue overhead. The failed 168-second attempt produced no complete response, so it does not establish throughput.

The HPC Gemma endpoint accepted `chat_template_kwargs.enable_thinking=false` in a direct request and returned Python in 201 completion tokens. Mark a dedicated tier with `MANIM_MODEL_<ROLE>_LLAMA_CPP=true` only after verifying support on that server and template. Manim sends the flag in both streaming and buffered requests. `MANIM_MODEL_ENABLE_THINKING` defaults to `false` on those tiers. Set it to `true` to re-enable thinking. On marked tiers this setting takes precedence over `MANIM_MODEL_<ROLE>_DISABLE_REASONING`. Unmarked tiers retain their existing provider-specific controls. [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

`MANIM_AGENT_STREAM=true` reports first-token latency. A streamed request stays on its chosen provider once response parts arrive. Buffered mode reports completion metrics. Manim reports reasoning bytes when present and exact token counts only when available. Missing counts and a zero count that conflicts with observed reasoning are reported as unavailable. If a model reaches the completion limit without usable Python, Manim can make one smaller request that keeps the teaching objective, cue contract, and completion cap. The authoring and rendering deadlines still apply.

### Offline API knowledge and preflight

The app selects Manim 0.22.1 signatures, documentation and up to two example excerpts for each teaching objective. The first turn can request one additional class, constructor, method, concept, example or alternatives lookup when the budget allows. Retrieval uses the shipped index and examples. Context7 remains optional. Corrections prioritize indexed alternatives and preserve the checked candidate and cue metadata within the context limit.

The authenticated publisher preflight inspects Python's AST and runs the existing native contract. For legacy replies it can rename one unambiguous, unreferenced cue scene. It checks the scaffold entry function and preserves authored line numbers. Python syntax feedback carries a categorized error and parser line and column when available. Runtime repair feedback uses the worker's sanitized error classification and source location. The publisher resolves statically identifiable calls near that location, and Sahaya includes their pinned signatures. Raw exception messages and tracebacks stay outside model feedback. It flags proven missing APIs or unsupported keywords for repair and treats uncertain findings as hints for isolated rendering. Python with runtime-dependent attributes, imports, or control flow can still need preview feedback. After preflight, preview and final requests follow the existing isolated worker and media verification. Publisher instances without the new preflight capability still enforce the native job contract and isolated execution. The app rejects a publisher that advertises a mismatched preflight version.

Build the index from the official Manim Community 0.22.1 wheel and the matching tagged docs. The tool verifies both SHA-256 hashes, never imports Manim, and stores source paths and line numbers in the index. Use `--verify-installed` in a trusted Python environment with Manim 0.22.1 to compare the installed Python sources to the pinned wheel during regeneration. The publisher build checks the installed Manim version against the index.

```bash
(
  set -euo pipefail
  work="$(mktemp -d)"
  trap 'rm -rf -- "$work"' EXIT
  curl -fsSL 'https://files.pythonhosted.org/packages/0d/4c/7462f0576f5de1a77849d0ae117b7fd697a399fa17b44c5a7d87bb79dbb7/manim-0.22.1-py3-none-any.whl' \
    -o "$work/manim-0.22.1-py3-none-any.whl"
  curl -fsSL 'https://codeload.github.com/ManimCommunity/manim/tar.gz/refs/tags/v0.22.1' \
    -o "$work/manim-v0.22.1.tar.gz"
  python3 scripts/build-manim-knowledge.py --wheel "$work/manim-0.22.1-py3-none-any.whl" \
    --docs "$work/manim-v0.22.1.tar.gz" --output "$work/manim_api.json"
  cmp "$work/manim_api.json" services/manim-renderer/manim_api.json
)
```

The corpus covers classes, inheritance, callable signatures, documented parameters and return values, constants, and Cairo guidance from the upstream docs. The example library covers shapes and cue integration, text and equations, number lines, plots, trackers, waves, vectors, kinematics, probability, linear algebra, and 2D and 3D cameras. The canonical `shapes.py` includes a complete `GeneratedScene` with cue metadata. All 12 examples pass the static checks. `verify-manim-examples.ts --render` checks which examples produce decoded MP4s on the deployed isolated renderer. [Manim 0.22.1 release](https://pypi.org/project/manim/0.22.1/) · [Tagged upstream docs](https://github.com/ManimCommunity/manim/tree/v0.22.1/docs/source) · [Example library](../skills/sahaya-manim/examples/manifest.json)

### Independent operator checks

Run from the checkout that contains these scripts, using the intended application environment. The commands load the HPC configuration from `.env.local`. Node's `--conditions=import` selects the workspace packages' import exports for the TypeScript entry points and works with the tested Node.js 22.23.1 invocation. Shell-scoped overrides let you verify the Gemma request without a service restart. [Node.js conditional exports](https://nodejs.org/docs/latest-v22.x/api/packages.html#resolving-user-conditions)

```bash
cd /home/danish/projects/OpenMAIC-llm-test
PATH="/opt/sahaya-manim/tools/bin:$PATH" \
  node --conditions=import --env-file=.env.local --import tsx scripts/smoke-manim-renderer.ts
node --conditions=import --env-file=.env.local --import tsx scripts/verify-manim-examples.ts --render
for task in number-line function-plot single-slit-diffraction; do
  LOG_LEVEL=info MANIM_AGENT_STREAM=true \
    MANIM_MODEL_PRIMARY_LLAMA_CPP=true MANIM_MODEL_ENABLE_THINKING=false \
    node --conditions=import --env-file=.env.local --import tsx scripts/diagnose-manim-model.ts \
    --task "$task" --publisher-container sahaya-manim-hpc --preview || break
done
```

The smoke test uses the existing publisher token and requires `ffprobe` on `PATH` (the private provisioning path is `/opt/sahaya-manim/tools/bin`). It checks Bubblewrap readiness, submits one trusted square animation under a unique operator owner, and checks the preview's SHA-256, stream, frame count and cue metadata. The publisher expires the preview with its normal TTL.

The model diagnostic accepts fixed synthetic teaching tasks, including wave interference and single-slit diffraction, and uses the production extraction, preflight and correction loop. `--publisher-container` uses the existing operator Docker access to run only the publisher's static validator as UID/GID 1000. Candidate source is input to the validator and is never executed by that command. The diagnostic prints the interpreter version and the sanitized syntax category, line and column. For local static checks, select an approved interpreter with `--python /absolute/path/to/python` or rely on the default `python3`. Use the container option when the host Python version differs from the publisher.

With `--preview`, the same agent submits a temporary preview under a unique diagnostic owner through the authenticated publisher. It reports `playableArtifact: true` after the publisher decodes the artifact and the diagnostic verifies the downloaded MP4's size and SHA-256. Omit `--preview` for static validation alone. Add `--capture` only when investigating the synthetic diagnostic. It writes prompts, reconstructed assistant replies, checked-input candidates, and cue files into a private temporary directory printed by the command. Directory permissions are 0700 and files are 0600. Remove the directory after review. Regular classroom requests record selected public API symbols, example IDs, context size, response format, and sanitized issue codes and line numbers. Monitor `Manim knowledge selected`, `Manim source preflight`, `Manim render evaluated`, and `Manim agent completed` in the application logs. The publisher logs `manim-artifact-checked` and `manim-render-failed` with job identifiers.

### Compare approved Manim models

Run the benchmark against already approved endpoints. Each profile names a model and an existing base URL. In the operator's private environment use `MANIM_BENCH_<PROFILE>_MODEL` and `MANIM_BENCH_<PROFILE>_BASE_URL`. Set `MANIM_BENCH_<PROFILE>_API_KEY` if required and set `MANIM_BENCH_<PROFILE>_LOCAL=true` for a local service. Set the profile's `_LLAMA_CPP` or `_DISABLE_REASONING` flag only where supported, as in the dedicated Manim configuration.

```bash
cd /home/danish/projects/OpenMAIC-llm-test
node --conditions=import --env-file=.env.local --import tsx \
  scripts/benchmark-manim-models.ts --profile GEMMA --profile APPROVED_ALT \
  --runs 3 --publisher-container sahaya-manim-hpc
```

The runner sends the same three synthetic objectives in rotating model order. It uses one configured endpoint per trial, the same initial offline knowledge with optional discovery closed, a common inference cap within the existing limits, and the same authenticated publisher and verified isolated preview. Each successful trial downloads the decoded MP4 and checks its size and SHA-256. Keep the commit, profile model versions and budget settings alongside the results. Add `--capture` for private reproduction files for synthetic trials.

Trial records include total latency, model calls, candidate submissions, repair attempts and verified playback. First-pass success requires a verified preview from the first Python submission without a correction. Repair success requires a verified preview after applying a line edit. Compare those counts across tasks and review the diffraction MP4 for scientific accuracy and teaching quality. Media verification alone measures playback, not scientific accuracy.

Docker Compose retains the `manim` profile and persistent volume. Podman and Quadlet use the same publisher image and artifact mount. The existing HTTPS deployment works with approved gVisor. A Compose local deployment adds a publisher-only read-only bind of the socket directory plus the mapped socket group, and sets `MANIM_SANDBOX_SOCKET` to the in-container path. Verify group and UID mapping before using a local socket with rootless container engines.

On the university HPC server, the standalone update script stages the new publisher image before stopping the Next.js pane. It verifies the local socket before changing services, stops Next.js before rebuilding the workspace, verifies actual HTTP readiness, and preserves the previous renderer container for rollback. The original renderer token, port, resource limits, and `sahaya-manim-hpc:/artifacts` persist. Gemma and Teaching Voice services remain on their existing allocations. If Next.js cannot restart after an upgrade, rollback restores the old renderer and attempts to restart the prior app revision from a separate worktree. That app recovery uses the local pnpm store and the original environment. [Standalone update script](../scripts/update-manim-hpc.sh)

```bash
(
  set -euo pipefail
  cd /home/danish/projects/OpenMAIC-llm-test
  git fetch origin refs/heads/feat/manim-integration
  git show FETCH_HEAD:scripts/update-manim-hpc.sh | bash -s -- FETCH_HEAD
)
```

Export the protected `MANIM_SANDBOX_TOKEN` for the first Bubblewrap rollout. `MANIM_BWRAP_SOCKET_DIR` defaults to `/run/sahaya-manim`. The rollout rebuilds the publisher and verifies that UID 1000 can execute its healthcheck. Leave the current deployment running while the university provisions the executor.

## Live verification and troubleshooting

1. Verify authenticated publisher readiness shows `secureExecution: true`, `isolation: verified`, and protocol 4. With broker availability intentionally removed in an approved test window, check that historical playback remains available and the app declines fresh generation before provider use.
2. Generate or retry the existing single-slit intensity and grating scenes. Verify both formulas, central peak and minima, labels, spacing and animations. Test another topic that uses native geometry or 3D.
3. Refresh while rendering and confirm the classroom rejoins the current job and keeps its outline order. Attempt a failed regeneration and confirm the previous video remains playable.
4. Check cue transitions, seeking, captions, playback speed and voice switching with real Teaching Voice audio. Measure first-pass preview success and final acceptance on the actual Linux host.

Monitor the publisher with `docker logs -f sahaya-manim-hpc`, the app with `tmux capture-pane -pt openmaic-llm-test -S -200`, and the sandbox broker’s approved service logs. App events include `Manim skill activated`, `Manim documentation read`, `Manim tool request`, `Manim render evaluated`, `Manim agent completed` and existing `SceneNarration` timing events. Publisher events include `manim-artifact-checked` and `manim-render-failed`. Use model call, preview/final, token, CPU, memory and elapsed-time fields when available.

Enable `MANIM_CAPTURE_REJECTED_PLANS=true` on the publisher only for a bounded diagnostic window. It stores rejected Python and the sanitized issue for at most 24 hours. Caps are eight captures per owner, 64 total. Authenticated internal `/diagnostics/<id>` requires the owning principal’s SHA-256 namespace. Generated source can contain course content and should be handled privately. Raw worker stdout and stderr stay outside logs and model feedback.
