"""txt2img/img2img generation for the Ultra Paint tab.

This module builds and runs Forge processing objects directly
instead of going through `modules.img2img.img2img()`. The stock entry point
takes ~40 positional arguments describing the five img2img sub-modes (sketch,
inpaint, inpaint-sketch, inpaint-upload, batch), none of which apply: Ultra
Paint always hands over one boundary-box-sized RGBA frame; an empty frame
selects txt2img, while visible raster content selects img2img/inpainting.

Threading contract
------------------
`run_generation` is a *plain synchronous function*. It must run on Forge's
single GPU worker thread, not on the Gradio/FastAPI request thread -- that is
the whole point of `modules_forge/main_thread.py` (one thread for every major
T2I/I2I call keeps model moves cheap and serialised). Wrapping is the
*caller's* job:

    processed = main_thread.run_and_wait_result(run_generation, image, params)

Mirrors `modules/img2img.py:296-297`, where `img2img()` is the thin wrapper and
`img2img_function()` is the thing that actually touches the GPU. Calling
`run_and_wait_result` in here as well would deadlock the worker thread against
itself the moment anything nested wanted the queue.

`gen_params`
------------
A plain dict so the UI layer and any future caller (API route, preset loader)
share one vocabulary. Every key is optional; defaults are listed below and
applied by `_get`.

===========================  =========  ==============================================
key                          default    notes
===========================  =========  ==============================================
``prompt``                   ``""``
``negative_prompt``          ``""``
``styles``                   ``[]``     names from `shared.prompt_styles`; Phase 1 UI
                                        does not expose these
``steps``                    ``20``
``cfg_scale``                ``7.0``
``distilled_cfg_scale``      ``3.5``    Flux/SD3-style guidance; matches the
                                        `StableDiffusionProcessing` field default
                                        (processing.py:163) and is ignored by models
                                        that do not use it
``denoising_strength``       ``0.75``
``sampler_name``             ``None``   ``None`` -> Forge's own fallback
``scheduler``                ``None``   ``None`` -> Forge's own fallback
``seed``                     ``-1``     ``-1`` -> randomized by `process_images`
``subseed``                  ``-1``
``subseed_strength``         ``0.0``
``resize_mode``              ``0``      0 = "Just resize"
``override_settings``        ``{}``
``inpainting_fill``          ``1``      Only used when a mask is supplied. 1 = "original",
                                        matching `StableDiffusionProcessing`'s own default
                                        (processing.py). 0 = fill, 2 = latent noise,
                                        3 = latent nothing.
``inpaint_full_res``         ``False``  Only used when a mask is supplied. ``False`` sends
                                        the whole boundary box to the model; ``True`` crops
                                        again around the mask plus context padding. The
                                        frontend exposes both modes and defaults to whole BB.
``inpaint_full_res_padding``  ``32``    Pixels of context kept around the masked region when
                                        ``inpaint_full_res`` is set.
``mask_blur``                ``4``      Pixels. Only used when a mask is supplied.
``inpainting_mask_invert``   ``0``      0 = inpaint masked area, 1 = inpaint unmasked area.
``soft_inpainting_enabled``  ``False``  Enables Forge's Soft Inpainting always-on script
                                        when a mask is supplied.
``inpaint_controlnet_enabled``  ``False``  Enables the selected inpaint ControlNet model
                                          when a mask is supplied.
``inpaint_controlnet_model``  ``""``     Model name for the inpaint ControlNet unit.
``inpaint_controlnet_weight``  ``1.0``   Weight of the inpaint ControlNet unit.
``coherence_pass_enabled``    ``False``  Runs a low-strength second img2img pass over a
                                        ring straddling the mask boundary.
``coherence_edge_size``       ``32``     Pixels on each side of the mask boundary included
                                        in the coherence-pass ring.
``soft_inpainting_power``    ``1``
``soft_inpainting_scale``    ``0.5``
``soft_inpainting_detail_preservation``  ``4``
``soft_inpainting_mask_influence``  ``0``
``soft_inpainting_difference_threshold``  ``0.5``
``soft_inpainting_difference_contrast``  ``2``
``target_width``             ``None``   Phase 3 boundary-box scale modes (None/Auto/Manual,
``target_height``             ``None``   frontend-side). When both are supplied, they become
                                        `p.width`/`p.height` directly -- Forge's own
                                        `resize_mode` machinery resizes `init_images`/`mask`
                                        from the boundary-box crop size up/down to this
                                        target, exactly like any ordinary img2img resize.
                                        The frontend computes the actual numbers (Auto:
                                        aspect-preserving fit to `native_resolution_for`;
                                        Manual: user-entered); this module does not choose
                                        them. When either is missing/``None`` ("None" scale
                                        mode, or Phase 1/2 callers that don't send them at
                                        all), `p.width`/`p.height` fall back to the
                                        composite's own (8px-clamped) dimensions, unchanged
                                        from pre-Phase-3 behavior.
===========================  =========  ==============================================

`mask_image`
------------
Optional. A grayscale (mode ``"L"``) `PIL.Image` the same size as
`composite_image`, white = regenerate / black = keep -- exactly what
`Compositor.flattenMask()` produces on the frontend. When present,
`build_img2img_processing` takes the inpainting path (`p.mask` is set); when
``None`` (the Phase 1/2 default, no mask layer painted), behavior is unchanged
from before Phase 3 -- `p.mask = None`, no inpainting-specific fields are
touched beyond their defaults.

The boundary-box scale mode and `inpaint_full_res` are independent: the first
sets the model's working resolution, while the second chooses whether its
context is the whole BB or a tighter mask-and-padding crop.

`control_layers`
----------------
Optional structured ControlNet inputs, kept separate from `gen_params` because
each layer carries its own decoded PIL image and settings. The builders splice
them into Forge's ControlNet always-on script when that optional extension is
registered; otherwise ordinary generation continues unchanged.

`batch_size` and `n_iter` are pinned to 1 in Phase 1 (one canvas in, one image
out) and are deliberately *not* read from `gen_params`.
"""

