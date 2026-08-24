"""Registers `POST /ultra_paint/api/interrupt` (Phase 3, T41).

Own file, same convention `ultra_paint_generate_api.py` documents: keeps this
task's changes out of files other concurrent work touches.
"""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.interrupt_api import INTERRUPT_ROUTE, interrupt_generation


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(INTERRUPT_ROUTE, interrupt_generation, methods=["POST"])


script_callbacks.on_app_started(on_app_started, name="ultra_paint_interrupt_api")
