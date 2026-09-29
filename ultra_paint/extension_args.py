"""Splice validated extension manifest values into Forge script_args.

Generalizes `ultra_paint/controlnet_units.py`'s ControlNet-specific splicing
to arbitrary `alwayson_scripts` extensions described by a `upaint.json`
manifest (see `ultra_paint/extension_manifest.py`): find the extension's
registered script by `title()`, then write its enabled flag (when
`canEnable`) plus its declared inputs, in manifest order, into that script's
`script_args` slot range -- the same `args_from`/`args_to` slice-assignment
`apply_controlnet_units` uses.
"""

import logging

from ultra_paint.extension_manifest import ExtensionManifest

__all__ = ["apply_extension_args"]

logger = logging.getLogger(__name__)


def apply_extension_args(
    p,
    manifests: list[ExtensionManifest],
    extension_values: dict[str, dict],
) -> None:
    """Write per-extension UI values into their alwayson script's args slots.

    `extension_values` is keyed by manifest id, e.g.
    `{"sd-forge-nag": {"enabled": True, "scale": 5.0, ...}}` -- the shape the
    frontend's extension section emits. A manifest with no entry in
    `extension_values`, or whose `scriptTitle` matches no currently
    registered `alwayson_scripts` entry, is left untouched rather than
    raising -- one uninstalled/renamed extension must never break generation
    for everyone else.
    """
    if not manifests or not extension_values:
        return

    scripts_by_title = {
        script.title(): script
        for script in getattr(getattr(p, "scripts", None), "alwayson_scripts", ())
    }

    for manifest in manifests:
        values = extension_values.get(manifest.id)
        if values is None:
            continue

        script = scripts_by_title.get(manifest.scriptTitle)
        if script is None:
            logger.info(
                "Ultra Paint: extension script %r is not registered; skipping %s",
                manifest.scriptTitle,
                manifest.id,
            )
            continue

        ordered = [
            values.get(input_spec.key, input_spec.default)
            for input_spec in manifest.inputs
        ]
        if manifest.canEnable:
            ordered = [bool(values.get("enabled", False)), *ordered]

        start, end = script.args_from, script.args_to
        slot_count = max(0, end - start)
        if len(ordered) > slot_count:
            logger.warning(
                "Ultra Paint: %s declares %d value(s) but %r only has %d script_args slot(s); truncating",
                manifest.id,
                len(ordered),
                manifest.scriptTitle,
                slot_count,
            )
            ordered = ordered[:slot_count]

        script_slots = list(p.script_args[start:end])
        script_slots[: len(ordered)] = ordered
        p.script_args[start:end] = script_slots
