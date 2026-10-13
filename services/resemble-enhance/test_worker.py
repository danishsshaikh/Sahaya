import json
import tempfile
import unittest
from pathlib import Path

from worker import parse_request


class WorkerRequestTests(unittest.TestCase):
    def valid_request(self):
        root = Path(tempfile.gettempdir())
        return {
            "id": "request-1",
            "inputPath": str(root / "input.wav"),
            "outputPath": str(root / "output.wav"),
            "nfe": 32,
            "solver": "midpoint",
            "denoiseStrength": 0.1,
            "priorTemperature": 0.5,
        }

    def test_accepts_conservative_inference_settings(self):
        request = self.valid_request()
        self.assertEqual(parse_request(json.dumps(request)), request)

    def test_rejects_relative_audio_paths(self):
        request = self.valid_request()
        request["inputPath"] = "input.wav"
        with self.assertRaisesRegex(ValueError, "absolute path"):
            parse_request(json.dumps(request))

    def test_rejects_out_of_range_settings(self):
        request = self.valid_request()
        request["nfe"] = 0
        with self.assertRaisesRegex(ValueError, "nfe"):
            parse_request(json.dumps(request))


if __name__ == "__main__":
    unittest.main()
