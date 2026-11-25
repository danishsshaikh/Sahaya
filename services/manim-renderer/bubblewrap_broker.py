"""Local Unix-socket execution service. Use a dedicated unprivileged Linux account."""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time

from bubblewrap_isolation import ENV, LAUNCH, WORKER, Policy, require, seccomp
from native_artifact import verify
from native_contract import MANIM_VERSION, MAX_RESULT, PROTOCOL, Rejected
from sandbox_broker import Handler, LOCK, RUNNING, pump

PROBE = """
import ctypes, errno, json, os, pathlib, shutil, socket, sys
import manim
assert manim.__version__ == sys.argv[1]
assert os.getuid() == 1000 and os.getgid() == 1000 and dict(os.environ) == json.loads(sys.argv[2])
assert all(shutil.which(name) for name in ('ffmpeg', 'latex', 'dvisvgm'))
assert not pathlib.Path(sys.argv[3]).exists()
assert not pathlib.Path('/proc/' + sys.argv[4]).exists()
assert not pathlib.Path('/artifacts').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/dev/nvidia0').exists()
for name, inode in json.loads(sys.argv[5]).items():
    assert os.stat('/proc/self/ns/' + name).st_ino != inode, name
for path in ('/', '/proc', '/dev'):
    assert os.statvfs(path).f_flag & os.ST_RDONLY, path
for line in pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]:
    assert line.split(':')[0].strip() == 'lo'
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert status['NoNewPrivs'].strip() == '1'
assert status['Seccomp'].strip() == '2'
assert not int(status['CapEff'].strip(), 16)
scratch = os.statvfs('/tmp')
assert 0 < scratch.f_blocks * scratch.f_frsize <= 512 * 1024**2
p = pathlib.Path('/tmp/sahaya-verify')
p.write_text('private')
p.unlink()
libc = ctypes.CDLL(None, use_errno=True)
assert libc.unshare(0x10000000) == -1 and ctypes.get_errno() == errno.EPERM
try:
    socket.socket(socket.AF_INET, socket.SOCK_STREAM)
except PermissionError:
    pass
else:
    raise AssertionError('socket filter')
for fd in os.listdir('/proc/self/fd'):
    if int(fd) > 2:
        assert not os.path.lexists('/proc/self/fd/' + fd), fd
print('namespaces-and-policy-ok')
"""
DESCENDANT = """
import subprocess, sys, time
subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(20)'],
                 start_new_session=True)
time.sleep(20)
"""
FIXTURE = {
    "source": (
        "from manim import Create, Square\nfrom sahaya_timing import CueScene\n"
        "class GeneratedScene(CueScene):\n    def construct(self):\n"
        "        with self.cue('intro'):\n            self.play(Create(Square()), run_time=0.8)\n"
    ),
    "segments": [{"id": "intro", "narration": "Synthetic isolation fixture."}],
    "minimums": {"intro": 1.0},
    "quality": "preview",
    "publication": "none",
}


