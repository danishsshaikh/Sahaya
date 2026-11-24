"""Wire limits shared by the trusted publisher, broker and isolated worker."""

import ast
import math
import os
import re

MANIM_VERSION = "0.22.1"
PROTOCOL = 1
PUBLISHER_PROTOCOL = 4
QUALITY = {"preview": (854, 480, 15), "standard": (1280, 720, 30), "high": (1920, 1080, 30)}
MAX_SOURCE = 48 * 1024
MAX_REQUEST = 128 * 1024
MAX_VIDEO = min(50 * 1024 ** 2, max(1024, int(os.getenv("MANIM_MAX_ARTIFACT_BYTES", "52428800"))))
MAX_RESULT = (MAX_VIDEO + 2) // 3 * 4 + 16384
MAX_DURATION = min(90, max(5, int(os.getenv("MANIM_MAX_DURATION", "90"))))
ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,31}")
HEX = re.compile(r"[a-f0-9]{64}")
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")
ALLOWED_IMPORTS = {"manim", "sahaya_timing", "math", "numpy", "random", "itertools", "functools"}
DISALLOWED = {"open", "compile", "eval", "exec", "input", "breakpoint", "globals",
              "locals", "vars", "getattr", "setattr", "delattr", "config", "tempconfig",
              "add_sound", "interactive_embed", "embed"}


class Rejected(ValueError):
    def __init__(self, code, message, line=None, symbol=None):
        super().__init__(message)
        self.issue = {"code": code, "message": message}
        if type(line) is int and 1 <= line <= 10000:
            self.issue["line"] = line
        if isinstance(symbol, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,47}", symbol):
            self.issue["symbol"] = symbol


def check_source(source):
    if not isinstance(source, str) or not 0 < len(source.encode()) <= MAX_SOURCE or "\x00" in source:
        raise Rejected("source", "Submit a bounded UTF-8 Python module.")
    try:
        tree = ast.parse(source, filename="<sahaya-scene>")
    except SyntaxError as error:
        raise Rejected("syntax", "Python syntax or indentation is invalid.", error.lineno) from None
    except (ValueError, RecursionError, MemoryError):
        raise Rejected("source", "Python source exceeds parser limits.") from None
    entry = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "GeneratedScene"]
    if len(entry) != 1 or not any(isinstance(node, ast.FunctionDef) and node.name == "construct" for node in entry[0].body):
        raise Rejected("entryPoint", "Define one GeneratedScene class with a construct method.")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            if (isinstance(node, ast.ImportFrom) and node.level or
                    any(name not in ALLOWED_IMPORTS for name in names)):
                raise Rejected("import", "Use Manim, the cue adapter, or the standard numerical helpers.", node.lineno)
        name = node.attr if isinstance(node, ast.Attribute) else node.id if isinstance(node, ast.Name) else ""
        if name.startswith("__") or name in DISALLOWED:
            raise Rejected("operation", "Use native scene APIs without dynamic execution, raw files or renderer overrides.",
                           node.lineno)
    return tree


def check_request(body):
    if not isinstance(body, dict) or set(body) != {"source", "segments", "minimums", "quality", "publication"}:
        raise Rejected("request", "Expected source, cue metadata and rendering options.")
    check_source(body["source"])
    if body["quality"] not in QUALITY.keys() or body["publication"] not in ("none", "preview", "saved"):
        raise Rejected("request", "Invalid rendering options.")
    segments = body["segments"]
    identifiers = set()
    narrated = False
    if not isinstance(segments, list) or not 1 <= len(segments) <= 24:
        raise Rejected("cues", "Provide 1–24 ordered cue records.")
    for segment in segments:
        if not isinstance(segment, dict) or set(segment) - {"id", "narration", "caption"}:
            raise Rejected("cues", "Each cue needs an ID and optional spoken text or caption.")
        identifier = segment.get("id")
        if not isinstance(identifier, str) or not ID.fullmatch(identifier) or identifier in identifiers:
            raise Rejected("cues", "Use unique cue IDs that start with a letter.")
        identifiers.add(identifier)
        for name in ("narration", "caption"):
            if name in segment:
                text = segment[name]
                if (not isinstance(text, str) or not 1 <= len(text.strip()) <= 420
                        or any(ord(char) < 32 for char in text)):
                    raise Rejected("cues", "Use one short plain-text sentence per cue.")
        narrated |= "narration" in segment
    if not narrated:
        raise Rejected("cues", "Include at least one narration segment.")
    minimums = body["minimums"]
    if not isinstance(minimums, dict) or minimums.keys() - identifiers or any(
        type(value) not in (int, float) or not 0 < value <= 24 for value in minimums.values()
    ) or sum(minimums.values()) > MAX_DURATION:
        raise Rejected("timing", "Measured cue durations exceed the per-cue or scene timing limit.")
    return body


def check_frames(frames, expected, fps, minimums):
    if not isinstance(frames, list) or len(frames) != len(expected):
        raise Rejected("cues", "Render exactly one ordered frame interval per cue.")
    start = 0
    cues = []
    for segment, entry in zip(expected, frames, strict=True):
        if not isinstance(entry, list) or len(entry) != 2:
            raise Rejected("cues", "Cue frames are malformed.")
        identifier, end = entry
        if (identifier != segment["id"] or type(end) is not int or not start < end <= MAX_DURATION * fps
                or end - start < math.ceil(minimums.get(identifier, 0) * fps)):
            raise Rejected("timing", "Cue frames do not match the ordered IDs or measured narration duration.")
        cues.append({**segment, "start": start / fps, "end": end / fps})
        start = end
    return cues, start
