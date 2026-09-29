"""Discover and validate third-party `upaint.json` extension manifests.

See `PLAN.md`'s "Third-party extension manifest schema" entry and
`ultra_paint/schemas/upaint.schema.json` for the manifest contract these
models mirror field-for-field. Field names are camelCase (not this
repo's usual snake_case) because a manifest is a pass-through of an
extension author's on-disk JSON file, served back to the frontend
unchanged over `GET /ultra_paint/api/extensions` -- there is no backend
computation in between that would want Python-idiomatic names.

`modules.extensions` (Forge's own extension registry) is imported lazily
inside `list_extension_manifests`, the same optional-Forge pattern
`ultra_paint/controlnet_units.py` uses for ControlNet, so this module stays
importable -- and unit-testable -- without a running Forge install.
"""

import json
import logging
from pathlib import Path
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

__all__ = [
    "MANIFEST_FILENAME",
    "ExtensionManifest",
    "ExtensionInput",
    "list_extension_manifests",
]

logger = logging.getLogger(__name__)

MANIFEST_FILENAME = "upaint.json"


class _InputBase(BaseModel):
    key: str
    label: str
    info: str | None = None


class NumberInput(_InputBase):
    type: Literal["number"]
    default: float
    min: float | None = None
    max: float | None = None
    step: float | None = None


class TextInput(_InputBase):
    type: Literal["text"]
    default: str
    maxLength: int | None = None
    placeholder: str | None = None


class BooleanInput(_InputBase):
    type: Literal["boolean"]
    default: bool


class SelectOption(BaseModel):
    label: str
    value: str


class SelectInput(_InputBase):
    type: Literal["select"]
    default: str
    options: list[SelectOption]


ExtensionInput = Annotated[
    Union[NumberInput, TextInput, BooleanInput, SelectInput],
    Field(discriminator="type"),
]


class ExtensionManifest(BaseModel):
    id: str
    title: str
    scriptTitle: str
    description: str | None = None
    canEnable: bool
    inputs: list[ExtensionInput] = Field(default_factory=list)


_manifest_adapter = TypeAdapter(ExtensionManifest)


def list_extension_manifests() -> list[ExtensionManifest]:
    """Discover `upaint.json` manifests from every enabled Forge extension.

    Degrades to an empty list rather than raising when Forge's extension
    registry is unavailable (e.g. under pytest), and skips -- logging a
    warning instead of raising -- any single extension whose manifest is
    missing, unreadable, or schema-invalid, so one broken third-party file
    can never break the Generation panel for everyone else.
    """
    try:
        from modules import extensions as forge_extensions
    except ImportError:
        logger.info(
            "Ultra Paint: Forge extensions registry is unavailable; no extension manifests loaded"
        )
        return []

    manifests: list[ExtensionManifest] = []
    for extension in forge_extensions.active():
        manifest = _load_manifest(Path(extension.path) / MANIFEST_FILENAME)
        if manifest is not None:
            manifests.append(manifest)
    return manifests


def _load_manifest(path: Path) -> ExtensionManifest | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        logger.warning(
            "Ultra Paint: could not read extension manifest %s: %s", path, exc
        )
        return None
    try:
        return _manifest_adapter.validate_python(raw)
    except ValidationError as exc:
        logger.warning("Ultra Paint: invalid extension manifest %s: %s", path, exc)
        return None