class Executor:
    def __init__(self, policy):
        self.policy = policy
        self.slots = threading.BoundedSemaphore(1)
        self.failed = False
        self.verified = False

    def capability(self):
        if self.verified and not self.failed:
            try:
                self.policy.check()
            except (OSError, ValueError, subprocess.SubprocessError):
                self.failed = True
        state = "administrator-configuration-required"
        if self.failed:
            state = "unavailable"
        elif self.verified and self.policy.approved:
            state = "verified"
        return {"protocol": PROTOCOL, "backend": "bubblewrap", "isolation": state,
                "manimVersion": MANIM_VERSION, "image": self.policy.identity if state == "verified" else None}

    def execute(self, arguments, payload, done, seconds, maximum):
        require(not self.failed, "Previous cleanup or verification failed.")
        deadline = time.monotonic() + seconds
        try:
            self.policy.check()
            require(not self.policy.processes(), "Dedicated resource groups already contain processes.")
        except (Rejected, OSError, ValueError, subprocess.SubprocessError):
            self.failed = True
            raise Rejected("sandbox", "Sandbox policy or dedicated resource groups failed verification.") from None
        process = None
        gate_in = gate_out = None
        try:
            with seccomp(self.policy.library) as filter_file:
                gate_in, gate_out = os.pipe()
                launcher = [sys.executable, "-I", "-S", "-c", LAUNCH, str(gate_in),
                            *self.policy.command(filter_file.fileno(), arguments)]
                process = subprocess.Popen(launcher, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, start_new_session=True, env={},
                                           close_fds=True, pass_fds=(gate_in, filter_file.fileno()))
                os.close(gate_in)
                gate_in = None
                self.policy.attach(process.pid)
                if done.is_set():
                    raise Rejected("cancelled", "Sandbox execution was cancelled.")
                os.write(gate_out, b"1")
                os.close(gate_out)
                gate_out = None
                return pump(process, payload, done, deadline, maximum)
        except subprocess.TimeoutExpired:
            raise Rejected("timeout", "Sandbox execution exceeded its deadline.") from None
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            if isinstance(error, Rejected):
                raise
            raise Rejected("sandbox", "Could not start the Bubblewrap sandbox.") from None
        finally:
            if gate_in is not None:
                os.close(gate_in)
            if gate_out is not None:
                os.close(gate_out)
            try:
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=3)
                    process.stdin.close()
                    process.stdout.close()
                    self.policy.drain()
            except (OSError, ValueError, subprocess.SubprocessError):
                self.failed = True
                raise Rejected("sandbox", "Sandbox cleanup failed. Disable execution and ask the administrator to inspect the dedicated cgroups.") from None

    def render(self, payload, done, deadline):
        return self.execute(WORKER, payload, done, deadline, MAX_RESULT)

    def verify(self):
        self.policy.audit_tree()
        with tempfile.NamedTemporaryFile(prefix="sahaya-synthetic-canary-") as canary:
            canary.write(b"test-only")
            canary.flush()
            # A distinct host process lets the fixture check visibility without
            # accessing anyone else's files or process data.
            with subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(25)"],
                                  env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL) as witness:
                try:
                    identities = {name: os.stat(f"/proc/self/ns/{name}").st_ino
                                  for name in ("user", "mnt", "pid", "ipc", "net", "uts", "cgroup")}
                    result = self.execute(
                        ("-I", "-c", PROBE, MANIM_VERSION, json.dumps(ENV), canary.name,
                         str(witness.pid), json.dumps(identities)), b"", threading.Event(), 8, 2048)
                    require(bytes(result).strip() == b"namespaces-and-policy-ok", "Isolation probe output was invalid.")
                finally:
                    witness.terminate()
        print("Passed namespace, filesystem canary, environment, descriptors, networking and tmpfs checks.", flush=True)
        for outcome in ("timeout", "cancelled"):
            cancel = threading.Event()
            observed = threading.Event()
            stop_observing = threading.Event()

            def watch():
                while not stop_observing.wait(0.05):
                    membership = self.policy.membership()
                    if len(membership[0]) >= 4 and all(entry == membership[0] for entry in membership):
                        observed.set()
                        if outcome == "cancelled":
                            cancel.set()
                        return

            thread = threading.Thread(target=watch)
            thread.start()
            try:
                try:
                    self.execute(("-I", "-c", DESCENDANT), b"", cancel, 4, 2048)
                    raise RuntimeError("Cleanup fixture unexpectedly exited.")
                except Rejected as error:
                    require(error.issue["code"] == outcome and observed.is_set()
                            and not self.policy.processes(), "Descendant or resource group cleanup failed.")
            finally:
                stop_observing.set()
                thread.join()
        print("Passed cgroup membership, deadline, cancellation and descendant cleanup checks.", flush=True)
        result = self.render(json.dumps(FIXTURE).encode(), threading.Event(), 40)
        with tempfile.TemporaryDirectory(prefix="sahaya-manual-verification-") as directory:
            folder = Path(directory)
            output = json.loads(result)
            try:
                verify(folder, FIXTURE, {**output, "video": "../../synthetic-canary.mp4"})
            except Rejected as error:
                require(error.issue["code"] == "output" and not any(folder.iterdir()),
                        "Artifact validation did not safely reject a path in place of video bytes.")
            else:
                raise Rejected("output", "Artifact validation accepted synthetic traversal data.")
            artifact = verify(folder, FIXTURE, output)
            require(artifact["cues"][0]["end"] >= 1.0, "Manim cue did not retain the measured duration.")
        print("Passed trusted Cairo render, publisher artifact extraction and frame validation.", flush=True)
        self.verified = True


class LocalServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = False


@contextmanager
def exclusive(directory):
    info = directory.stat()
    require(directory == directory.resolve(strict=True) and directory.is_dir()
            and info.st_uid == os.getuid() and info.st_gid != 0 and info.st_mode & 0o777 == 0o750
            and (info.st_gid == os.getegid() or info.st_mode & stat.S_ISGID),
            "Use a canonical private socket directory owned by the service account (0750).")
    lock = os.open(directory / "broker.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(lock)


def serve(executor, directory, secret):
    class LocalHandler(Handler):
        def secret(self):
            return secret

        def backend_capability(self):
            return executor.capability()

        def execute_job(self, payload, done, budget):
            return executor.render(payload, done, budget)

        def slots(self):
            return executor.slots

    path = directory / "broker.sock"
    if path.exists():
        require(stat.S_ISSOCK(path.lstat().st_mode), "The broker socket path is occupied.")
        path.unlink()
    try:
        with LocalServer(str(path), LocalHandler) as server:
            path.chmod(0o660)
            print("Bubblewrap controller ready on local socket.", flush=True)

            def stop(_signum, _frame):
                raise KeyboardInterrupt

            signal.signal(signal.SIGTERM, stop)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                with LOCK:
                    for event in RUNNING.values():
                        event.set()
    finally:
        path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("verify", "serve"))
    parser.add_argument("policy")
    parser.add_argument("socket_directory", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        with exclusive(args.socket_directory):
            policy = Policy.load(args.policy)
            require(not policy.processes(), "Resource groups must be empty. Stop the prior executor first.")
            executor = Executor(policy)
            if args.mode == "serve":
                secret = os.getenv("MANIM_SANDBOX_TOKEN", "")
                require(policy.approved, "Generation is disabled pending administrator approval.")
                require(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", secret), "Set the private sandbox token.")
            executor.verify()
            if args.mode == "serve":
                serve(executor, args.socket_directory, secret)
            else:
                print("Technical verification passed. Administrator security review is a separate prerequisite.")
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        detail = str(error) if isinstance(error, Rejected) else type(error).__name__
        raise SystemExit(f"Bubblewrap unavailable: {detail}") from None


if __name__ == "__main__":
    main()
