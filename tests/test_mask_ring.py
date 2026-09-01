from PIL import Image

from ultra_paint.mask_ring import blur_ring, dilate_then_blur, scale_edge_size


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
    mask = Image.new("L", (128, 128), 0)
    mask.paste(255, (32, 32, 96, 96))

    result = dilate_then_blur(mask, 16, 8)

    row = [result.getpixel((x, 64)) for x in range(10, 40)]
    assert row == sorted(row)  # monotonic, no discontinuity
    assert result.getpixel((0, 0)) == 0  # far away: untouched
    assert result.getpixel((64, 64)) >= 254  # deep interior: still ~opaque

    # Exactly one blur pass over the hard-dilated mask -- nothing pre-softened.
    from ultra_paint.mask_ring import compute_ring

    dilated_hard, _, _ = compute_ring(mask, 16)
    expected = blur_ring(dilated_hard, 8)
    assert list(result.getdata()) == list(expected.getdata())
