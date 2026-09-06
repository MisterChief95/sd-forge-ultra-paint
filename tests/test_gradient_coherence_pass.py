"""Unit tests for `scripts.gradient_coherence_pass`'s per-step blend.

The hook fires on every denoising step of every img2img/inpaint job in the
webui, so the opt-in guard is as load-bearing as the blend math itself. The
blend is deliberately sigma-independent (see the module docstring for why) --
`alpha` alone is the regenerate weight, identically on every step and the
final call -- so these tests don't vary `sigma` to probe the blend at all;
they just confirm the same flat formula applies everywhere the alpha field
says it should.

The spatial weight field is a dilate-then-blur alpha (matching the ring
method's own paste-back), not a dilate-minus-erode ring: deep inside the
original mask alpha is 1 (a no-op vs. Forge's own default there), and the
only place the blend actually does anything is the zone extending *outward
past* the mask's original boundary.
"""

import sys
import types

import pytest
import torch
from PIL import Image


@pytest.fixture
def gradient_coherence_pass(monkeypatch):
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
    monkeypatch.delitem(sys.modules, "scripts.gradient_coherence_pass", raising=False)

    import scripts.gradient_coherence_pass as module

    monkeypatch.setattr(module, "debug_save", lambda *_args, **_kwargs: None)

    yield module

    monkeypatch.delitem(sys.modules, "scripts.gradient_coherence_pass", raising=False)


# Big enough that the dilate+blur alpha actually reaches 0 inside the frame:
# with these settings it dilates ~5 latent px past the mask edge and the blur
# needs ~4 more to bottom out, so a 16px latent never leaves a genuinely
# untouched column to assert against.
LATENT = 32
MASK = 128
# Alpha plateaus at 254/255, not 255 -- `blur_ring` clips a float Gaussian
# back to uint8, so "fully opaque" is 0.996, never exactly 1.
OPAQUE = 0.99


