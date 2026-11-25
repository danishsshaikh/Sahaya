# sahaya-cues: [{"id": "motion", "narration": "With constant acceleration from rest, displacement grows with time squared."}]
from manim import Dot, FadeIn, NumberLine, ValueTracker, linear
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("motion"):
            axis = NumberLine(x_range=[0, 4, 1], length=7)
            t = ValueTracker(0)
            dot = Dot(axis.n2p(0))
            def position(mob):
                mob.move_to(axis.n2p(t.get_value() ** 2))
            dot.add_updater(position)
            self.play(FadeIn(axis), FadeIn(dot), run_time=0.6)
            self.play(t.animate.set_value(2), run_time=1.6, rate_func=linear)
            dot.remove_updater(position)
