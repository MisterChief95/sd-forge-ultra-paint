"""Registers the backend-backed single-slot document autosave routes."""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.autosave_api import (
    AUTOSAVE_CHECKPOINT_ROUTE,
    AUTOSAVE_CURRENT_ROUTE,
    AUTOSAVE_ROUTE,
    get_autosave_asset,
    get_autosave_current,
    get_autosave_manifest,
    prune_autosave_checkpoints,
    save_autosave,
)


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    prune_autosave_checkpoints()
    app.add_api_route(AUTOSAVE_ROUTE, save_autosave, methods=["POST"])
    app.add_api_route(
        AUTOSAVE_CURRENT_ROUTE,
        get_autosave_current,
        methods=["GET"],
        response_model=None,
    )
    app.add_api_route(
        f"{AUTOSAVE_CHECKPOINT_ROUTE}/manifest",
        get_autosave_manifest,
        methods=["GET"],
    )
    app.add_api_route(
        f"{AUTOSAVE_CHECKPOINT_ROUTE}/{{asset_path:path}}",
        get_autosave_asset,
        methods=["GET"],
    )


script_callbacks.on_app_started(on_app_started, name="ultra_paint_autosave_api")
