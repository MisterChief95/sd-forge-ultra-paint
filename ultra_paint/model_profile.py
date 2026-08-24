"""Native/recommended resolution lookup for the loaded Stable Diffusion model.

Forge has no built-in "native resolution" API (verified 2026-08-24 by grepping
`modules/`, `modules_forge/`, `extensions-builtin/` for `native_resolution` /
`recommended_resolution` / `default_res` -- no hits). This module builds one,
keyed on the same signals Forge itself uses to tell architectures apart:
`shared.sd_model.is_sd1` / `.is_sdxl` / `.is_wan` (booleans set per-subclass in
`backend/diffusion_engine/*.py`, default `False` in `base.py:46-48`) plus a
`type(shared.sd_model).__name__` fallback for architectures that set none of
those flags (Flux, Chroma, Lumina2, ...).

Deliberately duck-typed / no `modules.shared` import: `native_resolution_for()`
takes anything with (optionally missing) `is_sd1`/`is_sdxl`/`is_wan` attributes
and a `class_name`, so it is importable and unit-testable without a running
Forge instance. Callers pass `shared.sd_model` (or `type(shared.sd_model)`) at
the call site instead.

`is_wan` is NOT a clean architecture signal by itself -- per the 2026-08-24
research note this table is built from, it really means "WAN-VAE latent
layout" and is reused by non-video image models (Qwen-Image, Krea2), not set
only on the actual video model (Wan 2.1, `wan.py`'s `Wan` class). It is a
decent fallback native-res signal for the image models that happen to share
it, just not an architecture identifier on its own -- don't repurpose it as
one elsewhere.

**Wan (video model) has no resolution entry in this lookup at all** -- Ultra
Paint is an image-editing/img2img tool; Wan 2.1 has no square-1024 native
convention in this fork's own source (`wan.py` derives `h`/`w` purely from
whatever tensor it's given, no hardcoded default) and its public HuggingFace
convention is widescreen video resolution (480p/720p), not a still-image size
-- bucketing it into `HIGH_RES_ARCH_RESOLUTION` would be actively wrong, not
just imprecise. Instead, `is_unsupported_video_model()` below identifies it by
class name so callers (`generation.py`) can reject generation outright with a
clear error, rather than silently proceeding with a wrong resolution guess or
a nonsensical inpaint.

Class names verified against `backend/diffusion_engine/*.py` (2026-08-24):
SD1.x -> `StableDiffusion` (sd15.py); SDXL -> `StableDiffusionXL` /
`StableDiffusionXLRefiner` (sdxl.py), `Mugen` (mugen.py, SDXL-based, also sets
`is_sdxl`, confirmed hardcoded `width/height` default of 1024 at
`mugen.py:75-76`); no dedicated boolean -> `Flux` (flux.py), `Flux2`
(flux2.py), `Chroma` (chroma.py), `Lumina2` (lumina.py), `ErnieImage`
(ernie.py), `PiD` (pid.py), `ZImage` (zimage.py), `Anima` (anima.py, developer
call 2026-08-24: bucket with the other 1024-native architectures despite no
in-source resolution hint -- `anima.py` sets only `use_shift`); `is_wan`-flagged
(fallback only, no class-name match needed) -> `QwenImage` (qwen.py, this
fork's own `qwen.py:95` hardcodes a `1024*1024` VAE-resize target, corroborating
1024 even though Qwen-Image's public docs recommend 1328x1328 -- trusting this
fork's own code over upstream docs), `Krea2` (krea.py, no resolution hint in
source at all, defaulted to 1024 as the least-wrong guess for a modern
high-res architecture).

`shared.sd_model` is never `None` in steady state (backed by `SdModelData`,
`modules/sd_models.py:255-265`, initialized to a `FakeInitialModel()` stub that
has none of `is_sd1`/`is_sdxl`/`is_wan`), but a reload can transiently set it to
`None` (`sd_models.py:340`) or fall back to `FakeInitialModel()` again on load
failure (`sd_models.py:363`). Every attribute read here MUST tolerate both a
`None` model and one missing these attributes entirely -- hence `getattr(...,
False)` throughout rather than assuming any of these attributes exist.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

__all__ = [
    "FALLBACK_RESOLUTION",
    "SD1_RESOLUTION",
    "HIGH_RES_ARCH_RESOLUTION",
    "VIDEO_MODEL_CLASS_NAMES",
    "native_resolution_for",
    "is_unsupported_video_model",
]

# Resolution constants (native/recommended square side, pixels).
SD1_RESOLUTION: int = 512
HIGH_RES_ARCH_RESOLUTION: int = 1024
# Used when the model is unrecognised (no matching flag or class name) or
# missing entirely (no checkpoint loaded yet / mid-reload). Matches SD1's
# resolution as the most conservative (smallest) guess, so an unrecognised
# model never gets over-aggressively upscaled by an inpaint_full_res decision.
FALLBACK_RESOLUTION: int = SD1_RESOLUTION

# Architectures that set no dedicated `is_*` boolean and must be identified by
# `type(shared.sd_model).__name__` alone. All currently resolve to the same
# high-res bucket; kept as an explicit set (not just "else -> 1024") so a
# future architecture with a different native resolution is a one-line diff,
# not a rethink of the fallback branch.
_CLASS_NAME_HIGH_RES: frozenset[str] = frozenset(
    {
        "Flux",
        "Flux2",
        "Chroma",
        "Lumina2",
        "ErnieImage",
        "PiD",
        "ZImage",
        "Anima",
    }
)

# Video architectures with no still-image generation semantics. Ultra Paint is
# strictly an image-editing/img2img tool (developer decision, 2026-08-24) --
# `is_unsupported_video_model()` identifies these by class name so callers
# can reject generation outright with a clear error, rather than silently
# proceeding with a wrong resolution guess or a nonsensical inpaint. Kept as
# its own set (not folded into `native_resolution_for`'s fallback) precisely
# because falling through to a resolution number would look like "supported,
# just unsure of the size" instead of "not supported at all".
VIDEO_MODEL_CLASS_NAMES: frozenset[str] = frozenset({"Wan"})


@runtime_checkable
class ModelLike(Protocol):
    """The minimal shape `native_resolution_for` needs from a model object.

    Every attribute is optional in practice (a bare `FakeInitialModel` stub
    has none of them) -- this Protocol documents the *intended* shape, callers
    must still go through `getattr(..., False)`, not direct attribute access.
    """

    is_sd1: bool
    is_sdxl: bool
    is_wan: bool


@dataclass(frozen=True)
class ModelSignature:
    """Duck-typed snapshot of the flags/class name `native_resolution_for` reads.

    Exists so tests can construct one directly without a `ModelLike`-shaped
    fake object; `native_resolution_for` also accepts a raw model instance and
    builds one of these internally.
    """

    is_sd1: bool = False
    is_sdxl: bool = False
    is_wan: bool = False
    class_name: str = ""


def _signature_of(model: object | None) -> ModelSignature:
    if model is None:
        return ModelSignature()
    return ModelSignature(
        is_sd1=bool(getattr(model, "is_sd1", False)),
        is_sdxl=bool(getattr(model, "is_sdxl", False)),
        is_wan=bool(getattr(model, "is_wan", False)),
        class_name=type(model).__name__,
    )


def native_resolution_for(model: object | None) -> int:
    """Native/recommended square resolution (pixels) for a loaded SD model.

    `model` is normally `modules.shared.sd_model`; pass `None` (or an object
    missing every flag, e.g. a `FakeInitialModel` stub) to get the safe
    fallback. Never raises -- every attribute read is `getattr`-guarded.

    Precedence: `is_sd1` > `is_sdxl` > class-name match (Flux/Chroma/Lumina2/
    ErnieImage/PiD/ZImage) > `is_wan` > fallback. `is_sd1`/`is_sdxl` take
    priority over the class-name set because they are the more deliberate,
    explicitly-set signal; `is_wan` is checked last because (per the module
    docstring) it is the least architecture-specific of the three booleans.
    """
    sig = model if isinstance(model, ModelSignature) else _signature_of(model)

    if sig.is_sd1:
        return SD1_RESOLUTION
    if sig.is_sdxl:
        return HIGH_RES_ARCH_RESOLUTION
    if sig.class_name in _CLASS_NAME_HIGH_RES:
        return HIGH_RES_ARCH_RESOLUTION
    if sig.is_wan:
        return HIGH_RES_ARCH_RESOLUTION
    return FALLBACK_RESOLUTION


def is_unsupported_video_model(model: object | None) -> bool:
    """True if `model` is a video architecture Ultra Paint doesn't support.

    Identified by class name only (`VIDEO_MODEL_CLASS_NAMES`), not `is_wan`
    -- that boolean is shared with supported image models (Qwen-Image,
    Krea2), so it cannot be used to detect Wan specifically. Never raises,
    same `getattr`-guarded contract as `native_resolution_for`. Callers
    (`generation.py`) should check this before generating and raise a clear,
    user-facing error rather than silently proceeding.
    """
    sig = model if isinstance(model, ModelSignature) else _signature_of(model)
    return sig.class_name in VIDEO_MODEL_CLASS_NAMES
