# sahaya-cues: [{"id": "phase", "narration": "Increasing phase moves the same wave shape horizontally."}]
from math import sin
from manim import Axes, Create, ValueTracker, always_redraw
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("phase"):
            axes = Axes(x_range=[-3, 3, 1], y_range=[-1.5, 1.5, 1], x_length=7, y_length=3)
            phase = ValueTracker(0)
            curve = always_redraw(lambda: axes.plot(lambda x: sin(2*x - phase.get_value()), x_range=[-3, 3]))
            self.play(Create(axes), run_time=0.6)
            self.add(curve)
            self.play(phase.animate.set_value(3), run_time=1.4)
