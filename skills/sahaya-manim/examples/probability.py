# sahaya-cues: [{"id": "frequency", "narration": "In this example the two outcomes have probabilities one quarter and three quarters."}]
from manim import BarChart, FadeIn
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("frequency"):
            chart = BarChart([0.25, 0.75], bar_names=["A", "B"], y_range=[0, 1, 0.25], y_length=4, x_length=6)
            self.play(FadeIn(chart), run_time=1.0)
