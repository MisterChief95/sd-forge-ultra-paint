"""`POST /ultra_paint/api/save` -- saves a flattened canvas through Forge."""

import base64
import os
import re
from io import BytesIO

from fastapi import HTTPException
from PIL import Image
from pydantic import BaseModel

import modules.images
from modules import shared

__all__ = ["SAVE_ROUTE", "SaveRequest", "SaveResponse", "save"]

SAVE_ROUTE = "/ultra_paint/api/save"

_DATA_URL_RE = re.compile(r"^data:image/png;base64,(?P<b64>.+)$", re.DOTALL)


class SaveRequest(BaseModel):
    image: str


class SaveResponse(BaseModel):
    path: str


def _decode_data_url(data_url: str) -> Image.Image:
    match = _DATA_URL_RE.match(data_url.strip())
    if not match:
        raise ValueError("image must be a data:image/png;base64,... URL")
    try:
        raw = base64.b64decode(match.group("b64"), validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("image base64 payload could not be decoded") from exc
    try:
        image = Image.open(BytesIO(raw))
        image.load()
    except Exception as exc:
        raise ValueError("image did not decode to a valid PNG") from exc
    return image.convert("RGBA")


def save(request: SaveRequest) -> SaveResponse:
    try:
        image = _decode_data_url(request.image)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    path = shared.opts.outdir_save
    extension = shared.opts.samples_format
    save_to_dirs = shared.opts.use_save_to_dirs_for_ui
    os.makedirs(shared.opts.outdir_save, exist_ok=True)
    fullfn, _ = modules.images.save_image(
        image,
        path,
        "",
        seed=None,
        prompt=None,
        extension=extension,
        info=None,
        grid=False,
        p=None,
        save_to_dirs=save_to_dirs,
    )
    return SaveResponse(path=str(fullfn))
