# Forge Neo UltraPaint

<p align="center">
  <img src="https://img.shields.io/badge/powered%20by-Codex-080808" alt="Powered by Codex" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/powered%20by-Claude-da7756" alt="Powered by Claude" />
</p>

Ultra Paint is a work-in-progress extension that adds a layer-based painting tab to Forge Neo,
similar to InvokeAI's canvas. Uses PixiJS v8 for GPU-accelerated multi-layer paint surfaces -
paint, mask and ControlNet layers - wired directly into Forge's existing generation pipelines.

<img width="1740" height="919" alt="image" src="https://github.com/user-attachments/assets/e564ad75-18ff-4c07-a8a9-4f6f83ea202b" />

**Status: actively developed, work-in-progress.** The tab is a standalone Svelte 5 + PixiJS v8 SPA,
served by the extension's own FastAPI routes and mounted into the Gradio page via an
`<iframe>`. Layer painting, undo/redo, an InvokeAI-style boundary box, mask and
ControlNet layers, an infinite tile-backed canvas, auto-scale-to-native-resolution,
LaMA-backed auto-outpainting, a coherence pass, and real img2img/inpaint/txt2img
generation are all implemented and build-verified; see [`PLAN.md`](PLAN.md) for the
authoritative, continuously-updated status and roadmap.

## Features

- **Layer-based canvas**: raster, group, mask, and ControlNet layers with blend
  modes, opacity, drag-to-reorder, rename, and a context menu (copy, duplicate,
  convert between layer kinds) — rendered on a PixiJS v8 scene graph.
- **Infinite tile-backed canvas**: raster/mask/control surfaces are stored as a
  GPU tile grid (not one monolithic texture), so upload, paint, fill, clip,
  transform, merge, mask/control conversion, and flatten-for-save/generate all
  work tile-by-tile with automatic viewport culling of off-screen tiles.
- **Paint tools**: brush and eraser with radius/hardness/opacity, pressure
  sensitivity, consistent per-stroke opacity build-up, and tile-native strokes
  that grow a layer's tile grid on demand as the stroke crosses its edge.
- **Mask layers**: paint a mask directly on the canvas with a live hatch-pattern
  preview; flattened and sent to Forge's inpainting pipeline at generate time.
  Coherence Pass (gradient blend by default, or the original ring re-sample) and
  Forge-native Soft Inpainting are both supported, mutually exclusive, and kept
  calibrated in output pixels across resolution scaling.
- **Outpainting**: when the boundary box extends past painted content, the
  empty region is auto-detected and seeded with a content-aware fill (LaMA when
  installed, GPU-first with CPU fallback; OpenCV fast-marching inpaint
  otherwise) before generation, unioned with any hand-painted mask.
- **ControlNet integration**: any layer can be assigned to a ControlNet unit,
  with luminance-to-alpha display treatment, a live model/module/control-type
  catalog, and preprocessor preview — degrades gracefully when ControlNet isn't
  installed.
