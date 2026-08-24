# sd-forge-ultra-paint

Ultra Paint adds a layer-based painting tab to Forge, built on PixiJS v8, similar to
InvokeAI's canvas. The goal is a proper multi-layer paint surface living inside the
WebUI — paint, mask and reference layers composited on a GPU-accelerated canvas, then
handed to the existing Forge generation pipeline without round-tripping through
separate img2img/inpaint tabs.

Status: **skeleton**. The tab currently registers itself and renders a placeholder
mount point (`#upaint-root`); the canvas, image bridge and generation wiring land in
follow-up work.

## Installation

Drop this directory into `extensions/` of a `sd-webui-forge-classic` install and
restart the WebUI. The "Ultra Paint" tab appears alongside txt2img/img2img.

## Layout

| Path                        | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `scripts/ultra_paint_tab.py`| Registers the tab via `script_callbacks.on_ui_tabs`         |
| `ultra_paint/`              | Importable Python package — shared config and, later, logic |
| `style.css`                 | Auto-injected by Forge for every active extension           |
| `frontend/`                 | PixiJS frontend sources and build (see below)               |

## Development

The frontend source and its build pipeline live in `frontend/`, which is added by a
separate task — see that directory's own README for build commands once it exists.
Build output (`frontend/dist/`) and `frontend/node_modules/` are gitignored.

The Python side needs no build step; restart the WebUI (or use the Extensions tab's
reload) to pick up changes.

## License

AGPL-3.0, matching the parent repository.
