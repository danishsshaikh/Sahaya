"""Static authoring checks on the trusted publisher. Never imports or runs a candidate."""
import ast
from collections import Counter
from difflib import get_close_matches
from functools import lru_cache
import io
import json
from pathlib import Path
import tokenize

from native_contract import MANIM_VERSION, MAX_SOURCE, Rejected, check_request

CUE_BASES = {"CueScene", "CueMovingCameraScene", "CueThreeDScene"}
RELATED = {
    "NumberLine": ("n2p", "number_to_point", "p2n", "point_to_number"),
    "Axes": ("plot", "c2p", "coords_to_point", "p2c"),
    "ValueTracker": ("get_value", "set_value", "increment_value"),
    "Mobject": ("move_to", "shift", "add_updater", "remove_updater", "clear_updaters"),
    "ThreeDScene": ("set_camera_orientation", "move_camera", "begin_ambient_camera_rotation"),
}


@lru_cache(maxsize=1)
def knowledge():
    data = json.loads(Path(__file__).with_name("manim_api.json").read_text(encoding="utf8"))
    if data.get("version") != MANIM_VERSION:
        raise RuntimeError("Manim API index version mismatch")
    return data


def imports(tree):
    names, namespaces, stars = {}, {}, set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and not node.level:
            for alias in node.names:
                if alias.name == "*":
                    stars.add(node.module)
                else:
                    names[alias.asname or alias.name] = (node.module, alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                namespaces[alias.asname or alias.name] = alias.name
    # Shadowed imports are uncertain, including a same-named function parameter.
    rebound = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)}
    rebound.update(node.arg for node in ast.walk(tree) if isinstance(node, ast.arg))
    rebound.update(node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.ClassDef)))
    return ({name: value for name, value in names.items() if name not in rebound},
            {name: value for name, value in namespaces.items() if name not in rebound}, stars, rebound)


def imported_symbol(expr, bindings):
    names, namespaces, stars, rebound = bindings
    if isinstance(expr, ast.Name) and expr.id not in rebound:
        if expr.id in names:
            return names[expr.id]
        if expr.id in CUE_BASES and "sahaya_timing" in stars:
            return ("sahaya_timing", expr.id)
        if "manim" in stars:
            return ("manim", expr.id)
    if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
        return (namespaces.get(expr.value.id), expr.attr)
    return (None, None)


def constructs(node):
    return isinstance(node, ast.ClassDef) and any(
        isinstance(method, ast.FunctionDef) and method.name == "construct" for method in node.body
    )


def normalize(source, tree, bindings):
    if any(isinstance(node, ast.ClassDef) and node.name == "GeneratedScene" for node in tree.body):
        return source, None
    scenes = [node for node in tree.body if constructs(node)]
    if len(scenes) != 1:
        return source, None
    scene = scenes[0]
    if scene.decorator_list or scene.keywords or len(scene.bases) != 1:
        return source, None
    module, base = imported_symbol(scene.bases[0], bindings)
    if module != "sahaya_timing" or base not in CUE_BASES:
        return source, None
    if any(isinstance(node, ast.Constant) and isinstance(node.value, str)
           and (scene.name in node.value or "GeneratedScene" in node.value) for node in ast.walk(tree)):
        return source, None
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (SyntaxError, tokenize.TokenError):
        return source, None
    uses = [token for token in tokens if token.type == tokenize.NAME
            and token.string in (scene.name, "GeneratedScene")]
    if len(uses) != 1 or uses[0].start[0] != scene.lineno:
        return source, None
    token = uses[0]
    lines = source.split("\n")
    line, start = token.start
    lines[line - 1] = lines[line - 1][:start] + "GeneratedScene" + lines[line - 1][token.end[1]:]
    return "\n".join(lines), {"from": scene.name, "line": line}


