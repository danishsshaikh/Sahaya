"""Validate the wire format and resolve trusted calculations before rendering."""

import json
import math
import re
import time
from pathlib import Path

from jsonschema import Draft202012Validator

from science import compute, expression

SCHEMA = json.loads(Path(__file__).with_name("plan-v1.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA)
TEX_COMMANDS = set("frac sqrt cdot times pm sin cos tan exp log ln sum int infty "
                   "pi theta phi Delta delta alpha beta gamma partial nabla le ge "
                   "approx neq left right mathbf mathrm vec overline".split())
PLOT_KINDS = {"graph", "curve", "samples", "samples3d", "surface"}
OBJECT_FIELDS = {
    "text": {"text"}, "equation": {"text"}, "dot": set(),
    "line": {"points"}, "arrow": {"points"}, "circle": set(), "rectangle": {"height"},
    "polygon": {"points"}, "axes": {"xRange", "yRange", "height"},
    "plane": {"xRange", "yRange", "height"}, "axes3d": {"xRange", "yRange", "zRange", "height"},
    "graph": {"axes", "xRange", "source", "expression"},
    "curve": {"axes", "xRange", "expression", "yExpression"},
    "samples": {"axes", "source", "index"}, "array": {"index"},
    "surface": {"axes", "xRange", "yRange", "source", "expression"},
    "sphere": set(), "samples3d": {"axes", "source", "index"},
    "modelValue": {"text", "source", "index", "component"},
}
ANIMATION_FIELDS = {"move": "to", "rotate": "value", "scale": "value",
                    "replace": "target", "follow": "target"}


def safe_tex(text):
    if "^^" in text or not re.fullmatch(r"[A-Za-z0-9 ' +*/=.,()|!_^{}<>\\-]+", text):
        raise ValueError("Equation contains unsupported TeX characters")
    commands = re.findall(r"\\([A-Za-z]+)", text)
    if any(command not in TEX_COMMANDS for command in commands):
        raise ValueError("Equation contains an unsupported TeX command")
    if "\\" in re.sub(r"\\[A-Za-z]+", "", text):
        raise ValueError("Equation contains an unsupported TeX escape")
    depth = 0
    for char in text:
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        if not 0 <= depth <= 8:
            raise ValueError("Equation has unbalanced or deeply nested braces")
    if depth:
        raise ValueError("Equation has unbalanced braces")


def finite_tree(value):
    if isinstance(value, dict):
        for item in value.values():
            finite_tree(item)
    elif isinstance(value, list):
        for item in value:
            finite_tree(item)
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Plan values must be finite")
    elif isinstance(value, str) and any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise ValueError("Plan contains a control character")


def domain(value):
    lo, hi = value
    if hi - lo < 0.001:
        raise ValueError("Plot ranges must be increasing and at least 0.001 wide")
    return lo, hi


def validate(plan, max_duration=90, timings=None):
    finite_tree(plan)
    error = next(VALIDATOR.iter_errors(plan), None)
    if error:
        location = ".".join(map(str, error.absolute_path)) or "plan"
        raise ValueError(f"{location}: {error.message[:170]}")
    beats = plan["timeline"]
    if sum(beat["seconds"] for beat in beats) > max_duration:
        raise ValueError(f"Timeline exceeds {max_duration} seconds")
    if sum(len(beat.get("animations", [])) for beat in beats) > 96:
        raise ValueError("Timeline exceeds 96 animation operations")

    objects = {}
    science_started = time.monotonic()
    computed = compute(plan.get("model"))
    if timings is not None:
        timings["scienceMs"] = round((time.monotonic() - science_started) * 1000)
    plots = {}
    complexity = 0
    for obj in plan["objects"]:
        key, kind = obj["id"], obj["kind"]
        if key in objects:
            raise ValueError(f"Duplicate object {key}")
        if set(obj) - ({"id", "kind", "color", "opacity", "size", "at"} | OBJECT_FIELDS[kind]):
            raise ValueError(f"{key} contains fields unsupported by {kind}")
        if "at" in obj and abs(obj["at"][1]) > 3.8:
            raise ValueError(f"{key} is outside the vertical canvas")
        for name in ("xRange", "yRange", "zRange"):
            if name in obj:
                domain(obj[name])
        if kind in ("text", "equation"):
            if not obj.get("text", "").strip():
                raise ValueError(f"{key} requires text")
            if kind == "equation":
                safe_tex(obj["text"])
        if kind in ("line", "arrow", "polygon"):
            points = obj.get("points", [])
            if len(points) < (3 if kind == "polygon" else 2) or len(set(map(tuple, points))) != len(points):
                raise ValueError(f"{key} requires distinct points")
            if kind != "polygon" and len(points) != 2:
                raise ValueError(f"{key} requires exactly two endpoints")
        if kind == "modelValue":
            samples = computed.samples.get(obj.get("source"))
            if not samples or obj.get("index", 0) >= len(samples) or "component" not in obj:
                raise ValueError(f"{key} requires a supported model sample and component")
        if kind == "array" and obj.get("index", 0) >= len(computed.arrays):
            raise ValueError(f"{key} references an unavailable sorting state")
        if kind in PLOT_KINDS:
            axes = objects.get(obj.get("axes"))
            expected = {"axes3d"} if kind in {"surface", "samples3d"} else {"axes", "plane"}
            if not axes or axes["kind"] not in expected:
                raise ValueError(f"{key} requires compatible axes declared earlier")
            if "at" in obj or "size" in obj:
                raise ValueError(f"{key} is positioned by its axes")
            source = obj.get("source")
            if kind in {"samples", "samples3d"}:
                if kind == "samples3d" and source != "iterations":
                    raise ValueError(f"{key} requires gradient descent samples")
                samples = computed.samples.get(source)
                if not samples or ("index" in obj and obj["index"] >= len(samples)):
                    raise ValueError(f"{key} references unavailable model samples")
                plots[key] = [samples[obj["index"]]] if "index" in obj else samples
            else:
                if bool(source) == bool(obj.get("expression")):
                    raise ValueError(f"{key} requires exactly one expression or model source")
                if source and ((kind == "surface") != (source == "lossSurface")):
                    raise ValueError(f"{key} uses a model source with incompatible dimensions")
                variables = ("x", "y") if kind == "surface" else ("x",)
                fn = computed.functions.get(source) if source else expression(obj["expression"], variables)
                if not fn:
                    raise ValueError(f"{key} needs a different scientific model")
                lo, hi = domain(obj.get("xRange", computed.domains.get(source, axes.get("xRange", [-5, 5]))))
                if source in computed.domains:
                    begin, end = computed.domains[source]
                    if lo < begin or hi > end + 1e-8:
                        raise ValueError(f"{key} exceeds the model's physical domain")
                if kind == "surface":
                    bottom, top = domain(obj.get("yRange", axes.get("yRange", [-3, 3])))
                    for i in range(13):
                        for j in range(13):
                            fn(lo + (hi - lo) * i / 12, bottom + (top - bottom) * j / 12)
                    plots[key] = (fn, (lo, hi), (bottom, top))
                else:
                    y_fn = expression(obj.get("yExpression", "")) if kind == "curve" else fn
                    values = [lo + (hi - lo) * i / 160 for i in range(161)]
                    points = [(fn(v) if kind == "curve" else v, y_fn(v)) for v in values]
                    y_lo, y_hi = axes.get("yRange", [-3, 3])
                    if any(abs(a[1] - b[1]) > (y_hi - y_lo) * 0.75 for a, b in zip(points, points[1:])):
                        raise ValueError(f"{key} crosses a discontinuity or needs a different plot domain")
                    x_lo, x_hi = axes.get("xRange", [-5, 5])
                    if any(x < x_lo - 1e-6 or x > x_hi + 1e-6 or y < y_lo - 1e-6 or y > y_hi + 1e-6 for x, y in points):
                        raise ValueError(f"{key} falls outside the referenced axes")
                    plots[key] = points
        complexity += {"surface": 14, "equation": 3, "sphere": 8, "plane": 3}.get(kind, 1)
        objects[key] = obj
    if complexity > 85:
        raise ValueError("Objects exceed the scene complexity budget")

    visible = set()
    introduced = False
    for beat in beats:
        if beat.get("narration") and not beat["narration"].strip():
            raise ValueError("Narration must contain a spoken sentence")
        if "camera" in beat and beat.get("animations"):
            raise ValueError("Camera transitions need a dedicated beat")
        touched = set()
        for animation in beat.get("animations", []):
            key, op = animation["object"], animation["op"]
            field = ANIMATION_FIELDS.get(op)
            target = animation.get("target")
            if set(animation) != {"op", "object"} | ({field} if field else set()):
                raise ValueError(f"{op} requires only its supported animation parameters")
            if key not in objects or (target is not None and target not in objects):
                raise ValueError(f"{op} references an unknown object")
            if key in touched or (target is not None and (target in touched or target == key)):
                raise ValueError("Parallel animations cannot share an object")
            touched.add(key)
            if target is not None:
                touched.add(target)
            if op in {"create", "write", "fadeIn"}:
                if key in visible:
                    raise ValueError(f"{key} is already visible")
                visible.add(key)
                introduced = True
            elif key not in visible:
                raise ValueError(f"{op} requires {key} to be visible")
            if op == "fadeOut":
                visible.remove(key)
            elif op == "replace":
                if target in visible:
                    raise ValueError("Replacement target must be hidden")
                visible.remove(key)
                visible.add(target)
            elif op == "follow" and objects[target]["kind"] not in {"graph", "curve", "line", "arrow"}:
                raise ValueError("A follow target must be a path")
            elif op == "scale" and not 0.2 <= animation["value"] <= 3:
                raise ValueError("Scale factor must be between 0.2 and 3")
            elif op == "move" and abs(animation["to"][1]) > 3.8:
                raise ValueError("Move destination is outside the vertical canvas")
    if not introduced:
        raise ValueError("Timeline must introduce visible objects")
    return computed, plots
