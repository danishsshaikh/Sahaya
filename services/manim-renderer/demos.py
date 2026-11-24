"""Deterministic educational fixtures and real Cairo render benchmark."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time


from diffraction_demos import diffraction_demos

def obj(id, kind, **kwargs):
    return {"id": id, "kind": kind, **kwargs}


def beat(seconds, *animations, narration=None):
    return {"seconds": seconds, "animations": [
        {"op": a[0], "object": a[1], **(a[2] if len(a) > 2 else {})} for a in animations
    ], **({"narration": narration} if narration else {})}


def plan(title, objective, objects, timeline, model=None, **kwargs):
    spec = dict(version=1, type="visualization", engine="manim", title=title, objective=objective,
                objects=objects, timeline=timeline, seed=17, **kwargs)
    if model:
        spec["model"] = model
    return spec


BLUE, GOLD, GREEN, ROSE = "#6CDCF5", "#FFD079", "#A5E5AE", "#FF9FB3"


def demos():
    axes = obj("axes", "axes", xRange=[-3, 3], yRange=[-4, 9], height=4, at=[0, -0.4])
    f = obj("f", "graph", axes="axes", source="function", color=BLUE)
    tangent = obj("tangent", "graph", axes="axes", xRange=[-0.8, 2.8], source="tangent", color=GOLD)
    dot = obj("dot", "samples", axes="axes", source="tangent", color=ROSE)
    derivative = plan("A slope at one point", "Identify a derivative as tangent slope",
        [axes, f, tangent, dot, obj("label", "equation", text="f(x)=x^2, f'(1)=2", size=5.5, at=[0, 2.7])],
        [beat(1.5, ("create", "axes"), ("create", "f"), narration="The curve gives the height at each x."),
         beat(1.5, ("fadeIn", "dot"), ("create", "tangent"), narration="The tangent shows the local rate of change."),
         beat(1.5, ("write", "label"), narration="At x equals one, its slope is two.")],
        {"kind": "derivative", "expression": "x^2", "x": 1})

    projectile = plan("One launch, two motions", "Connect horizontal distance and vertical acceleration",
        [obj("a", "axes", xRange=[0, 23], yRange=[0, 8], size=9, height=4, at=[0, -.4]),
         obj("path", "graph", axes="a", source="trajectory", color=BLUE),
         obj("ball", "samples", axes="a", source="trajectory", index=0, color=GOLD),
         obj("assumptions", "text", text="12 m/s · 45° · constant gravity · no drag", at=[0, 2.8])],
        [beat(1.5, ("fadeIn", "assumptions"), ("create", "a"), ("fadeIn", "ball"), narration="Launch and landing share the same height."),
         beat(1.5, ("create", "path"), narration="Gravity bends the path downwards."),
         beat(1.5, ("follow", "ball", {"target": "path"}), narration="The point traces the trajectory.")],
        {"kind": "projectile", "speed": 12, "angle": 45, "gravity": 9.81})

    waves = plan("Destructive interference", "Add two opposite-phase displacements pointwise",
        [obj("axes", "plane", xRange=[0, 8], yRange=[-2, 2], height=4.4, at=[0, -.4]),
         obj("a", "graph", axes="axes", source="waveA", color=BLUE),
         obj("b", "graph", axes="axes", source="waveB", color=ROSE),
         obj("sum", "graph", axes="axes", source="sum", color=GOLD),
         obj("equation", "equation", text=r"\sin(x)+\sin(x+\pi)=0", at=[0, 2.8])],
        [beat(1.5, ("fadeIn", "axes"), ("create", "a"), narration="The blue curve is the first wave."),
         beat(1.5, ("create", "b"), narration="The pink wave is shifted by half a period."),
         beat(1.5, ("create", "sum"), ("write", "equation"), narration="Opposite displacements sum to zero.")],
        {"kind": "interference", "wavelength": 6.283185307179586, "phase": 3.141592653589793})

    model = {"kind": "gradient_descent", "expression": "x^2", "initial": 2.8, "rate": .22, "iterations": 5}
    samples = [obj(f"p{i}", "samples", axes="axes", source="iterations", index=i, color=GOLD) for i in range(6)]
    descent = plan("Steps down a loss curve", "Connect the gradient to successive iterates",
        [axes, f, *samples, obj("rule", "equation", text=r"x_{k+1}=x_k-\alpha f'(x_k)", at=[0, 2.8])],
        [beat(1.5, ("create", "axes"), ("create", "f"), ("write", "rule"), narration="The vertical axis is the loss."),
         beat(.7, ("fadeIn", "p0"), narration="Start on the right slope."),
         *(beat(.6, ("replace", f"p{i}", {"target": f"p{i+1}"})) for i in range(5)),
         beat(1, ("indicate", "p5"), narration="Each step moves closer to the minimum.")], model)

    surface = plan("A cross-section of a loss surface", "Relate the same one-dimensional descent to the y=0 slice",
        [obj("frame", "axes3d", size=7, height=6, xRange=[-3, 3], yRange=[-3, 3]),
         obj("surface", "surface", axes="frame", xRange=[-2.8, 2.8], yRange=[-2.0, 2.0], source="lossSurface", color=BLUE),
         obj("origin", "samples3d", axes="frame", source="iterations", color=GOLD)],
        [beat(1, ("create", "frame")), beat(1.6, ("fadeIn", "surface"), narration="The bowl adds a squared perpendicular coordinate."),
         {"seconds": 1.4, "camera": {"phi": 69, "theta": -18}, "narration": "Turn the axes to see both directions."},
         beat(1.3, ("fadeIn", "origin"), narration="The gold iterates approach the minimum along the center slice.")], model,
        camera={"phi": 57, "theta": -44})

    step_labels = [obj(f"card{i}", "modelValue", text="x = ", source="iterations", component="x", index=i, size=3.3, at=[-4.8 + i * 1.92, .5], color=BLUE) for i in range(6)]
    updates = plan("Updates shrink near the minimum", "Compare consecutive iterates in the update sequence",
        [*step_labels, obj("rule", "equation", text=r"x_{k+1}=0.56x_k", at=[0, 2.5], color=GOLD)],
        [beat(1, ("write", "rule"), narration="This loss and rate multiply x by point five six."),
         *(beat(.65, ("fadeIn", f"card{i}")) for i in range(6)),
         beat(1.2, ("indicate", "card5"), narration="The positions approach zero.")], model)

    numbers = [7, 2, 6, 3, 4]
    sorting = plan("Grow a sorted prefix", "Observe stable insertion sort after each outer iteration",
        [obj(f"row{i}", "array", index=i, at=[0, .35], color=GREEN) for i in range(len(numbers))] +
        [obj("label", "text", text="Insertion sort", at=[0, 2.2], color=BLUE)],
        [beat(1.2, ("write", "label"), ("fadeIn", "row0"), narration="The first cell is the initial sorted prefix."),
         *(beat(.8, ("replace", f"row{i}", {"target": f"row{i+1}"})) for i in range(len(numbers) - 1)),
         beat(1, ("indicate", "row4"), narration="The prefix now covers the whole array.")],
        {"kind": "insertion_sort", "values": numbers})

    return {"derivative": derivative, "projectile": projectile, "interference": waves,
            "gradient-curve": descent, "gradient-surface": surface, "gradient-updates": updates,
            "sorting": sorting, **diffraction_demos(obj, beat, plan, BLUE, GOLD, ROSE)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--quality", choices=("preview", "standard", "high"), default="preview")
    parser.add_argument("--only", nargs="+", choices=demos())
    args = parser.parse_args()
    args.output.mkdir(exist_ok=True, parents=True)
    report = {}
    for name, spec in demos().items():
        if args.only and name not in args.only:
            continue
        target = args.output / name
        target.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / "plan.json").write_text(json.dumps(spec))
            start = time.monotonic()
            subprocess.run([sys.executable, str(Path(__file__).with_name("render.py")), directory, args.quality], check=True)
            elapsed = time.monotonic() - start
            metadata = json.loads((job / "metadata.json").read_text())
            metadata["wallSeconds"] = round(elapsed, 2)
            report[name] = metadata
            for filename in ("video.mp4", "poster.jpg", "metadata.json", "plan.json"):
                (target / filename).write_bytes((job / filename).read_bytes())
            print(name, metadata["wallSeconds"], metadata["bytes"], flush=True)
    (args.output / "report.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
