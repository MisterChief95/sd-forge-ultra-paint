"""Unit tests for `ultra_paint.generation.build_img2img_processing` (Phase 3, T25).

`ultra_paint/generation.py` imports real Forge modules (`gradio`,
`modules.scripts`, `modules.shared`, `modules.processing`) that are not
installed/importable in a plain test environment (this repo has no Python
test infra anywhere else to inherit an existing stub setup from). This file
builds minimal fake replacements and installs them into `sys.modules` before
importing `ultra_paint.generation`, so the module under test runs exactly its
real code -- only its *dependencies* are faked, matching PLAN.md's T25 spec
("mock modules.shared/modules.processing/modules.scripts at import
boundaries").

Scope: `build_img2img_processing` only (pure assembly of a processing object,
no GPU work). `run_generation`/the FastAPI route are exercised indirectly
through this since they're thin wrappers, but are not separately unit tested
here -- they need `modules_forge.main_thread`/`call_queue` plus an actual
`process_images` call, which is Forge-runtime territory, not unit-test
territory.
"""

import sys
import types
from contextlib import contextmanager
from unittest import mock

import pytest
from PIL import Image


class _FakeStableDiffusionProcessingImg2Img:
    """Records every constructor kwarg as an attribute; no real processing."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)
        self.is_api = False
        self._scripts = None
        self._script_args = None

    @property
    def scripts(self):
        return self._scripts

    @scripts.setter
    def scripts(self, value):
        self._scripts = value

    @property
    def script_args(self):
        return self._script_args

    @script_args.setter
    def script_args(self, value):
        self._script_args = value

    def close(self):
        pass


class _FakeStableDiffusionProcessingTxt2Img(_FakeStableDiffusionProcessingImg2Img):
    pass


@pytest.fixture
def fake_forge_modules(monkeypatch):
    """Install minimal fake `gradio`/`modules.*` packages, then reload
    `ultra_paint.generation` against them. Yields the reloaded module and a
    fake `shared` object the test can mutate (e.g. to change `sd_model`).
    """
    # --- gradio ---
    fake_gradio = types.ModuleType("gradio")

    @contextmanager
    def _blocks_context(*_args, **_kwargs):
        yield None

    fake_gradio.Blocks = _blocks_context  # used as `with gr.Blocks():`

    # --- modules (package) ---
    fake_modules = types.ModuleType("modules")
    fake_modules.__path__ = []  # mark as a package so `modules.xyz` submodule imports work

    # --- modules.scripts ---
    fake_scripts_module = types.ModuleType("modules.scripts")

    class _FakeScriptRunner:
        def __init__(self):
            self.scripts = []
            self.alwayson_scripts = []
            self.inputs = []

        def run(self, p, *args):
            return None

    fake_scripts_module.scripts_img2img = _FakeScriptRunner()
    fake_scripts_module.scripts_txt2img = _FakeScriptRunner()

    # --- modules.shared ---
    fake_shared_module = types.ModuleType("modules.shared")

    class _FakeOpts:
        outdir_samples = ""
        outdir_img2img_samples = "/tmp/img2img-samples"
        outdir_txt2img_samples = "/tmp/txt2img-samples"
        outdir_grids = ""
        outdir_img2img_grids = "/tmp/img2img-grids"
        outdir_txt2img_grids = "/tmp/txt2img-grids"
        samples_log_stdout = False

    class _FakeSharedState:
        def begin(self, job=None):
            pass

        def end(self):
            pass

    # Mirrors the real `modules/shared.py`: `sd_model`/`opts`/`state`/etc. are
    # module-level attributes, not nested under a `shared.shared` object.
    # `ultra_paint.generation` does `from modules import shared` then reads
    # `shared.sd_model`/`shared.total_tqdm`/`shared.state` and
    # `from modules.shared import opts` -- both forms must resolve here.
    fake_shared_module.sd_model = None
    fake_shared_module.opts = _FakeOpts()
    fake_shared_module.state = _FakeSharedState()
    fake_shared_module.total_tqdm = mock.MagicMock()
    fake_shared = fake_shared_module

    # --- modules.processing ---
    fake_processing_module = types.ModuleType("modules.processing")
    fake_processing_module.StableDiffusionProcessingImg2Img = (
        _FakeStableDiffusionProcessingImg2Img
    )
    fake_processing_module.StableDiffusionProcessingTxt2Img = (
        _FakeStableDiffusionProcessingTxt2Img
    )
    fake_processing_module.Processed = object

    fake_shared.process_calls = []

    def _fake_process_images(p):
        fake_shared.process_calls.append(p)
        if p.mask is not None:
            p.mask_for_overlay = p.mask
            p.paste_to = None
        return types.SimpleNamespace(
            images=[p.init_images[0].convert("RGB")], extra_images=[]
        )

    fake_processing_module.process_images = _fake_process_images

    fake_modules.scripts = fake_scripts_module
    fake_modules.shared = fake_shared_module
    fake_modules.processing = fake_processing_module

    modules_to_install = {
        "gradio": fake_gradio,
        "modules": fake_modules,
        "modules.scripts": fake_scripts_module,
        "modules.shared": fake_shared_module,
        "modules.processing": fake_processing_module,
    }
    for name, module in modules_to_install.items():
        monkeypatch.setitem(sys.modules, name, module)

    # Drop any previously imported (real or differently-stubbed) copy so the
    # import below picks up the fakes just installed.
    monkeypatch.delitem(sys.modules, "ultra_paint.generation", raising=False)
    monkeypatch.delitem(sys.modules, "ultra_paint.model_profile", raising=False)

    import ultra_paint.generation as generation_module

    yield generation_module, fake_shared

    monkeypatch.delitem(sys.modules, "ultra_paint.generation", raising=False)


def _composite(width=64, height=64) -> Image.Image:
    return Image.new("RGBA", (width, height), (255, 0, 0, 255))


def _install_soft_inpainting_script(generation, control_values):
    class _Control:
        def __init__(self, value):
            self.value = value

    class _SoftInpaintingScript:
        args_from = 1
        args_to = 8
        is_img2img = True

        def title(self):
            return "Soft Inpainting"

        def ui(self, _is_img2img):
            return [_Control(value) for value in control_values]

    script = _SoftInpaintingScript()
    runner = generation.modules.scripts.scripts_img2img
    runner.scripts = [script]
    runner.alwayson_scripts = [script]
    runner.inputs = [None, *[_Control(value) for value in control_values]]
    generation._default_script_args_cache = None
    return script


def test_no_mask_leaves_inpainting_fields_at_gen_param_defaults(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules

    p = generation.build_img2img_processing(_composite(), {})

    assert p.mask is None
    assert p.inpainting_fill == generation.GEN_PARAM_DEFAULTS["inpainting_fill"]
    assert p.inpaint_full_res == generation.GEN_PARAM_DEFAULTS["inpaint_full_res"]
    assert p.mask_blur == generation.GEN_PARAM_DEFAULTS["mask_blur"]


def test_mask_with_undersized_box_respects_whole_image_choice(fake_forge_modules):
    generation, fake_shared = fake_forge_modules
    fake_shared.sd_model = None  # -> model_profile fallback resolution (512)

    small_composite = _composite(64, 64)  # well under the 512 fallback native res
    mask = Image.new("L", small_composite.size, 0)

    p = generation.build_img2img_processing(
        small_composite, {"inpaint_full_res": False}, mask_image=mask
    )

    assert p.mask is not None
    assert p.mask.mode == "L"
    assert p.inpaint_full_res is False


def test_masked_only_choice_is_respected(fake_forge_modules):
    generation, fake_shared = fake_forge_modules

    class _Sd1Model:
        is_sd1 = True
        is_sdxl = False
        is_wan = False

    fake_shared.sd_model = _Sd1Model()  # native resolution 512

    big_composite = _composite(512, 512)  # exactly at native resolution
    mask = Image.new("L", big_composite.size, 255)

    p = generation.build_img2img_processing(
        big_composite, {"inpaint_full_res": True}, mask_image=mask
    )

    assert p.mask is not None
    assert p.inpaint_full_res is True


def test_mask_size_mismatch_raises(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules

    composite = _composite(64, 64)
    mismatched_mask = Image.new("L", (32, 32), 0)

    with pytest.raises(ValueError, match="mask_image size"):
        generation.build_img2img_processing(composite, {}, mask_image=mismatched_mask)


def test_mask_blur_and_padding_pass_through(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules
    composite = _composite()
    mask = Image.new("L", composite.size, 255)

    p = generation.build_img2img_processing(
        composite,
        {"mask_blur": 12, "inpaint_full_res_padding": 80},
        mask_image=mask,
    )

    assert p.mask_blur == 12
    assert p.inpaint_full_res_padding == 80


def test_inpaint_disables_forge_original_image_overlay(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules
    composite = _composite()
    mask = Image.new("L", composite.size, 255)

    p = generation.build_img2img_processing(
        composite,
        {"override_settings": {"overlay_inpaint": True}},
        mask_image=mask,
    )

    assert p.override_settings["overlay_inpaint"] is False


def test_only_masked_result_becomes_transparent_bb_patch(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules
    raw = Image.new("RGB", (8, 8), (0, 255, 0))
    mask = Image.new("L", (16, 12), 0)
    mask.paste(255, (4, 3, 12, 9))

    result = generation._transparent_inpaint_patch(
        raw,
        (16, 12),
        mask,
        (4, 3, 8, 6),
    )

    assert result.size == (16, 12)
    assert result.getpixel((0, 0))[3] == 0
    assert result.getpixel((6, 5)) == (0, 255, 0, 255)


def test_whole_image_result_uses_mask_as_alpha(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules
    raw = Image.new("RGB", (8, 8), (0, 0, 255))
    mask = Image.new("L", (16, 12), 0)
    mask.paste(128, (0, 0, 8, 12))

    result = generation._transparent_inpaint_patch(raw, (16, 12), mask, None)

    assert result.size == (16, 12)
    assert result.getpixel((2, 2))[3] == 128
    assert result.getpixel((12, 2))[3] == 0


def test_coherence_pass_runs_second_pass_with_expanded_alpha(fake_forge_modules):
    generation, fake_shared = fake_forge_modules
    composite = _composite(32, 32)
    mask = Image.new("L", composite.size, 0)
    mask.paste(255, (12, 12, 20, 20))

    result = generation.run_generation(
        composite,
        {
            "coherence_pass_enabled": True,
            "coherence_edge_size": 3,
            "denoising_strength": 0.9,
            "mask_blur": 7,
        },
        mask,
    )

    assert len(fake_shared.process_calls) == 2
    p2 = fake_shared.process_calls[1]
    assert p2.denoising_strength == generation.COHERENCE_DENOISING_STRENGTH == 0.3
    assert p2.mask_blur == 7
    assert p2.scripts is None
    assert p2.script_args is None
    assert result.images[0].getpixel((10, 16))[3] > 0
    assert result.images[0].getpixel((8, 16))[3] == 0


def test_disabled_coherence_keeps_single_pass_mask_alpha(fake_forge_modules):
    generation, fake_shared = fake_forge_modules
    composite = _composite(32, 32)
    mask = Image.new("L", composite.size, 0)
    mask.paste(255, (12, 12, 20, 20))

    result = generation.run_generation(composite, {}, mask)

    assert len(fake_shared.process_calls) == 1
    assert result.images[0].getpixel((11, 16))[3] == 0
    assert result.images[0].getpixel((12, 16))[3] == 255


def test_coherence_pass_zero_edge_size_has_no_expanded_alpha(fake_forge_modules):
    generation, fake_shared = fake_forge_modules
    composite = _composite(32, 32)
    mask = Image.new("L", composite.size, 0)
    mask.paste(255, (12, 12, 20, 20))

    result = generation.run_generation(
        composite,
        {"coherence_pass_enabled": True, "coherence_edge_size": 0},
        mask,
    )

    assert len(fake_shared.process_calls) == 2
    assert result.images[0].getpixel((11, 16))[3] == 0
    assert result.images[0].getpixel((12, 16))[3] == 255


def test_coherence_pass_resizes_back_to_canvas_size(fake_forge_modules, monkeypatch):
    """Regression test: Forge returns the generated image and `mask_for_overlay`
    sized to the generation resolution (`processing.py:1757-1760`), not the
    canvas. `_apply_coherence_pass` must resize back down/up to the canvas
    size before returning, the same way `_transparent_inpaint_patch` already
    does -- otherwise the result pastes back at generation resolution instead
    of the boundary box's actual pixel size."""
    generation, fake_shared = fake_forge_modules
    composite = _composite(32, 32)
    mask = Image.new("L", composite.size, 0)
    mask.paste(255, (12, 12, 20, 20))

    generation_size = (64, 64)

    def _fake_process_images(p):
        fake_shared.process_calls.append(p)
        if p.mask is not None:
            p.mask_for_overlay = p.mask.resize(generation_size)
            p.paste_to = None
        image = Image.new("RGB", generation_size, (0, 255, 0))
        return types.SimpleNamespace(images=[image], extra_images=[])

    monkeypatch.setattr(generation, "process_images", _fake_process_images)

    result = generation.run_generation(
        composite,
        {"coherence_pass_enabled": True, "coherence_edge_size": 3},
        mask,
    )

    assert result.images[0].size == composite.size


