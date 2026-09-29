"""Registers the `/ultra_paint/api/styles` routes (Forge prompt styles)."""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.styles_api import STYLES_ROUTE, delete_style, get_styles, save_style


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(STYLES_ROUTE, get_styles, methods=["GET"])
    app.add_api_route(STYLES_ROUTE, save_style, methods=["PUT"])
    # Style names may contain "/", so the name travels as a query parameter.
    app.add_api_route(STYLES_ROUTE, delete_style, methods=["DELETE"])


script_callbacks.on_app_started(on_app_started, name="ultra_paint_styles_api")
