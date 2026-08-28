"""Persist the Generation panel's small JSON settings snapshot."""

import json
import os
from json import JSONDecodeError
from threading import Lock
from typing import Any

from fastapi import HTTPException, Response

from ultra_paint.config import DATA_DIR

__all__ = [
    "SETTINGS_ROUTE",
    "get_generation_settings",
    "save_generation_settings",
]

SETTINGS_ROUTE = "/ultra_paint/api/settings"
SETTINGS_FILE = DATA_DIR / "generation-settings.json"
MAX_SETTINGS_BYTES = 1024 * 1024
_SETTINGS_LOCK = Lock()


def get_generation_settings() -> dict[str, Any]:
    with _SETTINGS_LOCK:
        try:
            value = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, JSONDecodeError):
            return {}
    return value if isinstance(value, dict) else {}


def save_generation_settings(settings: dict[str, Any]) -> Response:
    encoded = json.dumps(settings, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_SETTINGS_BYTES:
        raise HTTPException(status_code=413, detail="Generation settings are too large.")

    with _SETTINGS_LOCK:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS_FILE.with_suffix(".tmp")
        try:
            temporary.write_text(encoded, encoding="utf-8")
            os.replace(temporary, SETTINGS_FILE)
        finally:
            temporary.unlink(missing_ok=True)
    return Response(status_code=204)
