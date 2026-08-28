"""Tests for the always-mounted Ultra Paint ControlNet API."""

import sys
import types

from PIL import Image


def _fake_global_state():
    global_state = types.SimpleNamespace(
        get_all_controlnet_names=lambda: ["model-a"],
        get_all_preprocessor_names=lambda: ["canny", "depth"],
        get_all_preprocessor_tags=lambda: ["All", "Canny"],
        select_control_type=lambda tag: (
            [tag],
            [f"{tag}-model"],
            "default-option",
            "default-model",
        ),
        get_preprocessor=lambda module: (
            (lambda image, **_kwargs: Image.fromarray(image))
            if module == "canny"
            else None
        ),
    )
    return global_state


def _load_api(monkeypatch, installed):
    fake_module = types.ModuleType("lib_controlnet")
    if installed:
        fake_module.global_state = _fake_global_state()
    monkeypatch.setitem(sys.modules, "lib_controlnet", fake_module)
    monkeypatch.delitem(
        sys.modules, "ultra_paint.controlnet_catalog_api", raising=False
    )
    import ultra_paint.controlnet_catalog_api as api

    return api


def test_installed_catalog_endpoints(monkeypatch):
    api = _load_api(monkeypatch, installed=True)

    assert api.get_controlnet_model_list() == {"model_list": ["model-a"]}
    assert api.get_controlnet_module_list() == {"module_list": ["canny", "depth"]}
    assert api.get_controlnet_control_types() == {
        "control_types": {
            "All": {
                "module_list": ["All"],
                "model_list": ["All-model"],
                "default_option": "default-option",
                "default_model": "default-model",
            },
            "Canny": {
                "module_list": ["Canny"],
                "model_list": ["Canny-model"],
                "default_option": "default-option",
                "default_model": "default-model",
            },
        }
    }

    image = Image.new("RGB", (2, 2), "red")
    image_url = api._encode_data_url(image)
    response = api.detect_controlnet(
        api.ControlNetDetectRequest(
            module="canny",
            image=image_url,
            threshold_a=1.5,
            threshold_b=2.5,
        )
    )
    assert response.image.startswith("data:image/png;base64,")


def test_detect_always_runs_pixel_perfect(monkeypatch):
    """The preprocessor's resolution is always the source image's own width
    -- Forge's `resize_image_with_pad` scales the SHORTER edge to
    `resolution`, so this keeps the detected map at the layer's own size
    without a separate resolution input for the user to get wrong."""
    captured = {}

    def fake_preprocessor(image, **kwargs):
        captured.update(kwargs)
        return Image.fromarray(image)

    fake_module = types.ModuleType("lib_controlnet")
    fake_module.global_state = types.SimpleNamespace(
        get_preprocessor=lambda module: fake_preprocessor
    )
    monkeypatch.setitem(sys.modules, "lib_controlnet", fake_module)
    monkeypatch.delitem(
        sys.modules, "ultra_paint.controlnet_catalog_api", raising=False
    )
    import ultra_paint.controlnet_catalog_api as api

    image = Image.new("RGB", (3, 7), "blue")
    api.detect_controlnet(
        api.ControlNetDetectRequest(
            module="canny",
            image=api._encode_data_url(image),
            threshold_a=1,
            threshold_b=2,
        )
    )

    assert captured["resolution"] == 3


def test_missing_controlnet_degrades_gracefully(monkeypatch):
    monkeypatch.delitem(sys.modules, "lib_controlnet", raising=False)
    api = _load_api(monkeypatch, installed=False)

    assert api.get_controlnet_model_list() == {"model_list": []}
    assert api.get_controlnet_module_list() == {"module_list": []}
    assert api.get_controlnet_control_types() == {"control_types": {}}
    response = api.detect_controlnet(
        api.ControlNetDetectRequest(
            module="canny",
            image="malformed",
            threshold_a=1,
            threshold_b=2,
        )
    )
    assert response.image is None


def test_unknown_module_and_malformed_image_return_null(monkeypatch):
    api = _load_api(monkeypatch, installed=True)

    assert (
        api.detect_controlnet(
            api.ControlNetDetectRequest(
                module="missing",
                image="malformed",
                threshold_a=1,
                threshold_b=2,
            )
        ).image
        is None
    )
