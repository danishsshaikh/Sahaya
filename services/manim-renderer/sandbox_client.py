"""HTTPS connection from the artifact publisher to the approved sandbox broker."""

import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import re
import time
import threading

from native_contract import IMAGE_ID, MANIM_VERSION, MAX_RESULT, PROTOCOL, Rejected

URL = os.getenv("MANIM_SANDBOX_URL", "").rstrip("/")
TOKEN = os.getenv("MANIM_SANDBOX_TOKEN", "")
CACHE = None
LOCK = threading.Lock()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(NoRedirect)


def configured():
    try:
        url = urlsplit(URL)
        return (url.scheme == "https" and bool(url.hostname) and not url.username and not url.password
                and not url.fragment and not url.query and bool(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", TOKEN)))
    except ValueError:
        return False


def request(path, *, method="GET", body=None, timeout=3, limit=4096):
    if not configured():
        raise Rejected("sandbox", "Configure the administrator-approved HTTPS sandbox broker.")
    try:
        with OPENER.open(Request(URL + path, data=body, method=method, headers={
            "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json",
            "Accept": "application/json",
        }), timeout=timeout) as response:
            content = response.read(limit + 1)
            if len(content) > limit:
                raise Rejected("output", "Sandbox response exceeds its output limit.")
            return json.loads(content)
    except HTTPError as error:
        with error:
            if error.code == 422:
                try:
                    value = json.loads(error.read(4097))
                    return {"issue": value.get("issue")}
                except (ValueError, AttributeError):
                    pass
            if error.code == 429:
                raise Rejected("busy", "The sandbox queue is busy.") from None
            raise Rejected("sandbox", "The approved sandbox declined execution.") from None
    except (OSError, ValueError, URLError) as error:
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
            result = request("/ready", timeout=1.3)
            if (not isinstance(result, dict) or result.get("protocol") != PROTOCOL
                    or result.get("backend") != "gvisor" or result.get("manimVersion") != MANIM_VERSION):
                status = {"isolation": "unsupported"}
            elif result.get("isolation") == "verified" and IMAGE_ID.fullmatch(str(result.get("image"))):
                status = {"isolation": "verified", "sandboxImage": result["image"], "backend": "gvisor"}
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
