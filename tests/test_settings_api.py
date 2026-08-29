"""Focused coverage for Python-backed Generation panel settings."""

import json
import sys
import types

import pytest


@pytest.fixture
def settings_api(monkeypatch):
    fake_fastapi = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class Response:
        def __init__(self, status_code=200):
            self.status_code = status_code

    fake_fastapi.HTTPException = HTTPException
    fake_fastapi.Response = Response
    monkeypatch.setitem(sys.modules, "fastapi", fake_fastapi)
    monkeypatch.delitem(sys.modules, "ultra_paint.settings_api", raising=False)

    import ultra_paint.settings_api as module

    yield module, HTTPException
    monkeypatch.delitem(sys.modules, "ultra_paint.settings_api", raising=False)


def test_settings_round_trip_uses_atomic_file(settings_api, monkeypatch, tmp_path):
    settings_api, _ = settings_api
    settings_file = tmp_path / "generation-settings.json"
    monkeypatch.setattr(settings_api, "SETTINGS_FILE", settings_file)
    payload = {"version": 1, "prompt": "persistent prompt", "steps": 42}

    response = settings_api.save_generation_settings(payload)

    assert response.status_code == 204
    assert settings_api.get_generation_settings() == payload
    assert json.loads(settings_file.read_text(encoding="utf-8")) == payload
    assert not settings_file.with_suffix(".tmp").exists()


def test_settings_reject_oversized_payload(settings_api, monkeypatch, tmp_path):
    settings_api, HTTPException = settings_api
    monkeypatch.setattr(
        settings_api, "SETTINGS_FILE", tmp_path / "generation-settings.json"
    )

    with pytest.raises(HTTPException, match="too large") as exc_info:
        settings_api.save_generation_settings(
            {"prompt": "x" * settings_api.MAX_SETTINGS_BYTES}
        )

    assert exc_info.value.status_code == 413
