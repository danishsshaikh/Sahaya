"""Validate the wire format and resolve trusted calculations before rendering."""

import json
import math
import re
import time
from pathlib import Path
from itertools import islice

from diagnostics import PlanValidationError, issue, require, schema_issues

from jsonschema import Draft202012Validator

from science import compute, expression

SCHEMA = json.loads(Path(__file__).with_name("plan-v1.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA)
CONTRACT = SCHEMA["x-contract"]
TEX_COMMANDS = set(CONTRACT["texCommands"])
PLOT_KINDS = {"graph", "curve", "samples", "samples3d", "surface"}
OBJECT_FIELDS = CONTRACT["objects"]
ANIMATION_FIELDS = CONTRACT["animationArguments"]
LIMITS = CONTRACT["limits"]


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
    errors = list(islice((entry for error in VALIDATOR.iter_errors(plan) for entry in schema_issues(error)), 12))
    if errors:
        raise PlanValidationError(errors)
    beats = plan["timeline"]
    require(sum(beat["seconds"] for beat in beats) <= max_duration, ["timeline"], "totalDuration",
            f"Timeline exceeds {max_duration} seconds", limit=max_duration)
    require(sum(len(beat.get("animations", [])) for beat in beats) <= LIMITS["operations"],
            ["timeline"], "operationLimit", "Timeline exceeds its animation operation budget",
            limit=LIMITS["operations"])

    shape_errors = []
    ids = set()
    for index, obj in enumerate(plan["objects"]):
        path = ["objects", index]
        kind = obj["kind"]
        contract = OBJECT_FIELDS[kind]
        allowed = {"id", "kind", "color", "opacity", "size", "at"} | set(contract["fields"])
        if kind in PLOT_KINDS:
            allowed -= {"at", "size"}
        for name in sorted(obj.keys() - allowed):
            shape_errors.append(issue([*path, name], "unsupportedField", f"Remove this field from {kind}"))
        for name in contract.get("required", []):
            if name not in obj:
                shape_errors.append(issue([*path, name], "required", f"{kind} requires this field"))
        if obj["id"] in ids:
            shape_errors.append(issue([*path, "id"], "duplicateId", "Use a unique object ID"))
        ids.add(obj["id"])
    for index, beat in enumerate(beats):
        for offset, animation in enumerate(beat.get("animations", [])):
            path = ["timeline", index, "animations", offset]
            field = ANIMATION_FIELDS[animation["op"]]
            if field and field not in animation:
                shape_errors.append(issue([*path, field], "required", f"{animation['op']} requires this field"))
            for name in sorted(animation.keys() - ({"op", "object"} | ({field} if field else set()))):
                shape_errors.append(issue([*path, name], "unsupportedField", "Remove this field from the operation"))
            for name in ("object", "target"):
                if name in animation and animation[name] not in ids:
                    shape_errors.append(issue([*path, name], "reference", "Reference an existing object ID"))
    if shape_errors:
        raise PlanValidationError(shape_errors)

    objects = {}
    science_started = time.monotonic()
    try:
        computed = compute(plan.get("model"))
    except ValueError as error:
        raise PlanValidationError([issue(["model"], "scientific", str(error))]) from error
    if timings is not None:
        timings["scienceMs"] = round((time.monotonic() - science_started) * 1000)
    plots = {}
    complexity = 0
    for index, obj in enumerate(plan["objects"]):
        path = ["objects", index]
        key, kind = obj["id"], obj["kind"]
        require("at" not in obj or abs(obj["at"][1]) <= LIMITS["verticalCanvas"],
                [*path, "at", 1], "canvasPosition", "Keep the vertical position inside the canvas",
                limit=LIMITS["verticalCanvas"])
        for name in ("xRange", "yRange", "zRange"):
            if name in obj:
                try:
                    domain(obj[name])
                except ValueError as error:
                    raise PlanValidationError([issue([*path, name], "range", str(error))]) from error
        if kind in ("text", "equation"):
            if not obj.get("text", "").strip():
                raise PlanValidationError([issue([*path, "text"], "blank", "Enter nonblank text")])
            if kind == "equation":
                try:
                    safe_tex(obj["text"])
                except ValueError as error:
                    raise PlanValidationError([issue([*path, "text"], "equation", str(error))]) from error
        if kind in ("line", "arrow", "polygon"):
            points = obj.get("points", [])
            if len(points) < (3 if kind == "polygon" else 2) or len(set(map(tuple, points))) != len(points):
                raise PlanValidationError([issue([*path, "points"], "geometry", "Provide the required number of distinct points")])
            if kind != "polygon" and len(points) != 2:
                raise PlanValidationError([issue([*path, "points"], "geometry", "Use exactly two endpoints", limit=2)])
        if kind == "modelValue":
            samples = computed.samples.get(obj.get("source"))
            if not samples or obj.get("index", 0) >= len(samples) or "component" not in obj:
                raise ValueError(f"{key} requires a supported model sample and component")
        if kind == "array" and obj.get("index", 0) >= len(computed.arrays):
            raise PlanValidationError([issue([*path, "index"], "reference", "Choose an available insertion-sort state", limit=max(0, len(computed.arrays) - 1))])
        if kind in PLOT_KINDS:
            axes = objects.get(obj.get("axes"))
            expected = {"axes3d"} if kind in {"surface", "samples3d"} else {"axes", "plane"}
            require(axes and axes["kind"] in expected, [*path, "axes"], "reference",
                    "Reference compatible axes declared earlier", allowed=sorted(expected))
            source = obj.get("source")
            if kind in {"samples", "samples3d"}:
                if kind == "samples3d" and source != "iterations":
                    raise ValueError(f"{key} requires gradient descent samples")
                samples = computed.samples.get(source)
                if not samples or ("index" in obj and obj["index"] >= len(samples)):
                    raise PlanValidationError([issue([*path, "index" if samples else "source"], "reference", "Choose an available scientific sample or index")])
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
    if complexity > LIMITS["complexity"]:
        raise ValueError("Objects exceed the scene complexity budget")

    visible = set()
    introduced = False
    for index, beat in enumerate(beats):
        path = ["timeline", index]
        if beat.get("narration") and not beat["narration"].strip():
            raise PlanValidationError([issue([*path, "narration"], "blank", "Provide a short spoken sentence")])
        if "camera" in beat and beat.get("animations"):
            raise PlanValidationError([issue(["timeline"], "timeline", "Place the camera transition in a dedicated beat")])
        touched = set()
        for offset, animation in enumerate(beat.get("animations", [])):
            animation_path = [*path, "animations", offset]
            key, op = animation["object"], animation["op"]
            target = animation.get("target")
            if key in touched or (target is not None and (target in touched or target == key)):
                raise PlanValidationError([issue([*animation_path, "object"], "reference", "Parallel animations cannot share an object")])
            touched.add(key)
            if target is not None:
                touched.add(target)
            if op in {"create", "write", "fadeIn"}:
                if key in visible:
                    raise PlanValidationError([issue([*animation_path, "object"], "visibility", "Object is already visible")])
                visible.add(key)
                introduced = True
            elif key not in visible:
                raise PlanValidationError([issue([*animation_path, "object"], "visibility", "Operation needs a visible object")])
            if op == "fadeOut":
                visible.remove(key)
            elif op == "replace":
                if target in visible:
                    raise PlanValidationError([issue([*animation_path, "target"], "visibility", "Replacement target must be hidden")])
                visible.remove(key)
                visible.add(target)
            elif op == "follow" and objects[target]["kind"] not in {"graph", "curve", "line", "arrow"}:
                raise PlanValidationError([issue([*animation_path, "target"], "reference", "Follow needs a graph, curve, line or arrow")])
            elif op == "scale":
                lo, hi = CONTRACT["scaleRange"]
                require(lo <= animation["value"] <= hi, [*animation_path, "value"], "scaleRange",
                        f"Scale factor must be between {lo} and {hi}", allowed=[lo, hi], value=animation["value"])
            elif op == "move":
                require(abs(animation["to"][1]) <= LIMITS["verticalCanvas"],
                        [*animation_path, "to", 1], "canvasPosition", "Move destination is outside the vertical canvas",
                        limit=LIMITS["verticalCanvas"])
    if not introduced:
        raise PlanValidationError([issue(["timeline"], "timeline", "Introduce visible objects with create, write or fadeIn")])
    return computed, plots
