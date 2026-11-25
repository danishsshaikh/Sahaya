#!/usr/bin/env python3
"""Index the pinned Manim distribution and matching official RST sources without importing Manim."""
import argparse
import ast
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import tarfile
import zipfile

VERSION = "0.22.1"
WHEEL = "797ee45a3c722a9da428bda9f11cd996ba951af5303b609dfb790352c56a46ea"
DOCS = "cc5b7907ac008b861fba3b1d41f60cd4deff97c8e218e0c7eb128e429a1d0794"
ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = f"https://github.com/ManimCommunity/manim/tree/v{VERSION}"
DOCUMENTS = (
    "faq/index.rst", "guides/deep_dive.rst", "guides/using_text.rst",
    "tutorials/building_blocks.rst", "reference_index/animations.rst",
    "reference_index/cameras.rst", "reference_index/utilities_misc.rst",
)


def verified(path, expected):
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit(f"Checksum mismatch: {path.name}")


def assigns(node):
    if isinstance(node, ast.Assign):
        return [target.id for target in node.targets if isinstance(target, ast.Name)]
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return [node.target.id]
    return []


def doc(node):
    value = ast.get_docstring(node) or ""
    # Keep the primary summary and bounded documented Parameters / Returns.
    return re.split(r"\n\s*(?:Examples|References|See Also)\n\s*-{3,}", value, maxsplit=1)[0][:1200].strip()


def callable_data(node, method=False):
    args = node.args
    positional = args.posonlyargs + args.args
    start = 1 if method and positional and positional[0].arg in ("self", "cls") else 0
    name = args.kwarg.arg if args.kwarg else None
    forwards = [keyword for item in ast.walk(node) if isinstance(item, ast.Call)
                and isinstance(item.func, ast.Attribute) and item.func.attr == "__init__"
                and isinstance(item.func.value, ast.Call)
                and isinstance(item.func.value.func, ast.Name) and item.func.value.func.id == "super"
                for keyword in item.keywords if keyword.arg is None
                and isinstance(keyword.value, ast.Name) and keyword.value.id == name]
    return {
        "signature": f"({ast.unparse(args)})" + (f" -> {ast.unparse(node.returns)}" if node.returns else ""),
        "keywords": [a.arg for a in args.args[max(0, start - len(args.posonlyargs)):] + args.kwonlyargs],
        "variadicKeywords": args.kwarg is not None,
        **({"forwardsKeywords": True} if forwards and sum(isinstance(item, ast.Name) and item.id == name
           for item in ast.walk(node)) == 1 else {}),
        "doc": doc(node), "line": node.lineno,
    }


