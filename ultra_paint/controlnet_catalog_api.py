"""Always-mounted Ultra Paint catalog and preview routes for optional ControlNet."""

import base64
import logging
import re
from io import BytesIO

import numpy as np
from PIL import Image
from pydantic import BaseModel

__all__ = [
    "CONTROLNET_MODEL_LIST_ROUTE",
    "CONTROLNET_MODULE_LIST_ROUTE",
    "CONTROLNET_CONTROL_TYPES_ROUTE",
    "CONTROLNET_DETECT_ROUTE",
    "ControlNetDetectRequest",
    "ControlNetDetectResponse",
    "get_controlnet_model_list",
    "get_controlnet_module_list",
    "get_controlnet_control_types",
    "detect_controlnet",
]

CONTROLNET_MODEL_LIST_ROUTE = "/ultra_paint/api/controlnet/model_list"
CONTROLNET_MODULE_LIST_ROUTE = "/ultra_paint/api/controlnet/module_list"
CONTROLNET_CONTROL_TYPES_ROUTE = "/ultra_paint/api/controlnet/control_types"
CONTROLNET_DETECT_ROUTE = "/ultra_paint/api/controlnet/detect"

_DATA_URL_RE = re.compile(r"^data:image/(?:png|jpeg|webp);base64,(?P<b64>.+)$", re.DOTALL)
logger = logging.getLogger(__name__)


class ControlNetDetectRequest(BaseModel):
    module: str
    image: str
    resolution: int
    threshold_a: float
    threshold_b: float


class ControlNetDetectResponse(BaseModel):
    image: str | None


def _decode_data_url(data_url: str) -> Image.Image:
    match = _DATA_URL_RE.match(data_url.strip())
    if not match:
        raise ValueError("image must be a data:image/...;base64,... URL")
    raw = base64.b64decode(match.group("b64"), validate=True)
    image = Image.open(BytesIO(raw))
    image.load()
    return image.convert("RGBA")


def _encode_data_url(image: Image.Image) -> str:
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def get_controlnet_model_list() -> dict:
    try:
        from lib_controlnet import global_state

        return {"model_list": list(global_state.get_all_controlnet_names())}
    except (ImportError, AttributeError, TypeError):
        logger.info("Ultra Paint: ControlNet is unavailable; returning an empty model list")
        return {"model_list": []}


def get_controlnet_module_list() -> dict:
    try:
        from lib_controlnet import global_state

        return {"module_list": list(global_state.get_all_preprocessor_names())}
    except (ImportError, AttributeError, TypeError):
        logger.info("Ultra Paint: ControlNet is unavailable; returning an empty module list")
        return {"module_list": []}


def get_controlnet_control_types() -> dict:
    try:
        from lib_controlnet import global_state

        control_types = {
            tag: dict(zip(
                ("module_list", "model_list", "default_option", "default_model"),
                global_state.select_control_type(tag),
            ))
            for tag in global_state.get_all_preprocessor_tags()
        }
        return {"control_types": control_types}
    except (ImportError, AttributeError, TypeError):
        logger.info("Ultra Paint: ControlNet is unavailable; returning empty control types")
        return {"control_types": {}}


def detect_controlnet(request: ControlNetDetectRequest) -> ControlNetDetectResponse:
    try:
        from lib_controlnet import global_state

        processor_module = global_state.get_preprocessor(request.module)
        if processor_module is None:
            return ControlNetDetectResponse(image=None)
        image = _decode_data_url(request.image)
        result = processor_module(
            np.array(image).astype("uint8"),
            resolution=request.resolution,
            slider_1=request.threshold_a,
            slider_2=request.threshold_b,
            json_pose_callback=lambda _json: None,
        )
        if isinstance(result, np.ndarray):
            result = Image.fromarray(result)
        if not isinstance(result, Image.Image):
            return ControlNetDetectResponse(image=None)
        return ControlNetDetectResponse(image=_encode_data_url(result))
    except (ImportError, AttributeError, TypeError, ValueError, OSError):
        logger.info("Ultra Paint: ControlNet preview unavailable; returning null image")
        return ControlNetDetectResponse(image=None)
