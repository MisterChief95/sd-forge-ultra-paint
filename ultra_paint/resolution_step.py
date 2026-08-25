"""Resolution step (pixel grid) lookup for Phase 3's Auto scale mode.

Mirrors a pattern the developer already uses in another extension: Forge has
its own "Resolution Step" setting (`res_step`, `modules/shared_options.py:166`,
default 64, choices 8/16/32/64/128/256) that governs the pixel grid every
width/height should snap to. Reuse it here rather than hardcoding 64, so
Ultra Paint's Auto-scale target respects whatever the user has configured
Forge-wide.

Deliberately duck-typed / no direct `modules.shared` import at call sites
inside this module: `resolution_step_for()` takes an `opts`-like object (only
needs `.data_labels` and `.data`, both dict-like), so it's importable and
unit-testable without a running Forge instance -- same pattern as
`model_profile.py`. Callers pass `modules.shared.opts`.
"""

from __future__ import annotations

__all__ = [
    "DEFAULT_RESOLUTION_STEP",
    "has_resolution_step_setting",
    "resolution_step_for",
]

# Matches `res_step`'s own OptionInfo default (modules/shared_options.py:166)
# and is also the fallback used when the setting isn't registered at all
# (older/customised Forge builds) or holds a non-positive/non-numeric value.
DEFAULT_RESOLUTION_STEP: int = 64


def has_resolution_step_setting(opts: object) -> bool:
    """True if this Forge build registers the `res_step` option at all.

    Checks `opts.data_labels` (the registered `OptionInfo` map), not
    `opts.data` (only overrides a user has actually changed live there) --
    the setting can be registered-but-unchanged, which is the common case.
    """
    return "res_step" in getattr(opts, "data_labels", {})


def _positive_step(value: object, fallback: int = DEFAULT_RESOLUTION_STEP) -> int:
    try:
        step = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return step if step > 0 else fallback


def resolution_step_for(opts: object) -> int:
    """The pixel grid (in px) Auto-scale target dimensions should snap to.

    Reads `opts.data.get("res_step", ...)` when the setting is registered
    (`has_resolution_step_setting`), otherwise (or on a garbage value) falls
    back to `DEFAULT_RESOLUTION_STEP`. Never raises.
    """
    if not has_resolution_step_setting(opts):
        return DEFAULT_RESOLUTION_STEP
    data = getattr(opts, "data", None) or {}
    return _positive_step(data.get("res_step", DEFAULT_RESOLUTION_STEP))