def hierarchy(classes, key):
    layers, visited, complete = [], set(), True
    pending = [key]
    while pending:
        name = pending.pop(0)
        if name in visited or name in ("object", "ABC"):
            continue
        visited.add(name)
        layer = classes.get(name)
        if not layer:
            complete = False
            continue
        layers.append(layer)
        pending.extend(layer["bases"])
    return layers, complete


def constructor(classes, key):
    accepted, visited = set(), set()
    while key in classes and key not in visited:
        visited.add(key)
        cls = classes[key]
        init = cls["methods"].get("__init__")
        if init:
            accepted.update(init["keywords"])
            if not init["variadicKeywords"]:
                return accepted, True
            if not init.get("forwardsKeywords"):
                break
        if len(cls["bases"]) != 1:
            break
        key = cls["bases"][0]
    return accepted, False


def keyword_hint(keyword, accepted):
    return get_close_matches(keyword, sorted(accepted), n=2, cutoff=0.49)


def cue_call(call):
    return (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
            and call.func.attr == "cue" and isinstance(call.func.value, ast.Name)
            and call.func.value.id == "self")


def straight_line(statements):
    for statement in statements:
        yield statement
        if isinstance(statement, ast.With) and len(statement.items) == 1 and cue_call(statement.items[0].context_expr):
            yield from straight_line(statement.body)


def api_findings(tree, bindings, api):
    classes, exports = api["classes"], api["exports"]
    findings = []
    changed_attributes = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
                          and isinstance(node.ctx, (ast.Store, ast.Del))}
    # A star import outside these modules can replace any unqualified inferred binding.
    if bindings[2] - {"manim", "sahaya_timing"}:
        return findings

    def class_key(call):
        module, name = imported_symbol(call.func, bindings)
        return exports.get(name) if module == "manim" else None

    def note(kind, node, symbol, certain=False, alternatives=()):
        if len(findings) < 8:
            findings.append({"kind": kind, "line": node.lineno, "symbol": symbol,
                             "severity": "error" if certain else "warning", "alternatives": list(alternatives)[:4]})

    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "manim" and not node.level:
            for alias in node.names:
                if alias.name not in exports and alias.name not in {"*", "np", "config", "unit", "rate_functions", "color"}:
                    note("unindexedImport", node, alias.name,
                         alternatives=get_close_matches(alias.name, sorted(exports), n=3, cutoff=0.65))

    for scope in (node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Module))):
        # Walk one lexical scope. A nested function's locals cannot establish
        # a concrete receiver type in its enclosing function.
        def scope_nodes():
            pending = list(reversed(scope.body))
            while pending:
                item = pending.pop()
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                    continue
                yield item
                pending.extend(reversed(list(ast.iter_child_nodes(item))))

        nodes = list(scope_nodes())
        writes = Counter(node.id for node in nodes if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store))
        types, adds = {}, {}
        for node in straight_line(scope.body):
            if not isinstance(node, ast.Assign) or len(node.targets) != 1 or not isinstance(node.value, ast.Call):
                continue
            target = node.targets[0]
            key = class_key(node.value)
            if isinstance(target, ast.Name) and writes[target.id] == 1 and key in classes:
                types[target.id] = (key, node.lineno)
        for node in nodes:
            if not isinstance(node, ast.Call):
                continue
            key = class_key(node)
            if key in classes:
                valid, complete = constructor(classes, key)
                for keyword in node.keywords:
                    if keyword.arg and keyword.arg not in valid and valid:
                        note("constructorKeyword", keyword, f"{classes[key]['name']}.{keyword.arg}", complete,
                             (f"{classes[key]['name']}({name}=…)" for name in keyword_hint(keyword.arg, valid)))
                continue
            if not isinstance(node.func, ast.Attribute) or not isinstance(node.func.value, ast.Name):
                continue
            method, receiver = node.func.attr, node.func.value.id
            if method == "play" and receiver == "self":
                for argument in node.args:
                    if isinstance(argument, ast.Call):
                        target_key = class_key(argument)
                    elif isinstance(argument, ast.Name) and argument.id in types:
                        target_key, assigned = types[argument.id]
                        if assigned >= node.lineno:
                            continue
                    else:
                        continue
                    layers, _ = hierarchy(classes, target_key)
                    if any(layer["name"] == "Mobject" for layer in layers):
                        note("animationLifecycle", argument, "Scene.play", alternatives=("Create", "FadeIn"))
            if method in ("add_updater", "remove_updater") and node.args:
                argument = node.args[0]
                if method == "add_updater" and isinstance(argument, ast.Name):
                    adds.setdefault(receiver, set()).add(argument.id)
                if method == "remove_updater" and (isinstance(argument, ast.Lambda) or
                        isinstance(argument, ast.Name) and receiver in adds and argument.id not in adds[receiver]):
                    note("updaterIdentity", node, "Mobject.remove_updater", alternatives=("Mobject.add_updater", "Mobject.remove_updater"))
            if receiver not in types or method in changed_attributes or method.startswith(("get_", "set_", "_")):
                continue
            key, assigned = types[receiver]
            if node.lineno <= assigned:
                continue
            layers, complete = hierarchy(classes, key)
            methods = {name for layer in layers for name in layer["methods"]}
            attributes = {name for layer in layers for name in layer["attributes"]}
            if method not in methods and method not in attributes and method not in {"animate", "always"}:
                name = classes[key]["name"]
                alternatives = [f"{name}.{item}" for item in get_close_matches(method, sorted(methods), n=2, cutoff=0.64)]
                alternatives.extend(f"{name}.{item}" for item in RELATED.get(name, ()) if item in methods)
                # A nonstandard attribute provider or an unindexed base makes
                # absence uncertain. Bindings outside a simple assignment are skipped.
                note("unknownMethod", node, f"{name}.{method}",
                     complete and not any(layer["dynamic"] for layer in layers), dict.fromkeys(alternatives))
    return findings


