"""Administrator-owned gVisor broker. Run on a dedicated execution host."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from hmac import compare_digest
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import subprocess
import threading
import time

from native_contract import (HEX, IMAGE_ID, MANIM_VERSION, MAX_REQUEST, MAX_RESULT, PROTOCOL,
                             Rejected, check_request)

DOCKER = os.getenv("MANIM_SANDBOX_DOCKER", "/usr/bin/docker")
IMAGE = os.getenv("MANIM_SANDBOX_IMAGE", "")
SECRET = os.getenv("MANIM_SANDBOX_TOKEN", "")
APPROVED = os.getenv("MANIM_SANDBOX_APPROVED") == "true"
LABEL = "org.sahaya.manim-sandbox"
OPTIONS = [
    "--runtime=runsc", "--pull=never", "--network=none", "--ipc=private", "--read-only",
    "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--cpus=2", "--memory=2g", "--memory-swap=2g", "--pids-limit=128",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777",
    "--log-driver=none", "--ulimit=nofile=256:256",
    *("--env=" + key + "=" for key in ("HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
                                      "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy")),
]
PREVIEW_SECONDS = max(10, min(90, int(os.getenv("MANIM_SANDBOX_PREVIEW_SECONDS", "45"))))
FINAL_SECONDS = max(15, min(115, int(os.getenv("MANIM_SANDBOX_FINAL_SECONDS", "105"))))
LOCK = threading.Lock()
SLOTS = threading.BoundedSemaphore(max(1, min(2, int(os.getenv("MANIM_SANDBOX_CONCURRENCY", "1")))))
RUNNING = {}
CLEANUP_PENDING = set()
CAPABILITY = ("administrator-configuration-required", 0)


def docker(*arguments):
    return subprocess.run([DOCKER, *arguments], check=True, timeout=10,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout


def inspect_container(data):
    host = data["HostConfig"]
    env = dict(item.split("=", 1) for item in data["Config"].get("Env", []))
    if (host["Runtime"] != "runsc" or host["NetworkMode"] != "none"
            or host["IpcMode"] != "private" or not host["ReadonlyRootfs"] or host["Privileged"]
            or data["Config"]["User"] != "1000:1000" or data["Image"] != IMAGE
            or host.get("Binds") or host.get("Devices") or host.get("DeviceRequests")
            or host.get("CapAdd") or host.get("PidMode") or host.get("UtsMode")
            or any(value and re.search(r"TOKEN|CREDENTIAL|SECRET|PASSWORD|PROXY", name, re.I)
                   for name, value in env.items())
            or any(mount.get("Type") != "tmpfs" or mount.get("Destination") != "/tmp"
                   for mount in data.get("Mounts", []))
            or "ALL" not in host.get("CapDrop", [])
            or not any(option.startswith("no-new-privileges") for option in host.get("SecurityOpt", []))
            or host["PidsLimit"] != 128 or host["Memory"] != 2 * 1024 ** 3
            or host["MemorySwap"] != host["Memory"] or host["NanoCpus"] != 2 * 10 ** 9
            or host["Tmpfs"] != {"/tmp": "rw,noexec,nosuid,nodev,size=512m,mode=1777"}):
        raise Rejected("sandbox", "Container isolation settings failed verification.")


def pump(process, payload, done, deadline, maximum):
    sent = 0
    result = bytearray()
    with selectors.DefaultSelector() as selector:
        for file, event in ((process.stdin, selectors.EVENT_WRITE), (process.stdout, selectors.EVENT_READ)):
            os.set_blocking(file.fileno(), False)
            selector.register(file, event)
        while selector.get_map():
            if done.is_set():
                raise Rejected("cancelled", "Sandbox execution was cancelled.")
            if time.monotonic() >= deadline:
                raise Rejected("timeout", "Sandbox execution exceeded its deadline.")
            for key, _ in selector.select(0.15):
                try:
                    if key.fileobj == process.stdin:
                        sent += os.write(key.fd, payload[sent:sent + 16384]) if sent < len(payload) else 0
                        if sent == len(payload):
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                    else:
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        result.extend(chunk)
                        if len(result) > maximum:
                            raise Rejected("output", "Sandbox output exceeded its size limit.")
                except BrokenPipeError:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                except BlockingIOError:
                    continue
    while process.poll() is None:
        if done.wait(0.05):
            raise Rejected("cancelled", "Sandbox execution was cancelled.")
        if time.monotonic() >= deadline:
            raise Rejected("timeout", "Sandbox execution exceeded its deadline.")
    if process.returncode != 0:
        raise Rejected("resources", "The sandbox process exited. Reduce scene complexity or check worker health.")
    return result


def execute(payload, done, seconds, *, probe=False):
    name = "sahaya-manim-" + secrets.token_hex(12)
    deadline = time.monotonic() + seconds
    process = None
    try:
        docker("create", "-i", "--name", name, "--label", LABEL, *OPTIONS, IMAGE,
               *(["--probe"] if probe else []))
        inspect_container(json.loads(docker("inspect", name))[0])
        if done.is_set():
            raise Rejected("cancelled", "Sandbox execution was cancelled.")
        process = subprocess.Popen([DOCKER, "start", "-a", "-i", name], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return pump(process, payload, done, deadline, 2048 if probe else MAX_RESULT)
    except subprocess.TimeoutExpired:
        raise Rejected("timeout", "Sandbox execution exceeded its deadline.") from None
    except (subprocess.SubprocessError, OSError, KeyError, TypeError, ValueError) as error:
        if isinstance(error, Rejected):
            raise
        raise Rejected("sandbox", "The approved sandbox runtime could not start.") from None
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()
        # Removing the container stops every sandbox process even if the attach
        # process disconnected. No user-controlled string is used in daemon CLI.
        try:
            docker("rm", "-f", name)
        except (subprocess.SubprocessError, OSError):
            with LOCK:
                CLEANUP_PENDING.add(name)


def reap():
    with LOCK:
        names = tuple(CLEANUP_PENDING)
    if not names:
        return
    try:
        present = set(docker("ps", "-a", "--format", "{{.Names}}", "--filter", f"label={LABEL}").decode().splitlines())
        for name in names:
            if name in present:
                docker("rm", "-f", name)
            with LOCK:
                CLEANUP_PENDING.discard(name)
    except (subprocess.SubprocessError, OSError):
        print("Manim sandbox cleanup pending", flush=True)


def preflight():
    global CAPABILITY
    status = "administrator-configuration-required"
    if APPROVED and IMAGE_ID.fullmatch(IMAGE):
        status = "unsupported"
        try:
            info = json.loads(docker("info", "--format", "{{json .}}"))
            runtime = info.get("Runtimes", {}).get("runsc", {})
            if (Path(runtime.get("path", "")).name == "runsc"
                    and all(info.get(key) is True for key in ("MemoryLimit", "SwapLimit", "CpuCfsQuota", "PidsLimit"))):
                raw = execute(b"", threading.Event(), 15, probe=True)
                if json.loads(raw) == {"protocol": PROTOCOL, "manimVersion": MANIM_VERSION, "probe": "passed"}:
                    status = "verified"
        except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
            pass
    CAPABILITY = (status, time.monotonic())
    print(f"Manim sandbox capability: {status}", flush=True)
    return status


def capability():
    status, checked = CAPABILITY
    with LOCK:
        if CLEANUP_PENDING:
            status = "unavailable"
    if checked and time.monotonic() - checked > 100:
        status = "unavailable"
    return {"protocol": PROTOCOL, "backend": "gvisor", "isolation": status,
            "manimVersion": MANIM_VERSION, "image": IMAGE if status == "verified" else None}


def monitor():
    while True:
        time.sleep(35)
        reap()
        if SLOTS.acquire(blocking=False):
            try:
                preflight()
            finally:
                SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    def secret(self):
        return SECRET

    def backend_capability(self):
        return capability()

    def execute_job(self, payload, done, budget):
        return execute(payload, done, budget)

    def slots(self):
        return SLOTS

    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def log_message(self, _format, *_args):
        # Keep request metadata and untrusted strings out of logs.
        return

    def reply(self, status, data):
        raw = data if isinstance(data, (bytes, bytearray)) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self):
        if not compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {self.secret()}".encode()):
            self.reply(401, {"error": "Sandbox authentication required"})
            return False
        return True

    def job_id(self):
        value = self.path.removeprefix("/execute/")
        return value if HEX.fullmatch(value) else None

    def do_GET(self):
        if self.authorized():
            self.reply(200, self.backend_capability()) if self.path == "/ready" else self.reply(404, {})

    def do_POST(self):
        if not self.authorized():
            return
        job = self.job_id()
        if not job:
            self.reply(404, {})
            return
        if self.backend_capability()["isolation"] != "verified":
            self.reply(503, {"error": "Verified sandbox unavailable"})
            return
        if not self.slots().acquire(blocking=False):
            self.reply(429, {"error": "Sandbox queue is busy"})
            return
        done = threading.Event()
        try:
            with LOCK:
                if job in RUNNING:
                    self.reply(409, {})
                    return
                RUNNING[job] = done
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= MAX_REQUEST:
                self.reply(413, {})
                return
            payload = self.rfile.read(size)
            request = check_request(json.loads(payload))
            budget = PREVIEW_SECONDS if request["quality"] == "preview" else FINAL_SECONDS
            result = self.execute_job(payload, done, budget)
            self.reply(200, result)
        except Rejected as error:
            self.reply(422, {"issue": error.issue})
        except (ValueError, TypeError, RecursionError):
            self.reply(422, {"issue": {"code": "request"}})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            with LOCK:
                if RUNNING.get(job) is done:
                    RUNNING.pop(job, None)
            self.slots().release()

    def do_DELETE(self):
        if not self.authorized():
            return
        job = self.job_id()
        with LOCK:
            done = RUNNING.get(job)
            if done is not None:
                done.set()
        self.reply(200 if done is not None else 404, {})


def main():
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", SECRET):
        raise SystemExit("Set a private MANIM_SANDBOX_TOKEN of at least 32 URL-safe characters.")
    os.umask(0o077)
    if APPROVED:
        try:
            for container in docker("ps", "-aq", "--filter", f"label={LABEL}").decode().splitlines():
                if re.fullmatch(r"[a-f0-9]{12,64}", container):
                    docker("rm", "-f", container)
        except (OSError, subprocess.SubprocessError):
            raise SystemExit("The broker could not clear its dedicated execution queue.") from None
    preflight()
    threading.Thread(target=monitor, daemon=True).start()

    def shutdown(_signum, _frame):
        with LOCK:
            for done in RUNNING.values():
                done.set()
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, shutdown)
    with ThreadingHTTPServer(("127.0.0.1", int(os.getenv("MANIM_SANDBOX_PORT", "8790"))), Handler) as server:
        # Keep request threads alive until their sandbox cleanup runs.
        server.daemon_threads = False
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            shutdown_started = time.monotonic()
            with LOCK:
                for done in RUNNING.values():
                    done.set()
            while RUNNING and time.monotonic() - shutdown_started < 12:
                time.sleep(0.1)


if __name__ == "__main__":
    main()
