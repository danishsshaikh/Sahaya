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
import subprocess
import sys
import threading
import time

from plan import PlanValidationError, validate
from render import COMPILER_REVISION, MAX_ARTIFACT, MAX_DURATION, QUALITIES, digest

VERSION = f"0.22.1/{COMPILER_REVISION}"
ROOT = Path(os.getenv("MANIM_ARTIFACT_DIR", "/artifacts")).resolve()
TMP = Path(os.getenv("MANIM_WORK_DIR", "/tmp/manim-jobs")).resolve()
SECRET = os.getenv("MANIM_RENDERER_TOKEN", "")
CONCURRENCY = max(1, min(4, int(os.getenv("MANIM_QUEUE_CONCURRENCY", "1"))))
CAPACITY = max(CONCURRENCY, min(32, int(os.getenv("MANIM_QUEUE_CAPACITY", "8"))))
TIMEOUT = max(10, min(600, int(os.getenv("MANIM_RENDER_TIMEOUT_SECONDS", "120"))))
QUOTA = int(os.getenv("MANIM_STORAGE_LIMIT_BYTES", str(10 * 1024 ** 3)))
BODY_LIMIT = 96 * 1024
DIAGNOSTICS = os.getenv("MANIM_CAPTURE_REJECTED_PLANS", "").lower() == "true"
DIAGNOSTIC_TTL = 24 * 60 * 60
DIAGNOSTIC_ROOT = ROOT / ".diagnostics"
DIAGNOSTIC_LOCK = threading.Lock()
HEX = re.compile(r"[a-f0-9]{64}")
MEDIA = {"video.mp4": "video/mp4", "poster.jpg": "image/jpeg", "plan.json": "application/json"}
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
        time.sleep(600)


def capture_diagnostic(owner, plan, kind, error=None):
    if not DIAGNOSTICS:
        return None
    try:
        payload = json.dumps({"plan": plan, "kind": kind,
                              "status": "rejected" if error else "accepted",
                              "issues": error.issues if error else [],
                              "blocked": error.blocked if error else []},
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
    process: subprocess.Popen | None = None
    cancelled: bool = False
    future: Future | None = None

    def snapshot(self):
        return {"id": self.id, "status": self.status, "artifact": self.artifact, "error": self.error,
                "errorCode": self.error_code,
                "queuePosition": PENDING.index(self.id) + 1 if self.id in PENDING else None}


def prune():
    now = time.monotonic()
    for key, job in list(JOBS.items()):
        if job.ended and now - job.ended > 1800:
            del JOBS[key]


def stop(process):
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run(job, body):
    work = TMP / job.id
    publish = ROOT / job.owner / f".{job.id}"
    output = ROOT / job.owner / job.key
    try:
        with LOCK:
            if job.id in PENDING:
                PENDING.remove(job.id)
            if job.cancelled:
                return
            job.status = "rendering"
            queue_ms = round((time.monotonic() - job.created) * 1000)
        work.mkdir(mode=0o700)
        (work / "plan.json").write_bytes(body)
        with (work / "render.log").open("wb") as log:
            with LOCK:
                if job.cancelled:
                    return
                job.process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name("render.py")), str(work), job.quality],
                    cwd=work, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                    env={**os.environ, "MANIM_RENDERER_TOKEN": "", "OPENBLAS_NUM_THREADS": "1",
                         "OMP_NUM_THREADS": "1"},
                )
            try:
                code = job.process.wait(timeout=TIMEOUT)
            except subprocess.TimeoutExpired:
                stop(job.process)
                job.process.wait()
                job.error_code = "VISUALIZATION_RENDER_TIMEOUT"
                raise ValueError("Visualization rendering exceeded its deadline") from None
        with LOCK:
            job.process = None
            if job.cancelled:
                return
            job.status = "processing"
        if code:
            print(f"Manim worker {job.id} exited with code {code}", file=sys.stderr, flush=True)
            raise ValueError("Manim could not render the plan. Check equations, layout and plot domains.")
        metadata = json.loads((work / "metadata.json").read_text())
        metadata["timings"]["queueMs"] = queue_ms
        metadata["quality"] = job.quality
        metadata["artifactId"] = job.key
        metadata["renderJobId"] = job.id
        metadata["planSha256"] = sha256(body).hexdigest()
        if (digest(work / "video.mp4") != metadata["sha256"]
                or digest(work / "poster.jpg") != metadata["posterSha256"]):
            raise ValueError("Visualization artifact integrity check failed")
        files = ["video.mp4", "poster.jpg", "plan.json"]
        metadata_bytes = json.dumps(metadata, ensure_ascii=False).encode()
        needed = len(metadata_bytes) + sum((work / file).stat().st_size for file in files)
        with LOCK:
            if job.cancelled:
                return
            used = sum(file.stat().st_size for file in ROOT.glob("*/*/*")
                       if file.parent.parent != DIAGNOSTIC_ROOT and file.is_file())
            if used + needed > QUOTA:
                raise ValueError("Visualization storage quota reached. Contact your administrator.")
            publish.mkdir(mode=0o700, parents=True)
            for file in files:
                shutil.copyfile(work / file, publish / file)
            (publish / "metadata.json").write_bytes(metadata_bytes)
            publish.rename(output)
            job.artifact = metadata
            job.status = "completed"
    except Exception as error:
        print(f"Manim job failed: {type(error).__name__}", file=sys.stderr, flush=True)
        with LOCK:
            if not job.cancelled:
                job.status = "failed"
                job.error = str(error) if isinstance(error, ValueError) else "Renderer could not store the visualization"
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(publish, ignore_errors=True)
        with LOCK:
            if job.cancelled:
                job.status = "cancelled"
            job.ended = time.monotonic()
            if ACTIVE.get((job.owner, job.key)) == job.id:
                ACTIVE.pop((job.owner, job.key), None)


