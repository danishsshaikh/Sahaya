import importlib.util
from collections import OrderedDict
from pathlib import Path
import sys
import types
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SERVICE_PATH = REPO_ROOT / "services" / "voice-cloning" / "chatterbox_service.py"


def load_service_module():
    install_service_dependency_stubs()
    spec = importlib.util.spec_from_file_location("openmaic_chatterbox_service", SERVICE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def install_service_dependency_stubs():
    if "torch" not in sys.modules:
        torch_stub = types.ModuleType("torch")
        torch_stub.float32 = "float32"
        torch_stub.dtype = object
        torch_stub.Tensor = object
        torch_stub.cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
        torch_stub.device = lambda value: value
        torch_stub.zeros = lambda *args, **kwargs: None
        torch_stub.linspace = lambda *args, **kwargs: None
        torch_stub.sqrt = lambda value: value
        torch_stub.mean = lambda value: value
        torch_stub.load = lambda *args, **kwargs: None
        sys.modules["torch"] = torch_stub

    if "torchaudio" not in sys.modules:
        torchaudio_stub = types.ModuleType("torchaudio")
        torchaudio_stub.save = lambda *args, **kwargs: None
        sys.modules["torchaudio"] = torchaudio_stub

    if "fastapi" not in sys.modules:
        fastapi_stub = types.ModuleType("fastapi")

        class FastAPI:
            def __init__(self, *args, **kwargs):
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
            def __init__(self, status_code=None, detail=None):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

        class Response:
            def __init__(self, *args, **kwargs):
                pass

        fastapi_stub.FastAPI = FastAPI
        fastapi_stub.HTTPException = HTTPException
        fastapi_stub.Response = Response
        sys.modules["fastapi"] = fastapi_stub

    if "pydantic" not in sys.modules:
        pydantic_stub = types.ModuleType("pydantic")

        class BaseModel:
            pass

        pydantic_stub.BaseModel = BaseModel
        pydantic_stub.Field = lambda *args, **kwargs: args[0] if args else None
        sys.modules["pydantic"] = pydantic_stub

    if "uvicorn" not in sys.modules:
        uvicorn_stub = types.ModuleType("uvicorn")
        uvicorn_stub.run = lambda *args, **kwargs: None
        sys.modules["uvicorn"] = uvicorn_stub


class FakeAttention:
    def __init__(self, hooks=None):
        self._forward_hooks = OrderedDict(hooks or [])


class FakeLayer:
    def __init__(self, hooks=None):
        self.self_attn = FakeAttention(hooks)


class FakeConfig:
    output_attentions = False
    _attn_implementation = "sdpa"


class FakeTransformer:
    def __init__(self):
        self.layers = [FakeLayer([(1, "keep")]), FakeLayer()]
        self.config = FakeConfig()


class FakeT3:
    def __init__(self):
        self.tfmr = FakeTransformer()


class FakeModel:
    def __init__(self):
        self.t3 = FakeT3()


class ChatterboxServiceUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = load_service_module()

    def test_short_multi_sentence_text_stays_in_one_chunk(self):
        chunks = self.service.split_text(
            "This is the first sentence. This is the second sentence. This is the third sentence."
        )
        self.assertEqual(
            chunks,
            ["This is the first sentence. This is the second sentence. This is the third sentence."],
        )

    def test_long_text_chunks_only_when_needed(self):
        chunks = self.service.split_text("alpha " * 120)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= self.service.MAX_TEXT_CHUNK_CHARS for chunk in chunks))

    def test_multilingual_language_ids_are_normalized_without_text_rewriting(self):
        self.assertEqual(self.service.normalize_language_id("en-US"), "en")
        self.assertEqual(self.service.normalize_language_id("hi_IN"), "hi")
        with self.assertRaisesRegex(ValueError, "Unsupported language_id"):
            self.service.normalize_language_id("mr")

    def test_cleanup_removes_only_hooks_added_during_generation(self):
        model = FakeModel()
        snapshot = self.service.generation_hook_snapshot(model)
        config_snapshot = self.service.attention_config_snapshot(model)
        model.t3.tfmr.layers[0].self_attn._forward_hooks[2] = "new"
        model.t3.tfmr.layers[1].self_attn._forward_hooks[3] = "new"
        model.t3.tfmr.config.output_attentions = True
        model.t3.tfmr.config._attn_implementation = "eager"

        cleanup = self.service.cleanup_generation_runtime(model, snapshot, config_snapshot)

        self.assertEqual(cleanup["hooksRemoved"], 2)
        self.assertEqual(cleanup["hooksAfterCleanup"], 1)
        self.assertEqual(
            list(model.t3.tfmr.layers[0].self_attn._forward_hooks.items()),
            [(1, "keep")],
        )
        self.assertEqual(model.t3.tfmr.layers[1].self_attn._forward_hooks, OrderedDict())
        self.assertFalse(model.t3.tfmr.config.output_attentions)
        self.assertEqual(model.t3.tfmr.config._attn_implementation, "sdpa")
        self.assertTrue(cleanup["configRestored"])


if __name__ == "__main__":
    unittest.main()
