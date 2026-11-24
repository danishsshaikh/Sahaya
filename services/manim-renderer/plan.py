"""Validate the wire format and resolve trusted calculations before rendering."""

import json
import math
import re
import time
from pathlib import Path

from diagnostics import PlanValidationError, issue, require, schema_issues

from jsonschema import Draft202012Validator

from science import ModelError, ScientificData, compute, expression

SCHEMA = json.loads(Path(__file__).with_name("plan-v1.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA)
CONTRACT = SCHEMA["x-contract"]
TEX_COMMANDS = set(CONTRACT["texCommands"])
PLOT_KINDS = {"graph", "curve", "samples", "samples3d", "surface"}
OBJECT_FIELDS = CONTRACT["objects"]
ANIMATION_FIELDS = CONTRACT["animationArguments"]
LIMITS = CONTRACT["limits"]


def safe_tex(text):
    if "^^" in text or not re.fullmatch(r"[A-Za-z0-9 ' +*/=.,:()\[\]|!_^{}<>\\-]+", text):
        raise ValueError("Use bare math with ASCII operators and allowlisted TeX commands; omit math delimiters and text wrappers")
    commands = re.findall(r"\\([A-Za-z]+)", text)
    if any(command not in TEX_COMMANDS for command in commands):
        raise ValueError("Use an allowlisted display-math command; omit LaTeX macros, environments and wrappers")
    if "\\" in re.sub(r"\\[A-Za-z]+", "", text):
        raise ValueError("Use one backslash before each supported command (two in JSON); omit other escapes")
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


def finite_tree(value, depth=0):
    if depth > 16:
        raise ValueError("Plan is nested too deeply")
    if isinstance(value, dict):
        for item in value.values():
            finite_tree(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            finite_tree(item, depth + 1)
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Plan values must be finite")
    elif isinstance(value, str) and any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise ValueError("Plan contains a control character")


def domain(value):
    lo, hi = value[:2]
    if hi - lo < 0.001:
        raise ValueError("Ranges must be increasing and at least 0.001 wide")
    return lo, hi


def check_range(value, kind):
    lo, hi = domain(value)
    if len(value) == 3:
        if kind not in {"axes", "axes3d", "plane"}:
            raise ValueError("Use [min, max] for a plot domain. Set the tick interval on its axes.")
        step = value[2]
        if step <= 0 or step > hi - lo or (hi - lo) > step * LIMITS["axisIntervals"] * (1 + 1e-12):
            raise ValueError(f"Use a positive tick interval within the range and at most {LIMITS['axisIntervals']} intervals")


def validate(plan, max_duration=90, timings=None, require_narration=False):
    finite_tree(plan)
    structural = [entry for error in VALIDATOR.iter_errors(plan) for entry in schema_issues(error)]
    if not isinstance(plan, dict):
        raise PlanValidationError(structural)

    errors = []
    blocked = set()
    science_seconds = 0

    def record(path, phase, check):
        nonlocal science_seconds
        started = time.monotonic()
        try:
            check()
        except PlanValidationError as error:
            errors.extend({**entry, "phase": phase} for entry in error.issues)
        except ValueError as error:
            errors.append(issue(path, phase, str(error), phase=phase))
        finally:
            if phase in {"expression", "scientific"}:
                science_seconds += time.monotonic() - started

    def invalid(path, own_errors=structural):
        return any(entry["path"][:len(path)] == path for entry in own_errors)

    def entries(key):
        values = plan.get(key)
        # Do not run semantic work on arrays above the schema resource limits.
        if not isinstance(values, list) or len(values) > SCHEMA["properties"][key]["maxItems"]:
            return []
        return values

    objects = {}
    object_indexes = {}
    plots = {}
    invalid_axes = set()
    ids = set()
    model_path = ["model"]
    computed = None

    def calculate_model():
        nonlocal computed
        try:
            computed = compute(plan.get("model"))
        except ModelError as error:
            raise PlanValidationError([issue([*model_path, error.field], "scientific", str(error))]) from error

    if not invalid(model_path):
        record(model_path, "scientific", calculate_model)
    else:
        blocked.add("model calculation")

    complexity = 0
    for index, obj in enumerate(entries("objects")):
        path = ["objects", index]
        if not isinstance(obj, dict):
            blocked.add("object checks")
            continue
        key, kind = obj.get("id"), obj.get("kind")
        if isinstance(key, str):
            if key in ids:
                errors.append(issue([*path, "id"], "duplicateId", "Use a unique object ID", phase="references"))
            ids.add(key)
        contract = OBJECT_FIELDS.get(kind) if isinstance(kind, str) else None
        if not contract:
            blocked.add("kind-specific properties")
            continue
        allowed = {"id", "kind", "color", "opacity", "size", "at"} | set(contract["fields"])
        if kind in PLOT_KINDS:
            allowed -= {"at", "size"}
        for name in sorted(obj.keys() - allowed):
            errors.append(issue([*path, name], "unsupportedField", f"Remove this field from {kind}",
                                phase="object"))
        for name in contract.get("required", []):
            if name not in obj:
                errors.append(issue([*path, name], "required", f"{kind} requires this field", phase="object"))

        if "at" in obj and not invalid([*path, "at"]):
            record([*path, "at"], "object", lambda: require(
                abs(obj["at"][1]) <= LIMITS["verticalCanvas"], [*path, "at", 1], "canvasPosition",
                "Keep the vertical position inside the canvas", limit=LIMITS["verticalCanvas"]))
        for name in ("xRange", "yRange", "zRange"):
            if name in obj and not invalid([*path, name]):
                record([*path, name], "range", lambda: check_range(obj[name], kind))
        if kind in ("text", "equation") and "text" in obj and not invalid([*path, "text"]):
            record([*path, "text"], kind, lambda: require(
                obj["text"].strip(), [*path, "text"], "blank", "Enter nonblank text"))
            if kind == "equation":
                record([*path, "text"], "equation", lambda: safe_tex(obj["text"]))
        if kind in ("line", "arrow", "polygon") and "points" in obj and not invalid([*path, "points"]):
            points = obj["points"]
            record([*path, "points"], "object", lambda: require(
                len(set(map(tuple, points))) == len(points) and
                (len(points) >= 3 if kind == "polygon" else len(points) == 2),
                [*path, "points"], "geometry", "Use distinct vertices (at least three for a polygon, exactly two otherwise)"))
        for name in ("expression", "yExpression"):
            if name in obj and name in allowed and not invalid([*path, name]):
                variables = ("x", "y") if kind == "surface" else ("x",)
                record([*path, name], "expression", lambda: expression(obj[name], variables))

        if kind in PLOT_KINDS or kind in {"array", "modelValue"}:
            needs_model = kind in {"array", "modelValue", "samples", "samples3d"} or "source" in obj
            axes_id = obj.get("axes")
            expected = {"axes3d"} if kind in {"surface", "samples3d"} else {"axes", "plane"}
            axes = objects.get(axes_id) if isinstance(axes_id, str) else None
            if kind in PLOT_KINDS and isinstance(axes_id, str) and (
                    not axes or axes["kind"] not in expected) and axes_id not in invalid_axes:
                errors.append(issue([*path, "axes"], "reference", "Reference compatible axes declared earlier",
                                    allowed=sorted(expected), phase="references"))
            if (invalid(path) or invalid(path, errors) or (needs_model and computed is None)
                    or (isinstance(axes_id, str) and axes_id in invalid_axes)):
                blocked.add("plot and model sample calculations")
            else:
                axes_path = ["objects", object_indexes[axes_id]] if axes else None
                record(path, "scientific", lambda: resolve_plot(
                    obj, path, computed or ScientificData(), axes, axes_path, plots))
        complexity += {"surface": 14, "equation": 3, "sphere": 8, "plane": 3}.get(kind, 1)
        if isinstance(key, str):
            objects[key] = obj
            object_indexes[key] = index
            if kind in {"axes", "plane", "axes3d"} and (invalid(path) or invalid(path, errors)):
                invalid_axes.add(key)
    if timings is not None:
        timings["scienceMs"] = round(science_seconds * 1000)

    beats = entries("timeline")
    timeline_path = ["timeline"]
    if beats and all(isinstance(beat, dict) for beat in beats):
        if require_narration and not any(isinstance(beat.get("narration"), str) and
                                        beat["narration"].strip() for beat in beats):
            path = ["timeline", 0, "narration"]
            record(path, "narration", lambda: require(
                False, path, "blank" if "narration" in beats[0] else "required",
                "Add one short spoken cue"))
        if not any(invalid(["timeline", index, "seconds"]) for index in range(len(beats))):
            record(timeline_path, "limits", lambda: require(
                sum(beat["seconds"] for beat in beats) <= max_duration, timeline_path, "totalDuration",
                f"Timeline exceeds {max_duration} seconds", limit=max_duration))
        record(timeline_path, "limits", lambda: require(
            sum(len(beat["animations"]) for beat in beats if isinstance(beat.get("animations"), list))
            <= LIMITS["operations"], timeline_path, "operationLimit",
            "Timeline exceeds its animation operation budget", limit=LIMITS["operations"]))
    record(["objects"], "limits", lambda: require(
        complexity <= LIMITS["complexity"], ["objects"], "complexity",
        "Objects exceed the scene complexity budget", limit=LIMITS["complexity"]))

    for index, beat in enumerate(beats):
        if not isinstance(beat, dict) or not isinstance(beat.get("animations"), list):
            continue
        for offset, animation in enumerate(beat["animations"][:LIMITS["operations"]]):
            if not isinstance(animation, dict):
                continue
            path = ["timeline", index, "animations", offset]
            op = animation.get("op")
            if isinstance(op, str) and op in ANIMATION_FIELDS:
                field = ANIMATION_FIELDS[op]
                if field and field not in animation:
                    errors.append(issue([*path, field], "required", f"{op} requires this field", phase="animation"))
                for name in sorted(animation.keys() - ({"op", "object"} | ({field} if field else set()))):
                    errors.append(issue([*path, name], "unsupportedField",
                                        "Remove this field from the operation", phase="animation"))
            for name in ("object", "target"):
                if isinstance(animation.get(name), str) and animation[name] not in ids:
                    errors.append(issue([*path, name], "reference", "Reference an existing object ID", phase="references"))

    if invalid(timeline_path) or invalid(timeline_path, errors):
        blocked.add("timeline sequence")
    else:
        record(timeline_path, "timeline", lambda: validate_timeline(beats, objects))
    if structural or errors:
        combined = [*({**entry, "phase": "schema"} for entry in structural), *errors]
        # Deduplicate additional properties also recognized by the kind-specific contract.
        unique = {(tuple(entry["path"]), entry["code"]): entry for entry in combined}
        raise PlanValidationError(list(unique.values()), sorted(blocked))
    return computed, plots


def resolve_plot(obj, path, computed, axes, axes_path, plots):
    key, kind = obj["id"], obj["kind"]
    if kind == "modelValue":
        samples = computed.samples.get(obj.get("source"))
        if not samples or obj.get("index", 0) >= len(samples) or "component" not in obj:
            raise PlanValidationError([issue([*path, "index" if samples else "source"], "reference", "Choose an available scientific sample and index")])
    if kind == "array" and obj.get("index", 0) >= len(computed.arrays):
        raise PlanValidationError([issue([*path, "index"], "reference", "Choose an available insertion-sort state", limit=max(0, len(computed.arrays) - 1))])
    if kind in PLOT_KINDS:
        source = obj.get("source")
        if kind in {"samples", "samples3d"}:
            if kind == "samples3d" and source != "iterations":
                raise PlanValidationError([issue([*path, "source"], "scientific", "Use iterations from a gradient_descent model")])
            samples = computed.samples.get(source)
            if not samples or ("index" in obj and obj["index"] >= len(samples)):
                raise PlanValidationError([issue([*path, "index" if samples else "source"], "reference", "Choose an available scientific sample or index")])
            plots[key] = [samples[obj["index"]]] if "index" in obj else samples
        else:
            if bool(source) == bool(obj.get("expression")):
                raise PlanValidationError([issue(path, "scientificSource", "Provide exactly one expression or model source")])
            if source and ((kind == "surface") != (source == "lossSurface")):
                raise PlanValidationError([issue([*path, "source"], "scientific", "Use lossSurface only for a surface")])
            variables = ("x", "y") if kind == "surface" else ("x",)
            fn = computed.functions.get(source) if source else expression(obj["expression"], variables)
            if not fn:
                raise PlanValidationError([issue([*path, "source"], "reference", "Use a source exposed by the declared scientific model")])
            lo, hi = domain(obj.get("xRange", computed.domains.get(source, axes.get("xRange", [-5, 5]))))
            if source in computed.domains:
                begin, end = computed.domains[source]
                if lo < begin or hi > end + 1e-8:
                    raise PlanValidationError([issue([*path, "xRange"], "physicalDomain", "Keep the plot inside the model domain, or omit xRange", allowed=[begin, end])])
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
                y_lo, y_hi = domain(axes.get("yRange", [-3, 3]))
                if any(abs(a[1] - b[1]) > (y_hi - y_lo) * 0.75 for a, b in zip(points, points[1:])):
                    raise ValueError("The sampled plot crosses a discontinuity or needs a different domain")
                x_lo, x_hi = domain(axes.get("xRange", [-5, 5]))
                bounds_issues = []
                for name, limits, coordinate in (("xRange", (x_lo, x_hi), 0), ("yRange", (y_lo, y_hi), 1)):
                    minimum, maximum = limits
                    samples = [point[coordinate] for point in points]
                    if min(samples) < minimum - 1e-6 or max(samples) > maximum + 1e-6:
                        bounds_issues.append(issue(
                            [*axes_path, name], "plotBounds" if name in axes else "required",
                            "The axis must cover the full sampled plot",
                            allowed={"minAtMost": min(samples), "maxAtLeast": max(samples)}))
                if bounds_issues:
                    raise PlanValidationError(bounds_issues)
                plots[key] = points


def validate_timeline(beats, objects):
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
            elif op == "follow" and target in objects and objects[target]["kind"] not in {"graph", "curve", "line", "arrow"}:
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
