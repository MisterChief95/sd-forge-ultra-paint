"""Sketch: latent-space coherence pass, no second img2img dispatch, no second VAE roundtrip.

Runs after the main sampling loop (post_sample fires on the latent, before
decode_first_stage — modules/processing.py:1002-1011), crops the *latent* to
the mask-ring's bounding box, re-noises + denoises just that crop with a
short custom loop, and pastes it back into the same latent tensor before the
single normal decode happens.

TODO before this is real:
  - cond/uncond compilation (`_compile_cond` below) is a stub. Wire it to
    whatever `p.c`/`p.uc` actually are for this sampler (MulticondLearnedConditioning
    -> the same `model_conds` dict shape `calc_cond_uncond_batch` expects).
    See backend/sampling/condition.py's `compile_conditions` /
    `compile_weighted_conditions`, used the same way in
    backend/sampling/sampling_function.py:333-334.
  - Sigma schedule: reuses whatever scheduler p.sampler already resolved
    (`p.sampler.get_sigmas` or equivalent) sliced down to `steps`/`denoising_strength`
    instead of hand-rolling one -- don't reinvent noise scheduling here.
  - VAE spatial downscale factor is assumed 8 (standard SD latents); confirm
    for whatever model this extension targets.
"""

import torch

from modules import masking, scripts
from backend.sampling.sampling_function import calc_cond_uncond_batch


COHERENCE_STEPS = 6
COHERENCE_DENOISE_STRENGTH = 0.35
LATENT_DOWNSCALE = 8


def _compile_cond(p):
    """TODO: return (cond, uncond) in the {"model_conds": {...}} shape
    calc_cond_uncond_batch expects -- see sampling_function.sampling_function()
    for how it builds these from denoiser_params.text_cond/text_uncond."""
    raise NotImplementedError


def _ring_latent_bbox(mask_for_overlay, edge_size, image_size, latent_shape):
    """Bounding box (in latent pixels) of the dilated mask ring, padded."""
    alpha = mask_for_overlay.convert("L")
    crop_region = masking.get_crop_region_v2(alpha, edge_size)
    if crop_region is None:
        return None
    x1, y1, x2, y2 = crop_region
    lh, lw = latent_shape[-2], latent_shape[-1]
    sx, sy = lw / image_size[0], lh / image_size[1]
    return (
        max(0, int(x1 * sx)),
        max(0, int(y1 * sy)),
        min(lw, int(x2 * sx) + 1),
        min(lh, int(y2 * sy) + 1),
    )


class FastCoherencePass(scripts.Script):
    def title(self):
        return "Ultra Paint Fast Coherence Pass"

    def show(self, is_img2img):
        return is_img2img

    def post_sample(self, p, ps, *args):
        mask_for_overlay = getattr(p, "mask_for_overlay", None)
        if mask_for_overlay is None:
            return  # not an inpaint job

        samples = ps.samples  # (B, C, H, W) latent, pre-decode
        bbox = _ring_latent_bbox(mask_for_overlay, edge_size=32 // LATENT_DOWNSCALE, image_size=(p.width, p.height), latent_shape=samples.shape)
        if bbox is None:
            return
        x1, y1, x2, y2 = bbox

        crop = samples[:, :, y1:y2, x1:x2].clone()

        unet = p.sd_model.forge_objects.unet
        model = unet.model  # KModel: has .apply_model, .predictor
        cond, uncond = _compile_cond(p)  # TODO

        sigmas = p.sampler.get_sigmas(p, COHERENCE_STEPS)  # TODO: confirm this accessor on your sampler wrapper
        start_idx = int(len(sigmas) * (1.0 - COHERENCE_DENOISE_STRENGTH))
        sigmas = sigmas[start_idx:]

        noise = torch.randn_like(crop)
        x = crop + noise * sigmas[0]

        model_options = unet.model_options
        for i in range(len(sigmas) - 1):
            sigma = sigmas[i].expand(x.shape[0])
            cond_pred, uncond_pred = calc_cond_uncond_batch(model, cond, uncond, x, sigma, model_options)
            denoised = uncond_pred + (cond_pred - uncond_pred) * p.cfg_scale
            dt = sigmas[i + 1] - sigmas[i]
            x = x + (x - denoised) / sigma.view(-1, 1, 1, 1) * dt  # Euler step

        samples[:, :, y1:y2, x1:x2] = x
        ps.samples = samples
