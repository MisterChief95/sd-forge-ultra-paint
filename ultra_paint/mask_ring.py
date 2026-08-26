"""Shared ring-mask math for the coherence pass (both the slow img2img
variant in generation.py and the fast latent-space one in
scripts/fast_coherence_pass.py) -- keeps their blend geometry identical."""

from PIL import Image, ImageChops, ImageFilter


MAX_FILTER_DIM = 512


def compute_ring(
    alpha: Image.Image, edge_size: int
) -> tuple[Image.Image, Image.Image, Image.Image]:
    """Dilated mask, eroded mask, and their difference (the blend ring), all mode "L"."""
    if edge_size <= 0:
        dilated = eroded = alpha
        return dilated, eroded, ImageChops.subtract(dilated, eroded)

    # MaxFilter/MinFilter are rank filters -- exact dilate/erode only on
    # binary input. On a soft/feathered mask (a brush with anti-aliased
    # edges) they instead partially flatten the gradient toward whichever
    # extreme is nearest within the kernel radius, so the ring's width ends
    # up depending on the brush's feather radius instead of just `edge_size`.
    # Threshold first so the ring geometry is exact regardless of how soft
    # the source mask is; `_blur_ring` (downstream) still re-softens the
    # result, so this doesn't make the final blend any harder-edged.
    alpha = alpha.point(lambda x: 255 if x > 0 else 0)

    # MaxFilter/MinFilter are O(w*h*kernel); at full pixel resolution with a
    # wide kernel (edge_size ~32 -> kernel ~65) this was a measured
    # multi-second stall. The ring is a soft blend boundary, not something
    # needing per-pixel precision, so filter a downsampled copy and upsample
    # the result back instead -- no-op below MAX_FILTER_DIM (e.g. the
    # already latent-sized masks fast_coherence_pass.py passes in).
    orig_size = alpha.size
    scale = min(1.0, MAX_FILTER_DIM / max(orig_size))
    if scale < 1.0:
        work = alpha.resize(
            (max(1, round(orig_size[0] * scale)), max(1, round(orig_size[1] * scale))),
            Image.Resampling.BILINEAR,
        )
        work_edge = max(1, round(edge_size * scale))
    else:
        work = alpha
        work_edge = edge_size

    kernel = work_edge * 2 + 1
    dilated = work.filter(ImageFilter.MaxFilter(kernel))
    eroded = work.filter(ImageFilter.MinFilter(kernel))

    if scale < 1.0:
        dilated = dilated.resize(orig_size, Image.Resampling.LANCZOS)
        eroded = eroded.resize(orig_size, Image.Resampling.LANCZOS)

    ring = ImageChops.subtract(dilated, eroded)
    return dilated, eroded, ring
