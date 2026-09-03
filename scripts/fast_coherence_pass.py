"""Latent-space coherence pass: no second img2img dispatch, no second VAE roundtrip.

Runs after the main sampling loop (post_sample fires on the latent, before
decode_first_stage — modules/processing.py:1002-1011) and denoises the *same*
boundary-box latent tensor the main pass already produced, by calling back
into `p.sampler.sample_img2img` -- the same method the main pass itself uses
(processing.py:1917) -- so whatever sampler algorithm was actually configured
(Euler, DPM++, ER-SDE, restart, ...) runs the coherence pass too, instead of
a hardcoded integrator.

Deliberately does NOT crop to a sub-region: Ultra Paint's Coherence Pass mode
already runs the main pass with inpaint_full_res=False ("Whole image" -- the
boundary box itself is already the crop, matching InvokeAI's approach of
treating the bounding box as the whole canvas rather than exposing a separate
"only masked" sub-crop). Denoising a smaller crop would need its own
re-derived mask/RNG/image-conditioning at a different tensor shape -- fragile
(see git history: 5D-tensor slicing bugs, RNG shape mismatches) for a
compute saving that only matters when the ring is much smaller than the
boundary box. Reusing the full latent means `p.c`/`p.uc`/`p.rng`/
`p.image_conditioning` all carry over completely unmodified; only
`p.mask`/`p.nmask`/`p.denoising_strength` point at the ring instead of the
main pass's inpaint mask for the duration of the call.

Only fires for generations Ultra Paint explicitly opted in via
`p.ultra_paint_fast_coherence_enabled` (set in ultra_paint/generation.py's
`run_generation`) -- this is an alwayson script and would otherwise run on
every img2img/inpaint job in the webui, not just Ultra Paint's own.
"""

import numpy as np
import torch
from PIL import Image

from modules import scripts
from ultra_paint.mask_ring import blur_ring, compute_ring, debug_save, scale_edge_size

COHERENCE_STEPS_FRACTION = 0.25  # of the main pass's step count
COHERENCE_DENOISE_STRENGTH = 0.35
DEFAULT_EDGE_SIZE = 32


class FastCoherencePass(scripts.Script):
    def title(self):
        return "Ultra Paint Fast Coherence Pass"

    def show(self, is_img2img):
        # Must be the AlwaysVisible sentinel, not a plain bool -- Forge only
        # calls alwayson hooks like post_sample for scripts registered that
        # way (modules/scripts.py:614-623); a bool makes this a *selectable*
        # script that only runs if picked from the "Script:" dropdown, which
        # nothing here ever does.
        return scripts.AlwaysVisible if is_img2img else False

    def post_sample(self, p, ps, *args):
        if not getattr(p, "ultra_paint_fast_coherence_enabled", False):
            return

        # TODO: Allow masking + outpainting
        mask_for_overlay = getattr(p, "mask_for_overlay", None)
        if mask_for_overlay is None:
            return  # not an inpaint job

        # The ring's geometry must come from the *unblurred* mask, not
        # Forge's own mask_blur-softened mask_for_overlay -- compute_ring
        # hard-thresholds its input (mask_ring.py's `alpha.point(...)`), so
        # feeding it an already-blurred mask hardens that blur's faint tail
        # into solid coverage before the ring's own dilation is even applied,
        # ballooning the ring well past `edge_size`.
        coherence_mask = (
            getattr(p, "ultra_paint_coherence_mask", None) or mask_for_overlay
        )
        debug_save(coherence_mask, "01_coherence_mask_input")

        edge_size = getattr(p, "ultra_paint_coherence_edge_size", DEFAULT_EDGE_SIZE)
        canvas_size = getattr(
            p, "ultra_paint_coherence_canvas_size", coherence_mask.size
        )
        samples = (
            ps.samples
        )  # (B, C, H, W) latent, pre-decode -- (B, C, T, H, W) for video models

        # `edge_size`/`mask_blur` are pixel units in the mask's own
        # resolution -- coherence_mask's own size, not (p.width, p.height)
        # (Forge doesn't assume these match: processing.py:1800-1801). Scale
        # both into latent units by the real width/height ratio -- works
        # regardless of the model's VAE downscale factor (8x for most SD
        # models, 16x for some, a non-uniform ratio for video models).
        lh, lw = samples.shape[-2], samples.shape[-1]
        iw, ih = coherence_mask.size
        edge_scale = (lw / iw + lh / ih) / 2
        edge_size = scale_edge_size(edge_size, canvas_size, coherence_mask.size)

        # MaxFilter/MinFilter (in compute_ring) are O(w*h*kernel) -- run at
        # the mask's full pixel resolution with edge_size~32 (kernel~65) this
        # was a measured multi-second stall. Resize down to latent resolution
        # first so the filters run on a ~100x100 image instead.
        alpha_latent = coherence_mask.convert("L").resize(
            (lw, lh), Image.Resampling.BILINEAR
        )
        debug_save(alpha_latent, "02_alpha_latent")
        dilated_latent, eroded_latent, ring = compute_ring(
            alpha_latent, max(1, round(edge_size * edge_scale))
        )
        debug_save(dilated_latent, "03_dilated_latent")
        debug_save(eroded_latent, "04_eroded_latent")
        debug_save(ring, "05_ring_raw")
        ring = blur_ring(ring, max(0, round(p.mask_blur * edge_scale)))
        debug_save(ring, "06_ring_blurred")

        ring_arr = np.asarray(ring, dtype=np.float32) / 255.0
        ring_mask = (
            torch.from_numpy(ring_arr)
            .to(device=samples.device, dtype=samples.dtype)
            .view(1, 1, lh, lw)
        )
        keep_mask = 1.0 - ring_mask

        if ring_mask.max().item() <= 0:
            return  # edge_size resolved to nothing (e.g. mask fills the frame) -- nothing to blend

        # Forge's convention (processing.py:1868-1869): `mask` = 1 where the
        # original should be kept, `nmask` = 1 where it should regenerate.
        # p.c/p.uc/p.rng/p.image_conditioning are reused completely
        # unmodified -- same shape as the main pass, so no re-derivation
        # needed (see module docstring).
        coherence_steps = max(2, round(p.steps * COHERENCE_STEPS_FRACTION))

        saved = (p.mask, p.nmask, p.denoising_strength)
        p.mask, p.nmask = keep_mask, ring_mask
        p.denoising_strength = COHERENCE_DENOISE_STRENGTH
        try:
            denoised = p.sampler.sample_img2img(
                p,
                samples.clone(),
                torch.randn_like(samples),
                p.c,
                p.uc,
                steps=coherence_steps,
                image_conditioning=getattr(p, "image_conditioning", None),
            )
        finally:
            p.mask, p.nmask, p.denoising_strength = saved

        # Same final cleanup blend the stock img2img sample() does
        # (processing.py:1920) -- pins the "keep" region back to the exact
        # original latent instead of trusting the per-step blend alone.
        ps.samples = denoised * ring_mask + samples * keep_mask
