"""Connect to the local executor or the optional approved HTTPS broker."""

from http.client import HTTPConnection, HTTPException
import json
import os
import socket
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import re
import time
import threading

from native_contract import IMAGE_ID, MANIM_VERSION, MAX_RESULT, PROTOCOL, Rejected

URL = os.getenv("MANIM_SANDBOX_URL", "").rstrip("/")
SOCKET = os.getenv("MANIM_SANDBOX_SOCKET", "")
TOKEN = os.getenv("MANIM_SANDBOX_TOKEN", "")
CACHE = None
LOCK = threading.Lock()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(NoRedirect)


class UnixConnection(HTTPConnection):
    def connect(self):
        with_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            with_socket.settimeout(self.timeout)
            with_socket.connect(SOCKET)
            self.sock = with_socket
        except BaseException:
            with_socket.close()
            raise


def configured():
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", TOKEN):
        return False
    if SOCKET:
        return Path(SOCKET).is_absolute()
    try:
        url = urlsplit(URL)
        return (url.scheme == "https" and bool(url.hostname) and not url.username and not url.password
                and not url.fragment and not url.query)
    except ValueError:
        return False


def read_response(status, response, limit):
    if status == 422:
        try:
            return {"issue": json.loads(response.read(4097)).get("issue")}
        except (ValueError, AttributeError):
            raise Rejected("sandbox", "The executor returned an invalid error.") from None
    if status == 429:
        raise Rejected("busy", "The sandbox queue is busy.")
    if not 200 <= status < 300:
        raise Rejected("sandbox", "The approved executor declined execution.")
    content = response.read(limit + 1)
    if len(content) > limit:
        raise Rejected("output", "Sandbox response exceeds its output limit.")
    return json.loads(content)


def request(path, *, method="GET", body=None, timeout=3, limit=4096):
    if not configured():
        raise Rejected("sandbox", "Configure an administrator-approved sandbox executor.")
    headers = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json",
               "Accept": "application/json"}
    try:
        if SOCKET:
            connection = UnixConnection("localhost", timeout=timeout)
            try:
                connection.request(method, path, body=body, headers=headers)
                with connection.getresponse() as response:
                    return read_response(response.status, response, limit)
            finally:
                connection.close()
        with OPENER.open(Request(URL + path, data=body, method=method, headers=headers),
                         timeout=timeout) as response:
            return read_response(response.status, response, limit)
    except HTTPError as error:
        with error:
            return read_response(error.code, error, limit)
    except (OSError, ValueError, URLError, HTTPException) as error:
        if isinstance(error, Rejected):
            raise
        raise Rejected("sandbox", "The approved sandbox could not be reached.") from None


def readiness():
    global CACHE
    if not configured():
        return {"isolation": "administrator-configuration-required"}
    with LOCK:
        now = time.monotonic()
        if CACHE and now < CACHE[0]:
            return CACHE[1]
        try:
            expected_backend = "bubblewrap" if SOCKET else "gvisor"
            result = request("/ready", timeout=1.3)
            if (not isinstance(result, dict) or result.get("protocol") != PROTOCOL
                    or result.get("backend") != expected_backend or result.get("manimVersion") != MANIM_VERSION):
                status = {"isolation": "unsupported"}
            elif result.get("isolation") == "verified" and IMAGE_ID.fullmatch(str(result.get("image"))):
                status = {"isolation": "verified", "sandboxImage": result["image"], "backend": expected_backend}
            elif result.get("isolation") in ("administrator-configuration-required", "unsupported", "unavailable"):
                status = {"isolation": result["isolation"]}
            else:
                status = {"isolation": "unsupported"}
        except Rejected:
            status = {"isolation": "unavailable"}
        CACHE = (now + 5, status)
        return status


def cancel(job):
    try:
        request(f"/execute/{job}", method="DELETE", timeout=2)
    except Rejected:
        pass


def render(job, candidate, timeout):
    # Spoken text and captions are stored here and never sent to the worker.
    worker = {**candidate, "segments": [
        {"id": cue["id"], **({"narration": "Cue"} if "narration" in cue else {})}
        for cue in candidate["segments"]
    ]}
    return request(f"/execute/{job}", method="POST", body=json.dumps(worker, ensure_ascii=False).encode(),
                   timeout=timeout, limit=MAX_RESULT)
