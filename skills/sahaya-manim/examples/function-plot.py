# sahaya-cues: [{"id": "plot", "narration": "The curve plots the square of the horizontal coordinate."}, {"id": "point", "narration": "At one on the horizontal axis, the height is one."}]
from manim import Axes, Create, Dot, FadeIn
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("plot"):
            axes = Axes(x_range=[-2, 2, 1], y_range=[0, 4, 1], x_length=6, y_length=4)
            curve = axes.plot(lambda x: x*x, x_range=[-2, 2])
            self.play(Create(axes), Create(curve), run_time=1.2)
        with self.cue("point"):
            self.play(FadeIn(Dot(axes.c2p(1, 1))), run_time=0.6)
