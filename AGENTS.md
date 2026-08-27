# Ultra Paint Agent Guide

Ultra Paint is a Forge Classic extension that provides a layer-based painting
canvas, mask/reference layers, and img2img/inpaint generation. It is a split
application:

- A Python backend is loaded by Forge and exposes FastAPI routes.
- A Vite-built Svelte 5 + PixiJS v8 SPA is served from the extension and
  mounted inside Forge's Gradio page through an iframe.

## Source of truth

Read `README.md` for setup and `PLAN.md` before substantive changes. `PLAN.md`
is the living architecture/status document: use its current sections for
decisions and status, and treat older entries as history. Update its current
status or verification notes when a change materially changes behavior or test
coverage.

Do not treat `ai-docs/` refactor suggestions as accepted architecture unless a
current plan entry adopts them.

## Repository layout

```text
scripts/                         Forge auto-loaded callback/route shims
  ultra_paint_tab.py              Gradio tab and iframe wrapper
  ultra_paint_api.py              static SPA mount and progress route
  ultra_paint_*_api.py            FastAPI route registration for each feature
  fast_coherence_pass.py          Forge script for the fast coherence pass

ultra_paint/                     Importable Python implementation
  config.py                       paths, DOM prefix, defaults, version
  *_api.py                        request/response models and route handlers
  generation.py                   Forge processing construction and generation
  controlnet_units.py              optional ControlNet argument assembly
  model_profile.py                model/native-resolution detection
  resolution_step.py              Forge resolution-step lookup
  mask_ring.py                     inpaint ring-mask math

javascript/
  ultra-paint-iframe.js            host-page iframe injection/mount shim

frontend/                         Vite SPA source and frontend tooling
  src/main.ts                      Svelte mount entry point
  src/App.svelte                   three-pane shell and app lifecycle
  src/app/                         imperative Pixi/application orchestrator
  src/state/                       document schema and rune-backed stores
  src/scene/                       Pixi scene graph, overlays, compositor
  src/paint/                       brush, eraser, and stroke pipeline
  src/ui/                          feature UI components
  src/ui/generation/               generation UI, API clients, controller
  src/ui/lib/                      reusable Svelte controls
  src/input/                       keyboard/action mapping
  src/util/                        colors, blend modes, resolution helpers
  src/app.css                      Tailwind import and global theme tokens
  vite.config.ts                   `/ultra_paint/app/` base and dev proxy
  dist/                            generated build output; do not commit

tests/                             focused Python pytest modules
frontend/tests/                    Playwright fixtures and browser tests
README.md                          user-facing setup and architecture overview
PLAN.md                            living plan, status, and architecture reference
```

## Runtime flow

```text
Forge startup
  -> scripts/*.py callback registration
  -> Gradio tab wrapper + iframe host shim
  -> /ultra_paint/app/ serves frontend/dist
  -> main.ts mounts App.svelte
  -> App.svelte creates one UltraPaintApp
  -> stores -> LayerTree -> LayerNode/Pixi scene -> canvas

GenerationPanel
  -> frontend fetch('/ultra_paint/api/*')
  -> scripts route shim -> ultra_paint/*_api.py
  -> queue_lock + Forge main-thread dispatch
  -> generation.py -> process_images
  -> encoded result -> preview store/overlay -> new canvas layer
```

The production Vite base path (`/ultra_paint/app/`) must continue to match the
FastAPI `StaticFiles` mount. The dev proxy covers `/ultra_paint/api`; do not
silently change either prefix.

## Backend architecture

Keep `scripts/` thin. Forge auto-loads these modules, so they should register
callbacks and routes, not become a second business-logic layer. Put reusable
logic, Pydantic models, data decoding, and HTTP errors in `ultra_paint/`.

Current route groups are:

- `GET /ultra_paint/api/progress`
- `POST /ultra_paint/api/generate`
- `GET /ultra_paint/api/options` and `GET /ultra_paint/api/loras`
- `POST /ultra_paint/api/save` and `POST /ultra_paint/api/interrupt`
- ControlNet catalog/detect routes under `/ultra_paint/api/controlnet/*`

Generation is the Forge boundary. `generate_api.py` validates and decodes
data URLs, takes Forge's queue lock, brackets work with
`shared.state.begin()`/`shared.state.end()`, and dispatches through
`modules_forge.main_thread.run_and_wait_result`. `generation.py` constructs
Forge txt2img/img2img processing objects and calls `process_images`.

Preserve these backend rules:

- Keep `shared.state` progress and interrupt cleanup paired, including error
  paths.
- Preserve Forge API flags and complete script-argument defaults before
  changing always-on script slots.
- Keep optional ControlNet and LoRA integrations lazy and degrade gracefully
  when the corresponding Forge extension is unavailable.
- Keep `config.py` import-safe: paths/defaults only, without Forge, Gradio,
  Torch, or GPU initialization.
- Add focused pytest coverage in `tests/`; mock Forge modules with fixtures
  instead of requiring a running WebUI.

## Frontend architecture

`frontend/` is a standalone Vite SPA, not a SvelteKit application. The root
`App.svelte` owns the resizable three-pane layout:

- left: `GenerationPanel.svelte` and generation controls;
- center: `#upaint-root`, the Pixi canvas, toolbar, viewport controls, preview
  bar, and paste menu;
- right: `LayerPanel.svelte`.

Ownership is deliberately separated:

