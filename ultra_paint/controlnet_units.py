"""Build and splice optional Forge ControlNet units into a processing object."""

import logging

import numpy as np

__all__ = ["apply_controlnet_units"]

logger = logging.getLogger(__name__)


def apply_controlnet_units(p, control_layers: list[dict]) -> None:
    """Replace the leading ControlNet script slots with Ultra Paint layers.

    ControlNet is a built-in-but-optional Forge extension, so its imports stay
    inside this function and absence never prevents ordinary generation.
    """
    if not control_layers:
        logger.info("Ultra Paint: no ControlNet layers to apply")
        return

    try:
        from lib_controlnet.external_code import ControlMode, ControlNetUnit, ResizeMode
        from modules import shared
    except (ImportError, AttributeError):
        logger.info("Ultra Paint: ControlNet is unavailable; skipping control layers")
        return

    controlnet_script = None
    for script in getattr(getattr(p, "scripts", None), "alwayson_scripts", ()):
        if script.title() == "ControlNet":
            controlnet_script = script
            break
    if controlnet_script is None:
        logger.info("Ultra Paint: ControlNet script is not registered; skipping control layers")
        return

    try:
        options = getattr(getattr(shared, "opts", None), "data", {})
        configured_slots = max(0, int(options.get("control_net_unit_count", 3)))
    except (TypeError, ValueError):
        configured_slots = 3

    slot_count = min(
        configured_slots,
        max(0, controlnet_script.args_to - controlnet_script.args_from),
    )
    if len(control_layers) > slot_count:
        logger.warning(
            "Ultra Paint: dropping %d ControlNet layer(s); only %d unit slot(s) are available",
            len(control_layers) - slot_count,
            slot_count,
        )

    control_modes = {
        "balanced": ControlMode.BALANCED.value,
        "prompt": ControlMode.PROMPT.value,
        "control": ControlMode.CONTROL.value,
    }
    resize_modes = {
        "resize": ResizeMode.RESIZE.value,
        "crop": ResizeMode.INNER_FIT.value,
        "fill": ResizeMode.OUTER_FIT.value,
    }
    units = []
    for layer in control_layers[:slot_count]:
        mask_image = layer["mask_image"]
        mask = None
        if mask_image is not None:
            mask = (
                mask_image.getchannel("A")
                if "A" in mask_image.getbands()
                else mask_image.convert("L")
            )
        units.append(ControlNetUnit(
            enabled=bool(layer["enabled"]),
            module=layer["preprocessor"],
            model=layer["model"],
            weight=float(layer["weight"]),
            image={
                "image": np.array(layer["image"].convert("RGB"), dtype=np.uint8),
                "mask": np.array(mask, dtype=np.uint8) if mask is not None else None,
            },
            resize_mode=resize_modes[layer["resize_mode"]],
            processor_res=int(layer["preprocessor_resolution"]),
            threshold_a=float(layer["preprocessor_threshold_a"]),
            threshold_b=float(layer["preprocessor_threshold_b"]),
            guidance_start=float(layer["guidance_start"]),
            guidance_end=float(layer["guidance_end"]),
            pixel_perfect=bool(layer["pixel_perfect"]),
            control_mode=control_modes[layer["control_mode"]],
            # Forge defaults this True and appends the preprocessor's raw
            # np.ndarray detect-map to `p.extra_result_images`, which
            # generate_api.py otherwise treats as another generated layer
            # to add to the canvas. Ultra Paint has its own "Preview
            # preprocessor" button for this -- it doesn't belong in the
            # generation results.
            save_detected_map=False,
        ))

    start, end = controlnet_script.args_from, controlnet_script.args_to
    script_slots = list(p.script_args[start:end])
    script_slots[:len(units)] = units
    p.script_args[start:end] = script_slots
