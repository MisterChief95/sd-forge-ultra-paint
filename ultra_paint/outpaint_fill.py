"""Auto-outpaint mask derivation and content-aware seed fill.

Used by `run_generation` (`ultra_paint/generation.py`) when the boundary-box
composite has both fully transparent and fully opaque pixels and no mask
layer was painted: the empty region is treated as an outpaint. `Compositor.
flatten()` always clears to alpha 0 (`Compositor.ts`), so a genuinely empty
region really does arrive here as alpha == 0, not merely low alpha.

`derive_outpaint_mask` turns that region into an ordinary inpaint mask.
`fill_transparent_region` gives the model a plausible starting image there
instead of letting Forge flatten it to a flat background color
(`img2img_background_color`), using LaMA (`simple-lama-inpainting`,
https://github.com/enesmsahin/simple-lama-inpainting) when installed --
GPU first, with a one-time fallback to CPU on an out-of-memory error -- else
cv2's fast marching inpaint (`cv2` is always available; see `mask_ring.py`).

This module is intentionally import-safe with no Forge/torch dependency at
module scope, matching `mask_ring.py`: `torch`/`simple_lama_inpainting` are
only imported inside the lazy loader, so a missing/broken optional install
never breaks importing `ultra_paint.generation`.
"""

import logging

import numpy as np
from PIL import Image

__all__ = ["derive_outpaint_mask", "fill_transparent_region"]

logger = logging.getLogger(__name__)


def derive_outpaint_mask(composite: Image.Image) -> Image.Image:
    """White (255) wherever `composite` is fully transparent, else black."""
    return composite.getchannel("A").point(lambda a: 255 if a == 0 else 0)


_lama = None  # lazy SimpleLama singleton; demoted to CPU permanently after one OOM


def _get_lama():
    global _lama
    if _lama is None:
        from simple_lama_inpainting import SimpleLama

        _lama = SimpleLama()  # its own default: cuda if available, else cpu
    return _lama


def _is_oom(exc: Exception) -> bool:
    import torch

    return (
        isinstance(exc, torch.cuda.OutOfMemoryError)
        or "out of memory" in str(exc).lower()
    )


def _lama_fill(rgb: Image.Image, mask: Image.Image) -> Image.Image:
    import torch

    lama = _get_lama()
    try:
        result = lama(rgb, mask)
    except RuntimeError as exc:
        if lama.device.type != "cuda" or not _is_oom(exc):
            raise
        logger.warning(
            "Ultra Paint: LaMA ran out of GPU memory, retrying outpaint fill on CPU"
        )
        torch.cuda.empty_cache()
        lama.model.to("cpu")
        lama.device = torch.device("cpu")
        result = lama(rgb, mask)

    # SimpleLama pads the input up to a multiple of 8 internally and never
    # crops the result back down -- do that here so the fill always matches
    # the composite it was seeded from.
    return (
        result.crop((0, 0, rgb.width, rgb.height))
        if result.size != rgb.size
        else result
    )


def fill_transparent_region(composite: Image.Image, mask: Image.Image) -> Image.Image:
    """Best-effort content-aware RGB fill for `mask`'s white region.

    Never raises for a missing or failing optional LaMA install -- outpaint
    quality degrades to cv2's inpaint instead of failing the generation.
    """
    rgb = composite.convert("RGB")
    try:
        return _lama_fill(rgb, mask)
    except ImportError:
        logger.info(
            "Ultra Paint: simple-lama-inpainting is not installed; outpaint fill "
            "falling back to cv2 (pip install simple-lama-inpainting for higher quality)"
        )
    except Exception:
        logger.exception("Ultra Paint: LaMA outpaint fill failed, falling back to cv2")

    import cv2

    bgr = cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
    filled = cv2.inpaint(bgr, np.array(mask), 3, cv2.INPAINT_TELEA)
    return Image.fromarray(cv2.cvtColor(filled, cv2.COLOR_BGR2RGB))
