"""Linux policy and kernel resource checks for the on-host Manim executor."""

from dataclasses import dataclass
import ctypes
import errno
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import time

from native_contract import HEX, IMAGE_ID, Rejected

SCRATCH = 512 * 1024 ** 2
MEMORY = 2 * 1024 ** 3
ENV = {
    "PATH": "/opt/venv/bin:/usr/local/texlive/bin/linux:/usr/bin:/bin",
    "HOME": "/tmp", "TMPDIR": "/tmp", "XDG_CACHE_HOME": "/tmp", "PWD": "/tmp",
    "MPLCONFIGDIR": "/tmp/matplotlib", "LANG": "C.UTF-8",
    "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
    "shell_escape": "f", "openin_any": "p", "openout_any": "p",
}
CONTROLLERS = ("cpu", "memory", "pids")
PYTHON = "/opt/venv/bin/python"
WORKER = ("-I", "-B", "-c",
          "import sys,runpy; sys.path.append('/opt/sahaya-native');"
          "runpy.run_path('/opt/sahaya-native/sandbox_worker.py',run_name='__main__')")
# Wait until the supervisor has placed this PID in all three cgroups. On
# supervisor death the pipe closes and no untrusted code is started.
LAUNCH = """import ctypes, os, resource, sys
fd = int(sys.argv[1])
if os.read(fd, 1) != b'1':
    sys.exit(1)
os.close(fd)
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
if ctypes.CDLL(None).prctl(38, 1, 0, 0, 0) != 0:
    sys.exit(1)
os.execve(sys.argv[2], sys.argv[2:], {})
"""


def require(condition, message):
    if not condition:
        raise Rejected("sandbox", message)


def protected_path(raw):
    path = Path(raw)
    require(path.is_absolute() and path == path.resolve(strict=True), "Use canonical administrator-owned paths.")
    for entry in (path, *path.parents):
        info = entry.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022,
                "Sandbox paths and ancestors must be root-owned and protected from writes.")
    return path


def mounts():
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        first, second = line.split(" - ", 1)
        kind, _, options = second.split()[:3]
        point = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), first.split()[4])
        yield Path(point), kind, options.split(",")


def version(text):
    matched = re.fullmatch(r"bubblewrap (\d+)\.(\d+)\.(\d+)", text.strip())
    return tuple(map(int, matched.groups())) if matched else (0, 0, 0)


def policy_data(path):
    require(path.is_file() and 0 < path.stat().st_size <= 16384, "Use a bounded administrator policy file.")
    return path.read_bytes()


