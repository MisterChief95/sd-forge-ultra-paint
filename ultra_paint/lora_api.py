"""LoRA catalog for the generation settings panel."""

import math
from typing import TypedDict

__all__ = ["LORA_ROUTE", "LoraInfo", "get_loras"]

LORA_ROUTE = "/ultra_paint/api/loras"


class LoraInfo(TypedDict):
    name: str
    prompt_name: str
    activation_text: str
    preferred_weight: float


def _finite_weight(value: object, fallback: float = 1.0) -> float:
    try:
        weight = float(value)
    except (TypeError, ValueError):
        weight = fallback
    if not math.isfinite(weight):
        weight = fallback
    return max(-10.0, min(10.0, weight))


def get_loras() -> list[LoraInfo]:
    """Refresh and return Forge's installed LoRAs.

    Forge exposes its LoRA registry as a top-level ``networks`` module only
    after the built-in extension has loaded, so all Forge imports stay inside
    the handler.
    """
    try:
        import networks
        from modules import extra_networks, shared

        networks.list_available_networks()
        available_networks = networks.available_networks
    except (ImportError, AttributeError):
        return []

    default_weight = _finite_weight(
        getattr(shared.opts, "extra_networks_default_multiplier", 1.0)
    )
    loras: list[LoraInfo] = []

    for lora in available_networks.values():
        metadata = extra_networks.get_user_metadata(lora.filename)
        if not isinstance(metadata, dict):
            metadata = {}
        preferred_weight = metadata.get("preferred weight")
        weight = (
            _finite_weight(preferred_weight, default_weight)
            if _is_finite_nonzero(preferred_weight)
            else default_weight
        )
        activation_text = metadata.get("activation text", "")
        loras.append(
            {
                "name": lora.name,
                "prompt_name": lora.get_alias(),
                "activation_text": activation_text
                if isinstance(activation_text, str)
                else "",
                "preferred_weight": weight,
            }
        )

    return sorted(loras, key=lambda item: item["name"].casefold())


def _is_finite_nonzero(value: object) -> bool:
    try:
        weight = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(weight) and weight != 0
