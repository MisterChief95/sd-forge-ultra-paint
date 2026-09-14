"""Single-slot crash/reload autosave storage and FastAPI handlers."""

import json
import os
import re
import shutil
import uuid
from json import JSONDecodeError
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import HTTPException, Request, Response
from fastapi.responses import FileResponse

from ultra_paint.config import DATA_DIR

__all__ = [
    "AUTOSAVE_CHECKPOINT_ROUTE",
    "AUTOSAVE_CURRENT_ROUTE",
    "AUTOSAVE_ROUTE",
    "get_autosave_asset",
    "get_autosave_current",
    "get_autosave_manifest",
    "prune_autosave_checkpoints",
    "save_autosave",
]

AUTOSAVE_ROUTE = "/ultra_paint/api/autosave"
AUTOSAVE_CURRENT_ROUTE = f"{AUTOSAVE_ROUTE}/current"
AUTOSAVE_CHECKPOINT_ROUTE = f"{AUTOSAVE_ROUTE}/checkpoints/{{checkpoint_id}}"
AUTOSAVE_DIR = DATA_DIR / "autosave"

MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_TILE_COUNT = 4096
MAX_TILE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_UPLOAD_BYTES = 512 * 1024 * 1024
MAX_TILE_SIZE = 8192
_MAX_MULTIPART_OVERHEAD = MAX_MANIFEST_BYTES + MAX_TILE_COUNT * 1024
_CHECKPOINT_ID = re.compile(r"[0-9a-f]{32}")
_ASSET_PATH = re.compile(r"pixels/[0-9]+\.png")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_AUTOSAVE_LOCK = Lock()


def _current_file() -> Path:
    return AUTOSAVE_DIR / "current.json"


def _checkpoints_dir() -> Path:
    return AUTOSAVE_DIR / "checkpoints"


def _read_current_id() -> str | None:
    try:
        value = json.loads(_current_file().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, JSONDecodeError):
        return None
    checkpoint_id = value.get("checkpointId") if isinstance(value, dict) else None
    return (
        checkpoint_id
        if isinstance(checkpoint_id, str) and _CHECKPOINT_ID.fullmatch(checkpoint_id)
        else None
    )


def prune_autosave_checkpoints() -> None:
    """Remove crash-interrupted checkpoint directories on backend startup."""

    with _AUTOSAVE_LOCK:
        current_id = _read_current_id()
        checkpoints = _checkpoints_dir()
        if checkpoints.is_dir():
            for child in checkpoints.iterdir():
                if child.is_dir() and child.name != current_id:
                    shutil.rmtree(child, ignore_errors=True)
        if (
            current_id is None
            or not (checkpoints / current_id / "manifest.json").is_file()
        ):
            _current_file().unlink(missing_ok=True)
            if current_id is not None:
                shutil.rmtree(checkpoints / current_id, ignore_errors=True)


def _asset_tile_sizes(manifest: Any) -> dict[str, int]:
    if not isinstance(manifest, dict):
        raise HTTPException(
            status_code=400, detail="Autosave manifest must be a JSON object."
        )
    if (
        manifest.get("format") != "ultra-paint-project"
        or manifest.get("formatVersion") != 1
        or not isinstance(manifest.get("createdWith"), str)
    ):
        raise HTTPException(
            status_code=400, detail="Autosave manifest has an unsupported format."
        )
    document = manifest.get("document")
    assets = manifest.get("pixelAssets")
    if not isinstance(document, dict) or not isinstance(document.get("layers"), list):
        raise HTTPException(
            status_code=400, detail="Autosave manifest has an invalid document."
        )
    if not isinstance(assets, list):
        raise HTTPException(
            status_code=400, detail="Autosave manifest has no pixel asset list."
        )
    if len(assets) > MAX_TILE_COUNT:
        raise HTTPException(
            status_code=413, detail="Autosave contains too many pixel tiles."
        )

    layer_tile_sizes: dict[str, int] = {}
    for layer in document["layers"]:
        if not isinstance(layer, dict) or layer.get("kind") == "group":
            continue
        layer_id = layer.get("id")
        image = layer.get("image")
        tile_size = image.get("tileSize") if isinstance(image, dict) else None
        if (
            not isinstance(layer_id, str)
            or isinstance(tile_size, bool)
            or not isinstance(tile_size, int)
            or not 1 <= tile_size <= MAX_TILE_SIZE
            or layer_id in layer_tile_sizes
        ):
            raise HTTPException(
                status_code=400, detail="Autosave manifest has invalid tile metadata."
            )
        layer_tile_sizes[layer_id] = tile_size

    result: dict[str, int] = {}
    for asset in assets:
        if not isinstance(asset, dict):
            raise HTTPException(
                status_code=400, detail="Autosave has invalid pixel asset metadata."
            )
        layer_id = asset.get("layerId")
        path = asset.get("path")
        tile_x = asset.get("tileX")
        tile_y = asset.get("tileY")
        tile_size = (
            layer_tile_sizes.get(layer_id) if isinstance(layer_id, str) else None
        )
        if (
            tile_size is None
            or not isinstance(path, str)
            or not _ASSET_PATH.fullmatch(path)
            or path in result
            or isinstance(tile_x, bool)
            or isinstance(tile_y, bool)
            or not isinstance(tile_x, int)
            or not isinstance(tile_y, int)
            or abs(tile_x) > (2**53 - 1) // tile_size
            or abs(tile_y) > (2**53 - 1) // tile_size
        ):
            raise HTTPException(
                status_code=400, detail="Autosave has invalid pixel asset metadata."
            )
        result[path] = tile_size
    return result


