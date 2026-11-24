"""Bounded numerical models. Renderers consume values in physical/data units."""

import ast
from dataclasses import dataclass, field
import math
import operator

MAX_VALUE = 1_000_000
OPERATORS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
             ast.Div: operator.truediv, ast.Pow: operator.pow}
FUNCTIONS = {name: getattr(math, name) for name in ("sin", "cos", "exp", "sqrt", "log", "tan")}
CONSTANTS = {"pi": math.pi, "e": math.e}


def sinc(x):
    """Unnormalized sinc, with the continuous limiting value at zero."""
    return 1.0 if x == 0 else math.sin(x) / x


FUNCTIONS["sinc"] = sinc


def bounded(value):
    if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > MAX_VALUE:
        raise ValueError("Calculation exceeded the finite numerical domain")
    return float(value)


def expression(text, variables=("x",)):
    if len(text) > 180:
        raise ValueError("Expression is too long")
    try:
        root = ast.parse(text.replace("^", "**"), mode="eval")
    except (SyntaxError, RecursionError) as error:
        raise ValueError("Invalid mathematical expression") from error
    if sum(1 for _ in ast.walk(root)) > 64:
        raise ValueError("Expression is too complex")

    def compile_node(node):
        if isinstance(node, ast.Constant):
            value = bounded(node.value)
            return lambda _: value
        if isinstance(node, ast.Name):
            if node.id in variables:
                return lambda values: values[node.id]
            if node.id in CONSTANTS:
                return lambda _: CONSTANTS[node.id]
        if isinstance(node, ast.UnaryOp) and type(node.op) in (ast.UAdd, ast.USub):
            operand = compile_node(node.operand)
            sign = -1 if isinstance(node.op, ast.USub) else 1
            return lambda values: sign * operand(values)
        if isinstance(node, ast.BinOp) and type(node.op) in OPERATORS:
            left, right = compile_node(node.left), compile_node(node.right)
            op = OPERATORS[type(node.op)]

            def binary(values):
                lhs, rhs = left(values), right(values)
                if op is operator.pow and abs(rhs) > 12:
                    raise ValueError("Exponent must be between -12 and 12")
                return bounded(op(lhs, rhs))
            return binary
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id in FUNCTIONS and len(node.args) == 1 and not node.keywords):
            fn = FUNCTIONS[node.func.id]
            argument = compile_node(node.args[0])
            return lambda values: bounded(fn(argument(values)))
        raise ValueError("Expression contains unsupported syntax")

    evaluator = compile_node(root.body)

    def calculate(*args):
        try:
            return bounded(evaluator(dict(zip(variables, args, strict=True))))
        except (ArithmeticError, ValueError) as error:
            raise ValueError("Expression is undefined or out of range in the requested domain") from error
    return calculate


def derivative(fn, x):
    step = 1e-4 * max(1, abs(x))
    coarse = (fn(x + step) - fn(x - step)) / (2 * step)
    fine = (fn(x + step / 2) - fn(x - step / 2)) / step
    center = fn(x)
    left = (center - fn(x - step / 2)) / (step / 2)
    right = (fn(x + step / 2) - center) / (step / 2)
    if not math.isclose(coarse, fine, rel_tol=1e-3, abs_tol=1e-5):
        raise ValueError("Derivative did not converge near the selected point")
    if abs(left - right) > max(1e-2, abs(fine) * 0.035):
        raise ValueError("Derivative is unstable near the selected point")
    return bounded((4 * fine - coarse) / 3)


@dataclass
class ScientificData:
    functions: dict = field(default_factory=dict)
    samples: dict = field(default_factory=dict)
    arrays: list = field(default_factory=list)
    domains: dict = field(default_factory=dict)


class ModelError(ValueError):
    def __init__(self, field, message):
        super().__init__(message)
        self.field = field


def compute(model):
    data = ScientificData()
    if not model:
        return data
    kind = model["kind"]
    if kind in ("derivative", "gradient_descent"):
        try:
            fn = expression(model["expression"])
        except ValueError as error:
            raise ModelError("expression", f"{kind}: {error}") from error
        data.functions["function"] = fn
        if kind == "derivative":
            x = model["x"]
            try:
                slope, y = derivative(fn, x), fn(x)
            except ValueError as error:
                raise ModelError("x", f"Derivative evaluation at x failed. {error}") from error
            data.functions["tangent"] = lambda v: y + slope * (v - x)
            data.samples["tangent"] = [(x, y)]
        else:
            x = model["initial"]
            try:
                points = [(x, fn(x))]
            except ValueError as error:
                raise ModelError("initial", f"Loss evaluation at the initial point failed. {error}") from error
            for step in range(model["iterations"]):
                try:
                    gradient = derivative(fn, x)
                except ValueError as error:
                    field = "initial" if step == 0 else "rate"
                    raise ModelError(field, f"Gradient evaluation failed before step {step + 1}. Check the loss domain and step size. {error}") from error
                try:
                    x = bounded(x - model["rate"] * gradient)
                    points.append((x, fn(x)))
                except ValueError as error:
                    raise ModelError("rate", f"Step {step + 1} left the bounded domain of the loss. {error}") from error
            data.samples["iterations"] = points
            data.functions["lossSurface"] = lambda x, y: bounded(fn(x) + y * y)
    elif kind == "projectile":
        # Launch and landing at y=0, constant downward gravity, no drag. SI units.
        angle = math.radians(model["angle"])
        vx = model["speed"] * math.cos(angle)
        vy = model["speed"] * math.sin(angle)
        gravity = model["gravity"]
        flight = 2 * vy / gravity
        distance = vx * flight

        def height(x):
            t = x / vx
            return t * (vy - gravity * t / 2)

        data.functions["trajectory"] = height
        data.domains["trajectory"] = (0, distance)
        data.samples["trajectory"] = [(i * distance / 80, height(i * distance / 80)) for i in range(81)]
    elif kind == "interference":
        wave_number = math.tau / model["wavelength"]
        a = lambda x: math.sin(wave_number * x)
        b = lambda x: math.sin(wave_number * x + model["phase"])
        data.functions.update(waveA=a, waveB=b, sum=lambda x: a(x) + b(x))
    elif kind == "insertion_sort":
        values = list(model["values"])
        data.arrays.append(values.copy())
        for end in range(1, len(values)):
            index = end
            while index and values[index] < values[index - 1]:
                values[index], values[index - 1] = values[index - 1], values[index]
                index -= 1
            data.arrays.append(values.copy())
    return data
