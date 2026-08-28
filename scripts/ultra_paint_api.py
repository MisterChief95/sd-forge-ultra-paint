"""Serves the Ultra Paint static build and its live generation progress API.

Kept separate from `ultra_paint_tab.py` because it hooks a different callback
(`on_app_started`, which hands us the FastAPI `app` instance) rather than
`on_ui_tabs`. This is also the landing spot for later phases' chattier needs
(e.g. per-layer image extraction for multi-layer ControlNet); for now it hosts
the Vite build alongside the small progress-polling endpoint.
"""

import base64
from io import BytesIO

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from gradio import Blocks

from modules import script_callbacks, shared
from ultra_paint.config import DATA_DIR, FRONTEND_DIST_DIR

PROGRESS_ROUTE = "/ultra_paint/api/progress"


def _current_image_data_url() -> str | None:
    image = shared.state.current_image
    if image is None:
        return None
    buffered = BytesIO()
    image.save(buffered, format="PNG")
    encoded = base64.b64encode(buffered.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def _get_progress() -> dict:
    payload = shared.state.dict()
    payload["current_image"] = _current_image_data_url()
    return payload


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(PROGRESS_ROUTE, _get_progress, methods=["GET"])
    if not FRONTEND_DIST_DIR.is_dir():
        print(
            f"Warning: Ultra Paint frontend build directory is missing: {FRONTEND_DIST_DIR}"
        )
    app.mount(
        "/ultra_paint/app",
        StaticFiles(directory=FRONTEND_DIST_DIR, html=True, check_dir=False),
        name="ultra_paint_app",
    )
    # Serves data/tags.csv (and any other static data files) for the prompt
    # autocomplete feature to fetch directly from the iframe.
    app.mount(
        "/ultra_paint/data",
        StaticFiles(directory=DATA_DIR, check_dir=False),
        name="ultra_paint_data",
    )


script_callbacks.on_app_started(on_app_started, name="ultra_paint_api")
