# University administrator guide

This guide separates host administration from work a normal Sahaya deployment account can perform.
It assumes a shared Linux/NVIDIA server and prefers rootless Podman.

## A. University IT responsibilities

1. Allocate a dedicated unprivileged account and storage quota.
2. Install/maintain the NVIDIA driver, Podman, `crun`, and NVIDIA Container Toolkit.
3. Ensure cgroup v2, subordinate UID/GID ranges, and rootless networking are configured.
4. Verify `nvidia-cdi-refresh.path` and the generated CDI specification.
5. Allocate explicit GPU/CDI devices. Do not grant all GPUs by default.
6. Decide whether supplementary GPU groups or SELinux changes are permitted. Sahaya scripts never
   alter them.
7. Allow only the chosen application/reverse-proxy port. Inference ports remain container-private.
8. Provide HTTPS through the institution's reverse proxy, certificate, firewall, and DNS standards.
9. Decide whether the rootless user may linger for startup before login.
10. Provide backup storage, retention policy, monitoring, and incident-response procedures.

Useful administrator checks:

```bash
nvidia-smi -L
nvidia-ctk cdi list
systemctl status nvidia-cdi-refresh.path
podman info --format '{{.Host.CgroupsVersion}} {{.Host.OCIRuntime.Name}}'
loginctl show-user <sahaya-user> -p Linger
```

Do not restart drivers, regenerate MIG layouts, chmod device nodes, or change SELinux policy while
other users have GPU workloads without following the institution's maintenance process.

## B. Sahaya developer responsibilities

1. Clone the repository and protect `.env` with mode `0600`.
2. Select only allocated CDI device names.
3. Pin upstream model source revisions and record checkpoint versions/licenses.
4. Run the read-only preflight before building or starting.
5. Start only the required mode and verify each model health endpoint.
6. Run one authorized functional test; do not use another person's reference recording.
7. Monitor disk/GPU use and report capacity problems rather than moving other workloads.
8. Stop Sahaya safely before a consistent filesystem backup or update.

## Recommended storage layout

Set `SAHAYA_DATA_DIR` to a dedicated account-owned filesystem, for example:

```text
/srv/sahaya/                 # or ~/.local/share/sahaya for rootless use
├── app/                     # accounts, classrooms, voice profiles/audio, job artifacts
├── postgres/                # optional database cluster
└── cache/huggingface/       # model cache

repository/.models/
├── gemma/                   # authorized GGUF
├── ming3-tts/               # Ming checkpoint
├── qwen3-tts/               # Qwen checkpoint
└── sources/                 # pinned upstream source checkouts
```

Model paths can live on a separate read-only shared model filesystem. Do not put API keys in model
directories, images, build arguments, or browser-visible variables.

## Data locations and privacy boundaries

- **Browser IndexedDB:** browser-local courses, playback state, and other client persistence where
  implemented. It is not automatically synchronized and is lost if that browser data is cleared.
- **University disk:** accounts, Teaching Voice recordings/profiles, server classroom media,
  generated narration artifacts, optional PostgreSQL, model files/caches, and engine logs.
- **GPU memory:** loaded weights and temporary inference allocations. GPU memory is not permanent
  user-data storage and clears when processes exit/reset.
- **NVIDIA hosted API:** receives prompts/content sent to configured Nemotron endpoints.
- **Sarvam:** receives requested synthesis text and the authorized reference/remote clone information
  used by the existing cloned-voice path.
- **Bodhan:** receives synthesis text, language, voice, and style for Indic-Speak.

University administrators with host privileges may access server files and container logs. External
provider requests leave the university boundary. This repository does not promise encryption at
rest, regulatory compliance, external-provider retention, or automatic cross-device synchronization.
Review institutional policy and each provider's current contract separately.

## Backup and restore

For a filesystem-consistent backup, stop Sahaya first:

```bash
deploy/podman/sahaya-podman stop
deploy/podman/sahaya-podman backup /secure/backups/sahaya-$(date +%F).tar.gz
```

Also export important browser-only classrooms from the browser. Include `.env` only in a separately
encrypted administrator secret backup. Model checkpoints may be re-downloaded if licensing permits,
but preserving their hashes and pinned revisions improves reproducibility.

Restore only into an empty, access-controlled `SAHAYA_DATA_DIR`: verify the archive, extract it as
the deployment user with `podman unshare tar`, restore database files while PostgreSQL is stopped,
run preflight, then start
and verify health. Never extract an untrusted archive as root. The repository intentionally does not
offer an overwrite-style automated restore.

Container removal and data deletion are distinct. `podman rm` or `docker compose down` does not
delete bind-mounted data. Conversely, deleting `SAHAYA_DATA_DIR`, a named volume, browser site data,
or a remote provider clone is a separate destructive action with different recovery behavior.

## Updates and monitoring

```bash
deploy/podman/sahaya-podman stop
git fetch origin
git checkout feat/voice-ui
git pull --ff-only
deploy/podman/sahaya-podman --mode <mode> preflight
deploy/podman/sahaya-podman --mode <mode> build
deploy/podman/sahaya-podman --mode <mode> start
```

Before updating, back up server data and record the prior image/commit. Monitor `podman stats`,
`nvidia-smi`, container health, disk usage, and logs without exposing transcript or reference-audio
content. Application logs are the container engine's responsibility unless the institution configures
another logging system; no log-retention guarantee is invented here.
