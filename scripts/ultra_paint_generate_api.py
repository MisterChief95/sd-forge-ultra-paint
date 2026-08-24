"""Registers `POST /ultra_paint/api/generate` (Phase 2.R).

Kept in its own `on_app_started` registration rather than folded into
`ultra_paint_api.py` (which owns the progress-polling route and the static
`dist/` mount, T16) -- purely to keep this task's changes in a file no other
Phase 2.R task touches concurrently. `script_callbacks.on_app_started`
supports multiple independent registrations (each takes a `name=`), the same
way `on_ui_tabs` does, so this is not a workaround, just a deliberate file
split. Fine to merge into `ultra_paint_api.py` later if wanted -- not required.
"""

from fastapi import FastAPI
from gradio import Blocks

from modules import script_callbacks

from ultra_paint.generate_api import GENERATE_ROUTE, generate


def on_app_started(_demo: Blocks | None, app: FastAPI) -> None:
    app.add_api_route(GENERATE_ROUTE, generate, methods=["POST"])


script_callbacks.on_app_started(on_app_started, name="ultra_paint_generate_api")
