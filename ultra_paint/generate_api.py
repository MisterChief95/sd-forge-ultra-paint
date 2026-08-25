"""`POST /ultra_paint/api/generate` -- runs one txt2img/img2img canvas pass.

Phase 2.R replacement for the old two-button Generate handshake
(`ultra_paint/bridge.py`'s hidden `LogicalImage` textbox + `input`-event
dispatch). Now that the frontend is a standalone SPA loaded in its own
`<iframe>` document (not a Gradio component tree), there is no longer a
Gradio-component-shaped way to hand a canvas-composited image to Python --
and no need for one, since a real page can just `fetch()` a real endpoint.

`build_img2img_processing`/`run_generation` in `ultra_paint/generation.py` are
unchanged -- this module is purely the HTTP <-> PIL.Image plumbing plus the
same `queue_lock`/`shared.state.begin`/`main_thread.run_and_wait_result`
sequence the old `_on_generate` click handler used
(`scripts/ultra_paint_tab.py`, pre-Phase-2.R).
"""

import base64
import re
from io import BytesIO
from typing import Literal

from fastapi import HTTPException
from PIL import Image
from pydantic import BaseModel

from modules import call_queue, shared
from modules_forge import main_thread

from ultra_paint.generation import run_generation

__all__ = [
    "GENERATE_ROUTE",
    "ControlLayerRequest",
    "GenerateRequest",
    "GenerateResponse",
    "generate",
]

GENERATE_ROUTE = "/ultra_paint/api/generate"

# Mirrors the `data:image/<type>;base64,<payload>` shape the frontend's
# `Compositor.flattenToDataURL()` (canvas.toDataURL) produces. `re.DOTALL` so
# a base64 payload isn't cut short if it happens to contain a literal
# newline-like byte sequence once decoded... base64 itself never contains
# real newlines, but `.` not matching `\n` by default is a common footgun, so
# it's set explicitly rather than relying on the default.
_DATA_URL_RE = re.compile(
    r"^data:image/(?:png|jpeg|webp);base64,(?P<b64>.+)$", re.DOTALL
)


class ControlLayerRequest(BaseModel):
    """Mirrors the control-layer dict expected by `generation.py`."""

    image: str
    mask_image: str | None = None
    model: str
    preprocessor: str
    preprocessor_resolution: int = -1
    preprocessor_threshold_a: float = -1
    preprocessor_threshold_b: float = -1
    weight: float = 1.0
    guidance_start: float = 0.0
    guidance_end: float = 1.0
    control_mode: str = "balanced"
    pixel_perfect: bool = False
    resize_mode: str = "resize"
    enabled: bool = True


class GenerateRequest(BaseModel):
    composite_image: str
    gen_params: dict = {}
    generation_mode: Literal["img2img", "txt2img"] = "img2img"
    # Optional data:image/...;base64,... URL from the frontend's
    # Compositor.flattenMask() (Phase 3) -- omitted/None when no mask layer
    # has been painted, matching Phase 1/2 behavior exactly (no inpainting).
    mask_image: str | None = None
    control_layers: list[ControlLayerRequest] = []


class GenerateResponse(BaseModel):
    images: list[str]


def _decode_data_url(data_url: str) -> Image.Image:
    match = _DATA_URL_RE.match(data_url.strip())
    if not match:
        raise ValueError("composite_image must be a data:image/...;base64,... URL")
    try:
        raw = base64.b64decode(match.group("b64"), validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("composite_image base64 payload could not be decoded") from exc
    try:
        image = Image.open(BytesIO(raw))
        image.load()
    except Exception as exc:  # PIL raises a mix of exception types for bad image bytes
        raise ValueError("composite_image did not decode to a valid image") from exc
    return image.convert("RGBA")


def _encode_data_url(image: Image.Image) -> str:
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def generate(request: GenerateRequest) -> GenerateResponse:
    """FastAPI route handler for `POST /ultra_paint/api/generate`.

    Runs on the request thread, same as the old Gradio click handler did --
    it does no GPU work itself, only decoding and handing off to Forge's
    single worker thread via `main_thread.run_and_wait_result`.
    """
    try:
        composite_image = _decode_data_url(request.composite_image)
        mask_image = (
            _decode_data_url(request.mask_image) if request.mask_image else None
        )
        control_layers = [
            {
                "image": _decode_data_url(layer.image),
                "mask_image": _decode_data_url(layer.mask_image)
                if layer.mask_image
                else None,
                "model": layer.model,
                "preprocessor": layer.preprocessor,
                "preprocessor_resolution": layer.preprocessor_resolution,
                "preprocessor_threshold_a": layer.preprocessor_threshold_a,
                "preprocessor_threshold_b": layer.preprocessor_threshold_b,
                "weight": layer.weight,
                "guidance_start": layer.guidance_start,
                "guidance_end": layer.guidance_end,
                "control_mode": layer.control_mode,
                "pixel_perfect": layer.pixel_perfect,
                "resize_mode": layer.resize_mode,
                "enabled": layer.enabled,
            }
            for layer in request.control_layers
        ]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # `state.begin`/`state.end` are what make `/ultra_paint/api/progress`
    # report anything, and what lets Interrupt work. `queue_lock` serialises
    # against the stock txt2img/img2img tabs the same way
    # `call_queue.wrap_gradio_gpu_call` does.
    with call_queue.queue_lock:
        shared.state.begin(job="ultra_paint")
        try:
            processed = main_thread.run_and_wait_result(
                run_generation,
                composite_image,
                request.gen_params,
                mask_image,
                request.generation_mode,
                control_layers=control_layers,
            )
        finally:
            shared.state.end()

    if processed is None:
        # `main_thread.Task.work` swallows exceptions and leaves `result` None.
        message = main_thread.last_exception or "unknown error"
        raise HTTPException(
            status_code=500, detail=f"Ultra Paint: generation failed ({message})"
        )

    # Same extraction as modules/img2img.py:287 / the old `_on_generate`.
    # `n_iter == batch_size == 1`, so there is never a grid image to strip.
    images = processed.images + processed.extra_images
    return GenerateResponse(images=[_encode_data_url(image) for image in images])
