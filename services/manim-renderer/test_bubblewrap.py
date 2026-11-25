"""Controller unit tests. Do not start Bubblewrap or execute generated code."""

from hashlib import sha256
from pathlib import Path
import subprocess
import os
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from bubblewrap_broker import Executor
from bubblewrap_isolation import Policy, LAUNCH, version
from native_contract import Rejected
import sandbox_client


class BubblewrapTests(unittest.TestCase):
    def test_version_is_numeric_and_rejects_ubuntu_focal_version(self):
        self.assertLess(version("bubblewrap 0.4.0"), (0, 12, 0))
        self.assertGreater(version("bubblewrap 0.12.10"), version("bubblewrap 0.12.9"))
        self.assertEqual(version("unexpected"), (0, 0, 0))

    def test_old_binary_fails_before_inspecting_cgroups(self):
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / "bwrap"
            binary.write_bytes(b"synthetic binary")
            binary.chmod(0o755)
            policy = Policy(binary, "", binary, binary, Path(folder), {}, True,
                            sha256(binary.read_bytes()).hexdigest(), sha256(binary.read_bytes()).hexdigest())
            with patch("bubblewrap_isolation.subprocess.run",
                       return_value=subprocess.CompletedProcess([], 0, "bubblewrap 0.4.0", "")), \
                 patch("bubblewrap_isolation.mounts") as controller_mounts:
                with self.assertRaisesRegex(Rejected, "0.12.0"):
                    policy.check()
                controller_mounts.assert_not_called()

    def test_command_has_no_repository_or_artifacts_mount(self):
        policy = Policy(Path("/config"), "", Path("/approved/bwrap"), Path("/approved/libseccomp.so"),
                        Path("/approved/rootfs"), {}, False, "", "")
        args = policy.command(12, ("-I", "worker"))
        for flag in ("--disable-userns", "--unshare-user", "--unshare-pid", "--unshare-ipc",
                     "--unshare-net", "--unshare-cgroup", "--unshare-uts", "--die-with-parent"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--ro-bind") + 1:args.index("--ro-bind") + 3],
                         ["/approved/rootfs", "/"])
        self.assertIn("--clearenv", args)
        self.assertEqual(args[args.index("--seccomp") + 1], "12")
        self.assertNotIn("/artifacts", args)
        self.assertNotIn("/var/run/docker.sock", args)

    def test_failed_cgroup_checks_block_launch_and_ready(self):
        policy = Mock(approved=True)
        policy.check.side_effect = Rejected("sandbox", "No dedicated cgroup")
        executor = Executor(policy)
        executor.verified = True
        with patch("bubblewrap_broker.subprocess.Popen") as process:
            with self.assertRaises(Rejected):
                executor.render(b"", threading.Event(), 1)
            process.assert_not_called()
        self.assertEqual(executor.capability()["isolation"], "unavailable")

    def test_checks_kernel_files_for_aggregate_limits(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary = root / "bwrap"
            binary.write_bytes(b"fixture")
            binary.chmod(0o755)
            groups = {}
            files = {
                "cpu": {"cpu.cfs_quota_us": "200000", "cpu.cfs_period_us": "100000"},
                "memory": {"memory.limit_in_bytes": "2147483648", "memory.memsw.limit_in_bytes": "2147483648"},
                "pids": {"pids.max": "128"},
            }
            for controller, limits in files.items():
                group = root / controller / "leaf"
                group.mkdir(parents=True)
                groups[controller] = group
                (group / "cgroup.procs").touch()
                for name, value in limits.items():
                    (group / name).write_text(value)
            policy = Policy(binary, "", binary, binary, root / "rootfs", groups, True,
                            sha256(b"fixture").hexdigest(), sha256(b"fixture").hexdigest())
            mode = {name for limits in files.values() for name in limits}
            real_stat = Path.stat

            def fake_stat(path, *args, **kwargs):
                value = real_stat(path, *args, **kwargs)
                if path.name in mode:
                    return os.stat_result((*value[:4], 0, *value[5:]))
                return value

            mount_points = [(path.parent, "cgroup", [controller]) for controller, path in groups.items()]
            with (
                patch.object(Path, "stat", fake_stat),
                patch("bubblewrap_isolation.os.access", side_effect=lambda path, _: path.name == "cgroup.procs"),
                patch("bubblewrap_isolation.mounts", return_value=mount_points),
                patch("bubblewrap_isolation.subprocess.run",
                      return_value=subprocess.CompletedProcess([], 0, "bubblewrap 0.12.0", "")),
            ):
                policy.check()
                for controller, name, bad in (
                    ("cpu", "cpu.cfs_quota_us", "-1"),
                    ("memory", "memory.memsw.limit_in_bytes", "3221225472"),
                    ("pids", "pids.max", "129"),
                ):
                    limit = groups[controller] / name
                    limit.write_text(bad)
                    with self.subTest(name=name), self.assertRaises(Rejected):
                        policy.check()
                    limit.write_text(files[controller][name])

    def test_technical_pass_alone_does_not_enable_generated_execution(self):
        policy = Mock(approved=False, identity="sha256:" + "a" * 64)
        executor = Executor(policy)
        executor.verified = True
        self.assertEqual(executor.capability()["isolation"], "administrator-configuration-required")
        policy.approved = True
        self.assertEqual(executor.capability()["isolation"], "verified")
        policy.check.side_effect = Rejected("sandbox", "revoked")
        self.assertEqual(executor.capability()["isolation"], "unavailable")

    def test_renderer_release_waits_for_process_migration(self):
        policy = Mock()
        policy.processes.return_value = set()
        policy.command.return_value = ["/approved/bwrap"]

        process = Mock(pid=5001)
        process.poll.return_value = 0
        executor = Executor(policy)
        with tempfile.TemporaryFile() as bpf:
            with (
                patch("bubblewrap_broker.seccomp", return_value=bpf),
                patch("bubblewrap_broker.subprocess.Popen", return_value=process) as start,
                patch("bubblewrap_broker.pump", return_value=b"checked"),
            ):
                gates = []

                def spawn(*args, **kwargs):
                    gates.append(os.dup(kwargs["pass_fds"][0]))
                    os.set_blocking(gates[0], False)
                    return process

                def attach(pid):
                    self.assertEqual(pid, 5001)
                    with self.assertRaises(BlockingIOError):
                        os.read(gates[0], 1)
                    launcher = start.call_args.args[0]
                    self.assertIn(LAUNCH, launcher)
                    # Read endpoint is closed in the supervisor before migration.
                    # Its copy in the subprocess waits until the gate is written.
                    self.assertEqual(start.call_args.kwargs["env"], {})
                    self.assertTrue(start.call_args.kwargs["close_fds"])
                    self.assertEqual(len(start.call_args.kwargs["pass_fds"]), 2)
                start.side_effect = spawn
                policy.attach.side_effect = attach
                try:
                    self.assertEqual(executor.render(b"fixture", threading.Event(), 1), b"checked")
                    self.assertEqual(os.read(gates[0], 1), b"1")
                    policy.drain.assert_called_once()
                finally:
                    for gate in gates:
                        os.close(gate)

    def test_local_socket_has_no_remote_fallback(self):
        ready = {"protocol": 1, "backend": "bubblewrap", "manimVersion": "0.22.1",
                 "isolation": "verified", "image": "sha256:" + "a"*64}
        with patch.multiple(sandbox_client, SOCKET="/run/local/broker.sock",
                            URL="https://unused.example", TOKEN="t"*32, CACHE=None):
            with patch.object(sandbox_client, "request", return_value=ready):
                self.assertEqual(sandbox_client.readiness()["backend"], "bubblewrap")
            with (
                patch.object(sandbox_client, "CACHE", None),
                patch.object(sandbox_client, "UnixConnection", side_effect=OSError),
                patch.object(sandbox_client, "OPENER") as https,
            ):
                self.assertEqual(sandbox_client.readiness()["isolation"], "unavailable")
                https.open.assert_not_called()

    def test_publisher_build_checks_healthcheck_as_non_root(self):
        dockerfile = Path(__file__).with_name("Dockerfile").read_text()
        mode = dockerfile.index("chmod 0644 /opt/sahaya-manim/*.py")
        non_root = dockerfile.index("USER 1000:1000")
        probe = dockerfile.index("RUN test -r /opt/sahaya-manim/healthcheck.py")
        self.assertLess(mode, non_root)
        self.assertLess(non_root, probe)