@dataclass
class Policy:
    file: Path
    image: str
    binary: Path
    library: Path
    root: Path
    groups: dict
    approved: bool
    digest: str
    executable_digest: str

    @classmethod
    def load(cls, path):
        require(os.name == "posix" and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
                and os.getuid() != 0, "Use a non-root Linux service account and Python with pidfd support (3.10+).")
        file = protected_path(path)
        data = policy_data(file)
        config = json.loads(data)
        require(set(config) == {"approved", "binary", "binary_sha256", "libseccomp", "rootfs", "image", "cgroups"}
                and type(config["approved"]) is bool and set(config["cgroups"]) == set(CONTROLLERS)
                and IMAGE_ID.fullmatch(config["image"]) and HEX.fullmatch(config["binary_sha256"]),
                "An administrator-owned policy with pinned executable, image and cgroups is required.")
        binary = protected_path(config["binary"])
        library = protected_path(config["libseccomp"])
        root = protected_path(config["rootfs"])
        groups = {key: protected_path(config["cgroups"][key]) for key in CONTROLLERS}
        require(all(not (a == b or a in b.parents or b in a.parents) for a in groups.values()
                    for b in (root,)), "Keep resource groups outside the runtime root.")
        policy = cls(file, config["image"], binary, library, root, groups, config["approved"],
                     sha256(data).hexdigest(), config["binary_sha256"])
        policy.check()
        return policy

    @property
    def identity(self):
        return "sha256:" + sha256(("bubblewrap-policy-v1:" + self.digest).encode()).hexdigest()

    def check(self):
        require(sha256(policy_data(self.file)).hexdigest() == self.digest,
                "Sandbox policy changed. Restart and rerun verification.")
        require(self.binary.is_file() and self.binary.stat().st_mode & 0o6000 == 0
                and sha256(self.binary.read_bytes()).hexdigest() == self.executable_digest,
                "The approved Bubblewrap executable changed or has set-ID bits.")
        info = subprocess.run([str(self.binary), "--version"], env={}, check=True,
                              text=True, capture_output=True, timeout=3)
        require(version(info.stdout) >= (0, 12, 0), "Bubblewrap 0.12.0 or newer is required.")
        mount_list = list(mounts())
        require(self.root != Path("/") and not any(self.root in point.parents for point, _, _ in mount_list),
                "The runtime root must have no nested mounts.")
        for name, path in self.groups.items():
            candidates = [(point, kind, options) for point, kind, options in mount_list
                          if point == path or point in path.parents]
            require(bool(candidates), "Cgroup controller mount is missing.")
            point, kind, options = max(candidates, key=lambda entry: len(entry[0].parts))
            require(kind == "cgroup" and name in options and point != path and path.is_dir()
                    and not any(entry.is_dir() for entry in path.iterdir()),
                    "Use dedicated cgroup v1 leaves.")
            require(os.access(path / "cgroup.procs", os.W_OK), "Cgroup process migration is not delegated.")
        cpu = self.groups["cpu"]
        limit_files = [cpu / "cpu.cfs_quota_us", cpu / "cpu.cfs_period_us",
                       self.groups["memory"] / "memory.limit_in_bytes",
                       self.groups["memory"] / "memory.memsw.limit_in_bytes",
                       self.groups["pids"] / "pids.max"]
        require(all(path.stat().st_uid == 0 and not os.access(path, os.W_OK) for path in limit_files),
                "Only the administrator may change cgroup limits.")
        quota, period = (int((cpu / name).read_text()) for name in ("cpu.cfs_quota_us", "cpu.cfs_period_us"))
        memory = self.groups["memory"]
        limit, swap = (int((memory / name).read_text())
                       for name in ("memory.limit_in_bytes", "memory.memsw.limit_in_bytes"))
        pids = self.groups["pids"]
        require(0 < quota <= 2 * period and 0 < limit <= MEMORY and swap == limit
                and 0 < int((pids / "pids.max").read_text()) <= 128,
                "CPU, memory without additional swap, and PID limits are required.")

    def audit_tree(self):
        worker = self.root / "opt/sahaya-native/sandbox_worker.py"
        require(self.root.is_dir() and stat.S_ISREG(worker.lstat().st_mode)
                and worker.resolve() == worker,
                "The approved Manim worker filesystem is incomplete.")
        for name in ("dev", "proc", "tmp"):
            path = self.root / name
            require(path.is_dir() and not path.is_symlink() and not any(path.iterdir()),
                    "Runtime mount targets must be empty directories.")
        def unreadable(error):
            raise error

        for folder, dirs, files in os.walk(self.root, followlinks=False, onerror=unreadable):
            for name in dirs + files:
                entry = Path(folder) / name
                info = entry.lstat()
                require(info.st_uid == 0, "Runtime files must be root-owned.")
                if stat.S_ISLNK(info.st_mode):
                    continue
                require((stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
                        and not info.st_mode & 0o6022,
                        "Remove writable, special and set-ID files from the trusted runtime.")

    def processes(self):
        return set().union(*self.membership())

    def membership(self):
        return [{int(pid) for pid in (path / "cgroup.procs").read_text().split()}
                for path in self.groups.values()]

    def attach(self, pid):
        for path in set(self.groups.values()):
            (path / "cgroup.procs").write_text(str(pid))
        require(all(str(pid) in (path / "cgroup.procs").read_text().split() for path in self.groups.values()),
                "The sandbox launcher failed to enter every resource group.")

    def command(self, filter_fd, python_args):
        return [str(self.binary), "--unshare-user", "--disable-userns", "--assert-userns-disabled", "--unshare-pid",
                "--unshare-ipc", "--unshare-net", "--unshare-uts", "--unshare-cgroup",
                "--uid", "1000", "--gid", "1000", "--cap-drop", "ALL",
                "--new-session", "--die-with-parent", "--clearenv", "--hostname", "manim-worker",
                "--ro-bind", str(self.root), "/", "--proc", "/proc", "--remount-ro", "/proc",
                "--size", "1048576", "--tmpfs", "/dev",
                *(arg for dev in ("null", "zero", "random", "urandom")
                  for arg in ("--dev-bind", f"/dev/{dev}", f"/dev/{dev}")),
                "--remount-ro", "/dev",
                "--size", str(SCRATCH), "--perms", "1777", "--tmpfs", "/tmp",
                *(arg for key, value in ENV.items() for arg in ("--setenv", key, value)),
                "--seccomp", str(filter_fd), "--chdir", "/tmp", "--", PYTHON, *python_args]

    def drain(self):
        deadline = time.monotonic() + 3
        while pids := self.processes():
            for pid in pids:
                try:
                    fd = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    if pid in self.processes():
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    os.close(fd)
            require(time.monotonic() < deadline, "Sandbox resource groups did not drain.")
            time.sleep(0.04)


class Compare(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("mask", ctypes.c_uint64), ("value", ctypes.c_uint64)]


class SeccompVersion(ctypes.Structure):
    _fields_ = [("major", ctypes.c_uint), ("minor", ctypes.c_uint), ("micro", ctypes.c_uint)]


def seccomp(library):
    """Compile the native-architecture filter with the host's libseccomp."""
    lib = ctypes.CDLL(str(library))
    lib.seccomp_version.restype = ctypes.POINTER(SeccompVersion)
    version = lib.seccomp_version().contents
    require((version.major, version.minor, version.micro) >= (2, 6, 2),
            "Use the approved libseccomp 2.6.2 or newer filter compiler.")
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                           ctypes.c_uint, ctypes.POINTER(Compare)]
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    context = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    require(bool(context), "Could not initialize seccomp.")
    output = tempfile.TemporaryFile()
    try:
        def deny(name, comparison=None, error=errno.EPERM):
            syscall = lib.seccomp_syscall_resolve_name(name.encode())
            require(syscall != -1, "Host libseccomp does not recognize a required syscall.")
            require(lib.seccomp_rule_add_array(context, 0x00050000 | error, syscall,
                                                int(comparison is not None), comparison) == 0,
                    "Could not compile the approved seccomp policy.")

        for name in ("unshare", "setns", "mount", "umount2", "pivot_root", "chroot", "bpf",
                     "ptrace", "process_vm_readv", "process_vm_writev", "pidfd_getfd",
                     "io_uring_setup", "perf_event_open", "userfaultfd", "keyctl", "add_key",
                     "request_key", "open_by_handle_at", "fsopen", "fsconfig", "fsmount",
                     "fspick", "open_tree", "move_mount", "mount_setattr", "socket"):
            deny(name)
        deny("clone3", error=errno.ENOSYS)  # Compatible glibc falls back to clone.
        for bit in (0x00000080, 0x00020000, 0x02000000, 0x04000000,
                    0x08000000, 0x10000000, 0x20000000, 0x40000000):
            deny("clone", Compare(0, 7, bit, bit))  # SCMP_CMP_MASKED_EQ
        require(lib.seccomp_export_bpf(context, output.fileno()) == 0, "Could not export seccomp.")
        output.seek(0)
        return output
    except BaseException:
        output.close()
        raise
    finally:
        lib.seccomp_release(context)
