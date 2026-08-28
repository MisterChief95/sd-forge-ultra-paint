# Forge Neo UltraPaint

<p align="center">
  <img src="https://img.shields.io/badge/powered%20by-Codex-080808" alt="Powered by Codex" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/powered%20by-Claude-da7756" alt="Powered by Claude" />
</p>

Ultra Paint is a work-in-progress extension that adds a layer-based painting tab to Forge Classic,
similar to InvokeAI's canvas. Uses PixiJS v8 for GPU-accelerated multi-layer paint surfaces - 
paint, mask and ControlNet layers - wired directly into Forge's existing generation pipelines.

<img width="1814" height="992" alt="image" src="https://github.com/user-attachments/assets/11139467-5399-4195-97fa-cefef7738253" />

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

## Installation

Drop this directory into `extensions/` of a `sd-webui-forge-classic` install, then
build the frontend once (see below) and restart the WebUI. The "Ultra Paint" tab
appears alongside txt2img/img2img.

## Layout

| Path                    | Purpose                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `scripts/`               | Forge callback registrations (tab shell, static mount, and each API route) |
| `ultra_paint/`            | Importable Python package — config, generation pipeline, API request/response models, model/resolution lookups |
| `javascript/`             | Auto-injected JS that mounts the SPA's `<iframe>` into the Gradio tab      |
| `frontend/`               | Svelte 5 + PixiJS v8 + Vite SPA source, built to `frontend/dist/` (see below) |
| `tests/`                  | Python tests (pytest) for the API routes and generation pipeline           |
| `frontend/tests/e2e/`     | Playwright end-to-end tests against a real browser                         |
| `PLAN.md`                 | Living plan/status document — the source of truth for what's implemented   |

### Scripts and routes

| File | Registers |
| --- | --- |
| `scripts/ultra_paint_tab.py` | `on_ui_tabs` — a near-empty `gr.HTML` wrapper that the injected JS turns into an iframe |
| `scripts/ultra_paint_api.py` | `StaticFiles` mount of `frontend/dist/` at `/ultra_paint/app` + `GET /ultra_paint/api/progress` |
| `scripts/ultra_paint_generate_api.py` | `POST /ultra_paint/api/generate` |
| `scripts/ultra_paint_options_api.py` | `GET /ultra_paint/api/options` (samplers, schedulers, native resolution, resolution step) |
| `scripts/ultra_paint_options_api.py` | `GET`/`PUT /ultra_paint/api/settings` (Generation panel persistence) |
| `scripts/ultra_paint_interrupt_api.py` | `POST /ultra_paint/api/interrupt` |
| `scripts/ultra_paint_save_api.py` | `POST /ultra_paint/api/save` |

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
