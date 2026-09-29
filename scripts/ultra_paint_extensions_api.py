"""Registers `GET /ultra_paint/api/extensions` (upaint.json extension discovery).

Own `on_app_started` registration, same reasoning as
`scripts/ultra_paint_options_api.py`: keeps this task's changes in a file no
other task touches concurrently. `script_callbacks.on_app_started` supports
multiple independent registrations (each takes a `name=`).
"""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.extensions_api import EXTENSIONS_ROUTE, get_extension_manifests


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(EXTENSIONS_ROUTE, get_extension_manifests, methods=["GET"])


script_callbacks.on_app_started(on_app_started, name="ultra_paint_extensions_api")
