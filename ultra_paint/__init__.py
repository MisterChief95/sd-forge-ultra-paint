"""Ultra Paint - a layer-based painting tab for sd-webui-forge-classic neo."""

from .config import (
    DEFAULT_CANVAS_HEIGHT,
    DEFAULT_CANVAS_WIDTH,
    ELEM_ID_PREFIX,
    EXTENSION_ROOT,
    VERSION,
    eid,
)

__version__ = VERSION

__all__ = [
    "DEFAULT_CANVAS_HEIGHT",
    "DEFAULT_CANVAS_WIDTH",
    "ELEM_ID_PREFIX",
    "EXTENSION_ROOT",
    "VERSION",
    "__version__",
    "eid",
]
