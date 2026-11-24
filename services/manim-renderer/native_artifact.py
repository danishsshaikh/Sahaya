"""Verify sandbox outputs before committing owner-scoped media."""

import base64
from hashlib import sha256
import json
import math
import re
import subprocess

from native_contract import MAX_VIDEO, QUALITY, Rejected, check_frames

ERRORS = {
    "api": "Check the named Manim method, class, or missing import.",
    "arguments": "Check the Manim method's arguments and types.",
    "syntax": "Correct the Python syntax or indentation.",
    "import": "Use the permitted Manim and numerical modules.",
    "operation": "Remove unsupported file, dynamic execution, or renderer operations.",
    "entryPoint": "Define a cue-enabled GeneratedScene with construct.",
    "cues": "Check that every cue has animation frames and is used once, in order.",
    "timing": "Check the cue IDs, frame boundaries and measured durations.",
    "latex": "Check MathTex syntax, braces, and standard LaTeX commands.",
    "math": "Check the function domain and numerical operation.",
    "encode": "The renderer could not encode the scene.",
    "output": "The renderer did not produce valid bounded video.",
    "visual": "The rendered frames have insufficient visual variation.",
    "resources": "Reduce the scene's memory or geometry requirements.",
    "timeout": "The sandbox reached its execution deadline.",
    "sandbox": "The approved execution backend is unavailable.",
    "busy": "The secure rendering queue is busy. Try again shortly.",
    "cancelled": "The sandbox execution was cancelled.",
    "runtime": "Inspect the indicated Python line and Manim API usage.",
    "source": "Submit a bounded Python module.",
    "request": "Check the source, narration metadata and render settings.",
}


def sanitize_issue(data):
    if not isinstance(data, dict) or not isinstance(data.get("code"), str):
        data = {"code": "runtime"}
    code = data["code"] if data["code"] in ERRORS else "runtime"
    return Rejected(code, ERRORS[code], data.get("line"), data.get("symbol"))


def media(binary, source, *options, timeout=20):
    return subprocess.run([binary, "-v", "error", "-protocol_whitelist", "file,pipe",
                           "-f", "mov", "-enable_drefs", "0", "-i", str(source), *options],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          timeout=timeout, check=True).stdout


def verify(folder, request, payload):
    if not isinstance(payload, dict):
        raise Rejected("output", "Missing sandbox output.")
    if "issue" in payload:
        raise sanitize_issue(payload["issue"])
    if set(payload) != {"video", "frames", "timings"} or not isinstance(payload["video"], str):
        raise Rejected("output", "Sandbox response did not contain a video and cue frames.")
    try:
        data = base64.b64decode(payload["video"], validate=True)
    except (ValueError, TypeError):
        raise Rejected("output", "The sandbox produced malformed video bytes.") from None
    if not 16 < len(data) <= MAX_VIDEO or data[4:8] != b"ftyp":
        raise Rejected("output", "Sandbox output must be a bounded MP4 file.")
    width, height, fps = QUALITY[request["quality"]]
    cues, count = check_frames(payload["frames"], request["segments"], fps, request["minimums"])
    path = folder / "video.mp4"
    path.write_bytes(data)
    try:
        report = json.loads(media("ffprobe", path, "-show_entries",
            "stream=codec_name,codec_type,width,height,pix_fmt,avg_frame_rate,nb_frames",
            "-of", "json"))
        streams = report["streams"]
        if len(streams) != 1:
            raise Rejected("output", "The output must contain one silent video stream.")
        track = streams[0]
        if (track["codec_type"], track["codec_name"], track["width"], track["height"], track["pix_fmt"],
                track["avg_frame_rate"], int(track["nb_frames"])) != (
            "video", "h264", width, height, "yuv420p", f"{fps}/1", count
        ):
            raise Rejected("output", "Encoded video parameters or frame count differ from the render contract.")
        duration = count / fps
        # Decode the complete output. A separate very small RGB sample detects
        # blank frames without pretending to review layout or scientific claims.
        decoded = media("ffmpeg", path, "-xerror", "-threads", "2", "-map", "0:v:0",
                        "-frames:v", str(count + 1), "-progress", "pipe:1", "-nostats", "-f", "null", "-",
                        timeout=35)
        frame_counts = re.findall(rb"^frame=(\d+)\s*$", decoded, re.MULTILINE)
        if not frame_counts or int(frame_counts[-1]) != count:
            raise Rejected("timing", "Decoded frame count differs from the cue boundaries.")
        sample = media("ffmpeg", path, "-threads", "2",
                       "-vf", f"fps={min(fps, 4/duration):.8f}:start_time=0,scale=64:36,format=rgb24",
                       "-frames:v", "4", "-f", "rawvideo", "-")
        frame_size = 64 * 36 * 3
        channels = (sample[index + channel:index + frame_size:3]
                    for index in range(0, len(sample), frame_size) for channel in range(3))
        visible = any(max(channel, default=0) - min(channel, default=0) > 35 for channel in channels)
        if not visible:
            raise Rejected("visual", "Sampled video frames appear blank or have insufficient contrast.")
        poster = folder / "poster.jpg"
        media("ffmpeg", path, "-ss", str(max(0, cues[0]["end"] - 2 / fps)), "-frames:v", "1",
              "-vf", "scale=480:-2", str(poster))
        poster_data = poster.read_bytes()
        if len(poster_data) > 1024 ** 2 or not poster_data.startswith(b"\xff\xd8") or not poster_data.endswith(b"\xff\xd9"):
            raise Rejected("output", "The generated poster is invalid.")
    except (KeyError, TypeError, subprocess.SubprocessError) as error:
        raise Rejected("output", "The renderer could not verify or decode the produced media.") from error
    timings = payload["timings"]
    return {"duration": duration, "width": width, "height": height, "fps": fps, "bytes": len(data),
            "sha256": sha256(data).hexdigest(), "posterSha256": sha256(poster_data).hexdigest(),
            "specVersion": 1, "sourceFormat": "python", "cues": cues, "classification": "illustrative",
            "verification": {"media": "decoded", "scientific": "faculty-review-required"},
            "timings": {key: value for key, value in timings.items()
                        if key in {"renderMs", "encodeMs", "cpuSeconds", "peakMemoryKiB"}
                        and type(value) in (float, int) and 0 <= value <= 10 ** 9 and math.isfinite(value)}
            if isinstance(timings, dict) else {}}
