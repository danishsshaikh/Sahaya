# sahaya-cues: [{"id": "tracker", "narration": "The tracked value controls the dot's horizontal position."}]
from manim import Dot, FadeIn, RIGHT, ValueTracker
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("tracker"):
            tracker = ValueTracker(-2)
            dot = Dot(2 * -RIGHT)
            def follow(mob):
                mob.move_to(tracker.get_value() * RIGHT)
            dot.add_updater(follow)
            self.play(FadeIn(dot), run_time=0.4)
            self.play(tracker.animate.set_value(2), run_time=1.2)
            dot.remove_updater(follow)
