"""Registers the "Ultra Paint" top-level tab with the Forge UI.

The tab is an iframe shim: `create_ui()` exposes only a stable Gradio HTML
wrapper, and Forge's extension-JS auto-loader injects the self-contained Ultra
Paint app from `/ultra_paint/app/` into that wrapper.

`on_ui_tabs` contract (modules/script_callbacks.py:473-483): the callback returns
either None or a *list* of `(gradio_component, title, elem_id)` tuples. The
aggregator does `res += c.callback() or []` (script_callbacks.py:283) and the
result is spliced into `interfaces` in modules/ui.py:883, whose entries are
unpacked as `for interface, label, ifid in sorted_interfaces`. Returning a bare
tuple would therefore splice three loose items and break the unpack -- it must
be a list of tuples.
"""

import gradio as gr

from modules import script_callbacks

from ultra_paint.config import eid

TAB_TITLE = "Ultra Paint"
TAB_ELEM_ID = "ultra_paint"

IFRAME_WRAPPER_ELEM_ID = eid("iframe-wrapper")


def create_ui() -> gr.Blocks:
    """Build the minimal iframe mount point for the Ultra Paint tab."""
    with gr.Blocks(analytics_enabled=False) as ultra_paint_interface:
        gr.HTML("", elem_id=IFRAME_WRAPPER_ELEM_ID)

    return ultra_paint_interface


def on_ui_tabs():
    """`on_ui_tabs` callback: a list of (component, title, elem_id) tuples."""
    return [(create_ui(), TAB_TITLE, TAB_ELEM_ID)]


script_callbacks.on_ui_tabs(on_ui_tabs, name="ultra_paint")
