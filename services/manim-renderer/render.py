"""Trusted Cairo compositor. The model controls only validated data."""

import hashlib
import json
import os
import resource
from pathlib import Path
import subprocess
import sys
import time

from plan import validate

QUALITIES = {"preview": (854, 480, 15), "standard": (1280, 720, 30), "high": (1920, 1080, 30)}
MAX_DURATION = min(120, int(os.getenv("MANIM_MAX_DURATION", "90")))
MAX_ARTIFACT = int(os.getenv("MANIM_MAX_ARTIFACT_BYTES", str(48 * 1024 * 1024)))
COMPILER_REVISION = "2"


def digest(file):
    with file.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def run_media(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT)


def render(folder, plan, quality):
    start = time.monotonic()
    full_started = start
    timings_ms = {}
    data, plots = validate(plan, MAX_DURATION, timings_ms)
    timings_ms["validationMs"] = max(0, round((time.monotonic() - start) * 1000) - timings_ms["scienceMs"])
    import manim as m
    import numpy as np

    width, height, fps = QUALITIES[quality]
    spatial = ("camera" in plan or any("camera" in beat for beat in plan["timeline"])
               or any(obj["kind"] in {"axes3d", "surface", "sphere"} for obj in plan["objects"]))
    base = m.ThreeDScene if spatial else m.Scene
    segments = []

    def xyz(pair):
        return np.array([*pair, 0], dtype=float)

    def axis_range(values, divisions=5):
        lo, hi = values
        return [lo, hi, (hi - lo) / divisions]

    class Visualization(base):
        def construct(self):
            objects = {}

            def axes(obj, color, cls):
                ranges = dict(x_range=axis_range(obj.get("xRange", [-5, 5])),
                              y_range=axis_range(obj.get("yRange", [-3, 3])),
                              x_length=obj.get("size", 9), y_length=obj.get("height", 5))
                if cls is m.ThreeDAxes:
                    ranges.update(z_range=axis_range(obj.get("zRange", [-2, 12])), z_length=4)
                return cls(**ranges, axis_config={"color": color, "include_numbers": False})

            def graph(obj, color):
                axis = objects[obj["axes"]]
                coords = [axis.c2p(x, y) for x, y in plots[obj["id"]]]
                if obj["kind"] == "samples":
                    return m.VGroup(*(m.Dot(point, radius=0.065, color=color) for point in coords))
                return m.VMobject(color=color).set_points_as_corners(coords)

            def samples3d(obj, color):
                axis = objects[obj["axes"]]
                return m.VGroup(*(m.Dot3D(axis.c2p(x, 0, z), radius=0.085, color=color, resolution=(8, 8))
                                  for x, z in plots[obj["id"]]))

            def surface(obj, color):
                fn, u_range, v_range = plots[obj["id"]]
                axis = objects[obj["axes"]]
                return m.Surface(lambda u, v: axis.c2p(u, v, fn(float(u), float(v))),
                                 u_range=u_range, v_range=v_range, resolution=(12, 12),
                                 checkerboard_colors=False, fill_color=color, fill_opacity=0.65,
                                 stroke_width=0.5)

            def array(obj, color):
                cells = []
                for value in data.arrays[obj.get("index", 0)]:
                    box = m.RoundedRectangle(width=0.75, height=0.65, corner_radius=0.09, color=color)
                    cells.append(m.VGroup(box, m.Text(str(value), font="Noto Sans", font_size=29, color=color).move_to(box)))
                return m.VGroup(*cells).arrange(m.RIGHT, buff=0.12)

            def text(obj, color):
                kind = obj["kind"]
                value = obj.get("text", "")
                if kind == "modelValue":
                    x, y = data.samples[obj["source"]][obj.get("index", 0)]
                    number = x if obj["component"] == "x" else y
                    value += f"{number:.2f}"
                color_options = {"color": color, "font_size": obj.get("size", 4.5 if kind == "equation" else 3.6) * 10}
                label = m.MathTex(value, **color_options) if kind == "equation" else m.Text(value, font="Noto Sans", **color_options)
                x, y = obj.get("at", (0, 0))
                safe_width = max(0.8, 13.2 - 2 * abs(x))
                safe_height = max(0.5, min(2.4, 7.6 - 2 * abs(y)))
                if label.width > safe_width:
                    label.scale_to_fit_width(safe_width)
                if label.height > safe_height:
                    label.scale_to_fit_height(safe_height)
                return label

            def line(obj, color):
                start, end = map(xyz, obj["points"])
                if obj["kind"] == "arrow":
                    return m.Arrow(start, end, color=color, buff=0)
                return m.Line(start, end, color=color)

            registry = {
                "text": text, "equation": text, "modelValue": text, "line": line, "arrow": line,
                "dot": lambda o, c: m.Dot(radius=o.get("size", 0.1), color=c),
                "circle": lambda o, c: m.Circle(radius=o.get("size", 1), color=c),
                "rectangle": lambda o, c: m.Rectangle(width=o.get("size", 2), height=o.get("height", 1), color=c),
                "polygon": lambda o, c: m.Polygon(*map(xyz, o["points"]), color=c),
                "axes": lambda o, c: axes(o, c, m.Axes),
                "plane": lambda o, c: axes(o, c, m.NumberPlane),
                "axes3d": lambda o, c: axes(o, c, m.ThreeDAxes),
                "graph": graph, "curve": graph, "samples": graph, "samples3d": samples3d, "array": array, "surface": surface,
                "sphere": lambda o, c: m.Sphere(radius=o.get("size", 1), resolution=(12, 12)).set_color(c),
            }
            if spatial:
                camera = plan.get("camera", {"phi": 65, "theta": -45})
                self.set_camera_orientation(phi=camera["phi"] * m.DEGREES, theta=camera["theta"] * m.DEGREES)
            for obj in plan["objects"]:
                item = registry[obj["kind"]](obj, obj.get("color", "#E7EEF8"))
                if "at" in obj:
                    item.move_to(xyz(obj["at"]))
                if "opacity" in obj:
                    item.set_opacity(obj["opacity"])
                objects[obj["id"]] = item

            def animation(entry):
                obj = objects[entry["object"]]
                op = entry["op"]
                simple = {"create": m.Create, "write": m.Write, "fadeIn": m.FadeIn,
                          "fadeOut": m.FadeOut, "indicate": m.Indicate}
                if op in simple:
                    return simple[op](obj)
                if op == "move":
                    return obj.animate.move_to(xyz(entry["to"]))
                if op == "rotate":
                    return obj.animate.rotate(entry["value"] * m.DEGREES)
                if op == "scale":
                    return obj.animate.scale(entry["value"])
                target = objects[entry["target"]]
                return m.ReplacementTransform(obj, target) if op == "replace" else m.MoveAlongPath(obj, target)

            frame = 0
            authored_time = 0
            for index, beat in enumerate(plan["timeline"]):
                authored_time += beat["seconds"]
                end = round(authored_time * fps)
                seconds = (end - frame) / fps
                frame = end
                writer = self.renderer.file_writer
                before = len(writer.partial_movie_files)
                if "camera" in beat:
                    camera = beat["camera"]
                    self.move_camera(phi=camera["phi"] * m.DEGREES, theta=camera["theta"] * m.DEGREES, run_time=seconds)
                elif beat.get("animations"):
                    self.play(*(animation(entry) for entry in beat["animations"]), run_time=seconds)
                else:
                    self.wait(seconds)
                files = [file for file in writer.partial_movie_files[before:] if file is not None]
                if len(files) != 1:
                    raise ValueError(f"Unexpected media segments for beat {index + 1}")
                segments.append(files[0])

    start = time.monotonic()
    with m.tempconfig({
        "renderer": "cairo", "media_dir": str(folder / "media"), "output_file": "source",
        "pixel_width": width, "pixel_height": height, "frame_rate": fps, "disable_caching": True,
        "background_color": plan.get("background", "#101924"), "progress_bar": "none",
        "random_seed": plan.get("seed", 0), "format": "mp4",
    }):
        scene = Visualization()
        scene.render()
        source = Path(scene.renderer.file_writer.movie_file_path)
    render_ms = round((time.monotonic() - start) * 1000)

    start = time.monotonic()
    output = folder / "video.mp4"
    run_media("ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(source), "-an",
              "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
              "-fs", str(MAX_ARTIFACT), str(output))
    encode_ms = round((time.monotonic() - start) * 1000)

    start = time.monotonic()
    probe = json.loads(run_media("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)))
    if len(probe["streams"]) != 1:
        raise ValueError("Expected one video stream")
    stream = probe["streams"][0]
    duration = float(probe["format"]["duration"])
    size = output.stat().st_size
    timings = []
    frame = 0
    for index, (beat, segment) in enumerate(zip(plan["timeline"], segments, strict=True)):
        # Cairo can round a nominal run_time up by a frame. Read the emitted
        # segment length so later narration and seeks use the exact boundaries.
        frames = int(run_media("ffprobe", "-v", "error", "-select_streams", "v:0",
                               "-show_entries", "stream=nb_frames", "-of", "csv=p=0", str(segment)))
        timings.append({"id": f"viz-{index}", "start": frame / fps, "end": (frame + frames) / fps,
                        **{key: beat[key] for key in ("narration", "caption") if key in beat}})
        frame += frames
    if ((stream["codec_name"], stream["pix_fmt"], stream["width"], stream["height"])
            != ("h264", "yuv420p", width, height)
            or stream["avg_frame_rate"] != f"{fps}/1"
            or abs(duration - timings[-1]["end"]) > 1 / fps
            or duration > MAX_DURATION + 1e-6
            or size <= 0 or size >= MAX_ARTIFACT):
        raise ValueError("Encoded artifact did not meet the resolution, duration or size limit")
    timings[-1]["end"] = duration
    # Pick an interior frame from the first visible beat rather than the opening fade.
    first = next(timings[i] for i, beat in enumerate(plan["timeline"]) if beat.get("animations"))
    poster_time = min(duration - 1 / fps, first["start"] + (first["end"] - first["start"]) * 0.9)
    run_media("ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(poster_time),
              "-i", str(output), "-frames:v", "1", "-vf", "scale=480:-2", str(folder / "poster.jpg"))
    from PIL import Image

    poster = np.asarray(Image.open(folder / "poster.jpg").convert("RGB"), dtype=np.int16)
    background = plan.get("background", "#101924")
    background_rgb = np.array([int(background[i:i + 2], 16) for i in (1, 3, 5)])
    if np.count_nonzero(np.max(np.abs(poster - background_rgb), axis=-1) > 20) < 18:
        raise ValueError("The visualization poster is empty or the first objects lack contrast")
    shown = {
        entry["target"] if entry["op"] == "replace" else entry["object"]
        for beat in plan["timeline"] for entry in beat.get("animations", [])
        if entry["op"] in {"create", "write", "fadeIn", "replace"}
    }
    verified = any(obj["id"] in shown and (obj.get("source") or obj["kind"] == "array")
                   for obj in plan["objects"])
    usage = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_seconds = usage.ru_utime + usage.ru_stime + children.ru_utime + children.ru_stime
    return {
        "cpuSeconds": round(cpu_seconds, 3),
        "meanCpuCores": round(cpu_seconds / max(0.001, time.monotonic() - full_started), 2),
        "peakMemoryKiB": max(usage.ru_maxrss, children.ru_maxrss),
        "duration": duration, "width": width, "height": height, "fps": fps, "bytes": size,
        "sha256": digest(output), "posterSha256": digest(folder / "poster.jpg"),
        "rendererVersion": f"{m.__version__}/{COMPILER_REVISION}", "specVersion": 1,
        "cues": timings, "classification": "verified-components" if verified else "illustrative",
        "timings": {**timings_ms, "renderMs": render_ms, "encodeMs": encode_ms,
                    "artifactsMs": round((time.monotonic() - start) * 1000)},
    }


if __name__ == "__main__":
    workdir = Path(sys.argv[1]).resolve()
    spec = json.loads((workdir / "plan.json").read_text())
    metadata = render(workdir, spec, sys.argv[2])
    (workdir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False))