def submit(owner, plan, quality, require_narration=False):
    validation_started = time.monotonic()
    validate(plan, MAX_DURATION, require_narration=require_narration)
    body = json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    key = sha256(f"{VERSION}:{quality}:{QUALITIES[quality]}:{MAX_ARTIFACT}:".encode() + body).hexdigest()
    with LOCK:
        prune()
        output = ROOT / owner / key / "metadata.json"
        if output.is_file():
            return {"status": "completed", "artifact": json.loads(output.read_text()), "cacheHit": True}
        existing = ACTIVE.get((owner, key))
        if existing:
            return JOBS[existing].snapshot()
        if len(ACTIVE) >= CAPACITY:
            return None
        job = Job(secrets.token_hex(32), owner, key, quality)
        JOBS[job.id] = job
        ACTIVE[(owner, key)] = job.id
        PENDING.append(job.id)
        job.future = POOL.submit(run, job, body)
        return {**job.snapshot(), "admissionMs": round((time.monotonic() - validation_started) * 1000)}


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
        kind = "repair" if self.headers.get("X-Manim-Candidate") == "repair" else "draft"
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= BODY_LIMIT:
                self.send_json(413, {"error": "Visualization request exceeds the size limit"})
                return
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict) or set(body) != {"plan", "quality"} or body["quality"] not in QUALITIES:
                raise ValueError("Expected a visualization plan and supported quality")
            result = submit(owner, body["plan"], body["quality"], self.headers.get("X-Manim-Require-Narration") == "1")
        except PlanValidationError as error:
            self.send_json(422, {"error": "Visualization plan validation failed", "issues": error.issues,
                                 "blocked": error.blocked, "truncated": error.truncated,
                                 "diagnosticId": capture_diagnostic(owner, body["plan"], kind, error)})
            return
        except (TypeError, ValueError, RecursionError):
            self.send_json(422, {"error": "Visualization plan is malformed or violates renderer constraints",
                                 "issues": [{"path": [], "code": "constraints",
                                             "message": "Check scientific domains, object layout and animation constraints"}]})
            return
        if result is None:
            self.send_json(429, {"error": "Visualization queue is full. Try again shortly."})
        else:
            if kind == "repair":
                result["diagnosticId"] = capture_diagnostic(owner, body["plan"], kind)
            self.send_json(200 if result["status"] == "completed" else 202, result)

    def job(self, owner, cancel=False):
        key = self.path.removeprefix("/jobs/")
        with LOCK:
            prune()
            job = JOBS.get(key) if HEX.fullmatch(key) else None
            if job is None or job.owner != owner:
                status, result = 404, {"error": "Render job expired or is unavailable. Retry generation."}
            else:
                if cancel and job.status not in TERMINAL:
                    job.cancelled = True
                    stop(job.process)
                    if job.id in PENDING:
                        PENDING.remove(job.id)
                    job.status = "cancelled"
                    if job.future is not None and job.future.cancel():
                        job.ended = time.monotonic()
                        ACTIVE.pop((owner, job.key), None)
                status, result = 200, job.snapshot()
        self.send_json(status, result)

    def do_DELETE(self):
        owner = self.owner()
        if owner is not None:
            self.job(owner, cancel=True)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"version": VERSION, "maxDuration": MAX_DURATION, "validationProtocol": 3})
            return
        owner = self.owner()
        if owner is None:
            return
        if self.path == "/ready":
            self.send_json(200, {"version": VERSION, "maxDuration": MAX_DURATION, "validationProtocol": 3})
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
        match = re.fullmatch(r"/artifacts/([a-f0-9]{64})/(video\.mp4|poster\.jpg|plan\.json)", self.path)
        if match is None:
            self.send_json(404, {"error": "Artifact unavailable"})
            return
        key, filename = match.groups()
        file = ROOT / owner / key / filename
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
    for binary in ("ffmpeg", "ffprobe", "latex", "dvisvgm"):
        if not shutil.which(binary):
            raise SystemExit(f"Required renderer dependency is missing: {binary}")
    for path in (ROOT, TMP):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        probe = path / f".health-{os.getpid()}"
        probe.touch(exist_ok=False)
        probe.unlink()
    for abandoned in [*TMP.glob("[a-f0-9]" * 64), *ROOT.glob("*/." + "[a-f0-9]" * 64)]:
        shutil.rmtree(abandoned, ignore_errors=True)
    # Existing captures age out even if capture is turned off.
    threading.Thread(target=diagnostic_cleanup, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("MANIM_PORT", "8780"))), Handler)

    def shutdown(_signal, _frame):
        with LOCK:
            for job in JOBS.values():
                job.cancelled = True
                stop(job.process)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
