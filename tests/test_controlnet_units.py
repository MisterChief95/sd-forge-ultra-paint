"""Tests for optional Forge ControlNet unit assembly."""

import logging
import sys
import types
from dataclasses import dataclass
from enum import Enum

import numpy as np
import pytest
from PIL import Image

from ultra_paint.controlnet_units import apply_controlnet_units


@pytest.fixture
def fake_controlnet(monkeypatch):
    class ControlMode(Enum):
        BALANCED = "Balanced"
        PROMPT = "My prompt is more important"
        CONTROL = "ControlNet is more important"

    class ResizeMode(Enum):
        RESIZE = "Just Resize"
        INNER_FIT = "Crop and Resize"
        OUTER_FIT = "Resize and Fill"

    @dataclass
    class ControlNetUnit:
        enabled: bool
        model: str
        weight: float
        image: dict
        resize_mode: str
        guidance_start: float
        guidance_end: float
        pixel_perfect: bool
        control_mode: str
        # Mirrors Forge's own `lib_controlnet.external_code.ControlNetUnit`
        # defaults -- `apply_controlnet_units` now omits these kwargs
        # entirely, relying on the always-passthrough defaults.
        module: str = "None"
        processor_res: int = -1
        threshold_a: float = -1
        threshold_b: float = -1
        save_detected_map: bool = True

    lib_controlnet = types.ModuleType("lib_controlnet")
    lib_controlnet.__path__ = []
    external_code = types.ModuleType("lib_controlnet.external_code")
    external_code.ControlMode = ControlMode
    external_code.ControlNetUnit = ControlNetUnit
    external_code.ResizeMode = ResizeMode

    shared = types.ModuleType("modules.shared")
    shared.opts = types.SimpleNamespace(data={"control_net_unit_count": 3})
    modules = types.ModuleType("modules")
    modules.__path__ = []
    modules.shared = shared

    monkeypatch.setitem(sys.modules, "lib_controlnet", lib_controlnet)
    monkeypatch.setitem(sys.modules, "lib_controlnet.external_code", external_code)
    monkeypatch.setitem(sys.modules, "modules", modules)
    monkeypatch.setitem(sys.modules, "modules.shared", shared)
    return ControlNetUnit, shared


def _layer(index=0, *, mask=False):
    """A regular (post-refactor) control-layer dict -- no per-layer
    preprocessor/threshold/mask fields, matching `ControlLayerRequest`."""
    layer = {
        "image": Image.new("RGBA", (3, 2), (10 + index, 20, 30, 40)),
        "model": f"control-model-{index}",
        "weight": 0.75 + index,
        "guidance_start": 0.1,
        "guidance_end": 0.9,
        "control_mode": ("balanced", "prompt", "control")[index % 3],
        "pixel_perfect": index % 2 == 0,
        "resize_mode": ("resize", "crop", "fill")[index % 3],
        "enabled": True,
    }
    if mask:
        # Only the synthetic auto-injected inpaint-ControlNet dict
        # (`ultra_paint/generation.py`) still carries `mask_image` --
        # `apply_controlnet_units` must tolerate both shapes via `.get()`.
        layer["mask_image"] = Image.new("RGBA", (3, 2), (0, 0, 0, 100 + index))
    return layer


def _processing(slot_count=3):
    script = types.SimpleNamespace(
        args_from=1,
        args_to=1 + slot_count,
        title=lambda: "ControlNet",
    )
    return types.SimpleNamespace(
        scripts=types.SimpleNamespace(alwayson_scripts=[script]),
        script_args=[0, *(["default"] * slot_count)],
    )


def test_missing_controlnet_is_a_noop(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    monkeypatch.setitem(sys.modules, "lib_controlnet", None)
    monkeypatch.delitem(sys.modules, "lib_controlnet.external_code", raising=False)
    p = _processing()
    original_args = list(p.script_args)

    apply_controlnet_units(p, [_layer()])

    assert p.script_args == original_args
    assert "ControlNet is unavailable" in caplog.text


def test_builds_units_with_complete_field_and_image_mapping(fake_controlnet):
    ControlNetUnit, _shared = fake_controlnet
    p = _processing()

    # First layer carries a `mask_image` (the synthetic-inpaint-unit dict
    # shape); second doesn't (the regular control-layer dict shape) -- both
    # must work through the same `.get("mask_image")` lookup.
    apply_controlnet_units(p, [_layer(0, mask=True), _layer(1)])

    first, second = p.script_args[1:3]
    assert isinstance(first, ControlNetUnit)
    assert isinstance(second, ControlNetUnit)
    assert (first.module, first.model, first.weight) == (
        "None",
        "control-model-0",
        0.75,
    )
    assert (first.processor_res, first.threshold_a, first.threshold_b) == (-1, -1, -1)
    assert (first.guidance_start, first.guidance_end, first.pixel_perfect) == (
        0.1,
        0.9,
        True,
    )
    assert (first.control_mode, first.resize_mode) == ("Balanced", "Just Resize")
    assert first.save_detected_map is False
    assert first.image["image"].shape == (2, 3, 3)
    assert first.image["image"].dtype == np.uint8
    assert first.image["mask"].shape == (2, 3)
    assert first.image["mask"].dtype == np.uint8
    assert first.image["mask"][0, 0] == 100
    assert second.image["mask"] is None
    assert (second.control_mode, second.resize_mode) == (
        "My prompt is more important",
        "Crop and Resize",
    )
    assert p.script_args[3] == "default"


def test_truncates_to_configured_slot_count(fake_controlnet, caplog):
    ControlNetUnit, shared = fake_controlnet
    shared.opts.data["control_net_unit_count"] = 2
    p = _processing(slot_count=4)

    apply_controlnet_units(p, [_layer(i) for i in range(4)])

    assert all(isinstance(unit, ControlNetUnit) for unit in p.script_args[1:3])
    assert p.script_args[3:] == ["default", "default"]
    assert [unit.model for unit in p.script_args[1:3]] == [
        "control-model-0",
        "control-model-1",
    ]
    assert "dropping 2 ControlNet layer(s)" in caplog.text
