import cv2
import numpy as np
from PIL import Image

from ultra_paint.mask_ring import (
    _blur_reach,
    blur_ring,
    dilate_then_blur,
    scale_edge_size,
)


def test_scale_edge_size_converts_canvas_units_to_mask_units():
    assert scale_edge_size(32, (1024, 1024), (2048, 2048)) == 64
    assert scale_edge_size(32, (2048, 2048), (1024, 1024)) == 16
    assert scale_edge_size(0, (1024, 1024), (2048, 2048)) == 0


def test_blur_ring_softens_a_hard_edge():
    mask = Image.new("L", (128, 128), 0)
    mask.paste(255, (32, 32, 96, 96))

    blurred = blur_ring(mask, 4)

    row = [blurred.getpixel((x, 64)) for x in range(28, 36)]
    assert row == sorted(row)  # monotonic ramp, not a hard step
    assert 0 < row[0] < row[-1] < 255
    assert blurred.getpixel((0, 0)) == 0  # far from the mask stays untouched
    assert blurred.getpixel((64, 64)) >= 254  # deep interior stays ~opaque


def test_blur_ring_zero_blur_is_a_no_op():
    mask = Image.new("L", (16, 16), 0)
    mask.paste(255, (4, 4, 12, 12))

    assert blur_ring(mask, 0) is mask


def test_dilate_then_blur_dilates_before_blurring():
    """The paste-back alpha ring dilates the hard mask boundary outward
    *first*, then applies a single blur pass. Blurring an already-blurred
    mask a second time (or blurring first and dilating the soft result
    afterward) both widen the semi-transparent band past what `mask_blur`
    asks for, letting the wrong side visibly show through at the seam."""
    mask = Image.new("L", (256, 256), 0)
    mask.paste(255, (64, 64, 192, 192))

    result = dilate_then_blur(mask, 16, 8)

    row = [result.getpixel((x, 128)) for x in range(40, 80)]
    assert row == sorted(row)  # monotonic, no discontinuity
    assert result.getpixel((0, 0)) == 0  # far away: untouched
    assert result.getpixel((128, 128)) >= 254  # deep interior: still ~opaque
    # The original mask edge (x=64) is what the ring pass actually
    # regenerated -- it must stay fully opaque, not sit mid-ramp. (The bug
    # this guards: dilating by only `edge_size / 2` before blurring lets the
    # blur's own inward reach eat back past this point and bleed through
    # whatever's underneath in the canvas compositor.)
    assert result.getpixel((64, 128)) >= 250

    # Exactly one blur pass over the hard-dilated mask, dilated by
    # edge_size/2 *plus* the blur's own inward reach.
    half = 16 // 2 + _blur_reach(8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (half * 2 + 1, half * 2 + 1))
    dilated_hard = Image.fromarray(cv2.dilate(np.array(mask, dtype=np.uint8), kernel))
    expected = blur_ring(dilated_hard, 8)
    assert list(result.getdata()) == list(expected.getdata())
