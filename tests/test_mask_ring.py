from PIL import Image

from ultra_paint.mask_ring import blur_ring, feathered_alpha, scale_edge_size


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


def test_feathered_alpha_has_no_hard_step_at_the_source_edge():
    """Blurring the hard dilated mask and clipping to its own footprint
    chops the Gaussian falloff mid-curve into a visible jump right at the
    mask's original edge. `feathered_alpha` blurs *first* (smooth on both
    sides) then dilates the already-smooth result outward -- grayscale
    dilation of a monotonic ramp just translates it, so the transition
    stays continuous the whole way from 0 to ~opaque."""
    mask = Image.new("L", (128, 128), 0)
    mask.paste(255, (32, 32, 96, 96))

    feathered = feathered_alpha(mask, 16, 8)

    row = [feathered.getpixel((x, 64)) for x in range(10, 40)]
    assert row == sorted(row)  # monotonic, no discontinuity
    assert max(b - a for a, b in zip(row, row[1:])) <= 15  # no single-pixel jump
    assert feathered.getpixel((0, 0)) == 0  # far away: untouched
    assert feathered.getpixel((64, 64)) >= 254  # deep interior: still ~opaque

    # Dilating a blurred ramp is exactly a translation by the dilation
    # radius (max-within-window on a monotonic curve == the curve shifted).
    half = 8  # edge_size=16 -> half=8, matching compute_ring's edge_size/2
    plain_blur = blur_ring(mask, 8)
    assert feathered.getpixel((31, 64)) == plain_blur.getpixel((31 + half, 64))
