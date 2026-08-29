"""Unit tests for the Ultra Paint generation API handler."""

import base64
import sys
import types
from io import BytesIO
from threading import Lock

import pytest
from PIL import Image


@pytest.fixture
def fake_forge_modules(monkeypatch):
    calls = []
    generation_calls = []

    fake_fastapi = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            self.status_code = status_code
            self.detail = detail

    fake_fastapi.HTTPException = HTTPException

    fake_modules = types.ModuleType("modules")
    fake_modules.__path__ = []
    fake_call_queue = types.ModuleType("modules.call_queue")
    fake_call_queue.queue_lock = Lock()
    fake_shared = types.ModuleType("modules.shared")
    fake_shared.state = types.SimpleNamespace(
        begin=lambda **_kwargs: None, end=lambda: None
    )
    fake_modules.call_queue = fake_call_queue
    fake_modules.shared = fake_shared

    fake_main_thread = types.ModuleType("modules_forge.main_thread")
    fake_main_thread.last_exception = None

    def run_and_wait_result(*args, **kwargs):
        calls.append((args, kwargs))
        return types.SimpleNamespace(
            images=[Image.new("RGB", (2, 2))],
            extra_images=[],
            all_seeds=[12345],
            infotexts=["fixture generation parameters"],
        )

    fake_main_thread.run_and_wait_result = run_and_wait_result
    fake_modules_forge = types.ModuleType("modules_forge")
    fake_modules_forge.__path__ = []
    fake_modules_forge.main_thread = fake_main_thread

    fake_generation = types.ModuleType("ultra_paint.generation")

    def run_generation(*args, **kwargs):
        generation_calls.append((args, kwargs))

    fake_generation.run_generation = run_generation

    for name, module in {
        "fastapi": fake_fastapi,
        "modules": fake_modules,
        "modules.call_queue": fake_call_queue,
        "modules.shared": fake_shared,
        "modules_forge": fake_modules_forge,
        "modules_forge.main_thread": fake_main_thread,
        "ultra_paint.generation": fake_generation,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, "ultra_paint.generate_api", raising=False)

    import ultra_paint.generate_api as generate_api

    yield generate_api, calls, generation_calls

    monkeypatch.delitem(sys.modules, "ultra_paint.generate_api", raising=False)


def _data_url(generate_api, color=(255, 0, 0, 255)):
    return generate_api._encode_data_url(Image.new("RGBA", (4, 4), color))


def test_control_layers_are_decoded_and_forwarded(fake_forge_modules):
    generate_api, calls, _generation_calls = fake_forge_modules
    image_url = _data_url(generate_api)
    request = generate_api.GenerateRequest(
        composite_image=image_url,
        control_layers=[
            generate_api.ControlLayerRequest(image=image_url, model="control-model-a"),
            generate_api.ControlLayerRequest(image=image_url, model="control-model-b"),
        ],
    )

    response = generate_api.generate(request)

    args, kwargs = calls[0]
    layers = kwargs["control_layers"]
    assert args[0] is generate_api.run_generation
    assert len(layers) == 2
    assert set(layers[0]) == {
        "image",
        "model",
        "weight",
        "guidance_start",
        "guidance_end",
        "control_mode",
        "pixel_perfect",
        "resize_mode",
        "enabled",
    }
    assert isinstance(layers[0]["image"], Image.Image)
    assert layers[0]["image"].size == (4, 4)
    assert isinstance(layers[1]["image"], Image.Image)
    assert len(response.images) == 1


def test_omitted_control_layers_forwards_empty_list(fake_forge_modules):
    generate_api, calls, _generation_calls = fake_forge_modules

    generate_api.generate(
        generate_api.GenerateRequest(composite_image=_data_url(generate_api))
    )

    assert calls[0][1]["control_layers"] == []


def test_generated_png_embeds_forge_infotext(fake_forge_modules):
    generate_api, _calls, _generation_calls = fake_forge_modules

    response = generate_api.generate(
        generate_api.GenerateRequest(composite_image=_data_url(generate_api))
    )

    payload = base64.b64decode(response.images[0].split(",", 1)[1])
    with Image.open(BytesIO(payload)) as image:
        assert image.info["parameters"] == "fixture generation parameters"


def test_malformed_control_layer_image_returns_400_without_generation(
    fake_forge_modules,
):
    generate_api, calls, generation_calls = fake_forge_modules
    request = generate_api.GenerateRequest(
        composite_image=_data_url(generate_api),
        control_layers=[
            generate_api.ControlLayerRequest(image="not-a-data-url", model="control-model")
        ],
    )

    with pytest.raises(generate_api.HTTPException) as exc_info:
        generate_api.generate(request)

    assert exc_info.value.status_code == 400
    assert calls == []
    assert generation_calls == []


def test_control_layer_value_shape_passes_through_unchanged(fake_forge_modules):
    generate_api, calls, _generation_calls = fake_forge_modules
    image_url = _data_url(generate_api)
    request = generate_api.GenerateRequest(
        composite_image=image_url,
        control_layers=[
            generate_api.ControlLayerRequest(
                image=image_url,
                model="custom-model",
                weight=0.625,
                guidance_start=0.15,
                guidance_end=0.85,
                control_mode="prompt",
                pixel_perfect=True,
                resize_mode="crop",
                enabled=False,
            )
        ],
    )

    generate_api.generate(request)

    layer = calls[0][1]["control_layers"][0]
    assert {key: value for key, value in layer.items() if key != "image"} == {
        "model": "custom-model",
        "weight": 0.625,
        "guidance_start": 0.15,
        "guidance_end": 0.85,
        "control_mode": "prompt",
        "pixel_perfect": True,
        "resize_mode": "crop",
        "enabled": False,
    }
