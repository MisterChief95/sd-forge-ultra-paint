"""Unit tests for the Ultra Paint manual-save API."""

import base64
import sys
import types
from io import BytesIO
from pathlib import Path
from unittest import mock

import pytest
from PIL import Image


@pytest.fixture
def fake_forge_modules(monkeypatch):
    fake_modules = types.ModuleType("modules")
    fake_modules.__path__ = []
    manual_dir = Path(__file__).resolve().parent

    fake_images_module = types.ModuleType("modules.images")
    save_image = mock.MagicMock(return_value=(str(manual_dir / "saved.png"), None))
    fake_images_module.save_image = save_image

    fake_shared_module = types.ModuleType("modules.shared")
    fake_shared_module.opts = types.SimpleNamespace(
        outdir_save=str(manual_dir),
        samples_format="png",
        use_save_to_dirs_for_ui=True,
    )

    fake_modules.images = fake_images_module
    fake_modules.shared = fake_shared_module
    monkeypatch.setitem(sys.modules, "modules", fake_modules)
    monkeypatch.setitem(sys.modules, "modules.images", fake_images_module)
    monkeypatch.setitem(sys.modules, "modules.shared", fake_shared_module)
    monkeypatch.delitem(sys.modules, "ultra_paint.save_api", raising=False)

    import ultra_paint.save_api as save_api_module

    yield save_api_module, fake_shared_module, save_image

    monkeypatch.delitem(sys.modules, "ultra_paint.save_api", raising=False)


def _data_url() -> str:
    buffer = BytesIO()
    Image.new("RGBA", (3, 2), (255, 0, 0, 128)).save(buffer, format="PNG")
    payload = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{payload}"


def test_save_uses_forge_manual_save_directory(fake_forge_modules):
    save_api, fake_shared, save_image = fake_forge_modules

    response = save_api.save(save_api.SaveRequest(image=_data_url()))

    args, kwargs = save_image.call_args
    assert args[0].size == (3, 2)
    assert args[1] == fake_shared.opts.outdir_save
    assert args[2] == ""
    assert kwargs == {
        "seed": None,
        "prompt": None,
        "extension": "png",
        "info": None,
        "grid": False,
        "p": None,
        "save_to_dirs": True,
    }
    assert response.path.endswith("saved.png")