def _validate_png(data: bytes, tile_size: int, path: str) -> None:
    if len(data) > MAX_TILE_BYTES:
        raise HTTPException(
            status_code=413, detail=f'Pixel tile "{path}" is too large.'
        )
    if (
        len(data) < 24
        or data[:8] != _PNG_SIGNATURE
        or data[8:12] != b"\x00\x00\x00\r"
        or data[12:16] != b"IHDR"
        or int.from_bytes(data[16:20], "big") != tile_size
        or int.from_bytes(data[20:24], "big") != tile_size
    ):
        raise HTTPException(
            status_code=400,
            detail=f'Pixel tile "{path}" is not a {tile_size}x{tile_size} PNG.',
        )


def _commit_checkpoint(manifest_bytes: bytes, pixels: dict[str, bytes]) -> str:
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, JSONDecodeError):
        raise HTTPException(
            status_code=400, detail="Autosave manifest is not valid JSON."
        )
    expected = _asset_tile_sizes(manifest)
    if set(pixels) != set(expected):
        raise HTTPException(
            status_code=400, detail="Autosave pixel files do not match its manifest."
        )
    for path, data in pixels.items():
        _validate_png(data, expected[path], path)

    checkpoint_id = uuid.uuid4().hex
    checkpoint_dir = _checkpoints_dir() / checkpoint_id
    old_id: str | None = None
    committed = False
    with _AUTOSAVE_LOCK:
        old_id = _read_current_id()
        checkpoint_dir.mkdir(parents=True)
        try:
            (checkpoint_dir / "pixels").mkdir()
            (checkpoint_dir / "manifest.json").write_bytes(manifest_bytes)
            for path, data in pixels.items():
                (checkpoint_dir / path).write_bytes(data)

            pointer_tmp = AUTOSAVE_DIR / "current.tmp"
            pointer_tmp.write_text(
                json.dumps({"checkpointId": checkpoint_id}, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(pointer_tmp, _current_file())
            committed = True
        finally:
            (AUTOSAVE_DIR / "current.tmp").unlink(missing_ok=True)
            if not committed:
                shutil.rmtree(checkpoint_dir, ignore_errors=True)

        if old_id is not None and old_id != checkpoint_id:
            shutil.rmtree(_checkpoints_dir() / old_id, ignore_errors=True)
    return checkpoint_id


async def _read_limited(upload: Any, limit: int, detail: str) -> bytes:
    data = await upload.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=detail)
    return data


async def save_autosave(request: Request) -> dict[str, str]:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_TOTAL_UPLOAD_BYTES + _MAX_MULTIPART_OVERHEAD:
                raise HTTPException(
                    status_code=413, detail="Autosave upload is too large."
                )
        except ValueError:
            raise HTTPException(
                status_code=400, detail="Invalid Content-Length header."
            )

    try:
        form = await request.form(max_files=MAX_TILE_COUNT + 1, max_fields=0)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=400, detail=f"Invalid autosave multipart upload: {error}"
        )

    manifest_upload = form.get("manifest")
    if manifest_upload is None or not hasattr(manifest_upload, "read"):
        raise HTTPException(
            status_code=400, detail="Autosave upload is missing manifest.json."
        )
    manifest_bytes = await _read_limited(
        manifest_upload, MAX_MANIFEST_BYTES, "Autosave manifest is too large."
    )

    pixels: dict[str, bytes] = {}
    total_bytes = len(manifest_bytes)
    for key, upload in form.multi_items():
        if key == "manifest":
            continue
        if (
            not _ASSET_PATH.fullmatch(key)
            or not hasattr(upload, "read")
            or key in pixels
        ):
            raise HTTPException(
                status_code=400, detail="Autosave upload has an invalid pixel file."
            )
        data = await _read_limited(
            upload, MAX_TILE_BYTES, f'Pixel tile "{key}" is too large.'
        )
        total_bytes += len(data)
        if total_bytes > MAX_TOTAL_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413, detail="Autosave pixel upload is too large."
            )
        pixels[key] = data

    return {"checkpointId": _commit_checkpoint(manifest_bytes, pixels)}


def get_autosave_current() -> dict[str, str] | Response:
    with _AUTOSAVE_LOCK:
        checkpoint_id = _read_current_id()
        if checkpoint_id is None:
            return Response(status_code=204)
        return {"checkpointId": checkpoint_id}


def _checkpoint_path(checkpoint_id: str) -> Path:
    if not _CHECKPOINT_ID.fullmatch(checkpoint_id):
        raise HTTPException(status_code=404, detail="Autosave checkpoint not found.")
    path = _checkpoints_dir() / checkpoint_id
    if checkpoint_id != _read_current_id() or not path.is_dir():
        raise HTTPException(status_code=404, detail="Autosave checkpoint not found.")
    return path


def get_autosave_manifest(checkpoint_id: str) -> FileResponse:
    path = _checkpoint_path(checkpoint_id) / "manifest.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Autosave manifest not found.")
    return FileResponse(path, media_type="application/json")


def get_autosave_asset(checkpoint_id: str, asset_path: str) -> FileResponse:
    if not _ASSET_PATH.fullmatch(asset_path):
        raise HTTPException(status_code=404, detail="Autosave pixel tile not found.")
    path = _checkpoint_path(checkpoint_id) / asset_path
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Autosave pixel tile not found.")
    return FileResponse(path, media_type="image/png")