import time
from contextlib import closing

import gradio as gr
from PIL import Image

import modules.scripts
from modules import shared
from modules.processing import (
    Processed,
    StableDiffusionProcessingImg2Img,
    StableDiffusionProcessingTxt2Img,
    process_images,
)
from modules.shared import opts

from ultra_paint.controlnet_units import apply_controlnet_units
from ultra_paint.mask_ring import compute_ring
from ultra_paint.model_profile import is_unsupported_video_model

__all__ = [
    "build_img2img_processing",
    "build_txt2img_processing",
    "run_generation",
    "GEN_PARAM_DEFAULTS",
]


GEN_PARAM_DEFAULTS: dict = {
    "prompt": "",
    "negative_prompt": "",
    "styles": [],
    "steps": 20,
    "cfg_scale": 7.0,
    "distilled_cfg_scale": 3.5,
    "denoising_strength": 0.75,
    "sampler_name": None,
    "scheduler": None,
    "seed": -1,
    "subseed": -1,
    "subseed_strength": 0.0,
    "resize_mode": 0,
    "override_settings": {},
    "inpainting_fill": 1,
    "inpaint_full_res": False,
    "inpaint_full_res_padding": 32,
    "mask_blur": 4,
    "inpainting_mask_invert": 0,
    "soft_inpainting_enabled": False,
    "inpaint_controlnet_enabled": False,
    "inpaint_controlnet_model": "",
    "inpaint_controlnet_weight": 1.0,
    "coherence_pass_enabled": False,
    "coherence_edge_size": 32,
    "coherence_pass_fast": False,
    "soft_inpainting_power": 1,
    "soft_inpainting_scale": 0.5,
    "soft_inpainting_detail_preservation": 4,
    "soft_inpainting_mask_influence": 0,
    "soft_inpainting_difference_threshold": 0.5,
    "soft_inpainting_difference_contrast": 2,
    "target_width": None,
    "target_height": None,
}


COHERENCE_DENOISING_STRENGTH = 0.3


def _get(gen_params: dict, key: str):
    """`gen_params[key]`, falling back to the documented default.

    Treats an explicit ``None`` as "not supplied" for every key whose default
    is not itself ``None`` -- Gradio hands us ``None`` for a dropdown the user
    never touched, and that should mean "default", not "crash in the sampler".
    """
    default = GEN_PARAM_DEFAULTS[key]
    value = gen_params.get(key, default)
    if value is None and default is not None:
        return default
    return value


