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

import time

import cv2
import numpy as np
import torch
from PIL import Image

from modules import scripts
from ultra_paint.mask_ring import compute_ring, scale_edge_size


COHERENCE_STEPS = 6
COHERENCE_DENOISE_STRENGTH = 0.35
DEFAULT_EDGE_SIZE = 32


def _blur_ring(ring_image, mask_blur):
    """Gaussian-blur the ring the same way Forge blurs any inpaint mask
    (processing.py:1729-1731) -- without this the ring's edge is exactly as
    hard as the MaxFilter/MinFilter that built it, instead of fading like the
    slow coherence pass's mask does."""
    if mask_blur <= 0:
        return ring_image
    kernel_size = 2 * int(2.5 * mask_blur + 0.5) + 1
    blurred = cv2.GaussianBlur(
        np.array(ring_image, dtype=np.float32), (kernel_size, kernel_size), mask_blur
    )
    return Image.fromarray(np.clip(blurred, 0, 255).astype(np.uint8))


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

        t_start = time.perf_counter()

        mask_for_overlay = getattr(p, "mask_for_overlay", None)
        if mask_for_overlay is None:
            return  # not an inpaint job

        edge_size = getattr(p, "ultra_paint_coherence_edge_size", DEFAULT_EDGE_SIZE)
        canvas_size = getattr(
            p, "ultra_paint_coherence_canvas_size", mask_for_overlay.size
        )
        samples = (
            ps.samples
        )  # (B, C, H, W) latent, pre-decode -- (B, C, T, H, W) for video models

        # `edge_size`/`mask_blur` are pixel units in the mask's own
        # resolution -- mask_for_overlay's own size, not (p.width, p.height)
        # (Forge doesn't assume these match: processing.py:1800-1801). Scale
        # both into latent units by the real width/height ratio -- works
        # regardless of the model's VAE downscale factor (8x for most SD
        # models, 16x for some, a non-uniform ratio for video models).
        lh, lw = samples.shape[-2], samples.shape[-1]
        iw, ih = mask_for_overlay.size
        edge_scale = (lw / iw + lh / ih) / 2
        edge_size = scale_edge_size(edge_size, canvas_size, mask_for_overlay.size)

        # MaxFilter/MinFilter (in compute_ring) are O(w*h*kernel) -- run at
        # the mask's full pixel resolution with edge_size~32 (kernel~65) this
        # was a measured multi-second stall. Resize down to latent resolution
        # first so the filters run on a ~100x100 image instead.
        alpha_latent = mask_for_overlay.convert("L").resize(
            (lw, lh), Image.Resampling.BILINEAR
        )
        _, _, ring = compute_ring(alpha_latent, max(1, round(edge_size * edge_scale)))
        ring = _blur_ring(ring, max(0, round(p.mask_blur * edge_scale)))

        ring_arr = np.asarray(ring, dtype=np.float32) / 255.0
        ring_mask = (
            torch.from_numpy(ring_arr)
            .to(device=samples.device, dtype=samples.dtype)
            .view(1, 1, lh, lw)
        )
        keep_mask = 1.0 - ring_mask

        if ring_mask.max().item() <= 0:
            return  # edge_size resolved to nothing (e.g. mask fills the frame) -- nothing to blend

        t_setup_done = time.perf_counter()

        # Forge's convention (processing.py:1868-1869): `mask` = 1 where the
        # original should be kept, `nmask` = 1 where it should regenerate.
        # p.c/p.uc/p.rng/p.image_conditioning are reused completely
        # unmodified -- same shape as the main pass, so no re-derivation
        # needed (see module docstring).
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
                steps=COHERENCE_STEPS,
                image_conditioning=getattr(p, "image_conditioning", None),
            )
        finally:
            p.mask, p.nmask, p.denoising_strength = saved

        t_sample_done = time.perf_counter()

        # Same final cleanup blend the stock img2img sample() does
        # (processing.py:1920) -- pins the "keep" region back to the exact
        # original latent instead of trusting the per-step blend alone.
        ps.samples = denoised * ring_mask + samples * keep_mask

        t_end = time.perf_counter()
        print(
            f"[ultra_paint fast coherence] TIMING setup={t_setup_done - t_start:.3f}s "
            f"sample_img2img={t_sample_done - t_setup_done:.3f}s "
            f"composite={t_end - t_sample_done:.3f}s total={t_end - t_start:.3f}s"
        )
