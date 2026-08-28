"""Resolution step (pixel grid) for Phase 3's Auto scale mode.

Deliberately does NOT read Forge's own "Resolution Step" setting (`res_step`,
`modules/shared_options.py:166`, default 64, choices 8/16/32/64/128/256):
that setting only sets the `step=` on Forge's stock txt2img/img2img
width/height sliders (`modules/ui.py:98`), a Gradio UI nicety, not a
processing-time constraint -- Forge never clamps generation width/height to
it. Ultra Paint's frontend bypasses those sliders entirely and posts its own
width/height straight to `generate_api.py`, so honoring a user's `res_step`
here would let an unrelated, possibly-tiny global preference (e.g. 8) quietly
choose this extension's Auto-scale target and land on a resolution the model
generates worse at. Always use the known-good default instead.
"""

from __future__ import annotations

__all__ = ["DEFAULT_RESOLUTION_STEP", "resolution_step_for"]

# Matches `res_step`'s own OptionInfo default (modules/shared_options.py:166).
DEFAULT_RESOLUTION_STEP: int = 64


def resolution_step_for(opts: object) -> int:
    """The pixel grid (in px) Auto-scale target dimensions should snap to.

    `opts` is accepted for call-site compatibility (callers pass
    `modules.shared.opts`) but unused -- see module docstring.
    """
    del opts
    return DEFAULT_RESOLUTION_STEP
