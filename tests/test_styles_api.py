"""Unit tests for `ultra_paint.styles_api`, run against a real `StyleDatabase`."""

import sys
import types

import pytest


@pytest.fixture
def styles_api(monkeypatch, tmp_path):
    fake_fastapi = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            self.status_code = status_code
            self.detail = detail

    fake_fastapi.HTTPException = HTTPException

    fake_modules = types.ModuleType("modules")
    fake_modules.__path__ = []
    fake_errors = types.ModuleType("modules.errors")
    fake_errors.report = lambda *a, **k: None
    fake_modules.errors = fake_errors
    monkeypatch.setitem(sys.modules, "fastapi", fake_fastapi)
    monkeypatch.setitem(sys.modules, "modules", fake_modules)
    monkeypatch.setitem(sys.modules, "modules.errors", fake_errors)

    # Load Forge's real styles.py so the tests exercise its real CSV round-trip.
    import importlib.util
    from pathlib import Path

    forge_styles = Path(__file__).resolve().parents[3] / "modules" / "styles.py"
    if not forge_styles.exists():
        pytest.skip("Forge modules/styles.py not available")
    spec = importlib.util.spec_from_file_location("modules.styles", forge_styles)
    styles_module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "modules.styles", styles_module)
    spec.loader.exec_module(styles_module)
    fake_modules.styles = styles_module

    csv_path = tmp_path / "styles.csv"
    csv_path.write_text(
        "name,prompt,negative_prompt\nmoody,dark {prompt},bright\n", encoding="utf-8"
    )
    fake_shared = types.ModuleType("modules.shared")
    fake_shared.prompt_styles = styles_module.StyleDatabase([csv_path])
    fake_modules.shared = fake_shared
    monkeypatch.setitem(sys.modules, "modules.shared", fake_shared)

    monkeypatch.delitem(sys.modules, "ultra_paint.styles_api", raising=False)
    import ultra_paint.styles_api as module

    yield module, fake_shared, csv_path
    monkeypatch.delitem(sys.modules, "ultra_paint.styles_api", raising=False)


def test_lists_forge_styles(styles_api):
    module, _shared, _csv = styles_api
    assert [(s.name, s.prompt, s.negative_prompt) for s in module.get_styles()] == [
        ("moody", "dark {prompt}", "bright")
    ]


def test_unavailable_database_lists_nothing_and_rejects_writes(styles_api):
    module, shared, _csv = styles_api
    shared.prompt_styles = None
    assert module.get_styles() == []
    with pytest.raises(sys.modules["fastapi"].HTTPException) as info:
        module.save_style(module.StyleEntry(name="x"))
    assert info.value.status_code == 503


def test_create_rename_delete_persist_to_forge_csv(styles_api):
    module, shared, csv_path = styles_api

    module.save_style(
        module.StyleEntry(name="new", prompt="masterpiece", negative_prompt="bad")
    )
    assert "new,masterpiece,bad" in csv_path.read_text(encoding="utf-8-sig")

    module.save_style(
        module.StyleEntry(name="renamed", prompt="best", original_name="new")
    )
    text = csv_path.read_text(encoding="utf-8-sig")
    assert "renamed,best" in text and "new,masterpiece" not in text
    assert shared.prompt_styles.styles["renamed"].path == str(csv_path)

    module.delete_style("renamed")
    assert "renamed" not in csv_path.read_text(encoding="utf-8-sig")
    with pytest.raises(sys.modules["fastapi"].HTTPException) as info:
        module.delete_style("renamed")
    assert info.value.status_code == 404
