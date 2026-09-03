"""Shared ring-mask math for the coherence pass -- the latent-space denoise
in scripts/fast_coherence_pass.py and the paste-back alpha in
generation.py's `run_generation`, kept geometrically identical."""

import os

import cv2
import numpy as np
from PIL import Image, ImageChops

_DEBUG_DIR = os.path.join(os.path.dirname(__file__), "..", "debug_dump")
_DEBUG_MASKS = os.environ.get("ULTRA_PAINT_DEBUG_MASKS", "1") != "0"


def debug_reset() -> None:
    """Clear debug_dump/ so stale PNGs from a previous run (or a since-
    renamed stage) never linger and scramble the numbered sequence."""
    if not _DEBUG_MASKS:
        return
    if os.path.isdir(_DEBUG_DIR):
        for name in os.listdir(_DEBUG_DIR):
            if name.endswith(".png"):
                os.remove(os.path.join(_DEBUG_DIR, name))


def debug_save(image: Image.Image, name: str) -> None:
    """Dump a numbered mask/image stage to debug_dump/ for visual inspection
    of the coherence pass's mask pipeline. Set ULTRA_PAINT_DEBUG_MASKS=0 to
    disable."""
    if not _DEBUG_MASKS:
        return
    os.makedirs(_DEBUG_DIR, exist_ok=True)
    image.save(os.path.join(_DEBUG_DIR, f"{name}.png"))


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


def _blur_reach(mask_blur: int) -> int:
    """Distance (px) a Gaussian blur of this radius eats into a hard edge
    before opacity is ~saturated -- same 2.5-sigma convention as the kernel
    size below, so the two stay consistent."""
    return int(2.5 * mask_blur + 0.5)


def blur_ring(mask: Image.Image, mask_blur: int) -> Image.Image:
    """Gaussian-blur a mask the same way Forge blurs any inpaint mask
    (processing.py:1729-1731). `compute_ring`'s dilate/erode/ring outputs are
    all hard-edged by construction (thresholded input, rank filters) -- this
    is what re-softens them before use as a blend/alpha mask."""
    if mask_blur <= 0:
        return mask
    source = np.array(mask, dtype=np.float32)
    kernel_size = 2 * _blur_reach(mask_blur) + 1
    blurred = cv2.GaussianBlur(source, (kernel_size, kernel_size), mask_blur)
    return Image.fromarray(np.clip(blurred, 0, 255).astype(np.uint8))


def dilate_then_blur(mask: Image.Image, edge_size: int, mask_blur: int) -> Image.Image:
    """Compositing alpha for the coherence-pass boundary: hard-dilate the
    mask outward by the ring's own `edge_size / 2` *plus* the blur's own
    reach, then blur once.

    The extra `_blur_reach(mask_blur)` margin matters because a symmetric
    Gaussian blur crosses 50% opacity exactly *at* the edge it's applied to
    and only saturates back to ~100% roughly `2.5 * mask_blur` px to the
    interior side. Dilating by only `edge_size / 2` and then blurring means
    that inward saturation distance eats back past the ring's true outward
    edge and lands on the original mask seam -- which the ring pass
    genuinely regenerated and must stay fully opaque -- leaving it only
    partially opaque and letting whatever is beneath (in the canvas
    compositor) show through. Padding the dilation by the blur's own reach
    first means saturation lands exactly at the ring's true boundary, so the
    entire regenerated region stays opaque and only the untouched area
    beyond it fades.

    Matches how Forge derives its own `mask_for_overlay` from a raw mask
    (one blur pass over a hard edge -- modules/processing.py:1731-1734) so
    the paste-back ring gets exactly the softness `mask_blur` asks for.
    Blurring a mask that was already blurred upstream (e.g. by feeding this
    a mask Forge itself already softened) stacks a second Gaussian pass on
    top of the first, widening the semi-transparent band well past
    `mask_blur` and letting the wrong side visibly show through at the
    seam."""
    if edge_size <= 0:
        dilated = mask
    else:
        half = max(1, round(edge_size / 2)) + _blur_reach(mask_blur)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (half * 2 + 1, half * 2 + 1))
        binary = mask.point(lambda x: 255 if x > 0 else 0)
        dilated = Image.fromarray(cv2.dilate(np.array(binary, dtype=np.uint8), kernel))
    return blur_ring(dilated, mask_blur)


def _demo() -> None:
    """Self-check: alpha at the original mask seam must saturate, not bleed."""
    size = 600  # generous margin: dilation (32+60px) + blur reach (60px) both sides
    mask = Image.new("L", (size, size), 0)
    mask.paste(255, (0, 0, size, size // 2))  # hard edge at y=300

    edge_size, mask_blur = 64, 24  # the reported bleed-through config
    alpha = dilate_then_blur(mask, edge_size, mask_blur)
    arr = np.array(alpha)

    seam_y = size // 2 - 1  # last row that was definitely inside the mask
    at_seam = int(arr[seam_y].mean())
    assert at_seam >= 250, f"seam alpha only {at_seam}/255 -- ring not fully opaque"

    far_outside = int(arr[-1].mean())  # bottom row: well past the blurred edge
    assert far_outside == 0, f"unrelated region got alpha {far_outside}, expected 0"

    print(f"ok: seam alpha={at_seam}, far-outside alpha={far_outside}")  # noqa: T201


if __name__ == "__main__":
    _demo()
