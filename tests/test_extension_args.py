"""Unit tests for `ultra_paint.extension_args.apply_extension_args`."""

import logging
import types

import pytest

from ultra_paint.extension_args import apply_extension_args
from ultra_paint.extension_manifest import ExtensionManifest

NAG_MANIFEST_DATA = {
    "id": "sd-forge-nag",
    "title": "Normalized Attention Guidance",
    "scriptTitle": "Normalized Attention Guidance",
    "canEnable": True,
    "inputs": [
        {"key": "scale", "label": "Scale", "type": "number", "default": 5.0},
        {"key": "tau", "label": "Tau", "type": "number", "default": 2.5},
        {"key": "alpha", "label": "Alpha", "type": "number", "default": 0.25},
        {"key": "sigma_end", "label": "Sigma End", "type": "number", "default": 0.0},
    ],
}


@pytest.fixture
def nag_manifest():
    return ExtensionManifest.model_validate(NAG_MANIFEST_DATA)


def _processing(slot_count, title):
    script = types.SimpleNamespace(
        args_from=1, args_to=1 + slot_count, title=lambda: title
    )
    return types.SimpleNamespace(
        scripts=types.SimpleNamespace(alwayson_scripts=[script]),
        script_args=[0, *(["default"] * slot_count)],
    )


def test_writes_ordered_values_into_predicted_slots(nag_manifest):
    p = _processing(5, "Normalized Attention Guidance")

    apply_extension_args(
        p,
        [nag_manifest],
        {
            "sd-forge-nag": {
                "enabled": True,
                "scale": 9.0,
                "tau": 3.0,
                "alpha": 0.5,
                "sigma_end": 0.1,
            }
        },
    )

    assert p.script_args == [0, True, 9.0, 3.0, 0.5, 0.1]


def test_missing_values_fall_back_to_manifest_defaults(nag_manifest):
    p = _processing(5, "Normalized Attention Guidance")

    apply_extension_args(p, [nag_manifest], {"sd-forge-nag": {"enabled": False}})

    assert p.script_args == [0, False, 5.0, 2.5, 0.25, 0.0]


def test_manifest_without_can_enable_omits_the_leading_slot():
    manifest = ExtensionManifest.model_validate(
        {
            **NAG_MANIFEST_DATA,
            "canEnable": False,
            "inputs": NAG_MANIFEST_DATA["inputs"][:2],
        }
    )
    p = _processing(2, "Normalized Attention Guidance")

    apply_extension_args(p, [manifest], {"sd-forge-nag": {"scale": 9.0, "tau": 3.0}})

    assert p.script_args == [0, 9.0, 3.0]


def test_unregistered_script_title_is_skipped_without_raising(nag_manifest, caplog):
    caplog.set_level(logging.INFO)
    p = _processing(5, "Some Other Script")
    original = list(p.script_args)

    apply_extension_args(
        p, [nag_manifest], {"sd-forge-nag": {"enabled": True, "scale": 1.0}}
    )

    assert p.script_args == original
    assert "is not registered" in caplog.text


def test_manifest_absent_from_extension_values_is_untouched(nag_manifest):
    p = _processing(5, "Normalized Attention Guidance")
    original = list(p.script_args)

    apply_extension_args(p, [nag_manifest], {})

    assert p.script_args == original


def test_overflowing_values_are_truncated_with_a_warning(nag_manifest, caplog):
    p = _processing(
        3, "Normalized Attention Guidance"
    )  # fewer slots than [enabled, *4 inputs]

    apply_extension_args(
        p,
        [nag_manifest],
        {
            "sd-forge-nag": {
                "enabled": True,
                "scale": 9.0,
                "tau": 3.0,
                "alpha": 0.5,
                "sigma_end": 0.1,
            }
        },
    )

    assert p.script_args == [0, True, 9.0, 3.0]
    assert "truncating" in caplog.text
