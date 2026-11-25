# sahaya-cues: [{"id": "square", "narration": "A square appears."}, {"id": "transform", "narration": "The square changes into a circle."}]
from manim import Square, Circle, Create, Transform
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("square"):
            shape = Square()
            self.play(Create(shape), run_time=0.9)
        with self.cue("transform"):
            self.play(Transform(shape, Circle()), run_time=1.0)
