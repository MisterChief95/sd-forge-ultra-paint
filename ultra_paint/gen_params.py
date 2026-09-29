"""Typed `gen_params` wire contract for `POST /ultra_paint/api/generate`.

Kept free of Forge imports so the request model -- and the OpenAPI schema
FastAPI derives from it -- can be imported by any backend and by tests
without a running WebUI. Field semantics are documented in the `gen_params`
table of `ultra_paint/generation.py`, which reads these values back through
`GEN_PARAM_DEFAULTS`.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

__all__ = ["GenParams"]


class GenParams(BaseModel):
    # Unknown keys are a frontend/backend drift bug, not something to ignore.
    model_config = ConfigDict(extra="forbid")

    prompt: str = ""
    negative_prompt: str = ""
    styles: list[str] = []
    steps: int = 20
    cfg_scale: float = 7.0
    distilled_cfg_scale: float = 3.5
    denoising_strength: float = 0.75
    sampler_name: str | None = None
    scheduler: str | None = None
    seed: int = -1
    subseed: int = -1
    subseed_strength: float = 0.0
    resize_mode: int = 0
    override_settings: dict = {}
    inpainting_fill: int = 1
    inpaint_full_res: bool = False
    inpaint_full_res_padding: int = 32
    mask_blur: int = 4
    inpainting_mask_invert: int = 0
    soft_inpainting_enabled: bool = False
    inpaint_controlnet_enabled: bool = False
    inpaint_controlnet_model: str = ""
    inpaint_controlnet_weight: float = 1.0
    coherence_pass_enabled: bool = False
    coherence_edge_size: int = 32
    coherence_algorithm: Literal["ring", "gradient"] = "gradient"
    soft_inpainting_power: float = 1
    soft_inpainting_scale: float = 0.5
    soft_inpainting_detail_preservation: float = 4
    soft_inpainting_mask_influence: float = 0
    soft_inpainting_difference_threshold: float = 0.5
    soft_inpainting_difference_contrast: float = 2
    target_width: int | None = None
    target_height: int | None = None
    upscaler_name: str | None = None
    # Checkpoint / VAE+text-encoder selection; `None` leaves Forge's current
    # selection untouched (`generation._apply_model_selection`).
    model: str | None = None
    modules: list[str] | None = None

    @model_validator(mode="before")
    @classmethod
    def _null_means_default(cls, data):
        # An explicit `null` (e.g. `JSON.stringify(NaN)`) means "use the
        # default", matching `generation._get`, instead of a 422.
        if not isinstance(data, dict):
            return data
        return {
            key: value
            for key, value in data.items()
            if value is not None
            or key not in cls.model_fields
            or cls.model_fields[key].default is None
        }
