"""Coherence pass with no extra sampling: a flat per-step alpha blend.

The ring method (scripts/fast_coherence_pass.py) buys its seam smoothing with
a second `sample_img2img` call -- ~25% of the main pass's U-Net evaluations --
and by injecting *fresh noise* into a dilate-minus-erode band straddling the
mask boundary, so that band is regenerated content faded back in rather than
the original pixels that happened to survive.

This one rides the single existing denoising trajectory instead. Forge fires
`on_mask_blend` at every sampling step (modules/sd_samplers_cfg_denoiser.py:
153-163) with both the trajectory's current latent and the untouched
`init_latent` in hand, so preserving the original costs nothing but a lerp:
no extra U-Net calls, and where the blend weight is 0 the result *is* the
original latent, bit for bit, never a regeneration of it.

The spatial weight field is the *same* dilate-then-blur alpha the ring
method's own paste-back already computes (`ultra_paint.mask_ring.
dilate_then_blur`, via `generation.py`'s `_transparent_inpaint_patch`), not a
dilate-minus-erode ring: alpha stays 1 everywhere deep inside the original
mask (fully committed to the trajectory, a no-op against Forge's own
default), and only softens in a zone extending *outward past* the mask's own
boundary. A ring instead erodes into the mask's interior, which would
second-guess pixels the main pass already confidently painted -- this pass
only ever blends new content into the surrounding untouched context, matching
what the pixel-space paste-back alpha represents.

The blend weight is `alpha` itself, applied identically at every step and on
the final call -- no sigma-dependent curve. This is deliberate, not a missing
feature: Forge's own *default* mask blend (`denoised*nmask + init_latent*mask`
in both modules/sd_samplers_cfg_denoiser.py and modules/processing.py) is
exactly this shape, a flat per-pixel weight applied every step with no sigma
term, and it's what powers every ordinary masked inpaint in the webui. An
earlier version of this script borrowed Soft Inpainting's sigma-dependent
curve (`alpha ** (sigma**power * scale)`, extensions-builtin/soft-inpainting/
scripts/soft_inpainting.py's `get_modified_nmask`) on the theory that it was
part of what "gradient denoising" means -- but that curve is calibrated for
Soft Inpainting's own, different design: it blends across the *entire* mask
and leans on a separate adaptive difference-based final composite to decide
how much actually changed, so its per-step curve only has to avoid abrupt
transitions during sampling, not carry the whole "how much should this blend"
decision. Measured against a typical Karras sigma schedule, that curve
crushes any alpha below ~0.85 to near-zero at the high-sigma steps that
actually decide structure (e.g. alpha=0.5 -> ~0.008 at sigma=14.6) -- so
widening `mask_blur`'s dilate+blur ramp only added pixels that got crushed
back to zero anyway, making blur look like it did nothing. Using `alpha`
directly instead means `mask_blur`/`coherence_edge_size` map 1:1 onto how
much of the trajectory survives, matching what those sliders already do for
Forge's own default masking and for the ring method's paste-back alpha.

Unlike Soft Inpainting, the effect is confined to the same dilate+blur
geometry the ring method's own paste-back alpha uses (`coherence_edge_size` /
`mask_blur`), so the two algorithms are directly comparable at matching
settings and share the exact same paste-back code path in generation.py --
outside that geometry `mba.blended_latent` is left exactly as Forge computed
it.

Only fires for generations Ultra Paint explicitly opted in via
`p.ultra_paint_gradient_coherence_enabled` (set in ultra_paint/generation.py's
`run_generation`) -- this is an alwayson script and would otherwise run on
every img2img/inpaint job in the webui.
"""

import numpy as np
import torch
from PIL import Image

from modules import scripts
from ultra_paint.mask_ring import debug_save, dilate_then_blur, scale_edge_size

DEFAULT_EDGE_SIZE = 32
ALPHA_EPSILON = 1e-3


