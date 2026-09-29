"""Unit tests for `ultra_paint.extension_manifest` (upaint.json discovery)."""

import json
import sys
import types

import pytest

from ultra_paint.extension_manifest import (
    ExtensionManifest,
    _load_manifest,
    list_extension_manifests,
)

NAG_MANIFEST = {
    "id": "sd-forge-nag",
    "title": "Normalized Attention Guidance",
    "scriptTitle": "Normalized Attention Guidance",
    "description": "Guides away from the Negative Prompt inside attention; works at CFG 1.",
    "canEnable": True,
    "inputs": [
        {
            "key": "scale",
            "label": "Scale",
            "type": "number",
            "default": 5.0,
            "min": 1.0,
            "max": 20.0,
            "step": 0.1,
        },
        {
            "key": "tau",
            "label": "Tau",
            "type": "number",
            "default": 2.5,
            "min": 1.0,
            "max": 10.0,
            "step": 0.1,
        },
        {
            "key": "alpha",
            "label": "Alpha",
            "type": "number",
            "default": 0.25,
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
        },
        {
            "key": "sigma_end",
            "label": "Sigma End",
            "type": "number",
            "default": 0.0,
            "min": 0.0,
            "max": 1.0,
            "step": 0.01,
            "info": "stop NAG below this sigma; higher is faster",
        },
    ],
}


def _write_manifest(tmp_path, data, name="upaint.json"):
    path = tmp_path / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_valid_nag_shaped_manifest_parses(tmp_path):
    manifest = _load_manifest(_write_manifest(tmp_path, NAG_MANIFEST))

    assert isinstance(manifest, ExtensionManifest)
    assert manifest.id == "sd-forge-nag"
    assert manifest.scriptTitle == "Normalized Attention Guidance"
    assert manifest.canEnable is True
    assert [input_spec.key for input_spec in manifest.inputs] == [
        "scale",
        "tau",
        "alpha",
        "sigma_end",
    ]
    assert manifest.inputs[0].min == 1.0
    assert manifest.inputs[0].max == 20.0
    assert manifest.inputs[0].step == 0.1


def test_missing_file_returns_none(tmp_path):
    assert _load_manifest(tmp_path / "does-not-exist.json") is None


def test_manifest_missing_can_enable_is_skipped(tmp_path, caplog):
    data = dict(NAG_MANIFEST)
    del data["canEnable"]

    assert _load_manifest(_write_manifest(tmp_path, data)) is None
    assert "invalid extension manifest" in caplog.text


def test_manifest_with_unknown_input_type_is_skipped(tmp_path, caplog):
    import copy

    data = copy.deepcopy(NAG_MANIFEST)
    data["inputs"][0]["type"] = "nonsense"

    assert _load_manifest(_write_manifest(tmp_path, data)) is None
    assert "invalid extension manifest" in caplog.text


def test_malformed_json_is_skipped(tmp_path, caplog):
    path = tmp_path / "upaint.json"
    path.write_text("{not valid json", encoding="utf-8")

    assert _load_manifest(path) is None
    assert "could not read extension manifest" in caplog.text


def test_list_extension_manifests_returns_empty_without_forge():
    # No `modules` package is installed/mocked in this bare test environment,
    # so the deferred `from modules import extensions` import inside
    # `list_extension_manifests` raises ImportError -- it must degrade to [].
    assert list_extension_manifests() == []


@pytest.fixture
def fake_forge_extensions(monkeypatch, tmp_path):
    """Installs a mocked `modules.extensions` whose `active()` returns
    extension stand-ins shaped like the real `modules.extensions.Extension`
    (`.path`/`.name`), so `list_extension_manifests` can discover manifests
    from them the same way it would against a real Forge install."""

    fake_modules = types.ModuleType("modules")
    fake_modules.__path__ = []
    fake_extensions_module = types.ModuleType("modules.extensions")

    active_extensions = []
    fake_extensions_module.active = lambda: active_extensions

    monkeypatch.setitem(sys.modules, "modules", fake_modules)
    monkeypatch.setitem(sys.modules, "modules.extensions", fake_extensions_module)

    def add_extension(name, manifest_data=None):
        ext_dir = tmp_path / name
        ext_dir.mkdir()
        if manifest_data is not None:
            (ext_dir / "upaint.json").write_text(
                json.dumps(manifest_data), encoding="utf-8"
            )
        active_extensions.append(
            types.SimpleNamespace(name=name, path=str(ext_dir), enabled=True)
        )

    return add_extension


def test_list_extension_manifests_empty_registry_returns_empty(fake_forge_extensions):
    assert list_extension_manifests() == []


def test_list_extension_manifests_discovers_valid_manifest(fake_forge_extensions):
    fake_forge_extensions("sd-forge-nag", NAG_MANIFEST)

    manifests = list_extension_manifests()

    assert len(manifests) == 1
    assert manifests[0].id == "sd-forge-nag"


def test_list_extension_manifests_skips_extensions_without_a_manifest(
    fake_forge_extensions,
):
    fake_forge_extensions("some-other-extension")
    fake_forge_extensions("sd-forge-nag", NAG_MANIFEST)

    manifests = list_extension_manifests()

    assert [manifest.id for manifest in manifests] == ["sd-forge-nag"]


def test_list_extension_manifests_skips_invalid_manifest_but_keeps_others(
    fake_forge_extensions,
):
    invalid = dict(NAG_MANIFEST, id="broken")
    del invalid["canEnable"]
    fake_forge_extensions("broken-extension", invalid)
    fake_forge_extensions("sd-forge-nag", NAG_MANIFEST)

    manifests = list_extension_manifests()

    assert [manifest.id for manifest in manifests] == ["sd-forge-nag"]
