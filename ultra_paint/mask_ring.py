"""Shared ring-mask math for the coherence pass -- the latent-space denoise
in scripts/fast_coherence_pass.py and the paste-back alpha in
generation.py's `run_generation`, kept geometrically identical."""

import cv2
import numpy as np
from PIL import Image, ImageChops


def scale_edge_size(
    edge_size: int,
    from_size: tuple[int, int],
    to_size: tuple[int, int],
) -> int:
    """Convert a canvas-space edge width to a mask's pixel space."""
    if edge_size <= 0:
        return 0
    from_width, from_height = from_size
    to_width, to_height = to_size
    scale = (to_width / from_width + to_height / from_height) / 2
    return max(1, round(edge_size * scale))


def compute_ring(
    alpha: Image.Image, edge_size: int
) -> tuple[Image.Image, Image.Image, Image.Image]:
    """Dilated mask, eroded mask, and their difference (the blend ring), all mode "L".

    `edge_size` is the ring's *total* width, centered on the mask boundary --
    half of it dilates outward, half erodes inward -- so a mask feature
    narrower than `edge_size` (a thin brush stroke, a tapered tip) only loses
    the fraction of its interior that's actually within `edge_size / 2` of an
    edge, instead of losing everything within a full `edge_size` (this
    matches InvokeAI's coherence-pass "Edge Size", which behaves the same
    way -- doubling the per-side reach relative to the number on the slider
    surprises users tuning it against a known brush diameter)."""
    if edge_size <= 0:
        dilated = eroded = alpha
        return dilated, eroded, ImageChops.subtract(dilated, eroded)

    edge_size = max(1, round(edge_size / 2))

    # Rank/morphology ops are exact dilate/erode only on binary input. On a
    # soft/feathered mask (a brush with anti-aliased edges) they instead
    # partially flatten the gradient toward whichever extreme is nearest
    # within the kernel radius, so the ring's width ends up depending on the
    # brush's feather radius instead of just `edge_size`. Threshold first so
    # the ring geometry is exact regardless of how soft the source mask is;
    # `blur_ring` (downstream) still re-softens the result, so this doesn't
    # make the final blend any harder-edged.
    alpha = alpha.point(lambda x: 255 if x > 0 else 0)

    # cv2.dilate/erode use a decomposable (van Herk/Gil-Werman) algorithm --
    # O(w*h) regardless of kernel size, unlike PIL's ImageFilter.MaxFilter/
    # MinFilter (brute-force O(w*h*kernel_area), a measured multi-second
    # stall at full pixel resolution with a wide kernel). That used to force
    # filtering a downsampled copy and upsampling the result back, which
    # smeared fine detail (individual hair strands, wisps) into blocky,
    # gray-banded lumps well before any intentional blur was applied.
    # cv2 stays exact at full resolution with plenty of headroom to spare.
    arr = np.array(alpha, dtype=np.uint8)
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT, (edge_size * 2 + 1, edge_size * 2 + 1)
    )
    dilated = Image.fromarray(cv2.dilate(arr, kernel))
    eroded = Image.fromarray(cv2.erode(arr, kernel))

    ring = ImageChops.subtract(dilated, eroded)
    return dilated, eroded, ring


def blur_ring(mask: Image.Image, mask_blur: int) -> Image.Image:
    """Gaussian-blur a mask the same way Forge blurs any inpaint mask
    (processing.py:1729-1731). `compute_ring`'s dilate/erode/ring outputs are
    all hard-edged by construction (thresholded input, rank filters) -- this
    is what re-softens them before use as a blend/alpha mask."""
    if mask_blur <= 0:
        return mask
    source = np.array(mask, dtype=np.float32)
    kernel_size = 2 * int(2.5 * mask_blur + 0.5) + 1
    blurred = cv2.GaussianBlur(source, (kernel_size, kernel_size), mask_blur)
    return Image.fromarray(np.clip(blurred, 0, 255).astype(np.uint8))


def feathered_alpha(mask: Image.Image, edge_size: int, mask_blur: int) -> Image.Image:
    """Compositing alpha for the coherence-pass boundary: blur the mask
    *first*, then dilate the already-smooth result outward by the ring's
    own `edge_size / 2` -- grayscale dilation of a monotonic falloff just
    translates it outward (the max within any window on an increasing ramp
    is the ramp's own value `radius` pixels further along), so the
    transition stays perfectly continuous the whole way to 0.

    Dilating the hard mask first and blurring afterward, clipped to that
    hard footprint, instead chops the Gaussian falloff mid-curve: the
    clipped edge sits close to the mask's *original* boundary, well before
    the blur has decayed anywhere near 0, so composited pixels jump from 0
    to a large alpha over a single pixel right at that boundary -- a visibly
    hard step despite the blur."""
    blurred = blur_ring(mask, mask_blur)
    if edge_size <= 0:
        return blurred
    half = max(1, round(edge_size / 2))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (half * 2 + 1, half * 2 + 1))
    return Image.fromarray(cv2.dilate(np.array(blurred, dtype=np.uint8), kernel))
