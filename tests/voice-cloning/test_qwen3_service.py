import asyncio
import importlib.util
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[2]
SERVICE_PATH = REPO_ROOT / "services" / "qwen3-tts" / "service.py"


def install_dependency_stubs():
    soundfile_stub = types.ModuleType("soundfile")
    soundfile_stub.info = lambda _path: types.SimpleNamespace(
        frames=24000, samplerate=24000, channels=1
    )
    soundfile_stub.write = lambda buffer, *_args, **_kwargs: buffer.write(
        b"RIFF" + (b"\x00" * 40)
    )
    sys.modules["soundfile"] = soundfile_stub

    torch_stub = types.ModuleType("torch")
    torch_stub.bfloat16 = "bfloat16"
    torch_stub.is_tensor = lambda _value: False

    class InferenceMode:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    torch_stub.inference_mode = InferenceMode
    sys.modules["torch"] = torch_stub

    fastapi_stub = types.ModuleType("fastapi")

    class FastAPI:
        def __init__(self, *_args, **_kwargs):
            pass

        def on_event(self, *_args, **_kwargs):
            return lambda fn: fn

        def get(self, *_args, **_kwargs):
            return lambda fn: fn

        def post(self, *_args, **_kwargs):
            return lambda fn: fn

        def delete(self, *_args, **_kwargs):
            return lambda fn: fn

    class HTTPException(Exception):
        def __init__(self, status_code=None, detail=None, headers=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail
            self.headers = headers

    class Request:
        pass

    class Response:
        def __init__(self, content=None, media_type=None):
            self.content = content
            self.media_type = media_type

    fastapi_stub.FastAPI = FastAPI
    fastapi_stub.HTTPException = HTTPException
    fastapi_stub.Request = Request
    fastapi_stub.Response = Response
    sys.modules["fastapi"] = fastapi_stub

    pydantic_stub = types.ModuleType("pydantic")

    class BaseModel:
        pass

    pydantic_stub.BaseModel = BaseModel
    pydantic_stub.Field = lambda *args, **kwargs: args[0] if args else None
    pydantic_stub.field_validator = lambda *_args, **_kwargs: lambda fn: fn
    sys.modules["pydantic"] = pydantic_stub

    transformers_stub = types.ModuleType("transformers")

    class StoppingCriteria:
        pass

    class StoppingCriteriaList(list):
        pass

    transformers_stub.StoppingCriteria = StoppingCriteria
    transformers_stub.StoppingCriteriaList = StoppingCriteriaList
    sys.modules["transformers"] = transformers_stub

    qwen_stub = types.ModuleType("qwen_tts")
    qwen_stub.Qwen3TTSModel = types.SimpleNamespace(from_pretrained=lambda *_args, **_kwargs: None)
    sys.modules["qwen_tts"] = qwen_stub

    uvicorn_stub = types.ModuleType("uvicorn")
    uvicorn_stub.run = lambda *_args, **_kwargs: None
    sys.modules["uvicorn"] = uvicorn_stub


def load_service_module():
    install_dependency_stubs()
    spec = importlib.util.spec_from_file_location("openmaic_qwen3_service", SERVICE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeRequest:
    def __init__(self, disconnect_after=None):
        self.disconnect_after = disconnect_after
        self.calls = 0

    async def is_disconnected(self):
        self.calls += 1
        return self.disconnect_after is not None and self.calls >= self.disconnect_after


class FakeModel:
    def __init__(self, wait_for_stop=False, finish_delay=0.0):
        self.wait_for_stop = wait_for_stop
        self.finish_delay = finish_delay
        self.calls = []
        self.stop_observed = threading.Event()

    def generate_voice_clone(self, **kwargs):
        self.calls.append(kwargs)
        if self.wait_for_stop:
            criterion = kwargs["stopping_criteria"][0]
            while not criterion(None, None):
                time.sleep(0.005)
            self.stop_observed.set()
            time.sleep(self.finish_delay)
        return [np.zeros(240, dtype=np.float32)], 24000


class QwenServiceUnitTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = load_service_module()

    def setUp(self):
        self.service.generation_queue = self.service.FairGenerationQueue(8)
        self.service.profiles.clear()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.reference = Path(self.temp_dir.name) / "reference.wav"
        self.reference.write_bytes(b"authorized-reference")
        self.service.profiles["vcp_test"] = self.service.VoicePrompt(
            self.reference,
            "Exact reference transcript.",
            {"speaker-embedding": object()},
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def request(self, text="Short classroom narration."):
        return types.SimpleNamespace(
            profileId="vcp_test",
            text=text,
            language="en",
            cloneMode="speaker-embedding",
        )

    async def test_short_generation_uses_explicit_token_and_deadline_controls(self):
        model = FakeModel()
        self.service.model = model

        response = await self.service.synthesize(self.request(), FakeRequest())

        self.assertEqual(response.media_type, "audio/wav")
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(model.calls[0]["max_new_tokens"], self.service.MAX_NEW_TOKENS)
        self.assertEqual(len(model.calls[0]["stopping_criteria"]), 1)
        self.assertFalse(self.service.generation_queue._active)

    async def test_deadline_discards_partial_audio_and_holds_lock_until_inference_returns(self):
        model = FakeModel(wait_for_stop=True, finish_delay=0.08)
        self.service.model = model
        original_deadline = self.service.SYNTHESIS_REQUEST_DEADLINE_SECONDS
        original_grace = self.service.SYNTHESIS_RESPONSE_GRACE_SECONDS
        self.service.SYNTHESIS_REQUEST_DEADLINE_SECONDS = 0.08
        self.service.SYNTHESIS_RESPONSE_GRACE_SECONDS = 0.01
        try:
            task = asyncio.create_task(
                self.service.synthesize(self.request("x" * 372), FakeRequest())
            )
            await asyncio.to_thread(model.stop_observed.wait, 1.0)
            self.assertTrue(self.service.generation_queue._active)
            with self.assertRaises(self.service.HTTPException) as caught:
                await task
            self.assertEqual(caught.exception.status_code, 504)
            self.assertFalse(self.service.generation_queue._active)
        finally:
            self.service.SYNTHESIS_REQUEST_DEADLINE_SECONDS = original_deadline
            self.service.SYNTHESIS_RESPONSE_GRACE_SECONDS = original_grace

    async def test_caller_disconnect_cooperatively_stops_before_releasing_the_slot(self):
        model = FakeModel(wait_for_stop=True, finish_delay=0.05)
        self.service.model = model

        task = asyncio.create_task(
            self.service.synthesize(self.request(), FakeRequest(disconnect_after=2))
        )
        await asyncio.to_thread(model.stop_observed.wait, 1.0)
        self.assertTrue(self.service.generation_queue._active)
        with self.assertRaises(self.service.HTTPException) as caught:
            await task
        self.assertEqual(caught.exception.status_code, 499)
        self.assertFalse(self.service.generation_queue._active)


if __name__ == "__main__":
    unittest.main()
