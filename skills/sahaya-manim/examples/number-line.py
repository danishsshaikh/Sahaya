# sahaya-cues: [{"id": "axis", "narration": "The number line shows the scale."}, {"id": "move", "narration": "The dot moves from zero to two."}]
from manim import Create, Dot, FadeIn, NumberLine
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("axis"):
            axis = NumberLine(x_range=[-2, 4, 1], length=7, include_numbers=True)
            self.play(Create(axis), run_time=1.2)
        with self.cue("move"):
            dot = Dot(axis.n2p(0))
            self.play(FadeIn(dot), run_time=0.4)
            self.play(dot.animate.move_to(axis.n2p(2)), run_time=0.9)