def _mask() -> Image.Image:
    """Hard vertical edge at MASK/2 (LATENT/2 in latent units)."""
    mask = Image.new("L", (MASK, MASK), 0)
    mask.paste(255, (0, 0, MASK // 2, MASK))
    return mask


def _fake_p(**overrides):
    p = types.SimpleNamespace()
    p.ultra_paint_gradient_coherence_enabled = True
    p.ultra_paint_coherence_mask = _mask()
    p.ultra_paint_coherence_edge_size = 16
    p.ultra_paint_coherence_canvas_size = (MASK, MASK)
    p.mask_blur = 4
    for key, value in overrides.items():
        setattr(p, key, value)
    return p


def _fake_mba(sigma, is_final_blend=False):
    shape = (1, 4, LATENT, LATENT)
    return types.SimpleNamespace(
        current_latent=torch.ones(shape),
        init_latent=torch.zeros(shape),
        nmask=torch.ones(shape),
        mask=torch.zeros(shape),
        # Forge hands the hook its own default blend already computed; a
        # distinctive value makes "left untouched" observable.
        blended_latent=torch.full(shape, 0.5),
        sigma=None if is_final_blend else torch.tensor([sigma]),
        is_final_blend=is_final_blend,
    )


def _alpha_columns(module, p, latent):
    """A column on the dilate+blur ramp (outside the original mask edge, at
    LATENT/2), one deep inside the mask (fully committed), and one clear of
    the effect zone entirely.

    The ramp, not a fully-committed column: `alpha ** anything == 1` at
    alpha 1, so a fully-opaque column is sigma-independent by construction
    and says nothing about the curve."""
    row = module._alpha(p, latent)[0, 0, LATENT // 2]
    partial = int((row - 0.5).abs().argmin())
    outside = int(row.argmin())
    deep_inside = 0  # x=0 is deep inside the mask's left half
    assert 0.2 < row[partial] < 0.8
    assert row[outside] <= module.ALPHA_EPSILON
    assert row[deep_inside] >= OPAQUE
    return partial, outside, deep_inside


def test_no_op_when_not_enabled(gradient_coherence_pass):
    module = gradient_coherence_pass
    p = _fake_p()
    del p.ultra_paint_gradient_coherence_enabled
    mba = _fake_mba(sigma=5.0)
    before = mba.blended_latent.clone()

    module.GradientCoherencePass().on_mask_blend(p, mba)

    assert torch.equal(mba.blended_latent, before)


def test_deep_inside_the_mask_is_a_no_op_vs_forges_default(gradient_coherence_pass):
    """Deep inside the original mask, alpha is ~1 -- the blend degenerates to
    `current_latent`, which is exactly Forge's own default there (nothing
    left to steer). True on every step and the final call alike, since the
    blend has no sigma term to make that call sigma-dependent."""
    module = gradient_coherence_pass
    p = _fake_p()

    for sigma, is_final in ((10.0, False), (1.0, False), (0.05, False), (0.0, True)):
        mba = _fake_mba(sigma=sigma, is_final_blend=is_final)
        _partial, _outside, deep_inside = _alpha_columns(module, p, mba.init_latent)

        module.GradientCoherencePass().on_mask_blend(p, mba)

        # current_latent is all-ones; alpha itself plateaus at 0.996 (uint8
        # rounding in blur_ring), not exactly 1 -- that's the only gap here.
        value = mba.blended_latent[0, 0, LATENT // 2, deep_inside].item()
        assert value > 0.97


def test_effect_zone_extends_outward_past_the_mask_boundary(gradient_coherence_pass):
    """The dilate+blur alpha must still be nonzero a couple of pixels
    *outside* the mask's original edge (LATENT/2 in latent units) -- the
    opposite of a dilate-minus-erode ring, which would instead erode a band
    *into* the mask's interior and stop exactly at the boundary going
    outward."""
    module = gradient_coherence_pass
    p = _fake_p()
    mba = _fake_mba(sigma=5.0)

    row = module._alpha(p, mba.init_latent)[0, 0, LATENT // 2]
    assert row[LATENT // 2 + 1] > module.ALPHA_EPSILON  # 1px past the mask edge


def test_final_blend_leaves_forges_own_default_outside_the_effect_zone(
    gradient_coherence_pass,
):
    """The final call uses the identical formula as every per-step call --
    including the `torch.where` guard -- so clear of the effect zone it must
    leave whatever Forge's own final blend already computed untouched, the
    same as the per-step case, not force its own alpha blend unconditionally
    there."""
    module = gradient_coherence_pass
    p = _fake_p()
    mba = _fake_mba(sigma=0.0, is_final_blend=True)
    _partial, outside, deep_inside = _alpha_columns(module, p, mba.init_latent)
    forges_default_outside = mba.blended_latent[0, 0, LATENT // 2, outside].item()

    module.GradientCoherencePass().on_mask_blend(p, mba)

    # Deep inside: alpha ~1 -> current_latent (fully regenerated).
    assert mba.blended_latent[0, 0, LATENT // 2, deep_inside].item() > OPAQUE
    # Clear of the effect zone: Forge's own default, left exactly as-is.
    assert (
        mba.blended_latent[0, 0, LATENT // 2, outside].item() == forges_default_outside
    )


def test_alpha_maps_1to1_onto_the_blend_weight_regardless_of_sigma(
    gradient_coherence_pass,
):
    """`init_latent` is 0 and `current_latent` is 1, so the blended value at
    the partial-alpha column *is* the regenerate weight -- it must equal
    `alpha` exactly and stay identical across wildly different sigma (and the
    final call), since the blend has no sigma term to crush or steer it.

    This is the property the sigma-curve version broke: raising a partial
    alpha to a sigma-dependent power crushed anything below ~0.85 toward zero
    at high sigma, so widening `mask_blur`'s ramp added pixels that got
    zeroed out anyway instead of actually widening the visible effect."""
    module = gradient_coherence_pass
    script = module.GradientCoherencePass()

    p = _fake_p()
    high = _fake_mba(sigma=10.0)
    partial, _outside, _deep_inside = _alpha_columns(module, p, high.init_latent)
    alpha_at_partial = module._alpha(p, high.init_latent)[
        0, 0, LATENT // 2, partial
    ].item()

    low = _fake_mba(sigma=0.05)
    final = _fake_mba(sigma=0.0, is_final_blend=True)

    for mba in (high, low, final):
        script.on_mask_blend(p, mba)
        weight = mba.blended_latent[0, 0, LATENT // 2, partial].item()
        assert weight == pytest.approx(alpha_at_partial, abs=1e-4)