- **Boundary box**: an interactive, draggable/resizable operating region (like
  InvokeAI's canvas bounds) that scopes Fill, Generate export, and new blank
  layers.
- **Layer transforms**: move, center-rotate, corner-scale (free or
  Shift-constrained), and mirror one selected layer through an undoable,
  grid-snapping canvas gizmo without rewriting tiled pixels.
- **Generation panel**: model, VAE/text-encoder, and LoRA selection, prompt/negative
  prompt with tag autocompletion, keyboard attention-weight adjustment
  (Ctrl+Up/Down), and auto-formatting of comma/whitespace spacing,
  sampler/scheduler (pulled live from Forge), steps/CFG/denoise, a frontend
  FIFO queue, in-button progress with a live preview image, current/remaining/all
  cancellation through Forge's interrupt mechanism, and server-persisted
  generation-panel settings.
- **Undo/redo**: bounded history covering pixel edits and layer/document state
  changes.
- **Viewport controls**: zoom reset, fit-to-boundary-box, and a pixel-grid toggle
  with zoom-tiered spacing.

## Roadmap

Painting tools, the Svelte/iframe shell, the boundary box, Playwright e2e
coverage, masking/inpainting, outpainting, the infinite tile-backed canvas,
ControlNet/LoRA integration, auto-scale to native resolution,
generation-panel persistence, and prompt-tag autocomplete have all
substantially landed; see `PLAN.md` for the current sub-feature breakdown.
Ahead:

- **Multi-layer ControlNet refinements**: the single-unit-per-layer path is
  implemented; multi-unit stacking and richer preprocessor controls remain.
- **Selection and shape tools**: the first single-layer transform gizmo has
  landed; multi-selection pivots, marquee/lasso selection tools, a gradient
  (fill) tool, and basic vector shape tools remain.
- **Document persistence**: save/load the actual canvas (layers, pixels,
  boundary box, masks) as a project file, not just generation settings.
- **Planned**: a pre-built single-page app bundle installed on extension load
  (no manual `npm run build` step), and registering other extensions'
  controls in the generation panel.
- Known gaps: a clean clone has no `data/tags.csv` or `data/generation-settings.json`
  (`/data/` is gitignored) so autocomplete and settings persistence start empty until
  first configured; generations are pinned to one image per Generate click; no run
  so far has exercised a real Forge server, so "build/typecheck-verified" work
  throughout the project still awaits live confirmation.

`PLAN.md` is the living, continuously-updated source of truth for status,
task breakdowns, and architecture decisions — read it before making changes.

## Installation

Drop this directory into `extensions/` of a `sd-webui-forge-classic` install, then
build the frontend once (see below) and restart the WebUI. The "Ultra Paint" tab
appears alongside txt2img/img2img.

## Layout

| Path                  | Purpose                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `scripts/`            | Forge callback registrations (tab shell, static mount, each API route, and the coherence-pass Forge scripts)   |
| `ultra_paint/`        | Importable Python package — config, generation pipeline, API request/response models, model/resolution/mask lookups |
| `javascript/`         | Auto-injected JS that mounts the SPA's `<iframe>` into the Gradio tab                                          |
| `frontend/`           | Svelte 5 + PixiJS v8 + Vite SPA source, built to `frontend/dist/` (see below)                                  |
| `tests/`              | Python tests (pytest) for the API routes and generation pipeline                                               |
| `frontend/tests/e2e/` | Playwright end-to-end tests against a real browser                                                             |
| `PLAN.md`             | Living plan/status document — the source of truth for what's implemented                                       |

### Scripts and routes

| File                                          | Registers                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scripts/ultra_paint_tab.py`                   | `on_ui_tabs` — a near-empty `gr.HTML` wrapper that the injected JS turns into an iframe         |
| `scripts/ultra_paint_api.py`                   | `StaticFiles` mount of `frontend/dist/` at `/ultra_paint/app` + `GET /ultra_paint/api/progress` |
| `scripts/ultra_paint_generate_api.py`          | `POST /ultra_paint/api/generate`                                                                |
| `scripts/ultra_paint_options_api.py`           | `GET /ultra_paint/api/options` (samplers, schedulers, native resolution, resolution step), `GET /ultra_paint/api/loras`, `GET`/`PUT /ultra_paint/api/settings` (generation-panel persistence) |
| `scripts/ultra_paint_controlnet_catalog_api.py`| `GET /ultra_paint/api/controlnet/{model_list,module_list,control_types}`, `POST /ultra_paint/api/controlnet/detect` |
| `scripts/ultra_paint_interrupt_api.py`         | `POST /ultra_paint/api/interrupt`                                                               |
| `scripts/ultra_paint_save_api.py`              | `POST /ultra_paint/api/save`                                                                    |
| `scripts/fast_coherence_pass.py`               | Forge script implementing the ring-resample coherence pass                                     |
| `scripts/gradient_coherence_pass.py`           | Forge script implementing the default gradient-blend coherence pass                             |

## Development

### Frontend

```bash
cd frontend
npm install         # once
npm run dev          # Vite dev server with HMR
npm run build        # production build -> frontend/dist/
npm run typecheck    # svelte-check
npm run lint         # eslint
npm run format:check # prettier --check
npm run test:e2e     # Playwright e2e tests
```

`frontend/dist/` is gitignored and not committed — it must be built at least once
before the extension will serve a working tab; no Node toolchain is required at
Forge-server runtime otherwise.

### Backend

No build step. Restart the WebUI (or use the Extensions tab's reload) to pick up
Python changes. Python tests live in `tests/` and run with `pytest` from the
repository root.

## Architecture

See [`PLAN.md`](PLAN.md) for the full architecture reference, file layout, layer
data model, public API surface, and phase-by-phase history — it's kept up to date
as the authoritative status document and is the right place to start before making
changes. `AGENTS.md` has the condensed agent-facing guide (layout, ownership rules,
Svelte/PixiJS conventions, and validation commands).

## License

AGPL-3.0, matching the parent repository.