# --------------------------------------------------------------- script args


_default_script_args_cache: dict[int, list] | None = None


def _control_default(control):
    """Default value of a Gradio control, resolving `value=lambda: ...` forms."""
    value = getattr(control, "value", None)
    return value() if callable(value) else value


def _default_script_args(script_runner=None) -> list:
    """A full-length `p.script_args` list filled with every script's defaults.

    Faithful port of `Api.init_default_script_args` (modules/api/api.py:309-327).
    Why it is needed: `ScriptRunner` dispatches by *slice* --
    `p.script_args[script.args_from:script.args_to]` (scripts.py:1011, 1022) --
    so the list must be as long as the highest `args_to` of any registered
    script, or every alwayson script (ControlNet, Regional Prompter, ...) blows
    up on a short/`None` slice even though Ultra Paint never drives them.

    Same three steps as the original:

    1. length = max `args_to` across `script_runner.scripts` (min 1);
    2. all ``None``, except index 0 = ``0``, which is the *selectable* script
       selector -- 0 means "Script: None", so `ScriptRunner.run()` returns
       ``None`` and the caller falls through to `process_images`;
    3. each script's slice overwritten with its controls' default `.value`.

    One deliberate deviation in step 3: `init_default_script_args` re-invokes
    `script.ui()` inside a throwaway `gr.Blocks()` because the API server has no
    UI to read from. We *do* -- `scripts_img2img.inputs` holds the very
    components the img2img tab built (`ScriptRunner.setup_ui_for_section` does
    `self.inputs += controls`, scripts.py:701) -- so we read `.value` off those
    and only fall back to calling `script.ui()` for a script whose slice is
    missing. That avoids constructing a second copy of every extension's UI
    (ControlNet et al. do real work in `ui()`), which would be a heavy and
    side-effect-prone thing to do on the first Generate click.

    Cached: script registration is fixed for the life of the process.
    """
    runner = (
        script_runner if script_runner is not None else modules.scripts.scripts_img2img
    )
    global _default_script_args_cache
    if _default_script_args_cache is None:
        _default_script_args_cache = {}
    cached = _default_script_args_cache.get(id(runner))
    if cached is not None:
        return list(cached)

    last_arg_index = 1
    for script in runner.scripts:
        if script.args_to is not None and last_arg_index < script.args_to:
            last_arg_index = script.args_to

    script_args = [None] * last_arg_index
    script_args[0] = 0

    live_inputs = getattr(runner, "inputs", None) or []

    # `script.ui()` creates components, which needs an open Blocks context.
    with gr.Blocks():
        for script in runner.scripts:
            args_from, args_to = script.args_from, script.args_to
            if args_from is None or args_to is None or args_to <= args_from:
                continue

            controls = list(live_inputs[args_from:args_to])
            if len(controls) != args_to - args_from or any(c is None for c in controls):
                controls = script.ui(script.is_img2img) or []
                if not controls:
                    continue

            script_args[args_from:args_to] = [_control_default(c) for c in controls]

    _default_script_args_cache[id(runner)] = list(script_args)
    return list(script_args)


# ------------------------------------------------------------------ building


