"""Registers the always-mounted Ultra Paint ControlNet catalog routes."""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.controlnet_catalog_api import (
    CONTROLNET_CONTROL_TYPES_ROUTE,
    CONTROLNET_DETECT_ROUTE,
    CONTROLNET_MODEL_LIST_ROUTE,
    CONTROLNET_MODULE_LIST_ROUTE,
    detect_controlnet,
    get_controlnet_control_types,
    get_controlnet_model_list,
    get_controlnet_module_list,
)


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(CONTROLNET_MODEL_LIST_ROUTE, get_controlnet_model_list, methods=["GET"])
    app.add_api_route(CONTROLNET_MODULE_LIST_ROUTE, get_controlnet_module_list, methods=["GET"])
    app.add_api_route(CONTROLNET_CONTROL_TYPES_ROUTE, get_controlnet_control_types, methods=["GET"])
    app.add_api_route(
        CONTROLNET_DETECT_ROUTE,
        detect_controlnet,
        methods=["POST"],
    )


script_callbacks.on_app_started(on_app_started, name="ultra_paint_controlnet_catalog_api")