def test_soft_inpainting_args_injected_when_mask_present(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules
    script = _install_soft_inpainting_script(generation, [False, 9, 9, 9, 9, 9, 9])
    composite = _composite()
    mask = Image.new("L", composite.size, 255)

    p = generation.build_img2img_processing(
        composite,
        {"soft_inpainting_enabled": True},
        mask_image=mask,
    )

    assert p.script_args[script.args_from : script.args_to] == [
        True,
        1.0,
        0.5,
        4.0,
        0.0,
        0.5,
        2.0,
    ]


def test_soft_inpainting_args_not_injected_without_mask(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules
    control_defaults = [False, 9, 8, 7, 6, 5, 4]
    script = _install_soft_inpainting_script(generation, control_defaults)

    p = generation.build_img2img_processing(
        _composite(),
        {"soft_inpainting_enabled": True},
    )

    assert p.script_args[script.args_from : script.args_to] == control_defaults


def test_inpaint_controlnet_disabled_preserves_manual_layers(
    fake_forge_modules, monkeypatch
):
    generation, _fake_shared = fake_forge_modules
    manual_layer = {"model": "manual"}
    calls = []
    monkeypatch.setattr(
        generation, "apply_controlnet_units", lambda _p, layers: calls.append(layers)
    )

    generation.build_img2img_processing(
        _composite(),
        {},
        mask_image=Image.new("L", (64, 64)),
        control_layers=[manual_layer],
    )

    assert calls == [[manual_layer]]


def test_inpaint_controlnet_not_added_without_mask(fake_forge_modules, monkeypatch):
    generation, _fake_shared = fake_forge_modules
    calls = []
    monkeypatch.setattr(
        generation, "apply_controlnet_units", lambda _p, layers: calls.append(layers)
    )

    generation.build_img2img_processing(
        _composite(),
        {
            "inpaint_controlnet_enabled": True,
            "inpaint_controlnet_model": "inpaint-model",
        },
    )

    assert calls == [[]]


def test_inpaint_controlnet_is_prepended_with_composite_and_mask(
    fake_forge_modules, monkeypatch
):
    generation, _fake_shared = fake_forge_modules
    composite = _composite()
    mask = Image.new("RGBA", composite.size, (255, 255, 255, 128))
    manual_layer = {"model": "manual"}
    calls = []
    monkeypatch.setattr(
        generation,
        "apply_controlnet_units",
        lambda p, layers: calls.append((p, layers)),
    )

    p = generation.build_img2img_processing(
        composite,
        {
            "inpaint_controlnet_enabled": True,
            "inpaint_controlnet_model": "inpaint-model",
            "inpaint_controlnet_weight": 1.5,
        },
        mask_image=mask,
        control_layers=[manual_layer],
    )

    assert len(calls) == 1
    assert calls[0][0] is p
    synthetic, manual = calls[0][1]
    assert manual is manual_layer
    assert synthetic["model"] == "inpaint-model"
    assert synthetic["preprocessor"] == "None"
    assert synthetic["weight"] == 1.5
    assert synthetic["image"] is composite
    assert synthetic["mask_image"] is p.mask
    assert synthetic["mask_image"].mode == "L"


def test_none_composite_image_raises(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules

    with pytest.raises(ValueError, match="no composite image"):
        generation.build_img2img_processing(None, {})


def test_wan_video_model_aborts_generation(fake_forge_modules):
    generation, fake_shared = fake_forge_modules

    WanModel = type("Wan", (), {"is_sd1": False, "is_sdxl": False, "is_wan": True})
    fake_shared.sd_model = WanModel()

    with pytest.raises(ValueError, match="does not support video models"):
        generation.build_img2img_processing(_composite(), {})


def test_non_wan_model_with_is_wan_flag_does_not_abort(fake_forge_modules):
    """Sanity check that the Wan abort is class-name-scoped, not is_wan-scoped
    -- QwenImage/Krea2/Anima also set is_wan=True and must keep working."""
    generation, fake_shared = fake_forge_modules

    QwenModel = type(
        "QwenImage", (), {"is_sd1": False, "is_sdxl": False, "is_wan": True}
    )
    fake_shared.sd_model = QwenModel()

    p = generation.build_img2img_processing(_composite(), {})
    assert p is not None


def test_no_target_size_uses_composite_dimensions(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules

    p = generation.build_img2img_processing(_composite(300, 400), {})

    assert (p.width, p.height) == (296, 400)  # 300 clamped down to a multiple of 8


def test_target_size_overrides_output_dimensions(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules

    p = generation.build_img2img_processing(
        _composite(300, 400), {"target_width": 896, "target_height": 1152}
    )

    assert (p.width, p.height) == (896, 1152)
    # init_images keeps the ORIGINAL box-cropped composite -- Forge's own
    # resize_mode handling scales it to (width, height), Ultra Paint does not
    # resample the canvas itself.
    assert p.init_images[0].size == (300, 400)


def test_target_size_does_not_override_whole_image_choice(fake_forge_modules):
    generation, fake_shared = fake_forge_modules
    fake_shared.sd_model = None  # fallback native resolution: 512

    small_composite = _composite(64, 64)
    mask = Image.new("L", small_composite.size, 0)

    p = generation.build_img2img_processing(
        small_composite,
        {"inpaint_full_res": False, "target_width": 512, "target_height": 512},
        mask_image=mask,
    )

    assert (p.width, p.height) == (512, 512)
    assert p.inpaint_full_res is False


def test_only_one_of_target_width_height_is_ignored(fake_forge_modules):
    """Both must be supplied together; a lone target_width falls back to
    composite dimensions rather than half-applying a target."""
    generation, _fake_shared = fake_forge_modules

    p = generation.build_img2img_processing(_composite(64, 64), {"target_width": 512})

    assert (p.width, p.height) == (64, 64)


def test_txt2img_uses_txt2img_runner_and_ignores_img2img_fields(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules

    p = generation.build_txt2img_processing(
        _composite(300, 400),
        {"denoising_strength": 0.1, "target_width": 896, "target_height": 1152},
    )

    assert isinstance(p, _FakeStableDiffusionProcessingTxt2Img)
    assert p.scripts is generation.modules.scripts.scripts_txt2img
    assert (p.width, p.height) == (896, 1152)
    assert not hasattr(p, "init_images")
    assert not hasattr(p, "denoising_strength")


def test_script_defaults_are_cached_per_runner(fake_forge_modules):
    generation, _fake_shared = fake_forge_modules

    class _Control:
        def __init__(self, value):
            self.value = value

    class _Script:
        args_from = 1
        args_to = 2
        is_img2img = False

        def ui(self, _is_img2img):
            return [_Control(0)]

    img2img_script = _Script()
    txt2img_script = _Script()
    img2img_runner = generation.modules.scripts.scripts_img2img
    txt2img_runner = generation.modules.scripts.scripts_txt2img
    img2img_runner.scripts, img2img_runner.inputs = (
        [img2img_script],
        [None, _Control(1)],
    )
    txt2img_runner.scripts, txt2img_runner.inputs = (
        [txt2img_script],
        [None, _Control(2)],
    )
    generation._default_script_args_cache = None

    assert generation._default_script_args(img2img_runner) == [0, 1]
    assert generation._default_script_args(txt2img_runner) == [0, 2]


def test_empty_composite_forces_txt2img_and_resizes_result(
    fake_forge_modules, monkeypatch
):
    generation, _fake_shared = fake_forge_modules
    composite = Image.new("RGBA", (16, 12), (0, 0, 0, 0))
    built = []
    original = generation.build_txt2img_processing

    def _build(*args):
        p = original(*args)
        built.append(p)
        return p

    monkeypatch.setattr(generation, "build_txt2img_processing", _build)
    monkeypatch.setattr(
        generation,
        "process_images",
        lambda _p: types.SimpleNamespace(
            images=[Image.new("RGB", (32, 24), (0, 255, 0))], extra_images=[]
        ),
    )

    result = generation.run_generation(composite, {}, generation_mode="img2img")

    assert isinstance(built[0], _FakeStableDiffusionProcessingTxt2Img)
    assert result.images[0].size == composite.size


def test_txt2img_ignores_mask_and_denoise(fake_forge_modules, monkeypatch):
    generation, _fake_shared = fake_forge_modules
    monkeypatch.setattr(
        generation,
        "process_images",
        lambda _p: types.SimpleNamespace(
            images=[Image.new("RGB", (64, 64))], extra_images=[]
        ),
    )

    result = generation.run_generation(
        _composite(),
        {"denoising_strength": 0.0},
        Image.new("L", (1, 1)),
        generation_mode="txt2img",
    )

    assert result.images[0].size == (64, 64)