def index(wheel, docs, verify_installed=False):
    verified(wheel, WHEEL)
    verified(docs, DOCS)
    installed = importlib.metadata.distribution("manim") if verify_installed else None
    if installed and installed.version != VERSION:
        raise SystemExit(f"Installed Manim must be {VERSION}")
    modules, paths = {}, {}
    with zipfile.ZipFile(wheel) as archive:
        for name in sorted(archive.namelist()):
            if not name.startswith("manim/") or not name.endswith(".py"):
                continue
            data = archive.read(name)
            if installed and Path(installed.locate_file(name)).read_bytes() != data:
                raise SystemExit(f"Installed source differs from pinned wheel: {name}")
            module = name[:-3].replace("/", ".").removesuffix(".__init__")
            modules[module], paths[module] = ast.parse(data, filename=name), name

    classes, functions, values, all_names, import_aliases, star_imports = {}, {}, {}, {}, {}, {}
    for module, tree in modules.items():
        exported, collected, aliases, stars = None, [], {}, []
        package = module if paths[module].endswith("/__init__.py") else module.rsplit(".", 1)[0]
        for node in tree.body:
            if isinstance(node, ast.ImportFrom):
                root = package.split(".")[:len(package.split(".")) - node.level + 1] if node.level else []
                target = ".".join(root + ([node.module] if node.module else []))
                for alias in node.names:
                    if alias.name == "*":
                        stars.append(target)
                    else:
                        aliases[alias.asname or alias.name] = f"{target}.{alias.name}"
                        collected.append(alias.asname or alias.name)
            if isinstance(node, ast.ClassDef):
                key = f"{module}.{node.name}"
                methods = {item.name: callable_data(item, True) for item in node.body
                           if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                           and (not item.name.startswith("_") or item.name == "__init__")}
                classes[key] = {
                    "name": node.name, "path": paths[module], "line": node.lineno, "doc": doc(node),
                    "bases": [ast.unparse(base) for base in node.bases],
                    "dynamic": any(isinstance(item, ast.FunctionDef) and item.name in ("__getattr__", "__getattribute__")
                                   for item in node.body) and key != "manim.mobject.mobject.Mobject",
                    "methods": methods,
                    "attributes": sorted({item.attr for item in ast.walk(node)
                                          if isinstance(item, ast.Attribute) and isinstance(item.ctx, ast.Store)
                                          and isinstance(item.value, ast.Name) and item.value.id in ("self", "cls")}
                                         | {name for item in node.body for name in assigns(item)}),
                }
                collected.append(node.name)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
                functions[f"{module}.{node.name}"] = {**callable_data(node), "path": paths[module]}
                collected.append(node.name)
            for name in assigns(node):
                if name == "__all__":
                    try:
                        exported = ast.literal_eval(node.value)
                    except (ValueError, TypeError):
                        pass
                if name.isupper() and not name.startswith("_") and node.value:
                    values[f"{module}.{name}"] = {
                        "value": ast.unparse(node.value)[:160], "path": paths[module], "line": node.lineno,
                    }
                    collected.append(name)
        all_names[module] = (exported if isinstance(exported, (tuple, list)) else None, collected)
        import_aliases[module] = aliases
        star_imports[module] = stars

    def module_exports(module, seen=frozenset()):
        if module in seen or module not in all_names:
            return {}
        explicit, local = all_names[module]
        output = {}
        for target in star_imports[module]:
            output.update(module_exports(target, seen | {module}))
        output.update({name: import_aliases[module].get(name, f"{module}.{name}") for name in local})
        if explicit is not None:
            output = {name: output[name] for name in explicit if name in output}
        return {name: key for name, key in output.items() if not name.startswith("_")}

    exports = {}
    for node in modules["manim"].body:
        if not isinstance(node, ast.ImportFrom) or node.level != 1 or not node.module:
            continue
        module = f"manim.{node.module}"
        for alias in node.names:
            if alias.name == "*":
                exports.update(module_exports(module))
            else:
                exports[alias.asname or alias.name] = f"{module}.{alias.name}"
    exports = {name: key for name, key in exports.items() if key in classes or key in functions or key in values}
    for key, entry in classes.items():
        module = key.rsplit(".", 1)[0]
        resolved = []
        for base in entry["bases"]:
            # Unresolved external / dynamic bases stay explicitly unknown to the preflight.
            name = re.split(r"\[", base, maxsplit=1)[0]
            path = import_aliases[module].get(name, f"{module}.{name}")
            resolved.append(path if path in classes else exports.get(name, base))
        entry["bases"] = resolved

    documents = []
    with tarfile.open(docs, "r:gz") as archive:
        for path in DOCUMENTS:
            file = f"docs/source/{path}"
            text = archive.extractfile(f"manim-{VERSION}/{file}").read().decode()
            # Pick passages from the official guides, retaining their direct provenance.
            if "reference_index/" in path:
                passages = re.findall(r"^\s{3,}([A-Za-z]\w+)\s*$", text, re.M)
                documents.append({"path": file, "symbols": [p for p in passages if p in exports]})
            else:
                for match in re.finditer(r"(?m)^([^\n]+\b(?:Cairo|OpenGL)\b[^\n]*(?:\n(?!\s*\n)[^\n]+){0,2})", text):
                    passage = " ".join(match[1].split())[:350]
                    if passage:
                        documents.append({"path": file, "text": passage})

    return {"version": VERSION, "provenance": {"tag": f"v{VERSION}", "upstream": UPSTREAM,
            "wheelSha256": WHEEL, "documentationSha256": DOCS, "license": "MIT"},
            "exports": exports, "classes": classes, "functions": functions, "constants": values,
            "documents": documents}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--docs", type=Path, required=True)
    parser.add_argument("--verify-installed", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "services/manim-renderer/manim_api.json")
    options = parser.parse_args()
    data = index(options.wheel, options.docs, options.verify_installed)
    options.output.write_text(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
