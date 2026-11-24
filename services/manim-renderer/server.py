"""Private, bounded queue and immutable render storage for a single renderer."""

from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from hashlib import sha256
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import sys
import threading
import time

from native_contract import MANIM_VERSION, MAX_DURATION, MAX_REQUEST, MAX_VIDEO, PUBLISHER_PROTOCOL, Rejected, check_request
from native_artifact import sanitize_issue, verify
import sandbox_client

VERSION = f"{MANIM_VERSION}/native-1"
ROOT = Path(os.getenv("MANIM_ARTIFACT_DIR", "/artifacts")).resolve()
TMP = Path(os.getenv("MANIM_WORK_DIR", "/tmp/manim-jobs")).resolve()
SECRET = os.getenv("MANIM_RENDERER_TOKEN", "")
CONCURRENCY = max(1, min(2, int(os.getenv("MANIM_QUEUE_CONCURRENCY", "1"))))
CAPACITY = max(CONCURRENCY, min(32, int(os.getenv("MANIM_QUEUE_CAPACITY", "8"))))
TIMEOUT = max(10, min(600, int(os.getenv("MANIM_RENDER_TIMEOUT_SECONDS", "120"))))
QUOTA = int(os.getenv("MANIM_STORAGE_LIMIT_BYTES", str(10 * 1024 ** 3)))
BODY_LIMIT = MAX_REQUEST
DIAGNOSTICS = os.getenv("MANIM_CAPTURE_REJECTED_PLANS", "").lower() == "true"
DIAGNOSTIC_TTL = 24 * 60 * 60
DIAGNOSTIC_ROOT = ROOT / ".diagnostics"
DIAGNOSTIC_LOCK = threading.Lock()
HEX = re.compile(r"[a-f0-9]{64}")
MEDIA = {"video.mp4": "video/mp4", "poster.jpg": "image/jpeg"}
PREVIEW_ROOT = ROOT / ".previews"
PREVIEW_TTL = 2 * 60 * 60
LOCK = threading.RLock()
POOL = ThreadPoolExecutor(max_workers=CONCURRENCY)
JOBS = {}
ACTIVE = {}
PENDING = []
TERMINAL = {"completed", "failed", "cancelled"}


def prune_diagnostics(owner=None):
    now = time.time()
    folders = [folder for folder in DIAGNOSTIC_ROOT.glob("*") if HEX.fullmatch(folder.name)]
    entries = []
    for folder in folders:
        for file in folder.glob("*.json"):
            if not HEX.fullmatch(file.stem):
                continue
            stamp = file.stat().st_mtime
            if now - stamp >= DIAGNOSTIC_TTL:
                file.unlink()
            else:
                entries.append((stamp, file))
    entries.sort()
    if owner:
        owned = [file for _, file in entries if file.parent.name == owner]
        for file in owned[:-7]:
            file.unlink()
        entries = [entry for entry in entries if entry[1].exists()]
        for _, file in entries[:-63]:
            file.unlink()
    for folder in folders:
        if not any(folder.iterdir()):
            folder.rmdir()


def diagnostic_cleanup():
    while True:
        with DIAGNOSTIC_LOCK:
            try:
                prune_diagnostics()
            except OSError:
                print("Manim diagnostic cleanup failed", file=sys.stderr)
        with LOCK:
            for owner in PREVIEW_ROOT.glob("*"):
                if not HEX.fullmatch(owner.name):
                    continue
                for artifact in owner.glob("*"):
                    if HEX.fullmatch(artifact.name) and time.time() - artifact.stat().st_mtime > PREVIEW_TTL:
                        shutil.rmtree(artifact, ignore_errors=True)
        time.sleep(600)


