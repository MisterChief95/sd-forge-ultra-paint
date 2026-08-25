"""Registers `GET /ultra_paint/api/options` (Phase 2.R).

Own `on_app_started` registration, same reasoning as
`scripts/ultra_paint_generate_api.py`: keeps this task's changes in a file no
other Phase 2.R task touches concurrently. `script_callbacks.on_app_started`
supports multiple independent registrations (each takes a `name=`).
"""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.lora_api import LORA_ROUTE, get_loras
from ultra_paint.options_api import OPTIONS_ROUTE, get_generation_options


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(OPTIONS_ROUTE, get_generation_options, methods=["GET"])
    app.add_api_route(LORA_ROUTE, get_loras, methods=["GET"])


script_callbacks.on_app_started(on_app_started, name="ultra_paint_options_api")
