# sahaya-cues: [{"id": "orbit", "narration": "Changing viewpoint makes the three axes easier to distinguish."}]
from manim import DEGREES, Create, FadeIn, Sphere, ThreeDAxes
from sahaya_timing import CueThreeDScene

class GeneratedScene(CueThreeDScene):
    def construct(self):
        with self.cue("orbit"):
            axes = ThreeDAxes()
            sphere = Sphere(radius=0.55, resolution=(12, 12))
            self.set_camera_orientation(phi=65 * DEGREES, theta=-45 * DEGREES)
            self.play(Create(axes), FadeIn(sphere), run_time=0.8)
            self.move_camera(theta=-15 * DEGREES, run_time=1.0)