def build_img2img_processing(
    composite_image: Image.Image,
    gen_params: dict,
    mask_image: Image.Image | None = None,
    control_layers: list[dict] | None = None,
) -> StableDiffusionProcessingImg2Img:
    """Assemble the processing object for one Ultra Paint generation.

    `composite_image` is the flattened canvas (RGBA PIL image) decoded from
    the frontend's `Compositor.flatten()` data URL.

    `mask_image` is optional: a grayscale (mode "L") image the same size as
    `composite_image`, from `Compositor.flattenMask()` -- white = regenerate,
    black = keep. When `None` (no mask layer painted), this is Phase 1/2
    behavior unchanged: straight img2img over the whole canvas, `mask=None`,
    no inpainting path taken. When present, Phase 3's inpainting fields
    (`inpainting_fill`, `mask_blur`, `inpainting_mask_invert`, and the selected
    `inpaint_full_res` area mode) come into play.

    `control_layers` is the ordered ControlNet layer stack; first layers take
    the available Forge unit slots first.
    """
    if composite_image is None:
        raise ValueError("Ultra Paint: no composite image was received from the canvas")

    if is_unsupported_video_model(shared.sd_model):
        raise ValueError(
            "Ultra Paint does not support video models (Wan). "
            "Load an image model before generating."
        )

    # The latent is width/8 x height/8, so a non-multiple-of-8 canvas produces a
    # latent whose decode does not line up with the init image. The stock
    # img2img sliders enforce step=8 for the same reason; the canvas has no such
    # constraint, so clamp here instead. `resize_mode=0` then rescales the init
    # image into these dimensions.
    width = max(8, (composite_image.width // 8) * 8)
    height = max(8, (composite_image.height // 8) * 8)

    mask: Image.Image | None = None
    if mask_image is not None:
        if mask_image.size != composite_image.size:
            raise ValueError(
                "Ultra Paint: mask_image size "
                f"{mask_image.size} does not match composite_image size {composite_image.size}"
            )
        mask = mask_image.convert("L")

    # Phase 3 boundary-box scale modes: an explicit target overrides the
    # output size Forge is asked to produce.
    target_width = _get(gen_params, "target_width")
    target_height = _get(gen_params, "target_height")
    if target_width is not None and target_height is not None:
        output_width = max(8, (int(target_width) // 8) * 8)
        output_height = max(8, (int(target_height) // 8) * 8)
    else:
        output_width = width
        output_height = height

    p = StableDiffusionProcessingImg2Img(
        sd_model=shared.sd_model,
        # Same option precedence as modules/img2img.py:226-227.
        outpath_samples=opts.outdir_samples or opts.outdir_img2img_samples,
        outpath_grids=opts.outdir_grids or opts.outdir_img2img_grids,
        prompt=_get(gen_params, "prompt"),
        negative_prompt=_get(gen_params, "negative_prompt"),
        styles=list(_get(gen_params, "styles")),
        batch_size=1,
        n_iter=1,
        steps=int(_get(gen_params, "steps")),
        cfg_scale=float(_get(gen_params, "cfg_scale")),
        distilled_cfg_scale=float(_get(gen_params, "distilled_cfg_scale")),
        denoising_strength=float(_get(gen_params, "denoising_strength")),
        sampler_name=_get(gen_params, "sampler_name"),
        scheduler=_get(gen_params, "scheduler"),
        seed=int(_get(gen_params, "seed")),
        subseed=int(_get(gen_params, "subseed")),
        subseed_strength=float(_get(gen_params, "subseed_strength")),
        width=output_width,
        height=output_height,
        init_images=[composite_image],
        mask=mask,  # None unless a mask layer was painted (Phase 3).
        resize_mode=int(_get(gen_params, "resize_mode")),
        override_settings={
            **dict(_get(gen_params, "override_settings")),
            # Ultra Paint adds the result over the existing layer stack, so
            # keep Forge's raw denoised pixels instead of baking the original
            # image back into them. `run_generation` restores the Only-masked
            # crop to boundary-box coordinates and uses the mask as alpha.
            "overlay_inpaint": False,
        },
        inpainting_fill=int(_get(gen_params, "inpainting_fill")),
        # False = use the whole boundary box; True = crop again around the
        # mask plus padding. The frontend exposes both and this must respect
        # the user's choice regardless of BB/model size.
        inpaint_full_res=bool(_get(gen_params, "inpaint_full_res")),
        inpaint_full_res_padding=int(_get(gen_params, "inpaint_full_res_padding")),
        mask_blur=int(_get(gen_params, "mask_blur")),
        inpainting_mask_invert=int(_get(gen_params, "inpainting_mask_invert")),
    )

    # MUST be set before `p.scripts` / `p.script_args`. Those are properties
    # (processing.py:294-315) that call `setup_scripts()` as soon as both are
    # populated, and `setup_scripts` forwards `is_ui=not self.is_api`. With
    # `is_ui=True`, every `ScriptBuiltinUI` subclass runs its `setup()` --
    # including `ScriptSampler`, whose setup does
    # `p.steps, p.sampler_name, p.scheduler = args` (processing_scripts/sampler.py:38-41)
    # and would therefore silently overwrite the values we just passed in with
    # the *img2img tab's* control defaults. `is_api = True` skips the
    # `setup_for_ui_only` scripts (scripts.py:1018) exactly the way
    # modules/api/api.py:476 does, leaving our explicit fields authoritative.
    p.is_api = True

    p.scripts = modules.scripts.scripts_img2img
    p.script_args = _default_script_args(p.scripts)

    if mask is not None:
        inpaint_controlnet_model = _get(gen_params, "inpaint_controlnet_model")
        if (
            _get(gen_params, "inpaint_controlnet_enabled")
            and isinstance(inpaint_controlnet_model, str)
            and inpaint_controlnet_model
        ):
            control_layers = [
                {
                    "image": composite_image,
                    "mask_image": mask,
                    "model": inpaint_controlnet_model,
                    # "None" (capital) is the no-op preprocessor's actual registry
                    # key (lib_controlnet.global_state.supported_preprocessors) --
                    # lowercase "none" raises a KeyError in ControlNet's own code.
                    "preprocessor": "None",
                    "preprocessor_resolution": -1,
                    "preprocessor_threshold_a": -1,
                    "preprocessor_threshold_b": -1,
                    "weight": float(_get(gen_params, "inpaint_controlnet_weight")),
                    "guidance_start": 0.0,
                    "guidance_end": 1.0,
                    "control_mode": "balanced",
                    "pixel_perfect": False,
                    "resize_mode": "resize",
                    "enabled": True,
                },
                *(control_layers or []),
            ]

        for script in p.scripts.alwayson_scripts:
            if script.title() != "Soft Inpainting":
                continue
            p.script_args[script.args_from : script.args_to] = [
                bool(_get(gen_params, "soft_inpainting_enabled")),
                float(_get(gen_params, "soft_inpainting_power")),
                float(_get(gen_params, "soft_inpainting_scale")),
                float(_get(gen_params, "soft_inpainting_detail_preservation")),
                float(_get(gen_params, "soft_inpainting_mask_influence")),
                float(_get(gen_params, "soft_inpainting_difference_threshold")),
                float(_get(gen_params, "soft_inpainting_difference_contrast")),
            ]
            break

    apply_controlnet_units(p, control_layers or [])
    return p


def build_txt2img_processing(
    composite_image: Image.Image,
    gen_params: dict,
    control_layers: list[dict] | None = None,
) -> StableDiffusionProcessingTxt2Img:
    """Assemble a txt2img processing object sized to the boundary box."""
    if composite_image is None:
        raise ValueError("Ultra Paint: no composite image was received from the canvas")

    if is_unsupported_video_model(shared.sd_model):
        raise ValueError(
            "Ultra Paint does not support video models (Wan). "
            "Load an image model before generating."
        )

    width = max(8, (composite_image.width // 8) * 8)
    height = max(8, (composite_image.height // 8) * 8)
    target_width = _get(gen_params, "target_width")
    target_height = _get(gen_params, "target_height")
    if target_width is not None and target_height is not None:
        width = max(8, (int(target_width) // 8) * 8)
        height = max(8, (int(target_height) // 8) * 8)

    p = StableDiffusionProcessingTxt2Img(
        sd_model=shared.sd_model,
        outpath_samples=opts.outdir_samples or opts.outdir_txt2img_samples,
        outpath_grids=opts.outdir_grids or opts.outdir_txt2img_grids,
        prompt=_get(gen_params, "prompt"),
        negative_prompt=_get(gen_params, "negative_prompt"),
        styles=list(_get(gen_params, "styles")),
        batch_size=1,
        n_iter=1,
        steps=int(_get(gen_params, "steps")),
        cfg_scale=float(_get(gen_params, "cfg_scale")),
        distilled_cfg_scale=float(_get(gen_params, "distilled_cfg_scale")),
        sampler_name=_get(gen_params, "sampler_name"),
        scheduler=_get(gen_params, "scheduler"),
        seed=int(_get(gen_params, "seed")),
        subseed=int(_get(gen_params, "subseed")),
        subseed_strength=float(_get(gen_params, "subseed_strength")),
        width=width,
        height=height,
        override_settings=dict(_get(gen_params, "override_settings")),
    )
    p.is_api = True
    p.scripts = modules.scripts.scripts_txt2img
    p.script_args = _default_script_args(p.scripts)
    apply_controlnet_units(p, control_layers or [])
    return p


# ------------------------------------------------------------------- running


def run_generation(
    composite_image: Image.Image,
    gen_params: dict,
    mask_image: Image.Image | None = None,
    generation_mode: str = "img2img",
    control_layers: list[dict] | None = None,
) -> Processed:
    """Run one txt2img or img2img pass over the boundary box. GPU-thread only.

    `control_layers` stays a separate top-level argument rather than becoming
    part of `gen_params`; see the module docstring.
    """
    if generation_mode not in {"img2img", "txt2img"}:
        raise ValueError(f"Ultra Paint: unknown generation mode {generation_mode!r}")

    # The frontend predicts this from visible layer bounds, but only the
    # flattened image knows whether the BB actually contains painted pixels.
    # A transparent composite cannot be a meaningful img2img init image.
    if composite_image.getchannel("A").getbbox() is None:
        generation_mode = "txt2img"

    is_txt2img = generation_mode == "txt2img"
    p = (
        build_txt2img_processing(composite_image, gen_params, control_layers)
        if is_txt2img
        else build_img2img_processing(
            composite_image, gen_params, mask_image, control_layers
        )
    )

    use_fast_coherence = (
        not is_txt2img
        and mask_image is not None
        and _get(gen_params, "coherence_pass_enabled")
        and _get(gen_params, "coherence_pass_fast")
    )
    if use_fast_coherence:
        # Picked up by scripts/fast_coherence_pass.py's post_sample hook --
        # patches the latent in place before Forge's single decode, instead
        # of dispatching a second full StableDiffusionProcessingImg2Img like
        # `_apply_coherence_pass` below.
        p.ultra_paint_fast_coherence_enabled = True
        p.ultra_paint_coherence_edge_size = int(_get(gen_params, "coherence_edge_size"))

    with closing(p):
        # Index 0 of script_args is 0 ("Script: None"), so `run` returns None and
        # we fall through to `process_images`. The call is still required: it is
        # what gives a *selectable* script the chance to take over, and it is the
        # shape modules/img2img.py:273-275 uses.
        _t_process_images = time.perf_counter()
        processed = p.scripts.run(p, *p.script_args)
        if processed is None:
            processed = process_images(p)
        print(
            f"[TIMING] generation: process_images()={time.perf_counter() - _t_process_images:.3f}s"
        )

        if is_txt2img:
            processed.images = [
                image.resize(composite_image.size, Image.Resampling.LANCZOS)
                if image.size != composite_image.size
                else image
                for image in processed.images
            ]
        elif mask_image is not None:
            _t_composite = time.perf_counter()
            mask_for_alpha = p.mask_for_overlay or mask_image.convert("L")
            if use_fast_coherence:
                # Latent already patched pre-decode -- paste back like the
                # no-coherence path, but alpha against the *dilated* mask
                # (same as _apply_coherence_pass's `patch.putalpha(dilated)`
                # below), not the plain one: the ring's blend extends
                # `coherence_edge_size` px outside the original mask, and
                # compositing against the un-dilated mask would clip that
                # outward half away with alpha=0.
                dilated, _, _ = compute_ring(
                    mask_for_alpha.convert("L"),
                    int(_get(gen_params, "coherence_edge_size")),
                )
                processed.images = [
                    _transparent_inpaint_patch(
                        image,
                        composite_image.size,
                        dilated,
                        p.paste_to,
                    )
                    for image in processed.images
                ]
            elif _get(gen_params, "coherence_pass_enabled"):
                processed.images = [
                    _apply_coherence_pass(
                        image,
                        composite_image.size,
                        mask_for_alpha,
                        int(_get(gen_params, "coherence_edge_size")),
                        p,
                        gen_params,
                    )
                    for image in processed.images
                ]
            else:
                processed.images = [
                    _transparent_inpaint_patch(
                        image,
                        composite_image.size,
                        mask_for_alpha,
                        p.paste_to,
                    )
                    for image in processed.images
                ]
            print(
                f"[TIMING] generation: post-process_images compositing={time.perf_counter() - _t_composite:.3f}s"
            )

    shared.total_tqdm.clear()

    if opts.samples_log_stdout:
        print(processed.js())

    return processed


def _apply_coherence_pass(
    image: Image.Image,
    canvas_size: tuple[int, int],
    mask_for_alpha: Image.Image,
    edge_size: int,
    base_p: StableDiffusionProcessingImg2Img,
    gen_params: dict,
) -> Image.Image:
    """Denoise a ring around an inpaint boundary, keeping its expanded alpha."""
    flattened = image.convert("RGBA")
    alpha = mask_for_alpha.convert("L")
    dilated, eroded, ring = compute_ring(alpha, edge_size)

    p2 = StableDiffusionProcessingImg2Img(
        sd_model=base_p.sd_model,
        outpath_samples=opts.outdir_samples or opts.outdir_img2img_samples,
        outpath_grids=opts.outdir_grids or opts.outdir_img2img_grids,
        prompt=base_p.prompt,
        negative_prompt=base_p.negative_prompt,
        styles=list(base_p.styles),
        batch_size=1,
        n_iter=1,
        steps=base_p.steps,
        cfg_scale=base_p.cfg_scale,
        distilled_cfg_scale=base_p.distilled_cfg_scale,
        denoising_strength=COHERENCE_DENOISING_STRENGTH,
        sampler_name=base_p.sampler_name,
        scheduler=base_p.scheduler,
        seed=base_p.seed,
        subseed=base_p.subseed,
        subseed_strength=base_p.subseed_strength,
        width=base_p.width,
        height=base_p.height,
        init_images=[flattened],
        mask=ring,
        resize_mode=0,
        override_settings={"overlay_inpaint": False},
        inpainting_fill=1,
        inpaint_full_res=False,
        inpaint_full_res_padding=0,
        mask_blur=int(_get(gen_params, "mask_blur")),
        inpainting_mask_invert=0,
    )
    with closing(p2):
        processed2 = process_images(p2)

    # `image`/`mask_for_alpha` are both sized to the generation resolution
    # (`base_p.width x base_p.height`), not the canvas -- Forge's own
    # `process_images` resizes `mask_for_overlay` to match right before
    # returning (processing.py:1757-1760), the same reason
    # `_transparent_inpaint_patch`'s "Whole image" branch resizes back down.
    # Skipping this step pastes the result back at generation resolution
    # instead of the boundary box's actual pixel size.
    patch = processed2.images[0].convert("RGBA")
    if patch.size != canvas_size:
        patch = patch.resize(canvas_size, Image.Resampling.LANCZOS)
    if dilated.size != canvas_size:
        dilated = dilated.resize(canvas_size, Image.Resampling.LANCZOS)
    patch.putalpha(dilated)
    return patch


def _transparent_inpaint_patch(
    image: Image.Image,
    canvas_size: tuple[int, int],
    mask: Image.Image,
    paste_to: tuple[int, int, int, int] | None,
) -> Image.Image:
    """Restore Forge's raw result to BB coordinates, with the mask as alpha."""
    patch = image.convert("RGBA")
    alpha = mask.convert("L")

    if paste_to is None:  # Whole image
        if patch.size != canvas_size:
            patch = patch.resize(canvas_size, Image.Resampling.LANCZOS)
        if alpha.size != canvas_size:
            alpha = alpha.resize(canvas_size, Image.Resampling.LANCZOS)
        patch.putalpha(alpha)
        return patch

    x, y, width, height = paste_to  # Only masked
    if patch.size != (width, height):
        patch = patch.resize((width, height), Image.Resampling.LANCZOS)
    if alpha.size != canvas_size:
        alpha = alpha.resize(canvas_size, Image.Resampling.LANCZOS)
    patch.putalpha(alpha.crop((x, y, x + width, y + height)))

    result = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    result.alpha_composite(patch, (x, y))
    return result
