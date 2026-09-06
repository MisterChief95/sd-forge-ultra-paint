"""Unit tests for `scripts.fast_coherence_pass`'s ring/blur pixel-space handling.

`coherence_edge_size` has no Forge equivalent, so it's calibrated in pixels of
the generation output (`p.width`/`p.height`) and rescaled down into the
mask's own pixel space before use. `mask_blur` DOES have a Forge equivalent
(`p.mask_blur`): `StableDiffusionProcessingImg2Img.init()` Gaussian-blurs the
mask in its own input resolution *before* Forge resizes it to the output
(installed `modules/processing.py:1731-1759`) -- so it must stay unscaled
here too, or the coherence ring's blur disagrees with Forge's own main-pass
mask blur whenever a Resolution-scale mode changes the output size.
"""

import sys
import types

import pytest
import torch
from PIL import Image


@pytest.fixture
def fast_coherence_pass(monkeypatch):
    """Install a minimal fake `modules.scripts`, then import the script fresh."""
    fake_scripts_module = types.ModuleType("modules.scripts")

    class _Script:
        def title(self):
            return ""

        def show(self, is_img2img):
            return False

    fake_scripts_module.Script = _Script
    fake_scripts_module.AlwaysVisible = "always-visible"

    fake_modules = types.ModuleType("modules")
    fake_modules.scripts = fake_scripts_module

    monkeypatch.setitem(sys.modules, "modules", fake_modules)
    monkeypatch.setitem(sys.modules, "modules.scripts", fake_scripts_module)
    monkeypatch.delitem(sys.modules, "scripts.fast_coherence_pass", raising=False)

    import scripts.fast_coherence_pass as module

    yield module

    monkeypatch.delitem(sys.modules, "scripts.fast_coherence_pass", raising=False)


class _FakeSampler:
    def sample_img2img(self, p, x, noise, c, uc, steps, image_conditioning):
        return x + 1.0


def _fake_p(mask_blur, edge_size, canvas_size, coherence_mask):
    p = types.SimpleNamespace()
    p.mask_for_overlay = coherence_mask  # marks this as an inpaint job
    p.ultra_paint_coherence_mask = coherence_mask
    p.ultra_paint_coherence_edge_size = edge_size
    p.ultra_paint_coherence_canvas_size = canvas_size
    p.mask_blur = mask_blur
    p.mask = p.nmask = None
    p.denoising_strength = 0.75
    p.steps = 8
    p.c = p.uc = None
    p.image_conditioning = None
    p.sampler = _FakeSampler()
    return p


def test_coherence_ring_scales_edge_size_but_not_mask_blur(
    fast_coherence_pass, monkeypatch
):
    module = fast_coherence_pass
    edge_sizes = []
    blur_reaches = []

    original_compute_ring = module.compute_ring
    original_blur_ring = module.blur_ring

    def _capture_compute_ring(alpha, edge_size):
        edge_sizes.append(edge_size)
        return original_compute_ring(alpha, edge_size)

    def _capture_blur_ring(mask, mask_blur):
        blur_reaches.append(mask_blur)
        return original_blur_ring(mask, mask_blur)

    monkeypatch.setattr(module, "compute_ring", _capture_compute_ring)
    monkeypatch.setattr(module, "blur_ring", _capture_blur_ring)
    monkeypatch.setattr(module, "debug_save", lambda *_args, **_kwargs: None)

    mask = Image.new("L", (64, 64), 0)
    mask.paste(255, (0, 0, 32, 64))  # hard vertical edge at x=32

    script = module.FastCoherencePass()

    def _run(canvas_size):
        p = _fake_p(mask_blur=8, edge_size=16, canvas_size=canvas_size, coherence_mask=mask)
        p.ultra_paint_fast_coherence_enabled = True
        ps = types.SimpleNamespace(samples=torch.zeros((1, 4, 16, 16)))
        script.post_sample(p, ps)

    _run((64, 64))  # canvas_size == mask size -> edge_size unscaled
    _run((128, 128))  # canvas_size == 2x mask size -> edge_size halved into mask units

    assert edge_sizes[0] != edge_sizes[1]
    assert edge_sizes[1] == pytest.approx(edge_sizes[0] / 2, abs=1)
    # `mask_blur` must stay in the mask's own pixel space regardless of
    # `canvas_size` -- matching Forge's own `mask_blur`, which blurs before
    # resizing to the output.
    assert blur_reaches[0] == blur_reaches[1]
