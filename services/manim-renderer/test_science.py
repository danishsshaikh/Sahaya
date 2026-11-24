import math
import unittest

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


    def test_diffraction_analytical_regression_cases(self):
        intensity = expression("sinc(pi*x)^2")
        grating = expression("((1+2*cos(2*pi*x)+2*cos(4*pi*x))/5)^2")
        self.assertAlmostEqual(intensity(0), 1)
        for order in (-2, -1, 1, 2):
            self.assertAlmostEqual(intensity(order), 0)
            self.assertAlmostEqual(grating(order), 1)
        for point in (0.2, 0.4, 0.6, 0.8):
            self.assertAlmostEqual(grating(point), 0)
