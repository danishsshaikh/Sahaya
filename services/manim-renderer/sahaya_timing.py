"""Minimal narration adapter. This module runs only in the sandbox worker."""

from contextlib import contextmanager
import math

from manim import MovingCameraScene, Scene, ThreeDScene
from native_contract import Rejected


class CueTiming:
    def cue_duration(self, identifier):
        return self._cue_minimums.get(identifier, 0)

    @contextmanager
    def cue(self, identifier):
        index = len(self._cue_frames)
        if (self._cue_open or index >= len(self._cue_ids) or self._cue_ids[index] != identifier):
            raise Rejected("cues", "Use each cue ID in order, with no nested cue blocks.")
        start = round(self.renderer.time * self._cue_fps)
        if start != (self._cue_frames[-1][1] if index else 0):
            raise Rejected("cues", "Put every animation and wait inside a named cue block.")
        self._cue_open = True
        try:
            yield
            end = round(self.renderer.time * self._cue_fps)
            if end == start:
                raise Rejected("cues", "Each cue needs an animation or a deliberate hold.")
            remaining = math.ceil(self.cue_duration(identifier) * self._cue_fps) - (end - start)
            if remaining > 0:
                self.wait((remaining + 0.25) / self._cue_fps, frozen_frame=True)
            self._cue_frames.append([identifier, round(self.renderer.time * self._cue_fps)])
        finally:
            self._cue_open = False


class CueScene(CueTiming, Scene):
    pass


class CueMovingCameraScene(CueTiming, MovingCameraScene):
    pass


class CueThreeDScene(CueTiming, ThreeDScene):
    pass
