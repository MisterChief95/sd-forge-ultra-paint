"""Unit tests for `ultra_paint.model_profile` (Phase 3, T25).

Pure logic, no Forge runtime dependency -- `model_profile.py` is deliberately
duck-typed for exactly this reason (see its module docstring).
"""

import pytest

from ultra_paint.model_profile import (
    FALLBACK_RESOLUTION,
    HIGH_RES_ARCH_RESOLUTION,
    SD1_RESOLUTION,
    ModelSignature,
    is_unsupported_video_model,
    native_resolution_for,
)


def test_sd1_flag_resolves_to_512():
    assert native_resolution_for(ModelSignature(is_sd1=True)) == SD1_RESOLUTION == 512


def test_sdxl_flag_resolves_to_1024():
    assert (
        native_resolution_for(ModelSignature(is_sdxl=True))
        == HIGH_RES_ARCH_RESOLUTION
        == 1024
    )


def test_is_sd1_takes_precedence_over_is_sdxl():
    # Not a real-world combination, but precedence must be deterministic.
    assert (
        native_resolution_for(ModelSignature(is_sd1=True, is_sdxl=True))
        == SD1_RESOLUTION
    )


@pytest.mark.parametrize(
    "class_name",
    ["Flux", "Flux2", "Chroma", "Lumina2", "ErnieImage", "PiD", "ZImage", "Anima"],
)
def test_class_name_only_architectures_resolve_to_1024(class_name):
    assert (
        native_resolution_for(ModelSignature(class_name=class_name))
        == HIGH_RES_ARCH_RESOLUTION
    )


def test_sdxl_flag_takes_precedence_over_unrelated_class_name():
    # Mugen sets is_sdxl=True in the real fork; both paths land on 1024, but
    # the flag path must win so a future divergence doesn't silently flip.
    sig = ModelSignature(is_sdxl=True, class_name="Mugen")
    assert native_resolution_for(sig) == HIGH_RES_ARCH_RESOLUTION


@pytest.mark.parametrize("class_name", ["QwenImage", "Krea2"])
def test_is_wan_flagged_architectures_resolve_to_1024(class_name):
    # Wan itself is deliberately excluded from this parametrization -- it's a
    # video model with no still-image resolution, covered separately below by
    # the is_unsupported_video_model tests, not by native_resolution_for.
    assert (
        native_resolution_for(ModelSignature(is_wan=True, class_name=class_name))
        == HIGH_RES_ARCH_RESOLUTION
    )


def test_class_name_match_takes_precedence_over_is_wan():
    # Belt-and-suspenders: even if a future model sets both, the explicit
    # class-name set should win per native_resolution_for's documented order.
    sig = ModelSignature(is_wan=True, class_name="Chroma")
    assert native_resolution_for(sig) == HIGH_RES_ARCH_RESOLUTION


def test_unrecognised_model_falls_back_to_512():
    assert (
        native_resolution_for(ModelSignature(class_name="SomeFutureArch"))
        == FALLBACK_RESOLUTION
        == 512
    )


def test_none_model_falls_back_to_512():
    assert native_resolution_for(None) == FALLBACK_RESOLUTION


def test_bare_object_missing_every_attribute_falls_back_to_512():
    """Mirrors `FakeInitialModel` -- no is_sd1/is_sdxl/is_wan attributes at all."""

    class BareStub:
        pass

    assert native_resolution_for(BareStub()) == FALLBACK_RESOLUTION


def test_real_model_like_object_with_attributes_is_read_via_getattr():
    class RealisticModel:
        is_sd1 = False
        is_sdxl = True
        is_wan = False

    assert native_resolution_for(RealisticModel()) == HIGH_RES_ARCH_RESOLUTION


def test_native_resolution_for_has_no_special_wan_handling():
    # native_resolution_for does not itself know Wan is unsupported -- Wan
    # sets is_wan=True same as QwenImage/Krea2, so it hits the same generic
    # is_wan fallback branch as those (1024), a number that's meaningless for
    # a video model. This is intentional: rejecting Wan is
    # is_unsupported_video_model()'s job, checked separately and first by
    # callers (generation.py aborts before ever consulting a resolution for
    # a video model) -- this function alone does not block anything.
    sig = ModelSignature(is_wan=True, class_name="Wan")
    assert native_resolution_for(sig) == HIGH_RES_ARCH_RESOLUTION


def test_is_unsupported_video_model_true_for_wan():
    assert (
        is_unsupported_video_model(ModelSignature(is_wan=True, class_name="Wan"))
        is True
    )


@pytest.mark.parametrize(
    "class_name",
    [
        "StableDiffusion",
        "StableDiffusionXL",
        "Flux",
        "Chroma",
        "QwenImage",
        "Anima",
        "Krea2",
    ],
)
def test_is_unsupported_video_model_false_for_image_architectures(class_name):
    assert is_unsupported_video_model(ModelSignature(class_name=class_name)) is False


def test_is_unsupported_video_model_false_for_none():
    assert is_unsupported_video_model(None) is False


def test_is_unsupported_video_model_false_for_bare_object_missing_every_attribute():
    class BareStub:
        pass

    assert is_unsupported_video_model(BareStub()) is False


def test_is_unsupported_video_model_reads_real_model_like_object():
    # type(instance).__name__ == "Wan", matching how the real
    # backend/diffusion_engine/wan.py class is actually named.
    WanModel = type("Wan", (), {"is_sd1": False, "is_sdxl": False, "is_wan": True})
    assert is_unsupported_video_model(WanModel()) is True
