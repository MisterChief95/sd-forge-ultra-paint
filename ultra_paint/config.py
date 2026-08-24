"""Shared configuration constants for the Ultra Paint extension.

Kept intentionally tiny: this module must stay import-safe (no gradio, no torch,
no webui imports) so any other module in the extension can pull from it freely.
"""

from pathlib import Path

# .../extensions/sd-forge-ultra-paint/ultra_paint/config.py -> .../sd-forge-ultra-paint
EXTENSION_ROOT: Path = Path(__file__).resolve().parent.parent

# Frontend build output lives here (created by the frontend build task).
FRONTEND_DIR: Path = EXTENSION_ROOT / "frontend"
FRONTEND_DIST_DIR: Path = FRONTEND_DIR / "dist"

# Prefix for every elem_id / DOM id / CSS hook this extension owns.
# Use `eid()` rather than hand-writing f-strings so the namespace stays consistent.
ELEM_ID_PREFIX: str = "upaint"

# Default canvas dimensions (pixels).
DEFAULT_CANVAS_WIDTH: int = 1024
DEFAULT_CANVAS_HEIGHT: int = 1024

VERSION: str = "0.1.0"


def eid(*parts: str) -> str:
    """Build a namespaced elem_id, e.g. eid("root") -> "upaint-root"."""
    return "-".join((ELEM_ID_PREFIX, *parts))