| Area | Owner | Rule |
| --- | --- | --- |
| Renderer lifecycle and imperative canvas operations | `app/UltraPaintApp.ts` | One instance per page; expose only the small imperative API UI needs. |
| Serializable document/tool/generation/preview state | `state/*.svelte.ts` | Use the shared singleton stores; keep UI state separate from live GPU objects. |
| Pixi layer hierarchy | `scene/LayerTree.ts` | The only code that adds/removes/reorders layer scene nodes. |
| One layer's visual objects | `scene/LayerNode.ts` | Apply texture, transform, opacity, visibility, blend mode, and filters here. |
| Flatten/export | `scene/Compositor.ts` | Render offscreen without coupling export to viewport pan/zoom. |
| Brush/eraser behavior | `paint/` | Keep stroke sampling and raster edits out of Svelte components. |
| UI and backend request handling | `ui/` and `ui/generation/` | Components update stores and call API clients/controllers; avoid direct scene mutation. |
| GPU texture lifetime | `LayerStore` plus the owning Pixi class | Destroy temporary/snapshot textures exactly once; do not proxy Pixi objects through Svelte. |

Svelte components that need instance-bound operations may use
`getActiveUltraPaintApp()`. Keep reactive data in stores and avoid prop/context
drilling when the existing singleton boundary already solves the problem.

## Svelte practices

For new or substantially changed Svelte code:

- Use Svelte 5 runes. Use `$state` only for values that drive the template or
  other reactive work; use `$state.raw` for large or live Pixi objects that
  should never be deeply proxied.
- Use `$derived` for computed state. Treat `$effect` as an escape hatch for
  external synchronization, not as a place to derive or repeatedly assign
  state.
- Prefer `onclick`/`onpointer...` attributes, keyed `{#each ... (key)}` blocks,
  and explicit cleanup in `onDestroy`. Preserve the existing working use of
  `onMount`, `onDestroy`, and the small Svelte action in `App.svelte`; do not
  perform a speculative migration just to change syntax.
- Treat `$props()` as changeable, avoid index keys, and use CSS custom
  properties for parent-to-child styling before adding global overrides.
- Keep UI accessible: semantic controls, labels, keyboard paths, visible focus,
  and useful ARIA text are part of correctness.
- Reuse controls in `ui/lib/` and existing store/controller APIs before adding
  a new state library, component framework, context layer, or abstraction.

When editing a Svelte component/module, use the Svelte tooling as a check:
run `npx @sveltejs/mcp svelte-autofixer <path>` for the changed component and
then run the repository typecheck. The autofixer is a validation aid, not a
reason to rewrite compatible existing code.

## PixiJS practices

This repository uses PixiJS v8. Follow v8 lifecycle and scene-graph rules:

- Construct with `new Application()`, then `await app.init(...)` before using
  `app.canvas`, `app.renderer`, or `app.screen`. On teardown, remove listeners,
  destroy owned nodes/textures, and call
  `app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true })`
  as the existing app does.
- Use `Container` for grouping. Treat `Sprite`, `Graphics`, `Text`, and other
  drawable objects as leaves; do not put children under a leaf. Remember that
  child transforms are local. Use `toGlobal()`/`toLocal()` when crossing
  viewport, world, and layer coordinate spaces.
- Keep scene structure in `LayerTree` and layer visuals in `LayerNode`. Do not
  create competing layer containers from Svelte components or unrelated
  overlays.
- The current paint path intentionally uses native DOM pointer/wheel events on
  the Pixi canvas with pointer capture. Preserve that boundary. If a new Pixi
  display object needs Pixi events, explicitly set `eventMode = "static"`, use
  a `hitArea` where useful, and use `globalpointermove` for drag tracking;
  do not assume ordinary `pointermove` is global.
- Use `RenderTexture` ownership deliberately. Temporary decoded sources and
  scratch/snapshot textures must be destroyed; store-owned textures live until
  the store replaces or removes them. For URL-based assets, use `Assets.load()`
  rather than assuming `Texture.from(url)` fetches anything. The current blob
  path uses `Texture.from(..., true)` for uncached temporary sources, then copies
  into store-owned render textures.
- Profile before adding culling, caching, object pools, high-resolution output,
  or antialiasing changes. Avoid per-frame text regeneration and unnecessary
  texture churn. A performance shortcut with a known ceiling should carry a
  `ponytail:` comment naming the ceiling and the upgrade trigger.

## Ponytail working style

Use ponytail as an implementation discipline, not an excuse to skip analysis:

1. Read the complete flow and search callers before changing a shared function.
2. Reuse an existing helper, store, controller, native browser feature, or
   installed dependency before writing a new abstraction.
3. Prefer the smallest correct diff, fewest files, and deletion of dead code
   over speculative flexibility. Do not add SvelteKit, a new state library,
   another renderer, or a backend dependency without a demonstrated need.
4. Fix root causes at shared boundaries. Do not scatter symptom guards across
   callers.
5. Never simplify away validation at trust boundaries, error handling,
   security, accessibility, resource cleanup, or explicit requirements.
6. Leave one focused runnable check for non-trivial logic. Mark deliberate
   shortcuts with `ponytail:` and state the measured/known ceiling and when to
   replace them.

## Validation

Run the narrowest relevant checks, then broaden them for cross-boundary work.

From `frontend/`:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:e2e
```

From the repository root:

```bash
pytest
```

Report whether validation was static, browser/Playwright, or live Forge. The
existing Playwright suite is useful but does not replace real Forge/GPU
validation; do not claim the latter unless a running WebUI was actually used.
