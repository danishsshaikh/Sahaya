import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import manim_preflight
import server


EXAMPLES = Path(__file__).resolve().parents[2] / "skills" / "sahaya-manim" / "examples"
SOURCE = '''from manim import *
from sahaya_timing import CueScene
class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("intro"):
            axis = NumberLine(include_numbers=True)
            self.play(Create(axis), FadeIn(Dot(axis.n2p(0))))
'''
REQUEST = {"source": SOURCE, "segments": [{"id": "intro", "narration": "Draw the number line."}],
           "minimums": {}, "quality": "preview", "publication": "none"}


class ManimPreflightTests(unittest.TestCase):
    def check(self, source):
        return manim_preflight.preflight({**REQUEST, "source": source})

    def test_recovers_wrong_entry_point_without_changing_other_lines(self):
        result = self.check(SOURCE.replace("GeneratedScene", "PointOnNumberLine"))
        self.assertNotIn("issue", result)
        self.assertEqual(result["source"], SOURCE)
        self.assertEqual(result["normalization"], {"from": "PointOnNumberLine", "line": 3})

    def test_declines_ambiguous_or_referenced_scene_renaming(self):
        wrong = SOURCE.replace("GeneratedScene", "PointOnNumberLine")
        for source in [wrong + wrong[wrong.index("class "):].replace("PointOnNumberLine", "OtherScene"),
                       wrong + "scene_type = PointOnNumberLine\n",
                       wrong.replace("class", "@decorate\nclass", 1),
                       SOURCE.replace("(CueScene):", "(Scene):")]:
            with self.subTest(source=source):
                result = self.check(source)
                self.assertEqual(result["issue"]["code"], "entryPoint")
                self.assertNotIn("normalization", result)

    def test_enforces_contract_after_normalization(self):
        wrong = SOURCE.replace("GeneratedScene", "PointOnNumberLine")
        for source, code in [("import os\n" + wrong, "import"),
                             (wrong.replace("Create(axis)", "open('private.txt')"), "operation"),
                             (wrong.replace('self.cue("intro")', 'self.cue("different")'), "cues"),
                             (wrong.replace("include_numbers=True)", "include_numbers=True"), "syntax")]:
            with self.subTest(code=code):
                self.assertEqual(self.check(source)["issue"]["code"], code)

    def test_reports_hallucinated_method_and_real_alternatives(self):
        result = self.check(SOURCE.replace("axis.n2p(0)", "axis.nudge(0)"))
        self.assertEqual(result["issue"]["code"], "api")
        finding = result["findings"][0]
        self.assertEqual((finding["symbol"], finding["line"], finding["severity"]), ("NumberLine.nudge", 7, "error"))
        self.assertIn("NumberLine.n2p", finding["alternatives"])
        self.assertIn("NumberLine.number_to_point", finding["alternatives"])
        self.assertNotIn("issue", self.check(SOURCE.replace("axis.n2p", "axis.number_to_point")))

    def test_rejects_closed_constructor_keyword_but_allows_uncertain_bindings(self):
        result = self.check(SOURCE.replace("Create(axis)", "Scene(not_a_parameter=True)"))
        self.assertEqual(result["issue"]["code"], "api")
        self.assertEqual(result["findings"][0]["kind"], "constructorKeyword")
        # Type provider is not a direct indexed constructor, so inspection defers to the isolated preview.
        dynamic = SOURCE.replace("axis = NumberLine(include_numbers=True)", "axis = make_axis()")
        self.assertNotIn("issue", self.check(dynamic))
        # An instance-specific method exists in the source and is allowed by the contract.
        patched = SOURCE.replace("            self.play", "            axis.custom = axis.n2p\n            self.play")
        self.assertNotIn("issue", self.check(patched.replace("Dot(axis.n2p(0))", "Dot(axis.custom(0))")))

    def test_updater_and_animation_lifecycle_hints_are_warnings(self):
        result = self.check(SOURCE.replace("self.play(Create(axis), FadeIn(Dot(axis.n2p(0))))",
                                           "axis.remove_updater(lambda item: item)\n            self.play(axis)"))
        self.assertNotIn("issue", result)
        self.assertEqual([(finding["kind"], finding["severity"]) for finding in result["findings"]],
                         [("updaterIdentity", "warning"), ("animationLifecycle", "warning")])

    def test_matches_pinned_index_and_statically_validates_all_examples(self):
        self.assertEqual(manim_preflight.knowledge()["version"], "0.22.1")
        with patch.object(manim_preflight.Path, "read_text", return_value='{"version":"0.22.0"}'), \
                self.assertRaisesRegex(RuntimeError, "version mismatch"):
            manim_preflight.knowledge.__wrapped__()
        for example in json.loads((EXAMPLES / "manifest.json").read_text()):
            with self.subTest(example=example["id"]):
                annotation, source = (EXAMPLES / f"{example['id']}.py").read_text().split("\n", 1)
                self.assertTrue(annotation.startswith("# sahaya-cues: "))
                segments = json.loads(annotation.removeprefix("# sahaya-cues: "))
                result = manim_preflight.preflight({**REQUEST, "source": source, "segments": segments})
                self.assertNotIn("issue", result)
                self.assertNotIn("normalization", result)

    def test_publisher_requires_authentication_and_does_not_enqueue_preflight(self):
        body = json.dumps(REQUEST).encode()
        handler = server.Handler.__new__(server.Handler)
        handler.path = "/preflight"
        handler.headers = {"X-Manim-Owner": "b" * 64, "Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.send_json = Mock()
        with patch.object(server, "SECRET", "synthetic-test"), patch.object(server, "submit") as submit:
            handler.do_POST()
            self.assertEqual(handler.send_json.call_args.args[0], 401)
            handler.headers["Authorization"] = "Bearer synthetic-test"
            handler.do_POST()
            status, result = handler.send_json.call_args.args
            self.assertEqual(status, 200)
            self.assertEqual(result["source"], SOURCE)
            submit.assert_not_called()
