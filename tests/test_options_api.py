"""Unit tests for `ultra_paint.options_api` (Phase 3 additions: native_resolution
/is_video_model/resolution_step fields, added so the frontend's boundary-box
scale modes don't need to duplicate `model_profile.py`'s architecture table in
TypeScript). `resolution_step` is a fixed constant, deliberately independent
of Forge's `res_step` setting -- see `resolution_step.py`'s docstring.
"""

import sys
import types

import pytest


class _FakeOpts:
    """Mirrors the shape `resolution_step_for` reads: `.data_labels`, `.data`."""

    def __init__(self, data_labels=None, data=None):
        self.data_labels = (
            data_labels if data_labels is not None else {"res_step": object()}
        )
        self.data = data if data is not None else {}


@pytest.fixture
def fake_forge_modules(monkeypatch):
    fake_modules = types.ModuleType("modules")
    fake_modules.__path__ = []

    fake_sd_samplers_module = types.ModuleType("modules.sd_samplers")

    class _Sampler:
        def __init__(self, name):
            self.name = name

    fake_sd_samplers_module.visible_samplers = lambda: [
        _Sampler("Euler a"),
        _Sampler("DPM++ 2M"),
    ]

    fake_sd_schedulers_module = types.ModuleType("modules.sd_schedulers")

    class _Scheduler:
        def __init__(self, label):
            self.label = label

    fake_sd_schedulers_module.schedulers = [
        _Scheduler("Automatic"),
        _Scheduler("Karras"),
    ]

    fake_shared_module = types.ModuleType("modules.shared")
    fake_shared_module.sd_model = None
    fake_shared_module.opts = _FakeOpts()
    fake_shared_module.opts.sd_model_checkpoint = "fixture-model.safetensors"
    fake_shared_module.opts.forge_additional_modules = ["C:/models/fixture-vae.safetensors"]

    fake_modules.sd_samplers = fake_sd_samplers_module
    fake_modules.sd_schedulers = fake_sd_schedulers_module
    fake_modules.shared = fake_shared_module

    fake_modules_forge = types.ModuleType("modules_forge")
    fake_main_entry_module = types.ModuleType("modules_forge.main_entry")
    fake_main_entry_module.refresh_models = lambda: (
        ["fixture-model.safetensors"],
        ["fixture-clip.safetensors", "fixture-vae.safetensors"],
    )
    fake_modules_forge.main_entry = fake_main_entry_module

    modules_to_install = {
        "modules": fake_modules,
        "modules.sd_samplers": fake_sd_samplers_module,
        "modules.sd_schedulers": fake_sd_schedulers_module,
        "modules.shared": fake_shared_module,
        "modules_forge": fake_modules_forge,
        "modules_forge.main_entry": fake_main_entry_module,
    }
    for name, module in modules_to_install.items():
        monkeypatch.setitem(sys.modules, name, module)

    monkeypatch.delitem(sys.modules, "ultra_paint.options_api", raising=False)
    monkeypatch.delitem(sys.modules, "ultra_paint.model_profile", raising=False)
    monkeypatch.delitem(sys.modules, "ultra_paint.resolution_step", raising=False)

    import ultra_paint.options_api as options_api_module

    yield options_api_module, fake_shared_module

    monkeypatch.delitem(sys.modules, "ultra_paint.options_api", raising=False)


def test_samplers_and_schedulers_pass_through(fake_forge_modules):
    options_api, _fake_shared = fake_forge_modules

    options = options_api.get_generation_options()

    assert options.samplers == ["Euler a", "DPM++ 2M"]
    assert options.schedulers == ["Automatic", "Karras"]


def test_model_manager_options_match_forge_catalog(fake_forge_modules):
    options_api, _fake_shared = fake_forge_modules

    options = options_api.get_generation_options()

    assert options.models == ["fixture-model.safetensors"]
    assert options.modules == ["fixture-clip.safetensors", "fixture-vae.safetensors"]
    assert options.selected_model == "fixture-model.safetensors"
    assert options.selected_modules == ["fixture-vae.safetensors"]


def test_native_resolution_and_video_flag_for_no_model(fake_forge_modules):
    options_api, _fake_shared = fake_forge_modules

    options = options_api.get_generation_options()

    assert options.native_resolution == 512  # FALLBACK_RESOLUTION
    assert options.is_video_model is False


def test_native_resolution_and_video_flag_for_sdxl(fake_forge_modules):
    options_api, fake_shared = fake_forge_modules

    SdxlModel = type(
        "StableDiffusionXL", (), {"is_sd1": False, "is_sdxl": True, "is_wan": False}
    )
    fake_shared.sd_model = SdxlModel()

    options = options_api.get_generation_options()

    assert options.native_resolution == 1024
    assert options.is_video_model is False


def test_native_resolution_and_video_flag_for_wan(fake_forge_modules):
    options_api, fake_shared = fake_forge_modules

    WanModel = type("Wan", (), {"is_sd1": False, "is_sdxl": False, "is_wan": True})
    fake_shared.sd_model = WanModel()

    options = options_api.get_generation_options()

    assert options.is_video_model is True


def test_resolution_step_defaults_to_64(fake_forge_modules):
    options_api, _fake_shared = fake_forge_modules

    options = options_api.get_generation_options()

    assert options.resolution_step == 64


def test_resolution_step_ignores_configured_forge_setting(fake_forge_modules):
    # Ultra Paint deliberately does not let Forge's `res_step` setting
    # influence its own Auto-scale target -- see resolution_step.py's docstring.
    options_api, fake_shared = fake_forge_modules
    fake_shared.opts = _FakeOpts(data={"res_step": 32})

    options = options_api.get_generation_options()

    assert options.resolution_step == 64
