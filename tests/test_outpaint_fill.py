import sys
import types

import pytest
from PIL import Image

from ultra_paint import outpaint_fill


@pytest.fixture(autouse=True)
def _reset_lama_singleton(monkeypatch):
    # `_lama` is a lazily-created module-level singleton; tests that inject
    # a fake `simple_lama_inpainting` must not see a real/previous instance.
    monkeypatch.setattr(outpaint_fill, "_lama", None)


def _mixed_composite(width=16, height=16) -> Image.Image:
    composite = Image.new("RGBA", (width, height), (255, 0, 0, 255))
    composite.paste((0, 0, 0, 0), (0, 0, width // 2, height))
    return composite


def test_derive_outpaint_mask_thresholds_on_alpha():
    composite = _mixed_composite(16, 10)

    mask = outpaint_fill.derive_outpaint_mask(composite)

    assert mask.mode == "L"
    assert mask.getpixel((0, 0)) == 255  # transparent half -> regenerate
    assert mask.getpixel((15, 0)) == 0  # opaque half -> keep


def test_fill_transparent_region_falls_back_to_cv2_when_lama_unavailable(monkeypatch):
    # A `None` entry makes the import statement raise ImportError, regardless
    # of whether simple-lama-inpainting actually happens to be installed in
    # whatever environment runs this test.
    monkeypatch.setitem(sys.modules, "simple_lama_inpainting", None)
    composite = _mixed_composite()
    mask = outpaint_fill.derive_outpaint_mask(composite)

    result = outpaint_fill.fill_transparent_region(composite, mask)

    assert result.mode == "RGB"
    assert result.size == composite.size


def _install_fake_torch(monkeypatch):
    class _FakeOutOfMemoryError(RuntimeError):
        pass

    class _FakeDevice:
        def __init__(self, device_type):
            self.type = device_type

    class _FakeCuda:
        OutOfMemoryError = _FakeOutOfMemoryError
        empty_cache_calls = 0

        @classmethod
        def empty_cache(cls):
            cls.empty_cache_calls += 1

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = _FakeCuda
    fake_torch.device = _FakeDevice
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    return fake_torch, _FakeDevice


def test_fill_transparent_region_retries_on_cpu_after_gpu_oom(monkeypatch):
    fake_torch, FakeDevice = _install_fake_torch(monkeypatch)
    calls = []

    class _FakeSimpleLama:
        def __init__(self):
            self.device = FakeDevice("cuda")
            self.model = types.SimpleNamespace(to=lambda dev: calls.append(("to", dev)))

        def __call__(self, rgb, mask):
            calls.append(("call", self.device.type))
            if self.device.type == "cuda":
                raise fake_torch.cuda.OutOfMemoryError("CUDA out of memory")
            return rgb

    fake_module = types.ModuleType("simple_lama_inpainting")
    fake_module.SimpleLama = _FakeSimpleLama
    monkeypatch.setitem(sys.modules, "simple_lama_inpainting", fake_module)

    composite = _mixed_composite()
    mask = outpaint_fill.derive_outpaint_mask(composite)

    result = outpaint_fill.fill_transparent_region(composite, mask)

    assert result.size == composite.size
    assert [c[0] for c in calls] == ["call", "to", "call"]
    assert fake_torch.cuda.empty_cache_calls == 1
    # The singleton stays demoted to CPU for the rest of the process --
    # a second fill must not retry the GPU path at all.
    calls.clear()
    outpaint_fill.fill_transparent_region(composite, mask)
    assert [c[0] for c in calls] == ["call"]


def test_fill_transparent_region_crops_padded_lama_result(monkeypatch):
    _install_fake_torch(monkeypatch)

    class _FakeSimpleLama:
        def __init__(self):
            self.device = types.SimpleNamespace(type="cpu")

        def __call__(self, rgb, _mask):
            # Mirrors SimpleLama padding the input up to a multiple of 8 and
            # never cropping the result back down.
            padded = Image.new("RGB", (rgb.width + 3, rgb.height + 5), (1, 2, 3))
            padded.paste(rgb, (0, 0))
            return padded

    fake_module = types.ModuleType("simple_lama_inpainting")
    fake_module.SimpleLama = _FakeSimpleLama
    monkeypatch.setitem(sys.modules, "simple_lama_inpainting", fake_module)

    composite = _mixed_composite(13, 11)
    mask = outpaint_fill.derive_outpaint_mask(composite)

    result = outpaint_fill.fill_transparent_region(composite, mask)

    assert result.size == composite.size
