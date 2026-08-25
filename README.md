# Forge Neo UltraPaint

<p align="center">
  <img src="https://img.shields.io/badge/powered%20by-Codex-080808" alt="Powered by Codex" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/powered%20by-Claude-da7756" alt="Powered by Claude" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/powered%20by-Copilot-8534F3" alt="Powered by Copilot" />
</p>

Ultra Paint adds a layer-based painting tab to Forge Classic, similar to InvokeAI's
canvas. It's a real GPU-accelerated multi-layer paint surface — paint, mask and
reference layers composited with PixiJS v8 — wired directly into Forge's existing
img2img/inpaint/ControlNet pipeline instead of round-tripping through separate tabs.

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
- **Auto-scale to native resolution**: the boundary box can auto-scale to the loaded
  model's recommended resolution (SD1/SDXL/Flux/etc., detected via
  [`ultra_paint/model_profile.py`](ultra_paint/model_profile.py)) and respects
  Forge's configured resolution step.
- **Generation panel**: prompt/negative prompt, sampler/scheduler (pulled live from
  Forge), steps/CFG/denoise, progress polling with a live preview image, and a
  cancel button that hits Forge's interrupt mechanism.
- **Undo/redo**: bounded history covering pixel edits and layer/document state
  changes.
- **Viewport controls**: zoom reset, fit-to-boundary-box, and a pixel-grid toggle
  with zoom-tiered spacing.
- Generated images land back in the canvas as new layers, not a separate gallery.

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