def check_scene(tree, segments, bindings):
    scene = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "GeneratedScene")
    if not scene.bases or all(imported_symbol(base, bindings)[0] == "manim" for base in scene.bases):
        raise Rejected("entryPoint", "Use a Sahaya cue scene base for GeneratedScene.", scene.lineno)
    construct = next(node for node in scene.body if isinstance(node, ast.FunctionDef) and node.name == "construct")
    calls = [item for item in ast.walk(construct) if cue_call(item)]
    direct = [item.context_expr for node in construct.body if isinstance(node, ast.With) for item in node.items
              if item.context_expr in calls]
    if direct and len(direct) == len(calls) and all(
        len(call.args) == 1 and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str)
        for call in direct
    ) and [call.args[0].value for call in direct] != [segment["id"] for segment in segments]:
        raise Rejected("cues", "The literal cue IDs and their order must match the supplied metadata.", direct[0].lineno)


def preflight(request):
    data = knowledge()
    result = {"version": MANIM_VERSION, "findings": []}
    try:
        source = request.get("source") if isinstance(request, dict) else None
        if not isinstance(source, str) or not 0 < len(source.encode()) <= MAX_SOURCE or "\x00" in source:
            check_request(request)
        try:
            tree = ast.parse(source, filename="<sahaya-scene>")
        except (SyntaxError, ValueError, RecursionError, MemoryError):
            check_request(request)
            raise
        source, operation = normalize(source, tree, imports(tree))
        if operation:
            result["normalization"] = operation
        candidate = {**request, "source": source}
        check_request(candidate)
        result["source"] = source
        if operation:
            tree = ast.parse(source, filename="<sahaya-scene>")
        bindings = imports(tree)
        check_scene(tree, candidate["segments"], bindings)
        result["findings"] = api_findings(tree, bindings, data)
        if any(finding["severity"] == "error" for finding in result["findings"]):
            finding = next(finding for finding in result["findings"] if finding["severity"] == "error")
            raise Rejected("api", "Check the referenced Manim API against the pinned index.", finding["line"])
    except Rejected as error:
        result["issue"] = error.issue
    return result
