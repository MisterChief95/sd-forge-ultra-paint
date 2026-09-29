"""`GET /ultra_paint/api/extensions` -- discovered third-party extension manifests.

Thin handler over `ultra_paint/extension_manifest.py`'s discovery/validation
logic, following the same split as `ultra_paint/options_api.py`: the
Pydantic model and real logic live in `ultra_paint/`, route registration
stays in `scripts/`.
"""

from ultra_paint.extension_manifest import ExtensionManifest, list_extension_manifests

__all__ = ["EXTENSIONS_ROUTE", "get_extension_manifests"]

EXTENSIONS_ROUTE = "/ultra_paint/api/extensions"


def get_extension_manifests() -> list[ExtensionManifest]:
    return list_extension_manifests()
