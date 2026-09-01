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

**Status: Phase 3 (in progress).** The tab is a standalone Svelte 5 + PixiJS v8 SPA,
served by the extension's own FastAPI routes and mounted into the Gradio page via an
`<iframe>`. Layer painting, undo/redo, an InvokeAI-style boundary box, mask layers,
auto-scale-to-native-resolution, and real img2img/inpaint generation are all
implemented and build-verified; see [`PLAN.md`](PLAN.md) for the authoritative,
continuously-updated status and roadmap.

## Features

- **Layer-based canvas**: raster, group, and mask layers with blend modes, opacity,
  drag-to-reorder, rename, and a context menu — rendered on a PixiJS v8 scene graph.
- **Paint tools**: brush and eraser with radius/hardness/opacity, consistent
  per-stroke opacity build-up, and dynamically growing brush textures (raster layers
  grow on demand as a stroke crosses their edge, up to an 8192×8192 cap).
- **Mask layers**: paint a mask directly on the canvas with a live hatch-pattern
  preview; flattened and sent to Forge's inpainting pipeline at generate time.
- **Boundary box**: an interactive, draggable/resizable operating region (like
  InvokeAI's canvas bounds) that scopes Fill, Generate export, and new blank layers.
- **Generation panel**: model and text encoder/VAE selection, prompt/negative prompt,
  sampler/scheduler (pulled live from Forge), steps/CFG/denoise, a frontend FIFO queue,
  in-button progress with a live preview image, and current/remaining/all cancellation
  through Forge's interrupt mechanism.
- **Undo/redo**: bounded history covering pixel edits and layer/document state
  changes.
- **Viewport controls**: zoom reset, fit-to-boundary-box, and a pixel-grid toggle
  with zoom-tiered spacing.
- **Layer transforms**: move, center-rotate, corner-scale (free or Shift-constrained),
  and mirror one selected layer through an undoable, 32px/8px-snapping canvas gizmo
  without rewriting tiled pixels.

## Roadmap (WIP)

### Complete ✅

- Brush engine with hardness and opacity
- Pressure sensitivity-enabled Brush and Eraser
- Layer masks
- Inpainting
  - Forge-native Soft Inpainting
  - Coherence Pass
- ControlNet Integration
  - Layer-based
  - Canvas-wide Inpaint ControlNets

### In-Progress 🏗️

- Tag autocompletion in prompt boxes
- Tag weighting adjustment via keyboard

### Planned ✏️

- Pre-built single-page app bundle that gets installed on extension load
- Outpainting with Lama/Patch match
- Registering other extensions in Generation Options

## Roadmap

Phases 1 through 2.75 (painting tools, the Svelte/iframe shell, the boundary box,
Playwright e2e coverage) are complete. Phase 3 (masking/inpainting, auto-scale to
native resolution) has substantially landed alongside generation-panel persistence,
model/LoRA controls, the generation queue, and prompt-tag autocomplete (Phase 1 of
that sub-feature; see `PLAN.md`). Ahead:

- **Phase 4 — Multi-layer ControlNet**: assign any layer to a ControlNet unit slot.
- **Phase 5 — Groups, transforms, selection, shape tools**: the first single-layer
  transform gizmo has landed; multi-selection pivots, marquee/lasso selection,
  and basic vector shapes remain.
- **Phase 6 — Document persistence**: save/load the actual canvas (layers, pixels,
  boundary box, masks) as a project file, not just generation settings.
- Known gaps: a clean clone has no `data/tags.csv` or `data/generation-settings.json`
  (`/data/` is gitignored) so autocomplete and settings persistence start empty until
  first configured; generations are pinned to one image per Generate click; no run
  so far has exercised a real Forge server, so "build/typecheck-verified" work
  throughout the project still awaits live confirmation.

`PLAN.md` is the living, continuously-updated source of truth for status, phase
task breakdowns, and architecture decisions — read it before making changes.

## Installation

Drop this directory into `extensions/` of a `sd-webui-forge-classic` install, then
build the frontend once (see below) and restart the WebUI. The "Ultra Paint" tab
appears alongside txt2img/img2img.

## Layout

| Path                  | Purpose                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `scripts/`            | Forge callback registrations (tab shell, static mount, and each API route)                                     |
| `ultra_paint/`        | Importable Python package — config, generation pipeline, API request/response models, model/resolution lookups |
| `javascript/`         | Auto-injected JS that mounts the SPA's `<iframe>` into the Gradio tab                                          |
| `frontend/`           | Svelte 5 + PixiJS v8 + Vite SPA source, built to `frontend/dist/` (see below)                                  |
| `tests/`              | Python tests (pytest) for the API routes and generation pipeline                                               |
| `frontend/tests/e2e/` | Playwright end-to-end tests against a real browser                                                             |
| `PLAN.md`             | Living plan/status document — the source of truth for what's implemented                                       |

### Scripts and routes

| File                                   | Registers                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scripts/ultra_paint_tab.py`           | `on_ui_tabs` — a near-empty `gr.HTML` wrapper that the injected JS turns into an iframe         |
| `scripts/ultra_paint_api.py`           | `StaticFiles` mount of `frontend/dist/` at `/ultra_paint/app` + `GET /ultra_paint/api/progress` |
| `scripts/ultra_paint_generate_api.py`  | `POST /ultra_paint/api/generate`                                                                |
| `scripts/ultra_paint_options_api.py`   | `GET /ultra_paint/api/options` (samplers, schedulers, native resolution, resolution step)       |
| `scripts/ultra_paint_options_api.py`   | `GET`/`PUT /ultra_paint/api/settings` (Generation panel persistence)                            |
| `scripts/ultra_paint_interrupt_api.py` | `POST /ultra_paint/api/interrupt`                                                               |
| `scripts/ultra_paint_save_api.py`      | `POST /ultra_paint/api/save`                                                                    |

## Development

### Frontend

```bash
cd frontend
npm install       # once
npm run dev        # Vite dev server with HMR
npm run build       # production build -> frontend/dist/
npm run typecheck    # svelte-check
npm run test:e2e      # Playwright e2e tests
```

`frontend/dist/` is gitignored and not committed — it must be built at least once
before the extension will serve a working tab; no Node toolchain is required at
Forge-server runtime otherwise.

### Backend

No build step. Restart the WebUI (or use the Extensions tab's reload) to pick up
Python changes. Python tests live in `tests/` and run with `pytest`.

## Architecture

See [`PLAN.md`](PLAN.md) for the full architecture reference, file layout, layer
data model, public API surface, and phase-by-phase history — it's kept up to date
as the authoritative status document and is the right place to start before making
changes.

## License

AGPL-3.0, matching the parent repository.
