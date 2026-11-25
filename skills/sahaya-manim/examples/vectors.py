# sahaya-cues: [{"id": "vectors", "narration": "The arrows add tip to tail."}]
from manim import Arrow, Create, ORIGIN, RIGHT, UP, YELLOW
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("vectors"):
            first = Arrow(ORIGIN, 2*RIGHT, buff=0)
            second = Arrow(2*RIGHT, 2*RIGHT + UP, buff=0)
            result = Arrow(ORIGIN, 2*RIGHT + UP, buff=0, color=YELLOW)
            self.play(Create(first), Create(second), run_time=0.9)
            self.play(Create(result), run_time=0.8)
