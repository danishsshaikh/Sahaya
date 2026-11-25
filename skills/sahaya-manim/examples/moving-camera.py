# sahaya-cues: [{"id": "zoom", "narration": "The camera approaches the circle."}]
from manim import Circle, Create
from sahaya_timing import CueMovingCameraScene

class GeneratedScene(CueMovingCameraScene):
    def construct(self):
        with self.cue("zoom"):
            shape = Circle()
            self.play(Create(shape), run_time=0.8)
            self.play(self.camera.frame.animate.scale(0.7).move_to(shape), run_time=1.0)
