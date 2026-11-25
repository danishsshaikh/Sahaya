# sahaya-cues: [{"id": "matrix", "narration": "Here is a two by two matrix."}, {"id": "column", "narration": "The first column is the image of the first basis vector."}]
from manim import Matrix, SurroundingRectangle, Write, Create
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("matrix"):
            matrix = Matrix([[1, 2], [0, 1]])
            self.play(Write(matrix), run_time=0.9)
        with self.cue("column"):
            box = SurroundingRectangle(matrix.get_columns()[0])
            self.play(Create(box), run_time=0.8)