class GradientCoherencePass(scripts.Script):
    def title(self):
        return "Ultra Paint Gradient Coherence Pass"

    def show(self, is_img2img):
        # Must be the AlwaysVisible sentinel, not a plain bool -- Forge only
        # calls alwayson hooks like on_mask_blend for scripts registered that
        # way (modules/scripts.py:614-623).
        return scripts.AlwaysVisible if is_img2img else False

    def on_mask_blend(self, p, mba, *args):
        if not getattr(p, "ultra_paint_gradient_coherence_enabled", False):
            return

        alpha = _alpha(p, mba.init_latent)
        if alpha is None:
            return

        # Same formula on every step and on the final call (no sigma term at
        # all -- see the module docstring for why): `alpha` IS the regenerate
        # weight, full stop. Outside the effect zone (alpha ~0) this already
        # reduces to `init_latent`, matching Forge's own default there, but
        # `torch.where` makes that explicit rather than relying on floating-
        # point convergence, and leaves Forge's default untouched bit-for-bit
        # for any pixel this script has no opinion about.
        blend = mba.init_latent * (1 - alpha) + mba.current_latent * alpha
        mba.blended_latent = torch.where(
            alpha > ALPHA_EPSILON, blend, mba.blended_latent
        ).to(mba.blended_latent.dtype)


def _alpha(p, latent):
    """Dilate+blur alpha at the latent's own resolution, as a broadcastable
    (1, 1, H, W) tensor -- or None when there is nothing to blend.

    `on_mask_blend` fires once per sampling step but the mask never changes
    mid-generation, so this is computed once and cached on `p` (freshly
    constructed per generation by `run_generation`)."""
    cached = getattr(p, "_ultra_paint_gradient_alpha", False)
    if cached is not False:
        return cached

    alpha = _build_alpha(p, latent)
    p._ultra_paint_gradient_alpha = alpha
    return alpha


def _build_alpha(p, latent):
    coherence_mask = getattr(p, "ultra_paint_coherence_mask", None) or getattr(
        p, "mask_for_overlay", None
    )
    if coherence_mask is None:
        return None  # not an inpaint job

    edge_size = getattr(p, "ultra_paint_coherence_edge_size", DEFAULT_EDGE_SIZE)
    canvas_size = getattr(p, "ultra_paint_coherence_canvas_size", coherence_mask.size)

    # Same derivation as scripts/fast_coherence_pass.py, so both algorithms
    # (and the ring method's own paste-back alpha) place the dilate+blur
    # geometry identically at matching settings: `edge_size` is calibrated in
    # generation-output pixels and rescaled into the mask's own space,
    # `p.mask_blur` is already in the mask's space, and both then convert
    # into latent units by the real width/height ratio.
    lh, lw = latent.shape[-2], latent.shape[-1]
    iw, ih = coherence_mask.size
    edge_scale = (lw / iw + lh / ih) / 2
    edge_size = scale_edge_size(edge_size, canvas_size, coherence_mask.size)

    # Resize down to latent resolution first -- same performance reason as
    # fast_coherence_pass.py's `alpha_latent`: cv2 dilate/blur are cheap at
    # latent res, a measured multi-second stall at full mask resolution.
    resized_mask = coherence_mask.convert("L").resize(
        (lw, lh), Image.Resampling.BILINEAR
    )
    debug_save(resized_mask, "gradient_01_alpha_resized")
    alpha_image = dilate_then_blur(
        resized_mask,
        round(edge_size * edge_scale),
        round(p.mask_blur * edge_scale),
    )
    debug_save(alpha_image, "gradient_02_alpha_dilated_blurred")

    alpha_arr = np.asarray(alpha_image, dtype=np.float32) / 255.0
    if alpha_arr.max() <= 0:
        return None  # edge_size resolved to nothing (e.g. mask fills the frame)

    return (
        torch.from_numpy(alpha_arr)
        .to(device=latent.device, dtype=latent.dtype)
        .view(1, 1, lh, lw)
    )