def capture_diagnostic(owner, candidate, kind, issue):
    if not DIAGNOSTICS:
        return None
    try:
        payload = json.dumps({"source": candidate.get("source"), "kind": kind,
                              "status": "rejected", "issue": issue},
                             ensure_ascii=False, allow_nan=False).encode()
        if len(payload) > 2 * BODY_LIMIT:
            return None
        with DIAGNOSTIC_LOCK:
            prune_diagnostics(owner)
            key = secrets.token_hex(32)
            folder = DIAGNOSTIC_ROOT / owner
            DIAGNOSTIC_ROOT.mkdir(mode=0o700, exist_ok=True)
            folder.mkdir(mode=0o700, exist_ok=True)
            with (folder / f"{key}.json").open("xb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(payload)
        return key
    except (OSError, ValueError, RecursionError):
        print("Manim diagnostic capture failed", file=sys.stderr)
        return None


@dataclass
class Job:
    id: str
    owner: str
    key: str
    quality: str
    status: str = "queued"
    created: float = field(default_factory=time.monotonic)
    ended: float = 0
    error: str | None = None
    error_code: str | None = None
    artifact: dict | None = None
    issue: dict | None = None
    diagnostic_id: str | None = None
    sandbox_image: str = ""
    cancelled: bool = False
    future: Future | None = None

    def snapshot(self):
        return {"id": self.id, "status": self.status, "artifact": self.artifact, "error": self.error,
                "errorCode": self.error_code, "issue": self.issue, "diagnosticId": self.diagnostic_id,
                "queuePosition": PENDING.index(self.id) + 1 if self.id in PENDING else None}


def prune():
    now = time.monotonic()
    for key, job in list(JOBS.items()):
        if job.ended and now - job.ended > 1800:
            del JOBS[key]


def artifact_folder(owner, key):
    saved = ROOT / owner / key
    return saved if saved.is_dir() else PREVIEW_ROOT / owner / key


def run(job, request):
    work = TMP / job.id
    root = PREVIEW_ROOT if request["publication"] == "preview" else ROOT
    publish = root / job.owner / f".{job.id}"
    output = root / job.owner / job.key
    started = time.monotonic()
    try:
        with LOCK:
            if job.id in PENDING:
                PENDING.remove(job.id)
            if job.cancelled:
                return
            job.status = "rendering"
        # Recheck the pinned broker identity at dispatch, including after queuing.
        ready = sandbox_client.readiness()
        if ready.get("sandboxImage") != job.sandbox_image:
            raise Rejected("sandbox", "The verified execution backend changed. Start a new attempt.")
        work.mkdir(mode=0o700)
        try:
            result = sandbox_client.render(job.id, request, min(TIMEOUT, 120))
        finally:
            # Idempotent, also covers client transport timeout.
            sandbox_client.cancel(job.id)
        with LOCK:
            if job.cancelled:
                return
            job.status = "processing"
        metadata = verify(work, request, result)
        metadata.update({"quality": job.quality, "artifactId": job.key, "renderJobId": job.id,
                         "rendererVersion": VERSION, "sourceSha256": sha256(request["source"].encode()).hexdigest(),
                         "sandboxImage": job.sandbox_image})
        metadata["timings"]["queueMs"] = round((started - job.created) * 1000)
        metadata["timings"]["totalMs"] = round((time.monotonic() - started) * 1000)
        with LOCK:
            if job.cancelled:
                return
            if request["publication"] != "none":
                (work / "source.py").write_text(request["source"], encoding="utf8")
                (work / "timing.json").write_text(json.dumps({
                    "segments": request["segments"], "minimums": request["minimums"],
                }, ensure_ascii=False), encoding="utf8")
                (work / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf8")
                files = ("video.mp4", "poster.jpg", "source.py", "timing.json", "metadata.json")
                needed = sum((work / file).stat().st_size for file in files)
                used = sum(file.stat().st_size for directory in (ROOT, PREVIEW_ROOT)
                           for file in directory.glob("*/*/*")
                           if HEX.fullmatch(file.parent.name) and HEX.fullmatch(file.parent.parent.name)
                           and file.is_file())
                if used + needed > QUOTA:
                    raise Rejected("output", "Visualization storage quota reached.")
                publish.mkdir(mode=0o700, parents=True)
                for file in files:
                    shutil.copyfile(work / file, publish / file)
                publish.rename(output)
            job.artifact = metadata
            job.status = "completed"
        print(json.dumps({"event": "manim-artifact-checked", "job": job.id, "quality": job.quality,
                          "publication": request["publication"], "timings": metadata["timings"]}), flush=True)
    except Exception as error:
        safe = sanitize_issue(error.issue if isinstance(error, Rejected) else {"code": "runtime"})
        print(json.dumps({"event": "manim-render-failed", "job": job.id, "issue": safe.issue}), flush=True)
        with LOCK:
            if not job.cancelled:
                job.status = "failed"
                job.issue = safe.issue
                job.error = str(safe)
                if safe.issue["code"] == "timeout":
                    job.error_code = "VISUALIZATION_RENDER_TIMEOUT"
                elif safe.issue["code"] in ("sandbox", "busy"):
                    job.error_code = "VISUALIZATION_UNAVAILABLE"
        if not job.cancelled:
            job.diagnostic_id = capture_diagnostic(job.owner, request, job.quality, safe.issue)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(publish, ignore_errors=True)
        with LOCK:
            if job.cancelled:
                job.status = "cancelled"
            job.ended = time.monotonic()
            if ACTIVE.get((job.owner, job.key)) == job.id:
                ACTIVE.pop((job.owner, job.key), None)


def submit(owner, request):
    check_request(request)
    ready = sandbox_client.readiness()
    if ready.get("isolation") != "verified":
        raise Rejected("sandbox", "An administrator-approved and verified gVisor broker is required.")
    quality = request["quality"]
    body = json.dumps(request, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    key = sha256(f"{VERSION}:{ready['sandboxImage']}:{MAX_DURATION}:{MAX_VIDEO}:".encode() + body).hexdigest()
    with LOCK:
        prune()
        output = artifact_folder(owner, key) / "metadata.json"
        if request["publication"] != "none" and output.is_file():
            return {"status": "completed", "artifact": json.loads(output.read_text()), "cacheHit": True}
        existing = ACTIVE.get((owner, key))
        if existing:
            return JOBS[existing].snapshot()
        if len(ACTIVE) >= CAPACITY:
            return None
        job = Job(secrets.token_hex(32), owner, key, quality, sandbox_image=ready["sandboxImage"])
        JOBS[job.id] = job
        ACTIVE[(owner, key)] = job.id
        PENDING.append(job.id)
        job.future = POOL.submit(run, job, request)
        return job.snapshot()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def owner(self):
        authorization = self.headers.get("Authorization", "")
        owner = self.headers.get("X-Manim-Owner", "")
        if not compare_digest(authorization.encode(), f"Bearer {SECRET}".encode()) or not HEX.fullmatch(owner):
            self.send_json(401, {"error": "Renderer authentication required"})
            return None
        return owner

    def do_POST(self):
        owner = self.owner()
        if owner is None:
            return
        if self.path != "/jobs":
            self.send_json(404, {"error": "Unknown renderer endpoint"})
            return
        body = None
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= BODY_LIMIT:
                self.send_json(413, {"error": "Visualization request exceeds the size limit"})
                return
            body = json.loads(self.rfile.read(size))
            result = submit(owner, body)
        except Rejected as error:
            diagnostic = capture_diagnostic(owner, body, "static-check", error.issue) if isinstance(body, dict) else None
            self.send_json(503 if error.issue["code"] == "sandbox" else 422,
                           {"error": str(error), "issue": error.issue, "diagnosticId": diagnostic})
            return
        except (TypeError, ValueError, RecursionError):
            self.send_json(422, {"issue": sanitize_issue({"code": "request"}).issue})
            return
        if result is None:
            self.send_json(429, {"error": "Visualization queue is full. Try again shortly."})
        else:
            self.send_json(200 if result["status"] == "completed" else 202, result)

    def job(self, owner, cancel=False):
        key = self.path.removeprefix("/jobs/")
        cancel_worker = False
        with LOCK:
            prune()
            job = JOBS.get(key) if HEX.fullmatch(key) else None
            if job is None or job.owner != owner:
                status, result = 404, {"error": "Render job expired or is unavailable. Retry generation."}
            else:
                if cancel and job.status not in TERMINAL:
                    job.cancelled = True
                    cancel_worker = job.status in ("rendering", "processing")
                    if job.id in PENDING:
                        PENDING.remove(job.id)
                    job.status = "cancelled"
                    if job.future is not None and job.future.cancel():
                        job.ended = time.monotonic()
                        ACTIVE.pop((owner, job.key), None)
                status, result = 200, job.snapshot()
        if cancel_worker:
            sandbox_client.cancel(job.id)
        self.send_json(status, result)

    def do_DELETE(self):
        owner = self.owner()
        if owner is not None:
            self.job(owner, cancel=True)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"version": VERSION, "protocol": PUBLISHER_PROTOCOL, "reachable": True})
            return
        owner = self.owner()
        if owner is None:
            return
        if self.path == "/ready":
            ready = sandbox_client.readiness()
            self.send_json(200, {"version": VERSION, "protocol": PUBLISHER_PROTOCOL, "maxDuration": MAX_DURATION,
                                 "manimVersion": MANIM_VERSION, "rendererReady": True,
                                 "secureExecution": ready.get("isolation") == "verified", **ready})
            return
        if self.path.startswith("/jobs/"):
            self.job(owner)
            return
        if self.path.startswith("/diagnostics/"):
            key = self.path.removeprefix("/diagnostics/")
            with DIAGNOSTIC_LOCK:
                file = DIAGNOSTIC_ROOT / owner / f"{key}.json" if DIAGNOSTICS and HEX.fullmatch(key) else None
                try:
                    payload = (json.loads(file.read_bytes()) if file and
                               time.time() - file.stat().st_mtime < DIAGNOSTIC_TTL else None)
                except FileNotFoundError:
                    payload = None
            self.send_json(200 if payload else 404, payload or {"error": "Diagnostic unavailable"})
            return
        reference = re.fullmatch(r"/artifacts/([a-f0-9]{64})/source\.json", self.path)
        if reference:
            folder = artifact_folder(owner, reference[1])
            try:
                timing = json.loads((folder / "timing.json").read_text(encoding="utf8"))
                source = (folder / "source.py").read_text(encoding="utf8")
            except FileNotFoundError:
                self.send_json(404, {"error": "Editable source unavailable"})
                return
            self.send_json(200, {"source": source, **timing})
            return
        match = re.fullmatch(r"/artifacts/([a-f0-9]{64})/(video\.mp4|poster\.jpg)", self.path)
        if match is None:
            self.send_json(404, {"error": "Artifact unavailable"})
            return
        key, filename = match.groups()
        file = artifact_folder(owner, key) / filename
        try:
            handle = file.open("rb")
        except FileNotFoundError:
            self.send_json(404, {"error": "Artifact unavailable"})
            return
        with handle:
            length = file.stat().st_size
            start, end, status = 0, length - 1, 200
            requested = self.headers.get("Range")
            if requested:
                bounds = re.fullmatch(r"bytes=(\d{0,16})-(\d{0,16})", requested.strip())
                if bounds and any(bounds.groups()):
                    first, last = bounds.groups()
                    if first:
                        start = int(first)
                        end = min(end, int(last)) if last else end
                    else:
                        start = max(0, length - int(last))
                    status = 206 if start <= end else 416
                else:
                    status = 416
            self.send_response(status)
            self.send_header("Content-Type", MEDIA[filename])
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", "0" if status == 416 else str(end - start + 1))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{length}")
            elif status == 416:
                self.send_header("Content-Range", f"bytes */{length}")
            self.end_headers()
            if status != 416:
                handle.seek(start)
                remaining = end - start + 1
                while remaining:
                    data = handle.read(min(remaining, 65536))
                    if not data:
                        break
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    remaining -= len(data)


def main():
    if not re.fullmatch(r"[A-Za-z0-9_-]{24,128}", SECRET):
        raise SystemExit("MANIM_RENDERER_TOKEN must contain 24–128 letters, digits, underscores or hyphens")
    for binary in ("ffmpeg", "ffprobe"):
        if not shutil.which(binary):
            raise SystemExit(f"Required renderer dependency is missing: {binary}")
    for path in (ROOT, TMP):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        probe = path / f".health-{os.getpid()}"
        probe.touch(exist_ok=False)
        probe.unlink()
    for abandoned in [*TMP.glob("[a-f0-9]" * 64), *ROOT.glob("*/." + "[a-f0-9]" * 64), *PREVIEW_ROOT.glob("*/." + "[a-f0-9]" * 64)]:
        shutil.rmtree(abandoned, ignore_errors=True)
    # Existing captures age out even if capture is turned off.
    threading.Thread(target=diagnostic_cleanup, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("MANIM_PORT", "8780"))), Handler)

    def shutdown(_signal, _frame):
        with LOCK:
            active = [job.id for job in JOBS.values() if job.status in ("rendering", "processing")]
            for job in JOBS.values():
                job.cancelled = True
        for job_id in active:
            sandbox_client.cancel(job_id)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
