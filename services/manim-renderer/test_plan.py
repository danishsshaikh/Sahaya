import copy
import math
import unittest

from demos import demos
from plan import safe_tex, validate
from science import compute, derivative, expression


class ScientificModelTests(unittest.TestCase):
    def test_quadratic_derivative_and_descent(self):
        function = expression("x^2 + 1")
        self.assertAlmostEqual(derivative(function, 3), 6, places=8)
        model = compute({"kind": "gradient_descent", "expression": "x^2", "initial": 4,
                         "rate": 0.25, "iterations": 3})
        for (x, y), expected in zip(model.samples["iterations"], (4, 2, 1, 0.5), strict=True):
            self.assertAlmostEqual(x, expected, places=8)
            self.assertAlmostEqual(y, expected ** 2, places=8)

    def test_projectile_uses_si_parameters_and_lands_at_zero(self):
        data = compute({"kind": "projectile", "speed": 10, "angle": 45, "gravity": 10})
        lo, hi = data.domains["trajectory"]
        self.assertAlmostEqual(lo, 0)
        self.assertAlmostEqual(hi, 10)
        self.assertAlmostEqual(data.functions["trajectory"](hi / 2), 2.5)
        self.assertAlmostEqual(data.functions["trajectory"](hi), 0)

    def test_opposite_phase_waves_cancel_and_sort_keeps_duplicates(self):
        waves = compute({"kind": "interference", "wavelength": 3, "phase": math.pi})
        for x in [0, .4, 4]:
            self.assertAlmostEqual(waves.functions["sum"](x), 0)
        sorting = compute({"kind": "insertion_sort", "values": [3, 1, 3, 1]})
        self.assertEqual(sorting.arrays, [[3, 1, 3, 1], [1, 3, 3, 1], [1, 3, 3, 1], [1, 1, 3, 3]])

    def test_expression_syntax_and_domain_fail_closed(self):
        for raw in ["x.attribute", "unknown(x)", "[x]", "x**400", "1/0", "sqrt(-1)", "9"*181]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                expression(raw)(2)
        with self.assertRaises(ValueError):
            derivative(expression("sqrt(x^2)"), 0)


class PlanTests(unittest.TestCase):
    def test_all_demonstrations_validate(self):
        for name, plan in demos().items():
            with self.subTest(name=name):
                validate(plan)

    def test_valid_equations_only_allow_simple_math(self):
        safe_tex(r"\frac{dy}{dx}=2x")
        for text in [r"\unknown{x}", "x^^2", "$x$", "1%2", "{x", "x}"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                safe_tex(text)

    def test_strict_shape_and_resource_bounds(self):
        plan = demos()["derivative"]
        for mutate in [
            lambda p: p.update(engine="python"),
            lambda p: p.update(code="unsupported"),
            lambda p: p["objects"].append(copy.deepcopy(p["objects"][0])),
            lambda p: p["timeline"][0]["animations"][0].update(op="unknown"),
            lambda p: p["timeline"][0]["animations"][0].update(object="absent"),
            lambda p: p["objects"][0].update(at=[float("nan"), 1]),
            lambda p: p["objects"].extend({"id": f"new{i}", "kind": "dot"} for i in range(49)),
        ]:
            invalid = copy.deepcopy(plan)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate(invalid)
        with self.assertRaisesRegex(ValueError, "exceeds"):
            validate(plan, max_duration=1)

    def test_parameter_changes_obey_scientific_domain(self):
        plan = demos()["projectile"]
        plan["model"]["angle"] = 90
        with self.assertRaises(ValueError):
            validate(plan)
        plan = demos()["derivative"]
        plan["objects"][1] = {"id": "f", "kind": "graph", "axes": "axes", "expression": "1/x"}
        with self.assertRaises(ValueError):
            validate(plan)
