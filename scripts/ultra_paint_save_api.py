"""Registers `POST /ultra_paint/api/save`."""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.save_api import SAVE_ROUTE, save


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(SAVE_ROUTE, save, methods=["POST"])


script_callbacks.on_app_started(on_app_started, name="ultra_paint_save_api")
