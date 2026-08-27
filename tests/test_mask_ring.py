from ultra_paint.mask_ring import scale_edge_size


def test_scale_edge_size_converts_canvas_units_to_mask_units():
    assert scale_edge_size(32, (1024, 1024), (2048, 2048)) == 64
    assert scale_edge_size(32, (2048, 2048), (1024, 1024)) == 16
    assert scale_edge_size(0, (1024, 1024), (2048, 2048)) == 0
