"""Tests for the Ultra Paint LoRA catalog."""

import sys
import types

import pytest

from ultra_paint.lora_api import LORA_ROUTE, get_loras


class _Lora:
    def __init__(self, name, filename, alias):
        self.name = name
        self.filename = filename
        self._alias = alias

    def get_alias(self):
        return self._alias


@pytest.fixture
def fake_forge(monkeypatch):
    refreshes = []
    loras = {
        "zeta": _Lora("zeta", "zeta.safetensors", "Zeta Alias"),
        "Alpha": _Lora("Alpha", "alpha.safetensors", "Alpha Alias"),
    }
    metadata = {
        "zeta.safetensors": {
            "activation text": "zeta style",
            "preferred weight": "2.5",
        },
        "alpha.safetensors": {
            "activation text": "alpha style",
            "preferred weight": 0,
        },
    }

    networks = types.ModuleType("networks")
    networks.available_networks = loras
    networks.list_available_networks = lambda: refreshes.append(True)

    extra_networks = types.ModuleType("modules.extra_networks")
    extra_networks.get_user_metadata = lambda filename: metadata.get(filename, {})
    shared = types.ModuleType("modules.shared")
    shared.opts = types.SimpleNamespace(extra_networks_default_multiplier=0.75)
    modules = types.ModuleType("modules")
    modules.extra_networks = extra_networks
    modules.shared = shared

    monkeypatch.setitem(sys.modules, "networks", networks)
    monkeypatch.setitem(sys.modules, "modules", modules)
    monkeypatch.setitem(sys.modules, "modules.extra_networks", extra_networks)
    monkeypatch.setitem(sys.modules, "modules.shared", shared)
    return networks, shared, metadata, refreshes


def test_catalog_refreshes_returns_aliases_metadata_and_sorted_names(fake_forge):
    _networks, _shared, _metadata, refreshes = fake_forge

    result = get_loras()

    assert LORA_ROUTE == "/ultra_paint/api/loras"
    assert refreshes == [True]
    assert result == [
        {
            "name": "Alpha",
            "prompt_name": "Alpha Alias",
            "activation_text": "alpha style",
            "preferred_weight": 0.75,
        },
        {
            "name": "zeta",
            "prompt_name": "Zeta Alias",
            "activation_text": "zeta style",
            "preferred_weight": 2.5,
        },
    ]


@pytest.mark.parametrize(
    ("preferred", "default", "expected"),
    [
        (50, 1.0, 10.0),
        (-50, 1.0, -10.0),
        (float("nan"), 3.0, 3.0),
        ("invalid", 20.0, 10.0),
        (0, float("inf"), 1.0),
    ],
)
def test_weights_are_valid_and_clamped(fake_forge, preferred, default, expected):
    networks, shared, metadata, _refreshes = fake_forge
    networks.available_networks = {"Alpha": networks.available_networks["Alpha"]}
    metadata["alpha.safetensors"]["preferred weight"] = preferred
    shared.opts.extra_networks_default_multiplier = default

    assert get_loras()[0]["preferred_weight"] == expected


def test_missing_lora_extension_returns_empty_catalog(monkeypatch):
    monkeypatch.delitem(sys.modules, "networks", raising=False)

    assert get_loras() == []
