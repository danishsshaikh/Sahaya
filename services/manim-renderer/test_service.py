"""Real HTTP queue, Cairo, storage and media checks (opt-in)."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from demos import demos
from plan import validate


@unittest.skipUnless(os.getenv("MANIM_REAL_TESTS") == "1", "enable actual Cairo tests with MANIM_REAL_TESTS=1")
class RendererServiceTests(unittest.TestCase):
    secret = "test-renderer-token-123456789"
    owner = "1" * 64
    outsider = "2" * 64
    endpoint = "http://127.0.0.1:18780"

    def request(self, path, *, owner=None, method="GET", body=None, headers=None, authenticated=True):
        request_headers = headers or {}
        if authenticated:
            request_headers = {**request_headers, "Authorization": f"Bearer {self.secret}",
                               "X-Manim-Owner": owner or self.owner}
        data = None
        if body is not None:
            data = json.dumps(body).encode() if isinstance(body, dict) else body
            request_headers["Content-Type"] = "application/json"
        request = Request(self.endpoint + path, data=data, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=4) as response:
                return response.status, response.read()
        except HTTPError as error:
            with error:
                return error.code, error.read()

    def start(self, data):
        env = {**os.environ, "MANIM_RENDERER_TOKEN": self.secret, "MANIM_PORT": "18780",
               "MANIM_QUEUE_CONCURRENCY": "1", "MANIM_QUEUE_CAPACITY": "2",
               "MANIM_CAPTURE_REJECTED_PLANS": "true",
               "MANIM_ARTIFACT_DIR": str(data / "artifacts"), "MANIM_WORK_DIR": str(data / "jobs")}
        log = (data / "service.log").open("ab")
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("server.py"))],
                                   env=env, stdout=log, stderr=subprocess.STDOUT)
        log.close()
        for _ in range(50):
            if process.poll() is not None:
                break
            try:
                if self.request("/health", authenticated=False)[0] == 200:
                    return process
            except URLError:
                pass
            time.sleep(.1)
        self.stop(process)
        self.fail((data / "service.log").read_text())

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.terminate()
            process.wait(10)

    def test_real_render_queue_authentication_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            process = self.start(data)
            try:
                fixture = Path(__file__).with_name("fixtures") / "llm-diffraction.json"
                bad_request = {"plan": json.loads(fixture.read_text()), "quality": "preview"}
                status, payload = self.request("/jobs", method="POST", body=bad_request)
                self.assertEqual(status, 422)
                refused = json.loads(payload)
                self.assertNotIn("id", refused)
                issues = {tuple(entry["path"]): entry for entry in refused["issues"]}
                self.assertEqual(issues[("engine",)]["code"], "required")
                self.assertEqual(issues[("objects", 1, "size")]["value"], 18)
                self.assertEqual(issues[("objects", 1, "size")]["limit"], 10)
                key = refused["diagnosticId"]
                self.assertEqual(self.request(f"/diagnostics/{key}", authenticated=False)[0], 401)
                self.assertEqual(self.request(f"/diagnostics/{key}", owner=self.outsider)[0], 404)
                status, captured = self.request(f"/diagnostics/{key}")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(captured)["plan"], bad_request["plan"])

                fixtures = os.getenv("MANIM_COMPILED_FIXTURES_PATH")
                plan = demos()["derivative"]
                if fixtures:
                    plans = json.loads(Path(fixtures).read_text())
                    self.assertGreaterEqual(len(plans), 7)
                    for candidate in plans:
                        with self.subTest(candidate=candidate["title"]):
                            validate(candidate, require_narration=True)
                    plan = plans[0]
                request = {"plan": plan, "quality": "preview"}
                status, payload = self.request("/jobs", method="POST", body=request,
                                               headers={"X-Manim-Candidate": "repair",
                                                        "X-Manim-Require-Narration": "1"})
                self.assertEqual(status, 202, payload)
                job = json.loads(payload)
                status, captured = self.request(f"/diagnostics/{job['diagnosticId']}")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(captured)["status"], "accepted")
                path = f"/jobs/{job['id']}"
                self.assertEqual(self.request(path, authenticated=False)[0], 401)
                self.assertEqual(self.request(path, owner=self.outsider)[0], 404)
                self.assertEqual(self.request(path, owner=self.outsider, method="DELETE")[0], 404)
                _, duplicate = self.request("/jobs", method="POST", body=request)
                self.assertEqual(json.loads(duplicate)["id"], job["id"])
                status, another = self.request("/jobs", method="POST",
                                               body={"plan": demos()["sorting"], "quality": "preview"})
                self.assertEqual(status, 202, another)
                other_id = json.loads(another)["id"]
                _, cancelled = self.request(f"/jobs/{other_id}", method="DELETE")
                self.assertEqual(json.loads(cancelled)["status"], "cancelled")
                self.assertEqual(self.request("/jobs", method="POST", body=b" " * 100_000)[0], 413)
                self.assertEqual(self.request("/jobs", method="POST",
                                              body={"plan": request["plan"], "quality": "python"})[0], 422)
                for _ in range(160):
                    _, payload = self.request(path)
                    completed = json.loads(payload)
                    if completed["status"] in {"completed", "failed", "cancelled"}:
                        break
                    time.sleep(.15)
                self.assertEqual(completed["status"], "completed",
                                 (completed, (data / "service.log").read_text()))
                artifact = completed["artifact"]
                self.assertEqual((artifact["width"], artifact["height"], artifact["fps"]), (854, 480, 15))
                self.assertEqual(len(artifact["cues"]), 3)
                self.assertAlmostEqual(artifact["cues"][-1]["end"], artifact["duration"])
                self.assertEqual(artifact["cues"][0]["end"], artifact["cues"][1]["start"])
                key = artifact["artifactId"]
                movie_path = f"/artifacts/{key}/video.mp4"
                self.assertEqual(self.request(movie_path, owner=self.outsider)[0], 404)
                partial_status, partial = self.request(movie_path, headers={"Range": "bytes=0-31"})
                self.assertEqual((partial_status, len(partial)), (206, 32))
                self.assertEqual(self.request(movie_path, headers={"Range": "bytes=9999999-"})[0], 416)
                self.assertEqual(self.request(f"/artifacts/{key}/poster.jpg")[0], 200)
                self.assertEqual(json.loads(self.request(f"/artifacts/{key}/plan.json")[1]), plan)
                self.assertEqual(self.request(f"/artifacts/{key}/../metadata.json")[0], 404)
                _, video = self.request(movie_path)
                self.assertEqual(hashlib.sha256(video).hexdigest(), artifact["sha256"])
                file = data / "decode.mp4"
                file.write_bytes(video)
                subprocess.run(["ffmpeg", "-v", "error", "-i", str(file), "-f", "null", "-"], check=True)

                self.stop(process)
                process = self.start(data)
                self.assertEqual(self.request(path)[0], 404)
                status, cached = self.request("/jobs", method="POST", body=request)
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(cached)["cacheHit"])
                self.assertEqual(self.request(movie_path)[1], video)
            except Exception:
                print((data / "service.log").read_text(), file=sys.stderr)
                raise
            finally:
                self.stop(process)


class WorkerDeadlineTests(unittest.TestCase):
    def test_deadline_terminates_process_group_and_releases_work_directory(self):
        from unittest.mock import Mock, patch

        import server

        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            tmp = data / "jobs"
            tmp.mkdir()
            job = server.Job("a" * 64, "b" * 64, "c" * 64, "preview")
            process = Mock(pid=123)
            process.wait.side_effect = [subprocess.TimeoutExpired("manim", 1), -9]
            with (patch.object(server, "ROOT", data / "artifacts"),
                  patch.object(server, "TMP", tmp),
                  patch.object(server.subprocess, "Popen", return_value=process),
                  patch.object(server.os, "killpg") as kill):
                server.run(job, b"{}")
            kill.assert_called_once_with(process.pid, server.signal.SIGKILL)
            self.assertEqual(job.status, "failed")
            self.assertIn("deadline", job.error)
            self.assertFalse((tmp / job.id).exists())
