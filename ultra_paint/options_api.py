"""`GET /ultra_paint/api/options` -- sampler/scheduler choices for the settings panel.

The old Gradio version baked `sd_samplers.visible_samplers()` /
`sd_schedulers.schedulers` into the tab's dropdown `choices=` at server-render
time. Phase 2.R's frontend is a static SPA with no server-side render step, so
it needs a real endpoint to fetch these from instead.

Deliberately NOT reusing Forge's stock `/sdapi/v1/samplers` /
`/sdapi/v1/schedulers` routes (`modules/api/api.py`): those only mount when
the server is launched with `--api` (see `webui.py`'s `launch_api = cmd_opts.api`
gate), which is not guaranteed. This route always mounts, the same way
`ultra_paint/generate_api.py`'s route does.

Phase 3 (2026-08-24): also reports the loaded model's native resolution,
video-model status, and Forge's configured resolution step, so the frontend's
boundary-box "Auto" scale mode (`model_profile.native_resolution_for`,
`resolution_step.resolution_step_for`) doesn't need to duplicate either the
architecture table or the `res_step` setting lookup in TypeScript, and so the
UI can warn about an unsupported (video) model before the developer ever
clicks Generate rather than only finding out from a failed request.
"""

from pydantic import BaseModel

from modules import sd_samplers, sd_schedulers, shared

from ultra_paint.model_profile import is_unsupported_video_model, native_resolution_for
from ultra_paint.resolution_step import resolution_step_for

__all__ = ["OPTIONS_ROUTE", "GenerationOptions", "get_generation_options"]

OPTIONS_ROUTE = "/ultra_paint/api/options"


class GenerationOptions(BaseModel):
    samplers: list[str]
    schedulers: list[str]
    native_resolution: int
    is_video_model: bool
    resolution_step: int


def get_generation_options() -> GenerationOptions:
    return GenerationOptions(
        samplers=[x.name for x in sd_samplers.visible_samplers()],
        schedulers=[x.label for x in sd_schedulers.schedulers],
        native_resolution=native_resolution_for(shared.sd_model),
        is_video_model=is_unsupported_video_model(shared.sd_model),
        resolution_step=resolution_step_for(shared.opts),
    )
