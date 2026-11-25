# sahaya-cues: [{"id": "equation", "narration": "An exponent changes the order of operations."}]
from manim import DOWN, MathTex, Text, VGroup, Write
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("equation"):
            label = Text("An exponent")
            formula = MathTex(r"x^2")
            group = VGroup(label, formula).arrange(DOWN)
            self.play(Write(group), run_time=1.2)
