"""Image entry point. Never launch this worker on a host or in the publisher."""

import base64
import json
import os
from pathlib import Path
import resource
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import traceback

from native_contract import (MANIM_VERSION, MAX_REQUEST, MAX_VIDEO, QUALITY, PROTOCOL,
                             Rejected, check_frames, check_request)


def probe():
    import manim
    if (os.getuid() == 0 or manim.__version__ != MANIM_VERSION
            or not all(shutil.which(name) for name in ("ffmpeg", "latex", "dvisvgm"))):
        raise RuntimeError("identity")
    if any(Path(path).exists() for path in ("/artifacts", "/var/run/docker.sock", "/dev/nvidia0")):
        raise RuntimeError("mount")
    if set(os.environ) & {"MANIM_RENDERER_TOKEN", "MANIM_SANDBOX_TOKEN", "CONTEXT7_API_KEY", "OPENAI_API_KEY"}:
        raise RuntimeError("credentials")
    if any(name != "lo" for _, name in socket.if_nameindex()):
        raise RuntimeError("network")
    if not os.statvfs("/").f_flag & os.ST_RDONLY:
        raise RuntimeError("read-only")
    return {"protocol": PROTOCOL, "manimVersion": MANIM_VERSION, "probe": "passed"}


def read_video(file):
    # Only the worker reads this untrusted path. The broker receives raw bytes
    # through a bounded pipe, never mounts or unpacks the sandbox filesystem.
    if not file.parent.resolve().is_relative_to(Path("/tmp").resolve()):
        raise Rejected("output", "The render output path is invalid.")
    with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_VIDEO:
            raise Rejected("output", "Manim did not produce a bounded MP4.")
        return handle.read(MAX_VIDEO + 1)


def run(request):
    import manim as m
    from sahaya_timing import CueTiming
    if m.__version__ != MANIM_VERSION:
        raise Rejected("sandbox", "The worker has the wrong Manim version.")
    width, height, fps = QUALITY[request["quality"]]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(dir="/tmp") as directory:
        path = Path(directory)
        with m.tempconfig({
            "renderer": "cairo", "media_dir": str(path / "media"), "output_file": "source",
            "pixel_width": width, "pixel_height": height, "frame_rate": fps, "disable_caching": True,
            "background_color": "#101924", "progress_bar": "none", "verbosity": "ERROR",
            "random_seed": 0, "format": "mp4",
        }):
            module = {"__name__": "sahaya_generated"}
            # This is the sole runtime execution point for generated Python.
            exec(compile(request["source"], "<sahaya-scene>", "exec"), module)
            cls = module["GeneratedScene"]
            if not isinstance(cls, type) or not issubclass(cls, CueTiming):
                raise Rejected("entryPoint", "Inherit from a Sahaya cue-enabled Manim scene.")
            scene = cls()
            scene._cue_frames = []
            scene._cue_ids = [entry["id"] for entry in request["segments"]]
            scene._cue_minimums = request["minimums"]
            scene._cue_fps = fps
            scene._cue_open = False
            scene.render()
            source = Path(scene.renderer.file_writer.movie_file_path)
            frames = scene._cue_frames
            _, count = check_frames(frames, request["segments"], fps, request["minimums"])
            if count != round(scene.renderer.time * fps):
                raise Rejected("timing", "Put all animation frames inside named cues.")
        rendered = time.monotonic()
        movie = path / "video.mp4"
        if not source.is_relative_to(path) or source.is_symlink():
            raise Rejected("output", "Manim did not produce a safe media file.")
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file",
            "-f", "mov", "-i", str(source), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "libx264", "-threads", "2",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-fs", str(MAX_VIDEO), str(movie),
        ], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        video = read_video(movie)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"video": base64.b64encode(video).decode("ascii"), "frames": frames, "timings": {
        "renderMs": round((rendered - started) * 1000),
        "encodeMs": round((time.monotonic() - rendered) * 1000),
        "cpuSeconds": round(usage.ru_utime + usage.ru_stime + children.ru_utime + children.ru_stime, 3),
        "peakMemoryKiB": max(usage.ru_maxrss, children.ru_maxrss),
    }}


def failure(error):
    if isinstance(error, Rejected):
        return error.issue
    if isinstance(error, SyntaxError):
        return Rejected("syntax", "Correct the Python syntax or indentation.", error.lineno).issue
    line = next((entry.lineno for entry in reversed(traceback.extract_tb(error.__traceback__))
                 if entry.filename == "<sahaya-scene>"), None)
    if isinstance(error, (NameError, AttributeError)):
        return Rejected("api", "Check the imported class, method, or undefined symbol.", line,
                        getattr(error, "name", None)).issue
    if isinstance(error, TypeError):
        return Rejected("arguments", "Check the arguments and types at the failing Manim call.", line).issue
    if isinstance(error, subprocess.CalledProcessError):
        return Rejected("encode", "FFmpeg could not encode the generated media.", line).issue
    if "latex" in str(error).lower() or "dvisvgm" in str(error).lower():
        return Rejected("latex", "Check MathTex syntax, braces, and supported commands.", line).issue
    if isinstance(error, ArithmeticError):
        return Rejected("math", "A mathematical calculation failed in the selected domain.", line).issue
    if isinstance(error, MemoryError):
        return Rejected("resources", "Reduce the scene's memory or geometry requirements.", line).issue
    return Rejected("runtime", "The scene failed during Cairo rendering. Inspect the indicated Python line.", line).issue


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        print(json.dumps(probe()), flush=True)
        sys.exit(0)
    # Save the result pipe and suppress all Python/TeX/native progress output.
    # The publisher additionally treats the entire pipe as untrusted data.
    with os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf8") as output, open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
        try:
            data = sys.stdin.buffer.read(MAX_REQUEST + 1)
            if len(data) > MAX_REQUEST:
                raise Rejected("request", "Sandbox request exceeds its limit.")
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_VIDEO, MAX_VIDEO))
            result = run(check_request(json.loads(data)))
        except Exception as error:
            result = {"issue": failure(error)}
        json.dump(result, output, allow_nan=False, separators=(",", ":"))
        output.flush()
