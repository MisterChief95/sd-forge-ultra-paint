"""Focused coverage for atomic single-slot autosave storage."""

import asyncio
import json
import sys
import types

import pytest


@pytest.fixture
def autosave_api(monkeypatch, tmp_path):
    fake_fastapi = types.ModuleType("fastapi")
    fake_responses = types.ModuleType("fastapi.responses")

    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class Request:
        pass

    class Response:
        def __init__(self, status_code=200):
            self.status_code = status_code

    class FileResponse:
        def __init__(self, path, media_type=None):
            self.path = path
            self.media_type = media_type

    fake_fastapi.HTTPException = HTTPException
    fake_fastapi.Request = Request
    fake_fastapi.Response = Response
    fake_responses.FileResponse = FileResponse
    monkeypatch.setitem(sys.modules, "fastapi", fake_fastapi)
    monkeypatch.setitem(sys.modules, "fastapi.responses", fake_responses)
    monkeypatch.delitem(sys.modules, "ultra_paint.autosave_api", raising=False)

    import ultra_paint.autosave_api as module

    monkeypatch.setattr(module, "AUTOSAVE_DIR", tmp_path / "autosave")
    yield module, HTTPException
    monkeypatch.delitem(sys.modules, "ultra_paint.autosave_api", raising=False)


def _manifest(tile_size=64, paths=("pixels/000000.png",)):
    return {
        "format": "ultra-paint-project",
        "formatVersion": 1,
        "createdWith": "test",
        "document": {
            "id": "document",
            "boundaryBox": {"x": 0, "y": 0, "width": 64, "height": 64},
            "layers": [
                {
                    "id": "layer",
                    "kind": "raster",
                    "image": {"tileSize": tile_size},
                }
            ],
            "layerOrder": ["layer"],
        },
        "pixelAssets": [
            {"layerId": "layer", "tileX": index, "tileY": 0, "path": path}
            for index, path in enumerate(paths)
        ],
    }


def _png(width=64, height=64):
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\rIHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
    )


def _commit(module, manifest):
    encoded = json.dumps(manifest).encode()
    pixels = {asset["path"]: _png() for asset in manifest["pixelAssets"]}
    return module._commit_checkpoint(encoded, pixels)


class _Upload:
    def __init__(self, data):
        self.data = data

    async def read(self, size):
        return self.data[:size]


class _Form:
    def __init__(self, items):
        self.items = items

    def get(self, key):
        return next((value for name, value in self.items if name == key), None)

    def multi_items(self):
        return self.items


class _Request:
    headers = {}

    def __init__(self, form):
        self._form = form

    async def form(self, **_limits):
        return self._form


def test_commit_atomically_replaces_the_only_checkpoint(autosave_api):
    module, _ = autosave_api
    first = _commit(module, _manifest())
    second = _commit(module, _manifest(paths=("pixels/000001.png",)))

    assert json.loads(module._current_file().read_text()) == {"checkpointId": second}
    assert not (module._checkpoints_dir() / first).exists()
    assert (module._checkpoints_dir() / second / "pixels" / "000001.png").is_file()
    assert [path.name for path in module._checkpoints_dir().iterdir()] == [second]


def test_multipart_handler_commits_manifest_and_named_pixel_parts(autosave_api):
    module, _ = autosave_api
    manifest = json.dumps(_manifest()).encode()
    request = _Request(
        _Form(
            [
                ("manifest", _Upload(manifest)),
                ("pixels/000000.png", _Upload(_png())),
            ]
        )
    )

    result = asyncio.run(module.save_autosave(request))

    assert module._read_current_id() == result["checkpointId"]


def test_multipart_handler_enforces_individual_tile_limit(autosave_api, monkeypatch):
    module, HTTPException = autosave_api
    monkeypatch.setattr(module, "MAX_TILE_BYTES", 23)
    request = _Request(
        _Form(
            [
                ("manifest", _Upload(json.dumps(_manifest()).encode())),
                ("pixels/000000.png", _Upload(_png())),
            ]
        )
    )

    with pytest.raises(HTTPException, match="too large") as exc_info:
        asyncio.run(module.save_autosave(request))

    assert exc_info.value.status_code == 413


def test_failed_pointer_swap_preserves_previous_checkpoint(autosave_api, monkeypatch):
    module, _ = autosave_api
    first = _commit(module, _manifest())

    def fail_replace(_source, _target):
        raise OSError("disk failure")

    monkeypatch.setattr(module.os, "replace", fail_replace)
    with pytest.raises(OSError, match="disk failure"):
        _commit(module, _manifest(paths=("pixels/000001.png",)))

    assert module._read_current_id() == first
    assert [path.name for path in module._checkpoints_dir().iterdir()] == [first]


def test_prune_removes_unreferenced_crash_checkpoint(autosave_api):
    module, _ = autosave_api
    current = _commit(module, _manifest())
    orphan = module._checkpoints_dir() / ("f" * 32)
    orphan.mkdir()

    module.prune_autosave_checkpoints()

    assert (module._checkpoints_dir() / current).is_dir()
    assert not orphan.exists()


def test_rejects_png_dimensions_that_do_not_match_declared_tile(autosave_api):
    module, HTTPException = autosave_api
    manifest = _manifest()
    with pytest.raises(HTTPException, match="64x64") as exc_info:
        module._commit_checkpoint(
            json.dumps(manifest).encode(), {"pixels/000000.png": _png(32, 64)}
        )

    assert exc_info.value.status_code == 400
