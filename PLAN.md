# Ultra Paint — Living Plan

This is the persistent context document for `sd-forge-ultra-paint`. Update it as work
lands or decisions change — it's the thing to read at the start of a new session to
get back up to speed, and the thing to edit at the end of one so the next session
doesn't have to re-derive context.

**Convention:** keep the "Current Status" section accurate above all else. Roadmap
and design-decisions sections can lag a little; status should never lie.

---

## Preview-gallery save with PNG metadata — 2026-08-29

The generation preview gallery now has a Save button immediately before its
discard actions. It sends the selected generated PNG directly through the same
Forge manual-save route and toast/saving state as the toolbar Save, without first
flattening or applying it to the canvas. Generation responses now embed Forge's
matching infotext as the PNG `parameters` text chunk, and the save route forwards
that chunk back to Forge's image saver so prompt/settings metadata survives this
path when Forge supplied it.

Files changed: `frontend/src/ui/GenerationPreviewBar.svelte`,
`frontend/tests/e2e/ultra-paint.spec.ts`, `ultra_paint/generate_api.py`,
`ultra_paint/save_api.py`, `tests/test_generate_api.py`, and
`tests/test_save_api.py`. Verification: Svelte autofix found no issues,
frontend typecheck and lint pass, the production build passes, the focused
Playwright preview-save test passes 1/1, and the focused generation/save API
tests pass 7/7. The full frontend format check remains blocked by unrelated
pre-existing formatting changes; the edited preview component passes its focused
format check. No live Forge/GPU validation was run.

---

## Preserve-alpha live stroke clipping — 2026-08-29

Brush strokes on preserve-alpha layers are now clipped to the layer's existing
alpha while the pointer is still down, rather than showing the complete stroke
until commit. The live mask uses a temporary Pixi sprite that shares the existing
layer texture (no pixel copy), and preserve-alpha strokes skip dynamic texture
growth because locked-alpha paint cannot extend the layer's occupied bounds. The
commit-time snapshot remains in place to avoid sampling from the render target
while writing back into it.

Files changed: `frontend/src/paint/ConsistentOpacityStroke.ts` and
`frontend/tests/e2e/ultra-paint.spec.ts`. Verification: frontend typecheck passes
with 0 errors/0 warnings, focused ESLint and Prettier checks pass, production build
passes, and the focused Playwright live-preview regression passes 1/1. No live
Forge validation was run.

---

## Upscale workflow — 2026-08-28

The Generation panel now has a collapsed **Upscale** workflow that snapshots the
current boundary-box composite and submits a dedicated whole-image img2img pass at
0.25x-4x the source size. It always reuses the current prompt, negative prompt,
model, modules, and seed behavior; owns a separate denoising strength; and can
optionally override sampler, scheduler, steps, and CFG through an independently
enabled Advanced section. The result keeps Forge's generated target resolution and
continues through the shared generation queue/preview/apply path.

Upscale deliberately omits masks and all inpaint/coherence parameters. Its typed
top-level `control_layers` field is sent as an empty list for now, leaving the
existing ControlNet payload boundary ready for a later passthrough phase without
implementing it here. Ordinary no-mask img2img retains its resize-back-to-boundary
behavior, covered alongside the new keep-target-size branch in
`tests/test_generation.py`.

Files changed: `ultra_paint/generate_api.py`, `ultra_paint/generation.py`,
`tests/test_generation.py`, `frontend/src/ui/generation/generationApi.ts`,
`frontend/src/ui/generation/generationController.svelte.ts`, and
`frontend/src/ui/GenerationPanel.svelte`. Verification: frontend typecheck passes
with 0 errors/0 warnings, production build passes, the focused upscale pytest passes,
the full generation tests pass 32/32, and generate API tests pass 4/4. The Svelte
autofixer was unavailable because the sandbox could not access the npm registry;
Prettier validation passed instead. No live Forge/GPU generation was run.

---

## Codex repo audit — gaps found, roadmap additions — 2026-08-27

A Codex pass (analysis only, no code changes) confirmed the architecture described
in §4 and the current-status summary in §3 match the actual code, and flagged a
few items not yet tracked anywhere in this document:

- **Clean-clone bootstrap gap.** `/data/` is gitignored (`.gitignore:200`), which
  covers both `data/tags.csv` (Phase 1 autocomplete's dataset, see entry above —
  already documented there as "hand-written placeholder") and
  `data/generation-settings.json` (Python-persisted panel state). A fresh clone
  has neither: autocomplete silently has nothing to search, and settings
  persistence starts from empty rather than missing. Not a bug in either
  feature's own logic — just means first-run behavior on a clean clone hasn't
  been exercised. Worth a one-line README/PLAN callout or a committed
  `data/.gitkeep`-plus-placeholder rather than a code fix.
- **No document (canvas/layers) save/load.** Generation *settings* persist
  (§ Python-backed Generation-panel persistence, above) but the actual
  document — layers, pixels, boundary box, masks — does not survive a reload;
  confirmed intentional for Phase 1 (§4, "nothing is actually persisted/
  serialized yet") but never revisited since. Distinct from and additive to
  Phase 5 (§7): worth its own roadmap slot rather than folding into Phase 5's
  transform/group/selection scope.
- **Structural undo is pixel/lightweight-state only.** §3's Phase 2 note
  already says this precisely ("bounded undo/redo for pixels plus lightweight
  layer/document state changes") — flagging here only to confirm it's still
  the case and worth widening once Phase 5's group/transform UI lands (more
  structural operations to cover).
- **Batches are pinned to one image.** `generation.py`'s `GEN_PARAM_DEFAULTS`
  (§4) pins `batch_size`/`n_iter` to 1 — by design per that section, but means
  there's no way to generate multiple variations from one Generate click other
  than re-queuing manually through the frontend FIFO queue.
- **Real Forge integration testing remains the standing gap.** §3's
  "live-verified" note already says this in detail (no working Forge server
  available in any session so far) — repeating here only because it's the
  single biggest correctness risk across every phase's build-only
  verification, not a new finding.

Roadmap bullets added to §7 for the genuinely new items (document persistence);
the rest are cross-referenced to existing phases/sections above rather than
duplicated.

---

## Prompt tag autocomplete — Phase 1 shipped, Phase 2-4 roadmap — 2026-08-27

**Phase 1 (plain tag/alias matching): COMPLETE, live-verified.** The Prompt and
Negative prompt textareas in `PromptFields.svelte` now autocomplete against a
TAC-format (`sd-webui-tagcomplete-neo`-compatible) CSV: `name,category,count,
"alias1,alias2"`. Ultra Paint runs in its own iframe document, separate from the
Gradio page tagcomplete-neo attaches to, so this is a small self-contained
reimplementation using our own data file rather than reaching across the iframe
boundary into that extension's internals.

`scripts/ultra_paint_api.py` mounts `data/` at `/ultra_paint/data` (same
`StaticFiles` pattern already used for `frontend/dist/`); `data/tags.csv` ships a
small hand-written placeholder (not a scraped dataset — drop in a real TAC tag
file such as `danbooru.csv` for the full list).
`frontend/src/ui/generation/tagAutocomplete.ts` lazily fetches and parses the CSV
once, builds a 3-char-prefix index (chunked with a `setTimeout(0)` yield every
5000 rows so a large dropped-in CSV doesn't block the UI thread), and searches
by name/alias substring sorted by count.
`frontend/src/ui/generation/TagAutocompleteDropdown.svelte` renders results,
styled like `ui/lib/ContextMenu.svelte`. `PromptFields.svelte` wires both
textareas independently (separate open/selected/debounce state per field, 150ms
debounce), with arrow-key navigation, Enter/Tab/click to insert, and Escape/blur
to close. `frontend/vite.config.ts`'s dev proxy now also covers
`/ultra_paint/data`.

Verified live against a running webui (browser-driven, not just build/typecheck):
dropdown opens within the debounce window and doesn't block typing, matches are
count-sorted, arrow keys/Enter/Tab/click all insert correctly with the current
comma-segment replaced and the rest of the prompt untouched, Escape and blur
close it, and the two textareas' dropdown state don't bleed into each other.

**Explicitly deferred (not built in Phase 1):**
- **Phase 2 — category color-coding, weight-syntax awareness (`(tag:1.2)`),
  refined comma/space insertion edge cases.** Pure frontend, no new data source;
  natural next step once Phase 1 has seen real use.
- **Phase 3 — wildcards, embeddings, LoRA/LyCO keyword insertion, frequency-based
  usage sorting, live translation.** Each needs its own data source (wildcard
  files, embedding/LoRA catalogs already partly available via
  `ultra_paint/lora_api.py`, a usage-count store) — scope one at a time rather
  than as a single block; frequency sort in particular needs a small persistence
  layer analogous to `settings_api.py`'s pattern.
- **Phase 4 — user-configurable tag file.** A settings-panel control to point at
  a different CSV path (or upload one) instead of requiring users to overwrite
  `data/tags.csv` by hand; natural pairing with the existing generation-settings
  persistence (`ultra_paint/settings_api.py`).

Files changed: `scripts/ultra_paint_api.py`, `data/tags.csv` (new),
`frontend/src/ui/generation/tagAutocomplete.ts` (new),
`frontend/src/ui/generation/TagAutocompleteDropdown.svelte` (new),
`frontend/src/ui/generation/PromptFields.svelte`, `frontend/vite.config.ts`.

---

## Frontend generation queue, in-button progress, toolbar Save, and toasts — 2026-08-27

Generation now uses a frontend-owned FIFO queue while continuing to send exactly
one request at a time through Forge's existing `/ultra_paint/api/generate` route.
Every Generate click snapshots the composite, mask, visible ControlNet inputs,
seed behavior, and all generation parameters before enqueueing, so later canvas or
control changes do not mutate waiting jobs. Failures surface as toast notifications
and do not stop later jobs. Cancel Current interrupts the active request and
continues, Cancel Remaining drops only waiting jobs, and Cancel All combines both.
Intentional interruption errors are suppressed.

The Generate button remains clickable while active and reads
`Generating… (current/total)`. Its background fill is the current Forge sampling
progress; the separate progress bar, job text, and step counter are removed. A
compact hover/focus/click queue menu appears beside it while active. The live preview
image remains. Ctrl/Cmd+Enter now enqueues during an active run and Escape cancels
only the current generation.

The Boundary Box tool moved beside Eyedropper with a divider. Save moved from the
Generation panel to a disk-icon button at the toolbar's far right. A shared,
dependency-free toast viewport now handles generation/queue/save information,
successes, and errors with keyed, bounded, dismissible notifications and appropriate
live-region priority. Persistent control-specific warnings remain inline.

Files added/changed for this work include
`frontend/src/state/generationRuntimeStore.svelte.ts`,
`frontend/src/state/toastStore.svelte.ts`, `frontend/src/ui/ToastViewport.svelte`,
`frontend/src/ui/generation/generationController.svelte.ts`,
`frontend/src/ui/generation/GenerationActionsAndStatus.svelte`,
`frontend/src/ui/GenerationPanel.svelte`, `frontend/src/ui/PaintToolbar.svelte`,
`frontend/src/input/actionMap.ts`, `frontend/src/App.svelte`, and focused Playwright
coverage. Svelte autofix reports no actionable issues on the changed components;
`npm run lint`, `npm run typecheck`, `npm run build`, and the full Chromium suite
(37/37) pass. Validation is frontend/browser-only; no live Forge/GPU generation was
run, and no backend code changed.

---

## Python-backed Generation-panel persistence — 2026-08-27

Generation-panel user choices now survive iframe/tab/window reloads and Forge
restarts through a versioned snapshot stored by Python in
`data/generation-settings.json`. `GET`/`PUT /ultra_paint/api/settings` provide the
restore/save boundary. The frontend uses a one-second trailing debounce, permits
only one ordinary write in flight, and sends a small keepalive write on page hide.
Python limits the payload to 1 MiB and atomically replaces the settings file.

The snapshot covers prompts, Forge model/modules, LoRAs, sampler/scheduler,
sampling values, seed behavior, the canvas boundary box, bounding-box output
sizing, and inpainting settings. Progress, errors, layers, other document
metadata, textures, and pixels are explicitly not persisted. Restore validates
untrusted JSON and clamps numeric values, while missing model/module/sampler
options fall back to the live Forge catalog rather than leaving stale selections
active.

Files changed include `ultra_paint/settings_api.py`,
`scripts/ultra_paint_options_api.py`, `frontend/src/ui/GenerationPanel.svelte`,
`frontend/src/ui/generation/generationApi.ts`, and focused backend/Playwright
coverage. The Svelte autofixer reports no issues; `npm run typecheck`,
`npm run lint`, `npm run build`, the full Chromium suite (35/35), and the focused
Python settings tests (2/2) pass. The available standalone Python environment
lacks FastAPI, so the focused test provides the same minimal FastAPI doubles used
elsewhere in the backend suite rather than exercising a live Forge server.

---

## Forge Model Manager controls in Ultra Paint — 2026-08-27

The Generation panel now includes an open **Model** section with Forge's native
selection model: one checkpoint dropdown and one combined **VAE / Text Encoder**
picker. The picker and chips share one click-to-open control; selecting a
VAE/text-encoder option adds a removable chip while keeping the option list
open for additional choices, rather than requiring the browser's Ctrl/Cmd
multi-select interaction. `GET /ultra_paint/api/options` sources both lists and the current
selection directly from `modules_forge.main_entry.refresh_models()` / Forge's
active settings, so the app sees the same compatible files as Forge's Model
Manager. The chosen values are submitted with Generate and applied on Forge's
GPU worker through `checkpoint_change()` / `modules_change()` before processing;
the change uses Forge's normal reload configuration and is serialized by the
existing generation queue. The selection is runtime-only (`save=False`), so a
generation does not rewrite Forge's persisted UI configuration.

Files changed: `ultra_paint/options_api.py`, `ultra_paint/generation.py`,
`frontend/src/ui/GenerationPanel.svelte`,
`frontend/src/ui/generation/ModelControls.svelte` (new),
`frontend/src/ui/generation/generationApi.ts`, `frontend/src/ui/lib/Select.svelte`,
and the options fixture/unit test. `npm run typecheck` and `npm run build` pass;
backend pytest is not runnable in the available Python because it lacks Forge's
Pydantic/Pillow dependencies. Live Forge model-loading verification remains
required.

---

## LoRA generation controls — 2026-08-24

The generation panel now has a LoRAs accordion with a lazy-loaded, searchable
catalog sourced from Forge's installed LoRA registry. Selected LoRAs have an
enabled toggle, -2..2 slider, -10..10 manual strength input, activation-word
insertion, and removal. Generation appends enabled `<lora:name:weight>` tags to
the request prompt without adding them to the visible prompt textarea. The
catalog endpoint respects Forge's configured LoRA alias and preferred/default
weight behavior. Backend unit coverage and focused Playwright coverage were
added for catalog metadata and the complete selection-to-generation flow.

Files added/changed: `ultra_paint/lora_api.py`,
`scripts/ultra_paint_options_api.py`, `frontend/src/ui/GenerationPanel.svelte`,
`frontend/src/ui/generation/generationApi.ts`,
`frontend/src/ui/generation/lora.ts`,
`frontend/src/ui/generation/LoraControls.svelte`, `tests/test_lora_api.py`, and
`frontend/tests/e2e/ultra-paint.spec.ts`.

## Disabled spellcheck and browser affordances on prompt textareas — 2026-08-24

The "Prompt" and "Negative prompt" textareas in GenerationPanel now disable browser
spellcheck, autocomplete, autocorrect, and autocapitalize to avoid red squiggly underlines
and performance overhead from spell-check processing. Implemented via a Svelte action
`disableSpellcheck` that sets `spellcheck=false` and attributes `autocomplete="off"`,
`autocorrect="off"` (Safari/WebKit), and `autocapitalize="off"` (mobile browsers).

File changed: `frontend/src/ui/GenerationPanel.svelte` (lines 15–24, 491, 507).
`npm run typecheck` and `npm run build` pass clean.

## Dynamically growing brush textures — 2026-08-24

Brush strokes now grow a raster layer's monolithic `RenderTexture` on demand,
independently per axis, with a hard 8192x8192 cap. Before each brush stamp,
`ConsistentOpacityStroke` checks the stamp's local radius bounds. A newly crossed
edge gets 512px of extra runway where capacity permits; the old layer pixels and
the accumulated per-stroke coverage are copied into larger textures at the
top/left insertion offset. The layer transform is compensated by that offset so
existing pixels do not move on screen. Every copy and the final stroke commit use
a fresh, never-parented `Sprite`; the live `strokeSprite` remains overlay-only, so
this does not reintroduce the previously diagnosed stale render-state bug.
Growth is opt-in (`allowGrowth`) and enabled only by `BrushEngine`; erasing retains
the existing clipped behavior and has no growth path.

`LayerStore.growRasterLayer()` atomically swaps the texture, applies the transform
compensation, updates raster size metadata, and emits once. Its companion
`replaceLayerTexture()` atomically installs an absolute texture/transform state.
Neither emits a `LayerStoreMutation`, because `UndoHistory.recordStoreMutation`
listens only to `subscribeMutations()` and growth must stay inside the stroke's
single pixel-history entry. Both methods use expected-texture identity checks and
leave destruction of the displaced texture to the successful caller.

Pixel history now snapshots the layer transform together with its pixels.
Undo/redo first captures the current texture *and current transform* as the
inverse entry, creates a fresh texture exactly matching the entry snapshot, copies
the snapshot into that same-sized texture, then atomically restores both texture
and transform. Thus undo of a growing stroke restores the pre-stroke dimensions,
placement, and pixels; its redo entry simultaneously preserves the grown
dimensions, compensated placement, and post-stroke pixels. The same replacement
flow for a non-growing stroke is visually equivalent to the old in-place copy:
dimensions and transform are unchanged and only snapshot pixels are restored.

Files changed: `frontend/src/paint/ConsistentOpacityStroke.ts`,
`frontend/src/paint/BrushEngine.ts`, `frontend/src/state/layerStore.svelte.ts`,
`frontend/src/app/UltraPaintApp.ts`, and this `PLAN.md`. `EraserEngine.ts` was read
but did not need a change because omitted `allowGrowth` defaults to false.
`npm run typecheck` and `npm run build` are verified clean. This is **not
live-browser-confirmed** because no dev server is available; growth and history in
particular need a real test pass: draw a stroke that crosses the layer's top/left
edge, confirm the original pixels remain fixed while the brush continues, undo and
confirm size/position/pixels all return to the exact pre-stroke state, then redo and
confirm the grown size/position/post-stroke pixels all return. Repeat near the
8192px cap and confirm further brush stamps clip without throwing, then verify an
eraser stroke outside the layer still does not grow it.

## 1. What this is

A new top-level Forge WebUI tab that turns Forge into a layer-based painting/image-gen
app similar to InvokeAI's canvas, rendered with **PixiJS v8**, while staying fully
compatible with Forge's native T2I, I2I, and ControlNet pipelines.

Baseline requirements (from the original spec):
- Compatibility with Forge's native T2I, I2I, and ControlNet workflows
- Layer-based painting/editing: blend modes, multiple layers each usable as their own
  ControlNet input (multi-layer ControlNet)
- InvokeAI-style masking/inpainting with a user-editable boundary box, auto-scaled to
  the loaded model's recommended resolution when the box is smaller than that
- Manual paint tools (brush/eraser/etc.) for painting on a layer before running img2img
- Layer groups, transforms, selection tools, shape tools

**All actual canvas rendering is PixiJS**, built fresh in `frontend/src/`. Forge's
built-in `ForgeCanvas` widget (`modules_forge/forge_canvas/canvas.py`) is not used for
rendering — only its JS↔Python data-bridge *trick* (a hidden `gr.Textbox` + dispatched
`input` event) is reused, since it's proven in this exact codebase.

## 2. Delivery approach

Full architecture designed up front; implementation proceeds **phase by phase with
checkpoints**. Each phase gets a detailed task breakdown only when it starts — don't
over-plan phases 2+ until Phase 1 has landed and been tested, since early phases
teach things that should inform later ones.

### Delegation model
- **Implementation**: Opus (medium effort) or Codex `gpt-5.6-sol` (high effort)
- **Quick changes / reviews**: Sonnet (high effort) or Codex `gpt-5.6-terra` (medium effort)
- **Research / light org+docs**: Haiku 4.5 (medium effort) or Codex `gpt-5.6-luna` (high effort)

Codex is invoked via the `codex:codex-rescue` subagent / `codex-companion.mjs task`
script, model+effort passed as `--model gpt-5.6-<name> --effort <level>` in the prompt text.

---

## 3. Current status

**Phase 1: COMPLETE and live-verified for the core render+layer path** — the tab
loaded, the PixiJS canvas mounted, and adding images as layers worked, all confirmed
live by the developer at the time. Fully superseded by Phase 2.R since (see the
retrospective a few paragraphs down, and §7 for the Phase 2 outline).

**Phase 2: COMPLETE.** T7-T13 (brush/eraser/fill, toolbar controls, bounded
undo/redo for pixels plus lightweight layer/document state changes) are implemented.
The brush round-trip and undo-relevant pixel-persistence path now have live
Playwright coverage (§2.75, below) in addition to typecheck/build; eraser, fill,
and undo/redo specifically do not yet have their own automated tests (see the gap
note under Phase 2.75).

**Phase 2.R: COMPLETE.** T14-T22 all landed (table below/§6a). The whole
Gradio-component tab is gone, replaced by a near-empty `gr.HTML` wrapper
(`scripts/ultra_paint_tab.py`) that an auto-injected `javascript/ultra-paint-iframe.js`
mounts an `<iframe>` into, pointed at `/ultra_paint/app/` — a real Svelte 5 + Vite +
Tailwind 4 (dark theme) SPA served as static files by the extension's own FastAPI
routes (`StaticFiles` mount + `POST /ultra_paint/api/generate` +
`GET /ultra_paint/api/options` + the pre-existing `GET /ultra_paint/api/progress`).
The old two-button Generate handshake, `ultra_paint/bridge.py`,
`bridge/pythonBridge.ts`, and every hand-rolled DOM UI class (`LayerPanel.ts`,
`PaintToolbar.ts`) are deleted, superseded by real `fetch()` calls and Svelte
components. `npm run build`/`npm run typecheck` both pass clean on the final
wired-together state.

**Phase 2.5: RESOLVED.** All six live-testing usability items (canvas
resize/recenter controls, brush/eraser opacity build-up within one stroke, blank
raster layers, generated images landing as layers not a gallery, the iframe
viewport-height/scroll bug, the layer-panel opacity-slider row-drag conflict) are
fixed — detail inline above in this section's history.

**Layer selection workflow: IMPLEMENTED.** The layer panel now supports
modifier-based multi-selection, selected-set hide/show and delete actions from the
context menu, merging selected raster/group content into a new raster layer, and
copying a single textured layer to the system clipboard as PNG. The store keeps a
primary selection for existing callers while tracking the selected set, cleans up
selection when layers are removed, and keeps regular/mask/control selections
bucket-compatible. Merge preserves the originals and document-space placement;
mask/control selections are intentionally not mergeable. Verified with
`npm run typecheck`, `npm run build`, and `git diff --check`.

**Boundary box (Invoke-style operating region): IMPLEMENTED** (superseding the
original Phase 2.5 item 1 fixed-size canvas controls) — `Document.boundaryBox` is
now the sole operating region for Fill, Generate export, and new blank layers, with
an interactive drag/resize overlay (`BoundaryBoxOverlay.ts`). Two live-test
regressions (z-order, Generate placement) were caught and fixed. This is groundwork
Phase 3 will build on directly (an editable boundary box is Phase 3's first bullet
in §7) — it already exists, Phase 3 does not need to build it from scratch.

**Boundary-box Pixi federation: IMPLEMENTED (2026-08-27).** Boundary body and
corner handles are now explicit PixiJS federated hit targets with tool-specific
cursors, `globalpointermove` drag tracking, and `pointerupoutside` completion.
Visual-only graphics, the layer-tree root, and the pixel-grid subtree are excluded
from event traversal with `eventMode = "none"`; Pixi wheel federation is disabled
because viewport zoom deliberately remains a non-passive native DOM wheel handler.
Native paint/coalesced-pointer input and keyboard shortcuts are unchanged. A single
native `pointercancel` listener remains because PixiJS 8.20 does not federate that
browser lifecycle event. The handle/body pattern stays local to
`BoundaryBoxOverlay.ts` as the minimal convention for future gizmos; no speculative
gizmo framework or event-feature lease manager was added.

Verification for the federation change: `npm run format:check`, `npm run lint`,
`npm run typecheck`, and `npm run build` pass. A focused live Chromium run passes
5/5 for native wheel zoom, native paint input, federated corner resize, federated
body move with one-step undo, out-of-canvas drag completion, and the native
`pointercancel` fallback (the last three behaviors share two new tests). Five stale
expectations were then aligned with the current UI: native drag reorder, hidden
empty layer accordions, collapsed Bounding Box settings, generation preview/apply,
and labelled Auto-target output. The full live Chromium suite now passes 31/31.

**Phase 2.75 — Playwright e2e infrastructure: COMPLETE.** The suite has grown to
31 tests covering the original smoke/paint/boundary/fixture-Generate paths plus
masking, shortcuts, viewport controls, generation settings, cancellation, and the
new federated boundary interactions. The current run status is recorded in the
federation note immediately above. The real (non-stubbed) FastAPI/Forge generation
path remains outside Playwright coverage.

**Mask layer thumbnails: IMPLEMENTED (2026-08-27).** Mask layers now use the same
GPU-generated pixel thumbnail path as raster layers, solidly tinted with their
display color (without the canvas's diagonal hatch pattern). Their thumbnail border
follows the mask display color, and the thumbnail itself is the display-color
picker; the separate display-color row was removed. Focused Playwright coverage
verifies the rendered PNG thumbnail and color-matched border.

**What "live-verified" means above:** Playwright's `webServer` runs the real Vite
dev server and a real installed Chromium, and the brush/boundary-box tests do real
mouse-driven interaction — so those two are genuinely live-verified now, not just
typecheck/build-verified. Everything still marked static/build-verified-only above
has not been exercised this way and has no developer-in-a-real-Forge-instance
confirmation either; no working Forge server has been available in any session so
far. First things to check whenever one is: the iframe mounts cleanly, Generate
reaches the real (non-stubbed) `/ultra_paint/api/generate` and a result lands as a
layer positioned correctly, sampler/scheduler dropdowns populate from the real
`/ultra_paint/api/options`, and `frontend/dist/` gets built before first launch
(gitignored, not committed — see §4 build-commands note).

---

**Handoff note for the next session/agent: start Phase 3.** Phases 1 through 2.75
are done — painting tools, the Svelte/iframe shell, usability fixes, the boundary
box, and a live-passing (if partial) Playwright suite are all in place. §7 has the
Phase 3 description (InvokeAI-style boundary box — already built, see above —
plus masking/inpainting backend wiring, `mask` layer support, and
auto-scale-to-native-resolution). No Phase 3 task breakdown exists yet — per §7's
own closing note, write one (T23+, following the T7-T13/T14-T22 style already used
in this document) when Phase 3 actually starts, rather than continuing to add ad
hoc dated sections. Read §7's Phase 3 bullet and §8's research notes on
`StableDiffusionProcessingImg2Img.mask`/`inpaint_full_res`/`inpainting_fill` and the
`model_profile.py`-style SD1/SDXL/Flux detection before writing that breakdown.

**Phase 1 retrospective (condensed 2026-08-25 — the original blow-by-blow live-test
narrative here described a Gradio-component two-button Generate handshake,
`ultra_paint/bridge.py`, and a hidden-textbox bridge trick that Phase 2.R deleted
entirely; keeping the detailed play-by-play around risked reading as current
architecture. Full text is in git history if ever needed.)** Phase 1 built the
original Gradio-tab version: extension skeleton (T1), esbuild+PixiJS pipeline (T2,
since replaced by Vite), layer scene graph/store/compositor (T3), a hand-rolled DOM
layer panel (T4, since replaced by `LayerPanel.svelte`), the original Gradio
two-button Generate handshake (T5, since replaced by a real `POST` endpoint), and
the progress-polling route (T6, still in use unchanged). Two unrelated bugs in
*other* extensions (`sd-webui-prompt-format`, `sd-dynamic-prompts` — both uncaught
top-level JS errors breaking Gradio's own app mount for every tab, not just Ultra
Paint) were found and fixed along the way; not Ultra Paint's own code, not repeated
here. All of this shipped fine and was later fully superseded by Phase 2.R's
iframe/Svelte rewrite — nothing about the two-button handshake or `bridge.py`
describes current behavior.

---

## 4. Architecture reference

### File layout (current, Phase 2.R — rewritten to match reality, was badly
stale here through the Gradio-component era; if you're reading an older
version of this section from git history, don't trust it)
```
extensions/sd-forge-ultra-paint/
  PLAN.md                       <- this file
  README.md, LICENSE, style.css, .gitignore
  javascript/
    ultra-paint-iframe.js       <- auto-injected by Forge; mounts the iframe into
                                    #upaint-iframe-wrapper, pins it to the viewport
  scripts/
    ultra_paint_tab.py          <- on_ui_tabs: near-empty gr.Blocks, just the
                                    iframe-wrapper div (elem_id eid("iframe-wrapper"))
    ultra_paint_api.py          <- on_app_started: StaticFiles mount of frontend/dist
                                    at /ultra_paint/app + GET .../api/progress
    ultra_paint_generate_api.py <- on_app_started: POST /ultra_paint/api/generate
    ultra_paint_options_api.py  <- on_app_started: GET /ultra_paint/api/options
                                    (sampler/scheduler names)
  ultra_paint/                  <- Python package
    config.py                   <- EXTENSION_ROOT, FRONTEND_DIST_DIR, eid() helper
    generation.py                <- build_img2img_processing(), run_generation()
    generate_api.py              <- data-URL<->PIL.Image plumbing for the generate route
    options_api.py                <- sampler/scheduler list for the options route
  frontend/                     <- Svelte 5 + Vite SPA SOURCE, built to frontend/dist/
                                    (gitignored, NOT committed -- see build-commands
                                    note below; served by ultra_paint_api.py at runtime)
    package.json, vite.config.ts, svelte.config.js, tsconfig.json, index.html
    src/
      main.ts                   <- entry point: mounts App.svelte into #app
      app.css                   <- Tailwind import + dark-theme CSS custom properties
      App.svelte                 <- root shell: 3-pane layout, constructs UltraPaintApp
      app/UltraPaintApp.ts       <- orchestrator: PIXI.Application, LayerTree, canvas
                                    mounting, pan/zoom, undo/redo; exports the module-
                                    level getActiveUltraPaintApp() singleton getter
      paint/{StrokeController,BrushEngine,EraserEngine}.ts
      scene/{LayerNode,LayerTree,Compositor}.ts
      state/{layerStore.svelte,paintToolStore.svelte,schema}.ts  <- Svelte 5 runes,
                                    dual API (reactive getters + legacy subscribe())
      ui/{LayerPanel,PaintToolbar,GenerationPanel}.svelte
      util/blendModes.ts
      types/assets.d.ts
```
Deleted during Phase 2.R, superseded by the above (don't go looking for these):
`javascript/ultra-paint.mjs`(+`.map`) (old esbuild bundle), `frontend/build.mjs`
(esbuild pipeline), `ultra_paint/bridge.py` (`LogicalImage` composite bridge),
`frontend/src/bridge/pythonBridge.ts`, `frontend/src/ui/LayerPanel.ts` +
`PaintToolbar.ts` + `panel.css` + `toolbar.css` (hand-rolled DOM UI classes).

### Build commands (from `frontend/`, Phase 2.R / Vite — superseded esbuild)
`npm install` (once) · `npm run dev` (Vite dev server, HMR) · `npm run build`
(production build → `frontend/dist/`) · `npm run typecheck` (`svelte-check`).
`dist/` is gitignored, NOT committed — unlike the old esbuild-era
`javascript/ultra-paint.mjs` (deleted, see T15/PLAN.md history), the build output
is served straight off disk by the extension's own FastAPI route
(`scripts/ultra_paint_api.py`, `StaticFiles` mount at `/ultra_paint/app`, T16), so
whoever runs the server needs to have run `npm run build` at least once. No
Node toolchain is required at Forge-server runtime otherwise.

### elem_id contract (Gradio host and iframe document)
| elem_id | what | notes |
|---|---|---|
| `upaint-iframe-wrapper` | iframe mount on the Gradio page | created by Python via `eid("iframe-wrapper")`; `javascript/ultra-paint-iframe.js` mounts the app here |
| `upaint-root` | PixiJS canvas mount | lives inside the iframe document; a plain `<div>` in `App.svelte`, `UltraPaintApp` mounts its canvas into it |
| `upaint-root-toolbar` | painting toolbar mount | lives inside the iframe document; `App.svelte` renders `<PaintToolbar>` directly inside this div — literal, hardcoded id (not derived from `rootId` at runtime; T22 removed that derivation logic along with `UltraPaintApp`'s old `toolbarElementId` option) |
| `upaint-root-panel` | layer panel mount | lives inside the iframe document; `App.svelte` renders `<LayerPanel>` directly inside this div — same as above, literal id |
| `upaint-settings-panel` | generation-settings panel mount (prompt/negative/sampler/steps/cfg/denoise/Generate) | new in Phase 2.R, no Gradio-era equivalent to preserve; T22's `App.svelte` provides the mount, T21 fills it |

If you add a new elem_id, add it to this table.

### Layer data model (finalized — later phases are additive, not breaking)
```ts
type LayerId = string;
type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "add"
  | "erase" | "min" | "max" | "color-burn" | "color-dodge" | "hard-light";

interface Transform { x: number; y: number; scaleX: number; scaleY: number; rotation: number; }

interface LayerBase {
  id: LayerId; name: string; kind: LayerKind;
  visible: boolean; locked: boolean;   // locked: unused so far, reserved
  opacity: number; blendMode: BlendMode; transform: Transform;
  parentId: LayerId | null;
  mask?: unknown;         // reserved for the masking phase
  controlNet?: unknown;   // reserved for the multi-layer-CN phase
}
type LayerKind = "raster" | "group";  // "shape"/"adjustment" reserved, not implemented
interface RasterLayer extends LayerBase { kind: "raster"; image: ImageRef; }
interface GroupLayer extends LayerBase { kind: "group"; children: LayerId[]; }  // index 0 = top
type Layer = RasterLayer | GroupLayer;
interface ImageRef { source: "upload" | "generated" | "paint"; width: number; height: number; }
interface Document {
  id: string; width: number; height: number;
  layers: Layer[];        // FLAT, parentId encodes the tree
  layerOrder: LayerId[];  // top-level stacking order, index 0 = TOP of stack
}
```
**Stacking convention: index 0 = top.** PixiJS draws last-child-on-top, so `LayerTree`
attaches the ordered list in reverse — don't re-invert this in new code.

Textures are kept in a side-map (`LayerStore` internal `Map<LayerId, PIXI.Texture>`),
never on the serializable `Layer`/`Document` objects — `ImageRef` is metadata only.
Nothing is actually persisted/serialized yet (see §6, no server-side layer persistence
in Phase 1 — confirmed acceptable with the user).

### Public API surface (what future code should call, not reinvent)

**No more `window.*` globals** (Phase 2.R) — the old Gradio-bootstrap `main.ts`
exposed `window.UltraPaintApp`/`window.UltraPaintStore`/etc. so inline Gradio
`js=` snippets could reach them; that bootstrap is gone. The current `main.ts`
just imports `App.svelte` and mounts it — everything below is reached via
normal ES module imports, plus one module-level singleton getter
(`getActiveUltraPaintApp()`) for the one thing that genuinely needs "the
current app instance" without prop/context drilling through the Svelte tree.

**`UltraPaintApp`** (`frontend/src/app/UltraPaintApp.ts`):
```ts
new UltraPaintApp(rootElementId: string, options?: { store?; toolStore?; background?; resolution? })
.ready: Promise<void>
.app: PIXI.Application | null
.getStore(): LayerStore
.getToolStore(): PaintToolStore
.getDocumentRoot(): PIXI.Container | null
.getTree(): LayerTree | null
.addImageFromFile(file: File | Blob, source?): Promise<LayerId>
.addImageFromDataURL(url, name?, source?): Promise<LayerId>
.addBlankLayer(name?): Promise<LayerId>
.flattenToDataURL(): string   // synchronous data:image/png;base64,...
.fillSelectedLayer(): void    // public since T22; used by PaintToolbar.svelte's Fill button
.resizeDocument(w, h): void
.destroy(): void

// module-level export, not a method:
getActiveUltraPaintApp(): UltraPaintApp | null
```
`panelElementId`/`toolbarElementId` options and `getPanel()`/`getToolbar()`
were REMOVED in T22 — mounting the layer panel / toolbar is no longer
`UltraPaintApp`'s job, `App.svelte` renders `<LayerPanel>`/`<PaintToolbar>`
directly as Svelte components instead (see file layout above).

**`LayerStore`** (`frontend/src/state/layerStore.svelte.ts`, singleton
export `layerStore`; Svelte 5 runes, dual API — reactive getters for Svelte
components, plus the original method-call/`subscribe()` shape for non-Svelte
consumers like `UltraPaintApp`'s undo/redo history):
```ts
// reactive getters (Svelte components read these directly, no subscribe needed):
.document: Readonly<Document>
.selectedLayerId: LayerId | null

// legacy method forms, still supported:
getDocument(): Readonly<Document>
getLayer(id) / getTexture(id) / getSiblingOrder(id) / getSelectedLayerId()
addRasterLayer(texture: RenderTexture, name?, source?): LayerId   // inserted at top (index 0);
    // auto-sizes the document to this texture if the document is still empty (no layers yet) — added
    // 2026-08-23 after a live-tested bug, see the round-2 live-test-session note further down
addGroupLayer(name?): LayerId
removeLayer(id) / reorderLayer(id, newIndex)        // within current parent
setSelectedLayerId(id | null)                       // emits through subscribe()
setOpacity(id, 0..1) / setBlendMode(id, mode) / setVisible(id, bool)
setName(id, name) / setTransform(id, Partial<Transform>) / setDocumentSize(w, h) / clear()
subscribe(fn: (doc: Document) => void): () => void  // returns unsubscribe
subscribeMutations(fn: (mutation: LayerStoreMutation) => void): () => void  // undo-history hook
```

**`PaintToolStore`** (`frontend/src/state/paintToolStore.svelte.ts`, singleton
export `paintToolStore`; same dual-API shape as `LayerStore`):
```ts
// reactive getters:
.state: Readonly<PaintToolState>
.activeTool: PaintTool
.brush: Readonly<BrushSettings>

// legacy method forms:
getState(): Readonly<PaintToolState>  // activeTool + brush settings
setActiveTool("brush" | "eraser")
setBrushSettings({ radius?, hardness?, color?, opacity? })
subscribe(fn): () => void
```

**Python `generation.py`**:
```python
build_img2img_processing(composite_image: PIL.Image, gen_params: dict) -> StableDiffusionProcessingImg2Img
run_generation(composite_image, gen_params) -> Processed
```
`GEN_PARAM_DEFAULTS` in `generation.py` is the single source of truth for gen_params
keys: `prompt, negative_prompt, styles, steps, cfg_scale, distilled_cfg_scale,
denoising_strength, sampler_name, scheduler, seed, subseed, subseed_strength,
resize_mode, override_settings`. `batch_size`/`n_iter` are pinned to 1, not
gen_params-configurable.

---

## 5. Open items (historical — both resolved, kept for the record)

- ~~Frontend progress-bar UI is missing.~~ **RESOLVED by T21** —
  `ui/GenerationPanel.svelte` polls `GET /ultra_paint/api/progress` while a
  generation is in flight and shows a step-N/total progress bar + live preview.
- ~~No automated test suite; Playwright is the likely future direction.~~
  **Superseded — now an actual planned phase, not just a future direction.**
  See §6b / roadmap "Phase 2.75."

## 6a. Phase 2.R — embedded custom-HTML app, decided (see §7 for roadmap position)

**Embedded custom-HTML app (iframe), not a Gradio-component tab.** First raised
early in Phase 2 and deliberately deferred then ("hold off unless a concrete Gradio
limitation blocks something"); the developer raised it again on 2026-08-23 after
the Phase 2.5 bug list. Originally discussed as a "standalone web app" — corrected
by the developer to "embedded app," specifically citing
`extensions/sd-webui-infinite-image-browsing` as the reference pattern. **Verified
by reading that extension's source (2026-08-23):**
- `scripts/iib_setup.py`'s `on_ui_tabs()` returns a near-empty `gr.Blocks` — just a
  wrapper `gr.HTML("", elem_id="infinite_image_browsing_container_wrapper")`, no
  real Gradio components for the app's own UI.
- `javascript/index.js` injects an `<iframe>` into that wrapper
  (`iframe.style = 'width: 100%; height: 100vh'`), and loads the real app into the
  iframe's own document — completely outside Gradio's Svelte layout system, full
  CSS control from that point on.
- The real app itself is a fully separate Vue SPA (`vue/dist/`), served via its own
  FastAPI routes (`StaticFiles` mount + a custom `index.html` route) registered in
  `on_app_started` — the *same hook* `ultra_paint_api.py` already uses for the
  progress-polling route, so this is a proven-safe mechanism in this exact codebase,
  not a hypothetical.

**Proposed shape for Ultra Paint:** the entire tab becomes one iframe (not just the
canvas — the developer's clarification implies the generation-settings panel
(prompt/negative/sampler/steps/cfg/denoise) moves into the custom app too, as plain
HTML controls, not Gradio components), served by new FastAPI routes this extension
registers itself. Generate becomes a real `POST` to a new endpoint (e.g.
`/ultra_paint/api/generate`) instead of the two-button hidden-textbox handshake in
`bridge.py`/`pythonBridge.ts` — those files and that whole mechanism would be
retired. The endpoint's Python-side implementation (`build_img2img_processing`,
`run_generation`, `main_thread.run_and_wait_result`) does not need to change at
all, only how the frontend reaches it. Per the developer: "our app's logic is
self-contained and requires no external component touching, just making backend
calls" — meaning (unlike IIB, which needs `postMessage` to push images into other
tabs like txt2img) Ultra Paint likely needs **no** parent-page communication at
all, simplifying this considerably relative to IIB's own implementation.

**Arguments for, sharpened by what Phase 1/2 actually hit:**
- The canvas-height-not-reaching-bottom-of-screen bug (Phase 2.5 item 5) is a
  Gradio column/CSS constraint fight, not something in our own control — gone
  entirely inside an iframe's own document.
- The two-button Generate handshake and hidden-`gr.Textbox`-plus-dispatched-`input`-
  event bridge trick (`bridge.py`, `pythonBridge.ts`) exist *specifically* to work
  around Gradio's component model having no first-class way to hand a canvas-composited
  image into a processing call — a real API endpoint makes this a plain HTTP POST,
  and removes the "is this Gradio-4.40-timing assumption actually safe" class of risk
  entirely — this class of risk doesn't come back once there's no handshake to
  reason about.
- Phase 1's live-test session found the *entire* Forge UI (every tab, not just Ultra
  Paint) failed to load because of uncaught top-level JS errors in two *unrelated*
  extensions (`sd-webui-prompt-format`, `sd-dynamic-prompts`) that Gradio's own
  auto-scanner injected into the same global scope as everything else. An iframed
  app, loaded from its own document, would not have been affected by either bug.

**Implementation cost, now that the pattern is concrete:** most of the existing
PixiJS app code (`frontend/src/`) is reusable as-is — the change is to the mounting
shell (mount into the iframe's own `document`, not a Gradio-tab DOM subtree) and to
`scripts/ultra_paint_tab.py` (shrinks to a wrapper `gr.HTML` + iframe-injection JS,
mirroring IIB's `javascript/index.js`), plus a new small `mount_ultra_paint_app()`
registered in `on_app_started` alongside the existing progress route in
`ultra_paint_api.py` to serve the built frontend as static files. The generation-
settings panel needs to be rebuilt as plain HTML (currently real Gradio components)
and a new `/ultra_paint/api/generate` endpoint written — this is the actual new
work, everything else is closer to "move" than "rebuild."

**Arguments against / cost:** a real API surface needs to be designed and
maintained (today there is exactly one route, the read-only progress poll); losing
Gradio's built-in component plumbing means rebuilding basic things Gradio gives for
free (routing/serving the page itself, any settings/session persistence Forge's
core UI might expect extensions to participate in).

**DECIDED (2026-08-23): this is happening, scoped as Phase 2.R, and it goes
*before* Phase 2.5 and Phase 3** — not folded into later UI work. Rationale from
the developer: redo the shell now, "just in case," before more feature work gets
built on top of the soon-to-be-replaced Gradio-component shell. Several Phase 2.5
items are superseded or need re-triage once this lands (item 4, generate-to-gallery
routing, and item 5, canvas height, are both solved for free by moving off Gradio's
layout; item 6, the layer-panel slider-drag bug, needs to be re-verified against
whatever DOM the ported `LayerPanel` component produces rather than assumed fixed
or broken). Items 1-3 (canvas controls, blank layers, brush-opacity build-up) are
pure logic/PixiJS concerns independent of the shell and remain valid regardless —
implement them after Phase 2.R lands, in the new shell, rather than twice.

**UI framework: Svelte 5, runes-only** (not Vue, not Svelte 4/legacy-mode), decided
2026-08-23. Reasons specific to this codebase:
- Runes (`$state`, `$derived`, `$effect`) work in plain `.svelte.ts` modules, not
  just `.svelte` components — `LayerStore`/`PaintToolStore`'s hand-rolled
  `subscribe(fn): Unsubscribe` + manual `emit()` pattern can likely be *replaced
  outright* by a `$state`-backed reactive singleton, not just ported to an
  equivalent store API (the original Svelte-4-store-API reasoning is superseded by
  this — runes make it a bigger simplification than initially scoped).
- **Caveat, needs a deliberate design pass at implementation time, not decided
  yet:** `$state()` deep-proxies plain objects/arrays/Maps/Sets, same as Vue's
  `reactive()` — so it has the identical footgun against live PixiJS object
  references (`RenderTexture`/`Sprite`/`Application`/`Container`) that ruled out
  Vue. Svelte 5's escape hatch is `$state.raw()` (holds the reference, no deep
  proxying) instead of Vue's `markRaw`. Plan: plain serializable layer/document
  metadata (opacity, blend mode, transform, layer order) as real `$state` for free
  fine-grained reactivity; anything holding PixiJS instances (the texture side-map
  in particular) as `$state.raw`. Design this split explicitly when Phase 2.R
  implementation starts — don't default to wrapping everything in `$state`.
- **Build tool: Vite, not esbuild** (reverses the earlier "esbuild fits already"
  note — corrected 2026-08-23 after checking rather than assuming). Two reasons:
  (1) Phase 2.R serves a real standalone page (`index.html` + hashed assets) via
  our own FastAPI route, matching IIB's `vue/dist/index.html` pattern — an
  app-bundling problem Vite solves natively (HTML entry, asset hashing, dev server
  with HMR) that esbuild has no built-in story for (esbuild is a JS/CSS bundler,
  not an app bundler; the old single-injected-JS-file model esbuild was originally
  chosen for no longer applies once we're serving a full page). (2) Confirmed via
  web search: `esbuild-svelte` supports Svelte 5 compilation as of 0.8.1 but
  **ignores `.svelte.js`/`.svelte.ts` files containing runes** (no `compileModule`
  support yet — [EMH333/esbuild-svelte#250](https://github.com/EMH333/esbuild-svelte/issues/250)),
  which is exactly the runes-in-module-files pattern planned above to replace
  `LayerStore`/`PaintToolStore`. `@sveltejs/vite-plugin-svelte` is the first-party
  path with no such gap. Plain Vite (`vite build` → static `dist/`), no SvelteKit —
  this is one embedded page with no routing/SSR to justify it. `frontend/build.mjs`
  and the esbuild pipeline get retired as part of this phase, replaced by a Vite
  config producing `dist/index.html` + assets, served the way IIB serves
  `vue/dist/`.

### Phase 2.R task breakdown (starts now, 2026-08-23)

Delegation: 1:2 Claude:Codex split (Claude on foundational/cross-cutting/backend-
correctness-sensitive tasks; Codex on larger-volume mechanical port work), per
developer's `/goal` directive. Codex invoked via `codex:codex-rescue`.

| Task | What | Owner | Depends on | Status |
|---|---|---|---|---|
| T14 | New `frontend/` Vite + Svelte 5 (runes) + Tailwind (dark theme) scaffold: `package.json`, `vite.config.ts`, `index.html` entry, Tailwind config, dark-theme CSS tokens. Old `build.mjs`/esbuild pipeline retired once cutover is verified. | Claude | — | **Done** — `npm run build` and `npm run typecheck` both pass clean (Vite 6 + `@sveltejs/vite-plugin-svelte` 5 + Tailwind 4; old `build.mjs`/esbuild deps removed). `base: "/ultra_paint/app/"` matches T16's mount prefix. |
| T15 | Iframe host shim: `scripts/ultra_paint_tab.py` shrinks to a near-empty `gr.Blocks` wrapper (`gr.HTML` container div, elem_id kept stable), mirroring `sd-webui-infinite-image-browsing`'s `iib_setup.py`. New `javascript/ultra-paint-iframe.js` injects the `<iframe>` pointing at the new static route, mirroring IIB's `javascript/index.js`. Retires the two-button Generate handshake and the `Context.root_block.load(js=...)` bootstrap call. | Codex | — | **Done**, syntax-checked. Claude additionally deleted the now-orphaned old esbuild bundle (`javascript/ultra-paint.mjs` + `.mjs.map`, ~7MB dead weight) since nothing loads it post-T15. |
| T16 | FastAPI static-serving route in `ultra_paint_api.py`: `StaticFiles` mount of `ultra_paint.config.FRONTEND_DIST_DIR` (already reserved in `config.py`) at e.g. `/ultra_paint/app`, `html=True`, registered in the existing `on_app_started` alongside the progress route. | Codex | T14 (needs a `dist/` to point at, but route code itself can be written in parallel) | **Done** — mounted at `/ultra_paint/app` with `check_dir=False` + a startup warning if `dist/` is missing; verified matches T14's `base: "/ultra_paint/app/"`. |
| T17 | New `POST /ultra_paint/api/generate` FastAPI endpoint (`ultra_paint/generate_api.py` + `scripts/ultra_paint_generate_api.py`, registered as its own `on_app_started` hook to avoid a concurrent-edit collision with T16's file): JSON body (composite image data URL + `gen_params`), decodes to `PIL.Image`, runs the existing `queue_lock`/`shared.state.begin/end`/`main_thread.run_and_wait_result(run_generation, ...)` sequence from the old `_on_generate`, returns `{images: [data URLs]}`. Retired `ultra_paint/bridge.py` (deleted — dead once a real POST endpoint exists). `build_img2img_processing`/`run_generation` in `generation.py` unchanged. | Claude | — | **Done**, syntax-checked. Not live-tested (no running server in this environment, same constraint as Phase 1/2). |
| T18 | Port `state/layerStore.ts` + `state/paintToolStore.ts` to Svelte 5 runes (`.svelte.ts` modules). Preserve the documented public API surface (PLAN.md §4) so PixiJS-facing code (T22) doesn't need a parallel rewrite — back it with `$state` for serializable metadata (opacity/blend/transform/order) and `$state.raw` for anything holding live PixiJS instances (texture side-map), per the design note already in this section. | Codex | T14 | **Done** — `layerStore.svelte.ts`/`paintToolStore.svelte.ts`, identical class names/methods/singleton exports to the originals (verified by Claude), `$state`/`$state.raw` split applied correctly, typecheck/build both passed. |
| T19 | Port `ui/LayerPanel.ts` (hand-rolled DOM) to Svelte component(s) + Tailwind, dark theme. Re-verify the opacity-slider-starts-a-row-drag bug (Phase 2.5 item 6) against the new DOM — don't assume fixed or broken. | Codex | T14, T18 | **Done** — `ui/LayerPanel.svelte`, verified by Claude: full feature parity (thumbnails, inline rename, drag reorder, opacity/blend/visibility/delete), own native-DnD reorder implementation, slider-vs-row-drag bug fixed via a `pointerdowncapture` guard that synchronously toggles `draggable` before any native drag gesture can start (plus a `dragstart` fallback check) — a different, arguably more robust mechanism than the old file's. Confirmed the old manual deferred-render/focusout-polling guard is NOT needed: keyed `{#each layerOrder as id (id)}` blocks mean Svelte's reactivity doesn't tear down focused inputs the way full-DOM-rebuild did. typecheck/build both passed. |
| T20 | Port `ui/PaintToolbar.ts` to a Svelte component + Tailwind, dark theme. | Codex | T14, T18 | **Done** — `ui/PaintToolbar.svelte`, verified by Claude: brush/eraser/fill buttons, size/hardness/opacity sliders with live readouts, color input, all correctly wired to the `paintToolStore` singleton and `getActiveUltraPaintApp()?.fillSelectedLayer()`. typecheck/build both passed. |
| T21 | Generation-settings panel as Svelte components (prompt/negative/sampler/steps/cfg/denoise/Generate button), replacing the Gradio controls removed in T15. Wire Generate to `POST /ultra_paint/api/generate` (T17) via `fetch`. Fetch sampler/scheduler choices from the new `GET /ultra_paint/api/options` (Claude, added ahead of this task — see note below). Wire the existing `GET /ultra_paint/api/progress` route for live progress display (open item, PLAN.md §5 — folded into this task rather than deferred again). Retire `bridge/pythonBridge.ts`. | Codex | T14, T17 | **Done** — `ui/GenerationPanel.svelte`, verified by Claude: prompt/negative textareas, sampler/scheduler selects populated from `/options`, steps/cfg/denoise as paired range+number inputs, Generate flattens the canvas and POSTs to `/generate`, run-id-guarded progress polling (with a `MAX_PROGRESS_POLLS` safety cutoff) drives a progress bar + live preview image, results land as new layers via `addImageFromDataURL` (Phase 2.5 item 4, resolved here rather than deferred), errors surfaced inline from the response `detail`. typecheck/build both passed. **Scope note:** this Codex session unexpectedly also rewrote `ui/LayerPanel.svelte` (T19's file — a second, independent implementation, functionally equivalent) and deleted the retired `ui/LayerPanel.ts`/`panel.css`/`bridge/pythonBridge.ts` — a real concurrent-edit collision with the T19 agent, caught via file-mtime inspection and a full re-read/re-verify (typecheck 0 errors/0 warnings, build clean) rather than assumed safe. Claude additionally deleted the now-dead `ui/PaintToolbar.ts`/`toolbar.css` (superseded by T20) once T20 was confirmed integrated. |
| T22 | Mount-shell migration: `UltraPaintApp.ts`'s PixiJS init now mounts inside the new Svelte app's own root elements (own `document`, not a Gradio DOM subtree) — thin `App.svelte` hosting `#upaint-root`/`#upaint-root-toolbar`/`#upaint-root-panel`, `onMount` wiring. Re-evaluate the `ResizeObserver`/pan-zoom-centering workaround for Gradio's hidden-tab-0x0 problem — likely simplifies or is no longer needed since there's no hidden Gradio tab anymore. | Claude | T14, T18 | **Done** — `npm run build` (837 modules, full PixiJS renderer bundle) and `npm run typecheck` both pass. Turned out to be broader than "mount shell": swapped `state/layerStore`→`layerStore.svelte`/`paintToolStore`→`paintToolStore.svelte` imports across `LayerTree.ts`/`BrushEngine.ts`/`EraserEngine.ts`/`StrokeController.ts` (type-only, no behavior change — T18 preserved identical class names/method signatures/singleton exports), deleted the old plain-TS `layerStore.ts`/`paintToolStore.ts`, and **stripped the old DOM `LayerPanel`/`PaintToolbar` instantiation out of `UltraPaintApp.ts` entirely** (removed `panelElementId`/`toolbarElementId` options, `mountPanel()`/`mountToolbar()`, `getPanel()`/`getToolbar()`) since that job now belongs to Svelte components mounted directly by `App.svelte` (T19/T20), not to `UltraPaintApp`. Added `getActiveUltraPaintApp()` (module-level singleton getter, mirrors the existing `layerStore`/`paintToolStore` singleton pattern) so those future Svelte components can reach the two instance-bound methods (`addImageFromFile`, `fillSelectedLayer`, the latter promoted to `public`) without prop/context drilling — reactive layer/tool data still comes straight from the `layerStore`/`paintToolStore` singletons. The `ResizeObserver`/pan-zoom-centering workaround in `mountViewportControls` was left as-is (untouched): it's generic DOM code keyed off `root.clientWidth/clientHeight`, already correct for a plain non-Gradio div, no changes needed. Old `ui/LayerPanel.ts`/`PaintToolbar.ts` (+ `panel.css`/`toolbar.css`) are now dead code, deliberately left in place until T19/T20 land — deleted then, not before. |

**Extra task discovered while scoping T21 (2026-08-23, Claude):** the old
Gradio settings panel got its sampler/scheduler dropdown `choices=` baked in
server-side at render time (`sd_samplers.visible_samplers()` /
`sd_schedulers.schedulers` in the old `ultra_paint_tab.py`). A static SPA has
no server-render step, so it needs a real endpoint. Forge's stock
`/sdapi/v1/samplers`/`/sdapi/v1/schedulers` (`modules/api/api.py`) only mount
when the server is launched with `--api` (`webui.py`: `launch_api =
cmd_opts.api`), not guaranteed — so a new **`GET /ultra_paint/api/options`**
was added instead (`ultra_paint/options_api.py` + `scripts/ultra_paint_options_api.py`,
own `on_app_started` registration, same pattern as T17's `generate_api.py`;
returns `{samplers: string[], schedulers: string[]}`), syntax-checked. Done
ahead of T21 so its prompt doesn't get built against a data source that might
not exist at runtime.

Suggested execution order: T14 first (everything else needs the scaffold).
T15/T16/T17 (Python-side) can run in parallel with T14 since they don't touch
`frontend/`. T18 next once T14 lands; T19/T20/T21/T22 fan out once T18 lands.

**Not started, no code written toward this yet.** Needs its own task breakdown
(like Phase 1's T1-T6) when it actually starts, per §2's delivery approach.

**Framework question re-litigated and re-confirmed (2026-08-23):** developer asked
whether plain Vite still holds once more views (settings, config, etc.) get added,
and separately floated a bigger possible future — splitting the frontend into its
own repo with a pluggable (non-REST) backend-adapter API so other generation tools
could host the same UI. Resolved:
- **More views within this app ≠ a reason for SvelteKit.** Settings/config are
  panels/tabs within one running SPA instance (`activeView`-style conditional
  rendering, or a tiny client-side router if URL sync is wanted), not separate
  pages needing file-based routing or SSR. Per-view code-splitting (if ever needed)
  is a plain `import()`/Vite manual-chunking concern, not a reason to adopt
  SvelteKit's routing/adapter machinery.
- **The repo-split / pluggable-backend-adapter idea is explicitly a "just
  exploring" future direction, not a near-term plan** (developer confirmed
  2026-08-23). Worth remembering *if* it becomes concrete: that's the condition
  that would flip the calculus toward SvelteKit (standalone settings/backend-
  selection screens, `adapter-static` still gives an offline SPA but with routing/
  layouts available if the app needs to stand alone outside any host's iframe). Not
  worth designing for now — no generic backend-adapter abstraction, no repo split,
  no SvelteKit migration until/unless this becomes a real plan. Revisit the
  framework choice at that point rather than building today's Phase 2.R for a
  hypothetical.
- **Plain Vite + `@sveltejs/vite-plugin-svelte`, no SvelteKit, reconfirmed.**

**Styling decided (2026-08-23): Tailwind, dark theme.** Tailwind is safe to use
freely now (not utility-only-for-layout as first floated) — Phase 2.R's iframe
isolation (own `document`, own FastAPI-served page) means Tailwind's preflight
reset can no longer touch Forge's own DOM/CSS, the concern that originally
motivated hand-rolling everything. Dark theme only for now (matches the rest of
the Forge UI and the target audience); no light-theme toggle planned unless asked
for later.

## 6. Decisions already made (don't re-litigate without new information)

- **No server-side layer persistence in Phase 1.** Layers live only in the browser
  tab's memory; closing/reloading loses work. Data model doesn't preclude adding
  save/load later (`ImageRef` is deliberately metadata-only, not a persistence hook).
- **Ultra Paint has its own minimal generation-settings panel**, independent from the
  stock img2img tab. No cross-tab Gradio component wiring.
- **Don't use git worktree isolation for agent tasks touching `extensions/`** — this
  repo gitignores `/extensions` at the root, so the worktree-cleanup heuristic ("no
  tracked changes = nothing happened, delete the worktree") destroys untracked work.
  Build directly in the main working tree instead.
- **Codex CLI write-mode was broken for most of Phase 1's build** (Windows sandbox
  helper blocked by Defender, then an approval-policy/Desktop-app daemon mismatch that
  outlasted a config fix, a Defender exclusion, and a Codex update). All of Phase 1
  ended up built via Claude/Opus instead of the planned Sol/Terra/Luna split. If Codex
  gets fixed, no code changes are needed to resume using it — just re-attempt
  delegation for the next phase's tasks.

---

## 6b. Phase 2.75 — Playwright testing infrastructure (COMPLETE — see §3 and the
dated entry near the end of this file; this section is kept as the original design
record)

**Why now:** prompted directly by the developer after round 2-4 of live-testing
Generate alone — three real, distinct bugs (wrong document size/no auto-resize,
a stale-transform mask corrupting the exported composite, then a second
mask-related on-screen rendering glitch) each only surfaced by a live click in
a real browser, none catchable by `npm run typecheck`/`npm run build`. That
verification gap is exactly what this document already flagged as the likely
direction back when Phase 1 finished ("Playwright against a real running Forge
server is the preferred approach... today's bugs are all DOM/interaction-level
issues... a no-browser unit-test suite would not have caught any of them",
originally §5, since condensed — see §5's current pointer here) — now
sharpened by three more rounds of the same lesson. The specific ask this phase
answers: can Playwright tests run without paying the cost of launching the
full Forge server (slow, GPU-dependent — an early-Phase-1 dependency gap once
blocked the server from starting at all, long since resolved on the
developer's end; live Generate calls have worked fine for several rounds now,
but full-server startup is still real cost worth avoiding for routine test
runs)?

**Yes, and cheaper than it first looks, because of how Phase 2.R landed.**
Two tiers:

1. **Frontend-only tier — no backend at all.** Since the frontend is now a
   fully standalone Vite SPA (Phase 2.R), `vite dev`/`vite preview` alone is
   enough for Playwright to drive it. This covers the large majority of what's
   actually been built: layers, painting/undo-redo, drag-and-drop, the
   document-bounds outline, general UI/layout — none of it touches a Python
   process. This is the highest-value, lowest-cost tier and should be built
   first.
2. **Backend-interaction tier — the three API calls only**
   (`GET /ultra_paint/api/options`, `POST /ultra_paint/api/generate`,
   `GET /ultra_paint/api/progress`). Leaning toward Playwright's own
   `page.route()` network interception (canned JSON/PNG responses defined
   right in the test) over standing up a separate stub server process — same
   coverage of the frontend's request/response handling with one less moving
   part. Tradeoff, worth deciding explicitly when this phase starts rather
   than deferring silently: route interception never exercises the real
   FastAPI handlers themselves (`ultra_paint/generate_api.py`'s base64 decode
   path, error responses, etc.), so a regression there wouldn't be caught by
   this tier alone. A small real stub server (a few dozen lines, the three
   routes, no Forge/GPU/model loading) is the fallback if that gap turns out
   to matter in practice.

**Open design questions, to resolve when this phase actually starts (per §2's
delivery approach — not pre-deciding these now):**
- Where do tests live — `frontend/tests/` (co-located, npm-script-driven) vs a
  top-level `tests/` dir?
- Route-interception-only, or also build the real stub server from day one?
- `vite dev`'s `base: "/ultra_paint/app/"` (hardcoded in `vite.config.ts` to
  match the production FastAPI mount path, PLAN.md §4) applies locally too —
  Playwright should navigate to e.g. `http://localhost:5173/ultra_paint/app/`
  to match, not assume root-served.
- Given the bug pattern that motivated this (GPU/rendering-state issues
  invisible to DOM-structure assertions alone), tests should include actual
  canvas-content assertions — e.g. `page.evaluate()` calling
  `getActiveUltraPaintApp()?.flattenToDataURL()` directly and asserting on the
  decoded image's dimensions/non-blankness — not just "does the button exist"
  checks. DOM-only assertions would not have caught any of rounds 2-4.
- No CI currently exists in this repo (personal fork, not evidenced anywhere)
  — likely starts as a local dev-only tool; decide later whether/how to wire
  into any CI if one ever gets added.

---

## 7. Phase roadmap

- **Phase 2 — Painting tools.** Brush/eraser/fill, adjustable size/hardness/color,
  painting via `RenderTexture` write-through onto a raster layer, undo/redo. Builds
  directly on `LayerNode`/`Compositor`.

**UI/layout work done alongside Phase 2 (2026-08-23, via Codex Sol):** three-pane
InvokeAI-style layout (`scripts/ultra_paint_tab.py`: left settings / center canvas /
right 320px layer sidebar, all elem_ids unchanged), pan/zoom camera `Container`
(`UltraPaintApp.ts`: mouse-wheel zoom 10%-800% anchored at cursor, middle-mouse-drag
pan, left-click reserved for future paint/selection — matches T8 below), a
`ResizeObserver` working around Gradio initializing hidden tabs at 0x0, and the two
layer-panel bugs (opacity slider no longer starts a row-drag; blend `<select>`
widened to 112px). Build passed, reviewed by Claude — no issues found. Not yet
live-tested by the developer.

### Phase 2 task breakdown (starts now — Phase 1 confirmed working)

| Task | What | Notes |
|---|---|---|
| T7 | Paintable raster layer backing | Done — uploaded/generated images are copied once into store-owned `RenderTexture`s. Existing `ImageRef`/`LayerStore` metadata shape doesn't need to change — this is a `LayerNode`/texture-lifetime concern, not a schema concern. Get a layer's texture via `store.getTexture(layerId)`; paint into it via `app.renderer.render({ container, target: texture, clear: false })` — no store emit or sprite-swap needed, the layer's sprite already references that texture. |
| T8 | Pointer/stroke capture | Done — left-pointer capture uses `Container.toLocal()` through the pan/zoom chain, consumes coalesced events, and builds evenly interpolated document-space stroke points with pointer capture through stroke end. |
| T9 | Brush stamping | Done — each stroke rasterizes one reusable PixiJS radial-gradient stamp, then writes it at radius-scaled spacing into the selected layer's existing `RenderTexture`; hardness controls the opaque-core-to-feather boundary. |
| T10 | Eraser | Done — transformed radial stamps use PixiJS v8's `"erase"` blend mode to subtract target RGBA, with the shared size/hardness/opacity settings. |
| T11 | Fill tool | Done — the toolbar's Fill action clears and fills the selected raster layer's `RenderTexture` with the current brush color and opacity; connected-region flood fill remains a stretch goal. |
| T12 | Toolbar UI + color/size/hardness controls | Done — `#upaint-root-toolbar` hosts brush, eraser, and fill controls plus size, hardness, opacity, and color, backed by shared `PaintToolStore` state. |
| T13 | Undo/redo | Done — one affected-layer `RenderTexture` GPU snapshot per brush/eraser stroke or fill, combined with lightweight state entries for reorder/opacity/blend/visibility/name/transform/document size in a 40-entry history; Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl/Cmd+Y work while the canvas is focused, and add/remove/clear invalidate history. |

Suggested build order: T7 → T8 → T9 (brush working end-to-end) → T12 (so brush is
actually usable/testable in the browser) → T10 → T11 → T13 last, since undo needs
the other tools' mutation shapes to exist first.
- **Phase 2.R — migrate to an embedded custom-HTML app (Svelte), replacing the
  Gradio-component tab.** Decided 2026-08-23, full detail in §6a. **COMPLETE**
  (2026-08-23, static/build-verified, not yet live-tested — see §3). T14-T22 all
  landed same-day via a 1:2 Claude:Codex split (Claude: T14, T17, T22; Codex: T15,
  T16, T18, T19, T20, T21).

- **Phase 2.5 — quick usability fixes, re-triage after Phase 2.R lands (2026-08-23,
  from developer live testing).** Phase 2.R has now landed (see above); re-triage
  done for items 4-6; items 2-3 remain open and unaffected by the shell change:
  - **Item 1 (canvas controls): IMPLEMENTED (2026-08-23; typecheck/build-verified,
    not live-browser-confirmed).** `ui/PaintToolbar.svelte` now has document width
    and height number inputs plus a Resize action, wired to
    `UltraPaintApp.resizeDocument()`. `app/UltraPaintApp.ts` now recenters the
    document after a manual resize at the current zoom level, while preserving the
    existing one-time centering for a viewport that first becomes measurable. No
    whole-canvas rotation was implemented; that remains a product decision.
  - **Item 4 (generated images to layers, not a gallery): RESOLVED by T21** —
    `GenerationPanel.svelte`'s Generate handler pushes results straight onto the
    layer stack via `addImageFromDataURL`, no gallery component exists anymore.
  - **Item 5 (canvas not reaching bottom of viewport): hit live by the developer
    even after Phase 2.R landed, root cause identified and fixed (2026-08-23).**
    `height: 100vh` on the iframe overflows the actual visible viewport by
    however tall Gradio's own top tab bar is — the iframe starts partway down
    the page (below the tab bar), not at `y=0`, so `100vh` pushes its bottom
    edge past the window edge, requiring a page-scroll to see the rest.
    `javascript/ultra-paint-iframe.js` deliberately skipped porting IIB's
    `onUiTabChange` "maximize" logic when T15 first built the iframe shim
    (reasonable at the time, no known reason to need it yet) — this is exactly
    the bug that logic exists to prevent. Added back: an `onUiTabChange`
    listener pins `#upaint-iframe-wrapper` to `position: fixed` filling the
    viewport below the tab bar once the Ultra Paint tab is actually active,
    with the tab-bar-height offset measured once (before the wrapper is ever
    taken out of normal flow) and reused on every later tab switch, to avoid
    a feedback loop where reading `getBoundingClientRect()` after `position:
    fixed` is already applied would read back a stale/zeroed value. `node
    --check` passed. Not yet live-confirmed.
  - **Item 6 (opacity slider starts a row-drag): RE-VERIFIED AND FIXED by T19/T21's
    `LayerPanel.svelte`** — rows start non-draggable and are armed for dragging only
    via a capture-phase `pointerdown` check that excludes interactive targets
    (`input`/`select`/`button`/`textarea`), a more robust mechanism than the old
    file's post-hoc `dragstart` cancellation. Not yet live-confirmed in a real
    browser (typecheck/build-verified only).
  - **Item 3 (brush/eraser opacity build-up within one stroke): FIXED
    (2026-08-23).** `frontend/src/paint/ConsistentOpacityStroke.ts` now collects
    each stroke's opaque stamp coverage into a temporary `RenderTexture` with
    PixiJS `max` blending, then composites that texture exactly once onto the
    target layer using the selected opacity. `BrushEngine.ts` and
    `EraserEngine.ts` now use this shared helper (`normal` and `erase` commit
    blend modes respectively), removing their duplicated stamp-compositing
    implementations. `npm run typecheck` and `npm run build` passed clean; **not
    live-browser-confirmed** because this environment has no dev server/browser
    test path, and this interaction needs Playwright or live verification.
  - **Item 3 regression fix (2026-08-23; typecheck/build-verified, NOT
    live-browser-confirmed).** The per-stroke scratch texture initially delayed
    all visible paint until pointer-up. `frontend/src/paint/ConsistentOpacityStroke.ts`
    now adds the brush's scratch-backed `strokeSprite` as a temporary identity
    child of the selected raster layer container while stamps are collected, then
    removes it immediately before committing the stroke to prevent a double-draw
    flash. Eraser uses a separate accurate preview path: directly showing an
    `erase`-blend sprite would punch through lower visible layers, so the helper
    redraws a disposable copy of the selected layer texture and erases the
    accumulated coverage into that copy; `frontend/src/paint/EraserEngine.ts`
    temporarily points the layer's existing sprite at that copy and restores the
    real texture before commit. `frontend/src/paint/BrushEngine.ts` explicitly
    selects the overlay path. Exact files touched: `frontend/src/paint/ConsistentOpacityStroke.ts`,
    `frontend/src/paint/BrushEngine.ts`, `frontend/src/paint/EraserEngine.ts`,
    and `PLAN.md`. `npm run typecheck` and `npm run build` are required/recorded
    as clean for this change; no live-browser confirmation is possible in this
    environment.
  - **Item 2 (blank/general raster layers): IMPLEMENTED (2026-08-23;
    typecheck/build-verified, not live-browser-confirmed).**
    `frontend/src/ui/LayerPanel.svelte` now exposes a `+ Blank` control beside the
    image-upload action. It calls `frontend/src/app/UltraPaintApp.ts`'s
    `addBlankLayer()`, which creates and explicitly clears a document-sized
    transparent `RenderTexture` before registering it with
    `frontend/src/state/layerStore.svelte.ts`'s `addRasterLayer()` as a paint layer.
    The new raster layer is selected immediately and can be painted without
    uploading an image first. No `LayerStore` API change was necessary because its
    existing `addRasterLayer()` already accepts a caller-created `RenderTexture`.
    `npm run typecheck` and `npm run build` passed clean; no live-browser test is
    available in this environment.

**LIVE TEST SESSION, round 2 (2026-08-23, developer live-testing Phase 2.R):**
Two issues found and fixed:
1. **Generate button position** — moved above the prompt fields in
   `ui/GenerationPanel.svelte` (was at the bottom of the panel).
2. **Real bug: wrong-resolution/misaligned Generate output.** Root cause: the
   document (`LayerStore`'s `Document.width/height`) never resized to match an
   uploaded image — it stayed at the 1024x1024 constructor default forever
   (no canvas-size UI exists yet, Phase 2.5 item 1). `flattenToDataURL()`
   always renders exactly `doc.width x doc.height`, so a 4:3 upload got
   cropped/composited against a stale/mismatched square region, and the
   img2img result (matching that wrong request size) came back and landed as
   its own new layer at its own native resolution and identity transform —
   i.e. not aligned with the original content at all. **Fixed** two ways:
   - `LayerStore.addRasterLayer()` (`state/layerStore.svelte.ts`) now
     auto-sizes the document to the new layer's texture dimensions when the
     document is still empty (the common "start a canvas from an image"
     path). Does not fire on later adds, so it can't fight a user who has
     already set up a canvas.
   - **Sub-canvas visualization**, directly from the developer's own
     suggestion: `UltraPaintApp.init()` (`app/UltraPaintApp.ts`) now gives
     `tree.root` a rectangular `Graphics` mask sized to `doc.width x
     doc.height` (clips on-screen rendering to the document bounds, same
     paradigm as Photoshop/Krita -- content painted outside the boundary
     still exists in the layer's texture, it's just not shown or exported),
     plus a separate unmasked `Graphics` stroke outline in the app's accent
     color so the boundary itself is visible. Both live as siblings of
     `tree.root` under `world` (not children of `root`), so `LayerTree`'s
     reconciliation — which owns `root`'s children exclusively — is
     unaffected. Redrawn reactively via a `store.subscribe()` whenever
     `doc.width/height` changes (including the auto-size above). This is
     **purely a visual fix** — `flatten()` already only ever captured exactly
     `doc.width x doc.height` regardless of the mask, so Generate's actual
     output was already correctly bounded once the document size itself was
     right; the mask's job is making that boundary visible *before* you hit
     Generate, not changing what gets sent.

   `npm run typecheck`/`npm run build` both pass clean (840 modules, 0
   errors/warnings). **Not yet live-confirmed** — same no-server constraint as
   everything else in this environment; next live-test pass should re-check
   the original 4:3-image repro specifically.

**LIVE TEST SESSION, round 3 (2026-08-23):** the round-2 sub-canvas mask fix
introduced a real regression, caught by the developer immediately: after
Generate, the returned image landed "detached" -- wrong scale/position -- and
looked like a mostly-blank/gray composite had been sent for img2img (a
low-denoise pass over near-nothing). **Root cause, confirmed against PixiJS
v8's actual source** (`node_modules/pixi.js/lib/rendering/renderers/shared/system/AbstractRenderer.mjs`,
not assumed): `renderer.render({container})` computes its render transform
from `container.updateLocalTransform()`/`.localTransform` *only* -- it never
composes with the container's real ancestor chain. `Compositor.flatten()`
already relied on this correctly for `tree.root` itself (resetting root's own
transform is sufficient; `world`'s live pan/zoom on `root`'s *parent* was
never going to leak in regardless). But the round-2 document-bounds mask
(`root.mask = boundsMask`) lives on `boundsMask`, a **sibling** of `root`
under `world`, not a descendant -- so during `flatten()`'s special direct
render call, `boundsMask`'s clip geometry still reflected whatever transform
it had from the last *normal* per-frame render (which DOES include `world`'s
live pan/zoom), while `root`'s content was being rendered in a
freshly-reset, un-panned/unzoomed space. The two disagreed the moment the
user was anything other than exactly-centered/unzoomed when clicking
Generate, silently cropping/misplacing the exported composite. **Fixed**
in `scene/Compositor.ts`: both `flatten()` and `flattenToTexture()` (the
latter unused today, reserved for a future "flatten to new layer" op, fixed
for consistency so it can't reintroduce this later) now also snapshot,
clear, and restore `root.mask` around the render call, the same
save/reset/restore pattern already used for root's transform. The mask
remains purely a viewing aid, as originally intended -- it now genuinely
cannot affect what gets exported, regardless of pan/zoom state at click time.
`npm run typecheck`/`npm run build` both pass clean. **Not yet live-confirmed.**

**LIVE TEST SESSION, round 4 (2026-08-23): the round-3 fix was incomplete —
a second, distinct problem from the same feature.** The gray-border/detached
symptom was gone, but the developer found the layer's rendered content still
visibly *shrinks* within the document-bounds outline, and critically: it
happens the instant Generate is clicked, before the network request even
starts. The only code that runs synchronously on click before the `fetch` is
`flattenToDataURL()` — i.e. still the mask, not the generation result itself.
**Decision: removed the clipping mask entirely rather than keep patching it
blind.** Diagnosing this precisely would mean verifying PixiJS v8's
stencil-mask pooling / render-group state (`MaskEffectManager`,
`StencilMask.init/reset`, `Container.enableRenderGroup()`) actually behaves
as expected across a manual off-cycle `renderer.render()` call — the kind of
thing that needs a live browser to confirm, not static source reading (round
3's fix *was* verified against real PixiJS source and was still incomplete,
which is the point). The document-bounds **outline** (a plain unmasked
`Graphics` stroke, always known to be low-risk, nothing ever indicated it was
broken) is kept; the **clip** (`tree.root.mask = boundsMask`) is removed.
`UltraPaintApp.ts` no longer creates/assigns `boundsMask` at all. The
mask-save/restore code added to `scene/Compositor.ts` in round 3 is left in
place — harmless (a no-op once nothing ever sets `root.mask`) and correctly
future-proofs `flatten()`/`flattenToTexture()` per the file's own "no view
artifacts in the export" contract, in case masking is reintroduced properly
later. Real on-screen clipping is worth revisiting once the Playwright
testing infrastructure below exists to actually verify PixiJS behavior
instead of reasoning about it blind. `npm run typecheck`/`npm run build` both
pass clean. **Not yet live-confirmed** — this is now the fourth live-test
round on Generate specifically; strongly recommend the next round tests
Generate in isolation (no other changes bundled) before moving on.

  1. **Canvas controls — SUPERSEDED (2026-08-23).** The original fixed
     document-width/document-height controls were replaced by the Invoke-style
     boundary-box operating region documented in the dated section below.
  2. **Blank/general raster layers.** Right now the only way to create a raster
     layer is `addImageFromFile`/`addImageFromDataURL` (`UltraPaintApp.ts`) — both
     require an actual image. Need a "+ Add blank layer" path that creates an empty
     (fully transparent) `RenderTexture` at document dimensions via
     `LayerStore.addRasterLayer()`, so a user can paint on a fresh layer without
     uploading anything first.
  3. **Brush opacity built up wrong *within* a single stroke — FIXED
     (2026-08-23; typecheck/build-verified, not live-browser-confirmed).** Diagnosed root
     cause: `BrushEngine.ts`'s `BrushStroke.addPoints()` renders each stamp straight
     onto the target `RenderTexture` with normal alpha "over" compositing
     (`clear: false`), and stamps within one stroke overlap heavily (spacing is
     `radius * 0.25`, i.e. dense). Every overlapping stamp re-composites on top of
     the previous one, so opacity keeps accumulating in overlap regions for the
     *entire duration of one continuous stroke* — the screenshot shows visibly
     darker patches where the stroke self-overlapped. Standard painting-app
     behavior (confirmed by the developer's reference screenshot: 3 *separate*
     strokes at the same opacity DO visibly build up on each other, which is
     correct) is that build-up should only happen *between* strokes, not *within*
     one. Implemented in `frontend/src/paint/ConsistentOpacityStroke.ts`: stamp
     coverage accumulates in a per-stroke scratch `RenderTexture` using `max`
     blending, then the scratch texture is composited once at `end()` using the
     selected opacity. `BrushEngine.ts` and `EraserEngine.ts` are now thin
     tool-specific wrappers over that shared implementation, also resolving the
     BrushEngine/EraserEngine stamp-compositing duplication noted in the Phase 2
     code review. Static verification passed (`npm run typecheck`, `npm run build`);
     not live-browser-confirmed because no dev server/browser is available here,
     and this interaction remains best verified with Playwright or a live session.
  4. **Generated images should land as a layer, not a separate gallery.** Currently
     Generate results go to `#upaint-gallery` (see PLAN.md §4 elem_id table), a
     stock Gradio gallery component separate from the layer stack. Should instead
     call `UltraPaintApp.addImageFromDataURL()` (already exists, already used by
     the Python bridge conceptually) to push the result directly onto the layer
     stack as a new raster layer, matching the "layers are the working surface"
     model instead of a side-channel output view.
  5. **Canvas viewport doesn't reach the bottom of the screen.** Layout/CSS sizing
     issue in the center canvas column (`scripts/ultra_paint_tab.py` /
     `UltraPaintApp.ts`'s `resizeTo: root` wiring) — the `#upaint-root` container
     is not filling available vertical space down to the page bottom. Needs
     investigation into what's constraining its height inside the Gradio column.
  6. **Layer-panel opacity slider still starts a row-drag, not fixed by the Phase 2
     Task A fix.** Developer screenshot shows the classic HTML5 native
     drag-and-drop "ghost" image (a translucent copy of the dragged element
     following the cursor) when attempting to drag the opacity slider thumb — i.e.
     the row-level `draggable=true` is still winning over the `<input
     type="range">`'s own drag gesture, exactly the bug PLAN.md previously recorded
     as fixed in `LayerPanel.ts`'s `attachDragHandlers`/`renderRow`. Either that fix
     didn't fully work (e.g. the interactive-control check in `dragstart` doesn't
     catch every code path pointerdown can take before dragstart fires) or there's
     a regression from a later change. Needs fresh investigation directly in
     `frontend/src/ui/LayerPanel.ts`, re-reading the current state of
     `attachDragHandlers` rather than assuming the old fix's diff is still correct.

- **Phase 2.75 — Playwright testing infrastructure. COMPLETE (2026-08-24).** Decided
  2026-08-23 (developer request, prompted directly by round 2-4 of Generate
  live-testing: three real bugs in a row that static code reading + typecheck/build
  couldn't catch, each needing a live round-trip with the developer to find). 4/4
  tests passing against a real installed Chromium — see §3 and the dated entry near
  the end of this file for detail and the current coverage gap (eraser/fill/
  undo-redo/layer-management/real-backend are not yet covered). Ran *before* Phase 3
  as planned, so the boundary box below already has baseline interactive coverage
  before masking adds more canvas interaction on top of it.
- **Phase 3 — InvokeAI-style boundary box, masking, auto-res inpainting. NEXT UP —
  not yet started.** The boundary-box overlay itself already shipped early
  (see §3's "Boundary box" entry) as groundwork; what remains for Phase 3 is a
  `mask` layer concept populating the reserved `LayerBase.mask` field; wires
  `StableDiffusionProcessingImg2Img.mask`/`inpaint_full_res`/`inpainting_fill`; a
  `model_profile.py`-style lookup (`is_sd1`/`is_sdxl` flags on `shared.sd_model`,
  class-name fallback for Flux/Chroma/Lumina2/etc. — no such lookup exists in Forge
  itself) drives auto-scale-to-native-resolution when the box is undersized.
- **Phase 4 — Multi-layer ControlNet.** Populates the reserved `LayerBase.controlNet`
  field; any layer can be assigned to a CN unit slot. No external ControlNet API
  exists in this fork — attach via `p.script_args[cn.args_from + i] =
  ControlNetUnit(...)`, found via `next(s for s in p.scripts.alwayson_scripts if
  s.title() == "ControlNet")`. Reuse the existing `image_fg`/`mask_image_fg`
  alpha-channel per-unit masking idiom rather than inventing regional conditioning.
- **Phase 5 — Groups, transforms, selection, shape tools.** Activates the `"group"`
  `LayerKind` fully (already structurally supported by `LayerTree`'s reconciliation
  logic, just no UI yet); interactive move/scale/rotate gizmos on the existing
  per-layer `Transform`; marquee/lasso selection; basic vector shapes (reserved
  `"shape"` `LayerKind`).
- **Phase 6 — Document (canvas/layer) persistence.** Save/load the actual
  document — layers, pixels, boundary box, mask layers — as a project file,
  analogous to how `ultra_paint/settings_api.py` already persists the
  generation-panel snapshot. Flagged by the 2026-08-27 Codex audit (above);
  distinct from Phase 5's transform/selection scope.

Each phase should get its own detailed task breakdown (like Phase 1's T1-T6) written
into this document (or a dated section/subfile) when that phase actually starts —
don't pre-plan implementation details for phases 2+ speculatively.

### Phase 3 task breakdown (starts now, 2026-08-24)

**Mask design decision (developer, 2026-08-24), resolving the ambiguity in the
original roadmap bullet:** masks are a distinct layer kind, not a per-layer
`LayerBase.mask` attachment — `LayerBase.mask` stays reserved/unused, that field
was too vague to build against directly. Concretely:
- New `LayerKind` value `"mask"`. Mask layers live in their own collapsible
  accordion section in the layer panel, separate from an accordion holding the
  existing raster/group layers (both accordions new — today's panel is one flat
  list).
- Mask layers are painted with the *existing* brush/eraser tool and stroke
  pipeline, unchanged — no new paint engine. Only coverage (alpha) painted into
  the mask layer's texture matters; the *color* the brush happens to be set to
  when painting is irrelevant to a mask layer and must not leak into the
  exported mask (see Compositor task below).
- Each mask layer has one solid display color, chosen per-layer (a color swatch
  control on the layer row, in the exact grid slot the opacity slider occupies
  for raster/group layers — mask layers have no opacity for now, so that slot is
  free). Painted mask coverage renders on-screen with a diagonal-hatch pattern
  tinted by that color (classic "quick mask" look), not as flat color — this is
  a display-only filter, it must not alter the underlying `RenderTexture` pixels
  or the exported mask.
- At Generate time, all visible mask layers within the boundary box are
  flattened into one black/white PNG (white = regenerate, black = keep,
  soft/partial edges preserved from brush hardness) and sent to the backend
  alongside the composite image.

| Task | What | Owner |
|---|---|---|
| T23 | `ultra_paint/model_profile.py` — pure function(s) mapping a loaded model to a native/recommended resolution. Input should be duck-typed (accept anything with `.is_sd1`/`.is_sdxl`/`.is_wan` attributes plus a class-name string), not a hard `shared` import, so it is unit-testable without a running Forge instance. Table from research (2026-08-24): SD1.x (`is_sd1`) -> 512; SDXL/Mugen (`is_sdxl`) -> 1024; Flux/Flux2/Chroma/Lumina2/ErnieImage/PiD/ZImage (class-name match, no dedicated boolean) -> 1024; Wan/Qwen/Anima/Krea2 (`is_wan` — note this flag is really "WAN-VAE latent layout", reused by non-video models, not a clean architecture signal by itself) -> 1024 unless a more specific class-name match applies. Unknown/no model loaded (bare `FakeInitialModel`, missing attributes) -> safe fallback 512, via `getattr(..., False)` guards, never `AttributeError`. Full class-name list and file:line citations are in the 2026-08-24 research note this table is built from (kept in agent history, not re-copied here — re-derive from `backend/diffusion_engine/*.py` if this table ever needs updating). | Claude |
| T24 | Backend generation.py / generate_api.py wiring. `GenerateRequest` gets an optional `mask_image: str \| None` (same data-URL shape as `composite_image`). New `GEN_PARAM_DEFAULTS` keys: `inpainting_fill` (0-3, default 1 = "original", matching `modules/processing.py`'s own default), `inpaint_full_res` (bool, default `True` — but only meaningful when a mask is present), `inpaint_full_res_padding` (px, default 32), `mask_blur` (px, default 4), `inpainting_mask_invert` (0/1, default 0). `build_img2img_processing` decodes `mask_image` (reuse `generate_api.py`'s `_decode_data_url`, convert to `"L"` not `"RGBA"` for the mask), passes it as `mask=`, and only when a mask is present: if the boundary box is smaller than `model_profile`'s native resolution for `shared.sd_model`, set `inpaint_full_res=True` (crop-and-upscale-to-native path); otherwise leave the developer's `inpaint_full_res` choice alone. No mask -> `mask=None`, exactly today's Phase 1 behavior, unchanged. | Claude |
| T25 | Backend unit tests (pytest, no running Forge instance needed). `model_profile.py`: cover every class-name branch, both boolean flags, the `getattr`-guarded unknown-model fallback, and boundary sizes (native-1, native, native+1). `generation.py`: mock `modules.shared`/`modules.processing`/`modules.scripts` at import boundaries and assert `build_img2img_processing` produces the right `mask`/`inpaint_full_res`/`inpainting_fill`/`mask_blur` fields for (a) no mask, (b) mask + undersized box, (c) mask + adequately-sized box. New test files live under `extensions/sd-forge-ultra-paint/tests/` (no test infra exists anywhere in this repo yet — this is the first). | Claude |
| T26 | Frontend schema/store. `frontend/src/state/schema.ts`: add `"mask"` to `LayerKind`, new `MaskLayer extends LayerBase { kind: "mask"; image: ImageRef; color: string }` (hex string), add to the `Layer` union. `layerStore.svelte.ts`: `addMaskLayer(name?, color?): LayerId` mirroring `addBlankLayer()` (document/boundary-box-sized transparent texture, positioned at `boundaryBox.x/y` — same fix class as the 2026-08-24 blank-layer-positioning bug, don't reintroduce it), `setMaskColor(id, color)`. Audit every existing `kind === "raster"` / `kind === "group"` switch (`LayerTree.ts` reconciliation, `Compositor.ts`, `StrokeController.ts`'s raster-only gate, `LayerPanel.svelte` thumbnail/icon logic) for exhaustiveness now that a third kind exists — TypeScript's discriminated-union exhaustiveness checking should catch most of these at `npm run typecheck` if switches use a `never` default case; add one anywhere it's missing. | Codex (gpt-5.6-sol) |
| T27 | Paint pipeline. `StrokeController.handlePointerDown`'s raster-only gate (`layer.kind !== "raster"`) must also accept `"mask"`. `BrushEngine`/`EraserEngine`/`ConsistentOpacityStroke` need no logic changes — they already only care about a texture + `LayerTree` node, and mask-layer coverage painting is semantically identical to raster alpha painting; verify `LayerTree`'s node kind check (used by `BrushEngine.beginStroke`, currently `node.kind !== "raster"`) is updated to allow `"mask"` too. | Codex (gpt-5.6-sol) |
| T28 | Mask display filter. New `frontend/src/scene/MaskHatchFilter.ts` (or similar), a PixiJS `Filter` (consult the `pixijs-filters` skill) applied only to mask-kind layer nodes' sprites: forces output RGB to the mask layer's chosen color wherever the source has coverage (alpha > 0), modulated by a diagonal-stripe pattern (e.g. `mod(fragCoord.x - fragCoord.y, spacing)`) so painted regions read as a colored hatch, not flat fill. Purely a display effect — never touches the underlying `RenderTexture`. `LayerTree` (or `LayerNode`) attaches/updates this filter (and its color uniform) for mask nodes only, removes it for everything else. | Codex (gpt-5.6-sol) |
| T29 | Layer panel UI. `LayerPanel.svelte`: split the flat list into two collapsible accordion sections — "Layers" (raster + group, existing rows unchanged) and "Masks" (new). A "+ Mask" toolbar button (next to "+ Add"/"+ Blank") calls `addMaskLayer()`. Mask rows reuse the existing row layout but swap the opacity-slider grid cell for a `<input type="color">` bound to `setMaskColor`; no opacity control, no blend-mode `<select>` (masks don't composite into the visible image at all — see T30/T31, they're export-only). Keep the existing drag-reorder/rename/visibility/delete affordances working for mask rows within their own accordion (reordering across accordions is out of scope — masks and layers are independent stacks). | Codex (gpt-5.6-sol) |
| T30 | Mask export. `Compositor.flattenMask(app, store, box): string \| null` — returns `null` if no visible mask layer exists (so the frontend can omit `mask_image` from the request entirely, preserving today's no-mask behavior byte-for-byte). Otherwise: build a temporary container of plain (unfiltered — do NOT reuse the T28 hatch-filtered sprites) sprites for every visible mask-kind layer within `boundaryBox`, apply a `ColorMatrixFilter` per sprite with matrix `[0,0,0,0,1, 0,0,0,0,1, 0,0,0,0,1, 0,0,0,1,0]` (forces RGB to pure white, alpha untouched, regardless of source pixel color — this is what makes the brush's arbitrary paint color irrelevant to the export, per the design note above), render onto an opaque black-cleared `RenderTexture` sized to the box (mirrors `flatten()`'s crop-to-box approach), export as PNG data URL. `UltraPaintApp`/`GenerationPanel.svelte`: call this alongside `flattenToDataURL()` on Generate, include `mask_image` in the POST body only when non-null. | Codex (gpt-5.6-sol) |
| T31 | Playwright coverage. Extend `frontend/tests/e2e/ultra-paint.spec.ts`: add a mask layer via the new "+ Mask" button and assert it appears under the Masks accordion (not Layers); paint a stroke on it and assert `Compositor.flattenMask()` (or an equivalent app-exposed hook) returns a non-null data URL with the expected painted-pixel coverage, mirroring the existing brush-paint pixel-check test; assert the stubbed Generate flow includes `mask_image` in its request body when a mask layer has paint, and omits it when none exists. This is additive to the existing 4 tests, not a rewrite — keep them passing. | Codex (gpt-5.6-sol) |

| Frontend task | Status |
|---|---|
| T26 | **Done** — added the mask discriminant/data shape and boundary-box-positioned mask texture/color store API in `frontend/src/state/schema.ts` and `frontend/src/state/layerStore.svelte.ts`; made `frontend/src/scene/LayerNode.ts`/`LayerTree.ts` exhaustive for all three kinds. Verified by typecheck, production build, and browser suite. |
| T27 | **Done** — admitted masks through `frontend/src/paint/StrokeController.ts`, `BrushEngine.ts`, `EraserEngine.ts`, the store's texture growth/replacement guards, and `frontend/src/app/UltraPaintApp.ts` pixel history. `ConsistentOpacityStroke.ts` remained unchanged as designed. Verified by a real pointer stroke and pixel-readback Playwright test. |
| T28 | **Done** — added `frontend/src/scene/MaskHatchFilter.ts` with PixiJS v8 WebGL/WebGPU filter programs and lifecycle/color updates from `LayerNode.ts`; the source `RenderTexture` stays untouched. Verified the WebGL path in Chromium with no console/page errors and mask export pixel checks; the WebGPU program was build/typechecked but not runtime-selected by Playwright. |
| T29 | **Done** — split `frontend/src/ui/LayerPanel.svelte` into collapsible Layers/Masks stacks, added `+ Mask`, mask color controls, and same-stack rename/visibility/reorder/delete behavior. Verified all new controls in Playwright. |
| T30 | **Done** — added black/white mask flattening with the specified `ColorMatrixFilter` matrix in `frontend/src/scene/Compositor.ts`, excluded mask overlays from normal flattening and exposed mask export in `frontend/src/app/UltraPaintApp.ts`, and conditionally posted `mask_image` from `frontend/src/ui/GenerationPanel.svelte`. Verified white painted coverage, black background, transparent regular composite, and both request shapes in Chromium. |
| T31 | **Done** — extended `frontend/tests/e2e/ultra-paint.spec.ts` additively from 4 to 7 tests. Final verification: `npm run typecheck` 0 errors/0 warnings; `npm run build` clean (844 modules); `npm run test:e2e` 7 passed, 0 failed. |

Suggested order: T23 -> T24 -> T25 (backend is self-contained, can run fully in
parallel with the frontend track) · T26 -> T27 -> T28 -> T29 -> T30 -> T31 (each
frontend task's UI/behavior depends on the previous one's data shape existing).
Backend and frontend tracks don't block each other until final wiring (the
frontend's `mask_image` POST field must match T24's `GenerateRequest` shape —
cross-check field names before T30 lands).

**T23-T25 (backend track): DONE, 2026-08-24.** `ultra_paint/model_profile.py`
(new) is the duck-typed `native_resolution_for(model)` lookup exactly as
specced — no `modules.shared` import, `ModelSignature` dataclass for tests,
`getattr(..., False)`-guarded reads so `None`/`FakeInitialModel`-shaped input
never raises. `ultra_paint/generation.py`: `build_img2img_processing()` gained
an optional `mask_image: Image.Image | None = None` third parameter (also
threaded through `run_generation()`); when supplied it's converted to `"L"`,
raises `ValueError` on a composite/mask size mismatch, and
`inpaint_full_res` is force-set to `True` whenever the (post-//8-clamp)
composite is smaller than `native_resolution_for(shared.sd_model)` in either
dimension — otherwise the caller's own `gen_params["inpaint_full_res"]` is
respected. Five new `GEN_PARAM_DEFAULTS` keys (`inpainting_fill`,
`inpaint_full_res`, `inpaint_full_res_padding`, `mask_blur`,
`inpainting_mask_invert`) are always passed to the `StableDiffusionProcessingImg2Img`
constructor now (harmless when `mask=None`, matching stock `processing.py`
defaults). `ultra_paint/generate_api.py`: `GenerateRequest` gained an optional
`mask_image: str | None` (same data-URL shape as `composite_image`), decoded
via the existing `_decode_data_url` helper and threaded through
`main_thread.run_and_wait_result`. No mask supplied -> byte-for-byte the old
Phase 1/2 code path (`mask=None`, nothing else touched) — verified by
`test_no_mask_leaves_inpainting_fields_at_gen_param_defaults`.

New: `extensions/sd-forge-ultra-paint/tests/` — the first Python test infra in
this whole repo (no root `pytest.ini`/`conftest.py` existed to inherit from).
`tests/conftest.py` puts the extension root on `sys.path`.
`tests/test_model_profile.py` (14 tests) exercises every branch/precedence
rule in `model_profile.py` directly, no mocking needed (it's deliberately
pure). `tests/test_generation.py` (5 tests) installs minimal fake
`gradio`/`modules.scripts`/`modules.shared`/`modules.processing` modules into
`sys.modules` before importing `ultra_paint.generation`, so the module under
test runs its real code against faked dependencies only — covers no-mask
(fields stay at defaults), mask+undersized-box (forces `inpaint_full_res`),
mask+adequate-box (respects caller choice), mask/composite size-mismatch
(raises), `None` composite (raises), and (added below) the Wan-abort path.
All 38 tests pass via the repo's existing `venv`
(`venv/Scripts/python.exe -m pytest extensions/sd-forge-ultra-paint/tests -v`)
— pytest itself had to be `pip install`ed into that venv first, nothing else
was missing (PIL/gradio were already present there). Run from the Forge repo
root, not the extension directory, since `pyproject.toml`'s pytest config
lives at the root and `rootdir` detection depends on it.

**Wan (video model) exclusion — developer decision, 2026-08-24, after the
model-profile review above surfaced it.** Ultra Paint is strictly an
image-editing/img2img tool; Wan 2.1 (`backend/diffusion_engine/wan.py`'s
`Wan` class) has no still-image resolution convention at all (confirmed
against source: `wan.py` derives `h`/`w` purely from whatever tensor it's
given, no hardcoded default; its public HuggingFace convention is widescreen
video, 480p/720p, not square). Two decisions, in order: first, bucket Wan
into `HIGH_RES_ARCH_RESOLUTION` like everything else non-SD1 (wrong — a
confident-looking 1024 number for a model with no such convention); then,
per the developer, keep Wan detection specifically so generation can warn and
abort rather than silently either mis-sizing or fully ignoring it. Landed as
`model_profile.py`'s `VIDEO_MODEL_CLASS_NAMES = frozenset({"Wan"})` and
`is_unsupported_video_model(model)` (class-name-only check — deliberately
NOT keyed on `is_wan`, since that boolean is shared with supported image
models QwenImage/Krea2 and can't distinguish Wan from them).
`generation.build_img2img_processing()` calls this first, right after the
existing "no composite image" guard, and raises `ValueError("Ultra Paint
does not support video models (Wan). Load an image model before
generating.")` before any further work happens. This `ValueError` surfaces
the same way `build_img2img_processing`'s other `ValueError`s already do:
raised on the GPU worker thread inside `run_generation`,
`main_thread.Task.work` swallows it and records `main_thread.last_exception`,
and `generate_api.py`'s existing `if processed is None` branch turns that
into an HTTP 500 whose detail includes the message — an existing pattern,
not a new error-handling path. Separately, `Anima` (`anima.py`, no
in-source resolution hint) was moved from the generic `is_wan` fallback into
the explicit `_CLASS_NAME_HIGH_RES` set per the developer, matching how the
architecture is actually identified elsewhere in this table rather than
riding along on a flag that's really about latent layout. Tests added:
`test_is_unsupported_video_model_*` (model_profile.py) and
`test_wan_video_model_aborts_generation` /
`test_non_wan_model_with_is_wan_flag_does_not_abort` (generation.py, the
latter guarding specifically against the abort accidentally becoming
`is_wan`-scoped instead of class-name-scoped).

Not covered by these unit tests (Forge-runtime territory, not unit-testable
without a live server): `run_generation()`'s actual `process_images()` call,
the `/ultra_paint/api/generate` FastAPI route end-to-end, and whether Forge's
own mask/inpaint pipeline (`modules/processing.py`, `modules/masking.py`)
actually produces a correct inpaint given our `mask`/`inpaint_full_res`
wiring — that needs a live Forge instance and is flagged the same way every
other not-live-tested item in this document already is.

Explicitly out of scope for Phase 3: per-layer `LayerBase.mask` clipping/visibility
masks (a different, unrequested feature — see the design-decision note above);
mask-layer opacity/blend modes; reordering a mask relative to a regular layer (they
are independent accordion stacks); flood-fill/lasso mask selection tools (brush/
eraser only, matching what already exists); anything from Phase 4/5 (ControlNet,
groups/transforms/shape tools).

### Phase 3 follow-up (developer live-review, 2026-08-24) — T32-T38

Three items raised after reviewing the T23-T31 landing:

1. Eraser-on-mask — **already true, verified, not a new task.** `EraserEngine.beginStroke`
   already gates on `node.kind !== "raster" && node.kind !== "mask"` (both
   `EraserEngine.ts` and `BrushEngine.ts` were broadened together back in T27). No
   fix needed; T32 below only adds the missing dedicated Playwright coverage for
   it, since T31's suite covers brush-on-mask but not eraser-on-mask specifically.
2. Live mask stroke preview shows raw white/brush-color, not the hatch+color
   filter, until commit — **confirmed real gap**, root-caused by reading
   `LayerNode.ts`/`ConsistentOpacityStroke.ts`/`MaskHatchFilter.ts`:
   `MaskHatchFilter` is attached to `LayerNode`'s persistent `this.sprite`
   (`LayerNode.ts` around the `case "mask":` branch), but the brush's live
   overlay preview (`ConsistentOpacityStroke`'s `livePreview: "overlay"` path)
   parents a *separate* `strokeSprite` into the same `layerContainer` as an
   additional sibling, not a child of `this.sprite` — so it never picks up a
   filter that's attached only to the sprite object, not the container. Fixed
   by T33.
3. Boundary-box resolution controls (None/Auto/Manual scale modes, aspect
   ratio lock, width/height quick-swap) — new feature, T34-T37.

**Backend prerequisite, DONE 2026-08-24 (Claude):** the frontend's Auto scale
mode needs to know the loaded model's native resolution without duplicating
`model_profile.py`'s architecture table in TypeScript, and generation needs a
way to actually request a different output size than the boundary-box crop
size. `ultra_paint/options_api.py`'s `GenerationOptions` gained three fields:
`native_resolution: int` (`model_profile.native_resolution_for(shared.sd_model)`),
`is_video_model: bool` (`model_profile.is_unsupported_video_model(...)`, lets
the frontend warn before Generate is even clicked instead of only on a failed
request), and `resolution_step: int` (new `ultra_paint/resolution_step.py`,
mirroring a pattern the developer already uses in another extension: Forge's
own "Resolution Step" setting, `res_step` — `modules/shared_options.py:166`,
default 64, choices 8/16/32/64/128/256 — read via `opts.data.get("res_step",
...)` when registered in `opts.data_labels`, else falling back to 64). Auto
mode's target-size math (below, T34) must use this fetched step, not a
hardcoded 64, so it respects whatever grid the user has actually configured
Forge-wide. `ultra_paint/generation.py`'s `GEN_PARAM_DEFAULTS` gained
`target_width`/`target_height` (both default `None`); when both are supplied,
`build_img2img_processing` uses them as `p.width`/`p.height` directly (Forge's
own `resize_mode` machinery does the actual up/downscale from the boundary-box
crop to that target — Ultra Paint does not resample the canvas itself, so
`init_images`/`mask` stay at their original box-cropped size). When either is
missing, output size falls back to the composite's own 8px-clamped dimensions,
byte-for-byte the pre-this-change behavior. The existing `inpaint_full_res`
native-resolution auto-force (T23-T25) deliberately keeps comparing against
the *original* box/composite size, not `target_width`/`target_height` — scaling
the whole canvas to a target and tightly cropping to just the masked region
within it are independent concerns that can both apply to one generation (see
the module docstring's `mask_image` section for the reasoning). New:
`tests/test_resolution_step.py`; full suite now 58 tests, all passing.

| Task | What | Owner |
|---|---|---|
| T32 | Playwright: dedicated eraser-on-mask test (paint a mask stroke, erase part of it, assert the exported `flattenMask()` coverage drops in the erased region) — the underlying capability already exists (see item 1 above), this is coverage only. | Codex (gpt-5.6-sol) |
| T33 | Live mask stroke preview fix. During a brush/eraser stroke on a `"mask"`-kind layer, the live overlay (`ConsistentOpacityStroke`'s `strokeSprite`, or the eraser's `previewTexture`-based preview) must render through the same `MaskHatchFilter` + layer color as the committed result, not raw paint color. Likely fix shape: `ConsistentOpacityStroke`/`BrushEngine`/`EraserEngine` need a way to know the target is a mask layer and either (a) apply a filter instance to `strokeSprite` itself for the duration of the live preview, mirroring `LayerNode`'s color, or (b) have `LayerNode` own the preview sprite's filter the same way it owns `this.sprite`'s. Pick whichever keeps `MaskHatchFilter` instantiation/color-sync in one place (`LayerNode`) rather than duplicating filter setup into the paint engines — the paint code should stay tool-generic (it already doesn't special-case mask color for brush/eraser logic itself, only for display). Must not change what gets committed to the texture or what `flattenMask()` exports (still forced-white via `ColorMatrixFilter`, per T30) — display-only, same contract `MaskHatchFilter` already has. | Codex (gpt-5.6-sol) |
| T34 | Backend groundwork for Auto/Manual scale modes is already done (see above) — this task is the frontend scale-mode state: a new field on the document or a new small store (developer's call which fits better given the existing `layerStore`/`paintToolStore` split) holding `scaleMode: "none" \| "auto" \| "manual"` plus `manualWidth`/`manualHeight`. Fetch `native_resolution`/`is_video_model`/`resolution_step` from `GET /ultra_paint/api/options` (`GenerationPanel.svelte` already fetches this endpoint for samplers/schedulers — extend the same fetch/parse, don't add a second request). **Auto-mode formula, updated 2026-08-24 from the developer's own reference implementation in another extension (verified to reproduce their worked example exactly: 300x400 box -> 896x1152 at native resolution 1024, step 64):** given `boxWidth`/`boxHeight` and `step` = fetched `resolution_step` (NOT hardcoded 64): `ratio = boxWidth / boxHeight`; `baseArea = nativeResolution * nativeResolution`; if `ratio === 1`, both dimensions are `round(nativeResolution / step) * step`; else if `ratio > 1` (wide), `idealWidth = sqrt(baseArea * ratio)`, `idealHeight = idealWidth / ratio`, then `newWidth = floor(idealWidth / step) * step` and `newHeight = round(idealHeight / step) * step` (note: **floor** on the axis computed directly from the sqrt, **round** on the derived one — NOT a symmetric "round both independently", that was this table's original, less-precise draft); else (tall, `ratio < 1`), the mirror image: `idealHeight = sqrt(baseArea / ratio)`, `idealWidth = idealHeight * ratio`, `newHeight = floor(idealHeight / step) * step`, `newWidth = round(idealWidth / step) * step`. Clamp both final dimensions to a minimum of `step`. Put this formula in one small pure/testable function (e.g. `frontend/src/util/autoResolution.ts`) so T38 can unit/Playwright-test it directly against the worked example instead of only through UI interaction. | Codex (gpt-5.6-sol) |
| T35 | Resolution controls UI in the left settings panel (`GenerationPanel.svelte`, per the developer — that's the panel already living in the left column). Mode selector (None/Auto/Manual) using T34's store; Manual mode shows width/height number inputs (T34's `manualWidth`/`manualHeight`); Auto mode shows the computed target size read-only (recomputed live as the boundary box changes, using T34's formula and the fetched `native_resolution`/`resolution_step`); when `is_video_model` is true, show a clear inline warning (Wan is loaded, Generate will be rejected) rather than waiting for a failed request. Wire the final `target_width`/`target_height` (omitted entirely in None mode, matching the backend's "both missing -> unchanged behavior" contract) into `GenerationPanel.svelte`'s existing POST body next to `mask_image`. | Codex (gpt-5.6-sol) |
| T36 | Aspect-ratio lock for the boundary box. A toggle button (in `PaintToolbar.svelte`, next to the existing boundary-box width/height fields from the original boundary-box work) that captures the box's current `width/height` ratio when turned on. While locked, `BoundaryBoxOverlay.ts`'s corner-drag resize (`dragBox()`) must derive the non-dragged dimension from the dragged one to preserve that ratio, still going through the existing `snap()` (8px) logic — don't bypass or duplicate the snapping, extend `dragBox()`'s existing corner-mode branches so the locked axis is computed from the free axis post-snap. The existing manual width/height number inputs (if present in `PaintToolbar.svelte` from the original boundary-box task) should also respect the lock: editing one field while locked recomputes the other. Body/move drag is unaffected by the lock (only resize is constrained). | Codex (gpt-5.6-sol) |
| T37 | Quick-swap button next to the boundary-box width/height controls: swaps the box's `width`/`height` values in one `setBoundaryBox` mutation (so it's a single undo entry, consistent with how drag-end already commits one mutation per gesture), keeping `x`/`y` (top-left) fixed. Already-grid-aligned inputs stay grid-aligned after a swap (swapping two multiples of 8 is still a multiple of 8, no re-snap needed). | Codex (gpt-5.6-sol) |
| T38 | Tests: Playwright coverage for T33 (live mask stroke preview uses the hatch filter/color, not raw paint color — e.g. read back a pixel from the live (not yet committed) canvas mid-stroke and assert it matches the expected tinted/hatched output rather than the raw brush color), T35 (mode switching, Auto-computed size updates when the box changes, target fields present/absent in the POST body per mode, video-model warning shown), T36 (locked corner-drag preserves ratio within snap tolerance), T37 (swap button swaps values, position unchanged). Also add a unit test (Vitest, if configured, or a small standalone Playwright/`node --test` check — developer's call on which is less friction given the current toolchain) for T34's Auto-resolution formula directly against the worked example (300x400 @ native 1024 -> 896x1152) plus a couple of edge cases (square box, box already larger than native resolution). Extend `frontend/tests/e2e/ultra-paint.spec.ts` additively, keep all existing tests passing. | Codex (gpt-5.6-sol) |

| Frontend task | Status |
|---|---|
| T32 | **Done** — added dedicated mask eraser/export coverage in `frontend/tests/e2e/ultra-paint.spec.ts`; live Chromium testing exposed and fixed PixiJS root-level erase blending by collecting the eraser sprite under a neutral preview root and copying the finished preview in `frontend/src/paint/ConsistentOpacityStroke.ts`. |
| T33 | **Done** — moved the single `MaskHatchFilter` attachment from the persistent sprite to the mask node's owning container in `frontend/src/scene/LayerNode.ts`, so brush overlays and eraser replacement previews inherit the same color/hatch without mask-specific paint-engine setup. Verified by mid-pointer screenshot pixel readback before commit. |
| T34 | **Done** — added rune-backed None/Auto/Manual state in `frontend/src/state/generationSettingsStore.svelte.ts` and the configurable-step, wide/tall floor+round native-area formula in `frontend/src/util/autoResolution.ts`; extended the existing options fetch for all three backend fields in `frontend/src/ui/GenerationPanel.svelte`. |
| T35 | **Done** — added scale-mode/manual/auto controls, live boundary-driven Auto readout, Wan/video warning, and conditional `target_width`/`target_height` request fields in `frontend/src/ui/GenerationPanel.svelte`; updated `frontend/tests/fixtures/options.json` for the backend fields. |
| T36 | **Done** — added captured aspect-lock state in `frontend/src/state/paintToolStore.svelte.ts`, lock-aware width/height editing in `frontend/src/ui/PaintToolbar.svelte`, and dominant-axis post-snap corner constraints in `frontend/src/scene/BoundaryBoxOverlay.ts`; move dragging remains unchanged. |
| T37 | **Done** — added the width/height swap control in `frontend/src/ui/PaintToolbar.svelte`; it preserves `x`/`y` and performs exactly one `LayerStore.setBoundaryBox()` mutation. |
| T39 | **Done** — corrected `frontend/src/scene/PixelGrid.ts` zoom-tier spacing to 64px below 150%, 32px from 150% to below 200%, and 8px at 200%+. |
| T40 | **Done** — added bottom-left viewport controls in `frontend/src/ui/ViewportControls.svelte`, additive camera/grid APIs in `frontend/src/app/UltraPaintApp.ts`, and grid visibility in `frontend/src/scene/PixelGrid.ts`; updated `frontend/src/App.svelte` layout and extended `frontend/tests/e2e/ultra-paint.spec.ts` from 15 to 18 live Chromium tests. |
| T41 | **Done (Claude)** — new `ultra_paint/interrupt_api.py` (`shared.state.interrupt()`, mirrors the stock UI's own Interrupt button) plus `scripts/ultra_paint_interrupt_api.py` registering `POST /ultra_paint/api/interrupt`; `GenerationPanel.svelte` gained a cancel (×) button that POSTs to it. The X button is always in the DOM (never `{#if}`-conditional) and toggled via `visibility`/`aria-hidden`/`tabindex`, not presence, specifically so the Generate button's own `flex-1` width never changes when the X appears/disappears — a conditionally-rendered sibling would have shrunk Generate's share of the row the moment it showed up. New backend tests: `tests/test_interrupt_api.py`; full pytest suite now 60, all passing. New Playwright test "cancel button interrupts generation without resizing the Generate button" (stalls the generate route until the interrupt route fires, asserts the button's `boundingBox().width` is identical idle vs. mid-generation, and that the interrupt endpoint is actually hit); full e2e suite 18/18 passing. `npm run typecheck`/`npm run build` both clean. Landed concurrently with T39/T40 in the same working tree (no worktree isolation) without file-content conflicts — `frontend/tests/e2e/ultra-paint.spec.ts` picked up both this task's and T40's new tests cleanly since they were appended at different points in the file — but a stale/incomplete file read of that shared spec file during Codex T40's concurrent write did produce one confusing transient test-run failure that resolved on a clean re-run; worth avoiding true concurrent dispatch onto the same spec file next time this happens, even though it worked out here. |

### Phase 3 follow-up round 2 (developer, 2026-08-24) — T39-T41

Three small, independently-scoped tweaks, dispatched in parallel to avoid
blocking on the T32-T38 formula-correction resume (which was still in flight
at dispatch time, touching `autoResolution.ts`/`generationSettingsStore.svelte.ts`/
`GenerationPanel.svelte`/`PaintToolbar.svelte`/`BoundaryBoxOverlay.ts`/
`LayerNode.ts`) — T39/T40 below were scoped to avoid those exact files.

| Task | What | Owner |
|---|---|---|
| T39 | Grid zoom-tier resizing. `frontend/src/scene/PixelGrid.ts`'s `spacingForZoom()` currently maps zoom -> spacing the opposite way round from what's wanted (finer grid the more zoomed OUT). New mapping, per the developer: zoom 100% -> 64px, 150% -> 32px, 200% -> 8px, i.e. `zoom < 1.5 -> 64`, `1.5 <= zoom < 2.0 -> 32`, `zoom >= 2.0 -> 8`. Everything else in the file (extent calc, opacity, line width, the `onRender` change-detection guard) is unchanged. | Codex (gpt-5.6-luna) |
| T40 | New bottom-left-of-canvas viewport control bar: current-zoom button (click resets to 100%), fit-to-boundary-box button (zoom so the boundary box fills as much of the viewport as possible with 8 screen px of padding on every side), grid-visibility toggle button. New Svelte component (e.g. `ui/ViewportControls.svelte`), absolutely positioned bottom-left inside `#upaint-root`'s wrapper in `App.svelte` (that wrapper needs `position: relative` if it doesn't have it already — check before assuming). Needs new additive public surface on `UltraPaintApp` (`frontend/src/app/UltraPaintApp.ts`): a way to read current zoom reactively (a plain `getZoom(): number` polled via `requestAnimationFrame` from the new component is fine, no new store required, unless a cheap hook already exists — check `PixelGrid`'s own `container.onRender` pattern for prior art before inventing a second mechanism), a `resetZoom()` or `setZoom(scale, anchor)` that recenters on the current viewport-center document point (not a hard jump), a `fitToBoundaryBox(paddingPx)` using the same `world.scale`/`world.position` math as `centerDocument()`/`handleWheel()`, and `setGridVisible(visible)`/`isGridVisible()` (currently `PixelGrid` has no visibility toggle at all — add one, e.g. `container.visible`). **Explicitly avoid editing** `PaintToolbar.svelte`, `GenerationPanel.svelte`, `BoundaryBoxOverlay.ts`, `LayerNode.ts`, and `autoResolution.ts`/`generationSettingsStore.svelte.ts` — those are owned by the concurrently-running T32-T38 formula-correction resume; touching them risks clobbering that work. | Codex (gpt-5.6-terra) |
| T41 | Generate-cancel button. Next to the existing Generate button in `GenerationPanel.svelte`, an X icon button appears only while `generating` is true, calling Forge's existing interrupt mechanism (new backend route, see below) — Generate's own button width must not change when the X appears/disappears (size the X as an adjacent sibling, not by growing/shrinking the Generate button itself). | Claude |

**Note for T40:** since T32-T38 is a separate in-flight Codex session working
in the same working tree (no git-worktree isolation), T40 was told to avoid
every file that session touches. If T40 finishes first, double-check
`App.svelte` didn't drift from what T32-T38 assumed before that session's own
PLAN.md update lands.
| T38 | **Done** — extended `frontend/tests/e2e/ultra-paint.spec.ts` additively from 7 to 14 tests, covering the pure Auto formula, mask erasing, live hatch preview, all scale request shapes, video warning, locked resize/input behavior, and swap position. Final verification: `npm run typecheck` 0 errors/0 warnings; `npm run build` clean (847 modules); `npm run test:e2e` 14 passed, 0 failed. |

Suggested order: T32 (quick, independent) · T33 (independent, fixes a real bug)
· T34 -> T35 -> T38's T35 coverage · T36 -> T37 -> T38's T36/T37 coverage. T33
and T34-T37 don't depend on each other and can be done in either order within
one Codex session.

### Phase 3 follow-up round 3 (developer, 2026-08-25) — T42

| Task | What | Owner |
|---|---|---|
| T42 | Layer workflow improvements: add robust multi-selection to `LayerStore` and `LayerPanel.svelte` with normal/Shift/Ctrl/Cmd selection semantics; make right-click hide/show and delete operate on the selected compatible set; merge selected top-level raster layers or rendered groups into a new raster layer while preserving originals and document-space coordinates; copy one textured raster, mask, or control layer to the native clipboard as PNG with graceful unsupported/error feedback. | Codex (gpt-5.6-sol) |
| T43 | Canvas-only image paste: attach a `paste` handler directly to the focusable Pixi canvas, import the first `image/*` item as a selected raster layer through `addImageFromFile()`, and prevent default only when an image was handled so prompt/other text-field pastes retain native behavior. Add focused Playwright coverage for both targets. | Codex |

**T42: DONE, 2026-08-25.** Changed only `frontend/src/state/layerStore.svelte.ts`,
`frontend/src/ui/LayerPanel.svelte`, and `frontend/src/app/UltraPaintApp.ts`;
`PLAN.md` was then updated with this entry. Merge uses the existing GPU compositor,
inserts above the highest selected layer, and leaves source layers intact. Copy
uses the native `ClipboardItem` API and reports encoding/permission failures in
the panel. Verification: `npm run typecheck` passed with 0 errors/warnings,
`npm run build` passed, and `git diff --check` passed.

**T43: DONE, 2026-08-25.** Image paste is scoped to the focusable Pixi canvas
only: its `paste` listener imports the first `image/*` clipboard item through the
existing `addImageFromFile()` path, selects the created layer, and prevents the
browser default only for an actual image. Prompt and other text-field paste events
are untouched. Added a focused Playwright check that proves a prompt-targeted image
paste is not consumed while the focused canvas receives the same image as a layer.
Updated the existing blank/mask test helpers to use the current `+` menu's
"Raster Layer" / "Mask Layer" actions. Final verification: `npm run typecheck`
passed with 0 errors/warnings, `npm run build` passed, `npm run test:e2e` passed
24/24, and `git diff --check` passed.

---

## 8. Research notes worth keeping (verified against this fork's actual source, not upstream A1111 docs)

- **Tab registration**: `modules/script_callbacks.py:473-483` `on_ui_tabs(callback)`,
  callback must return a **list** of `(component, title, elem_id)` tuples (a bare
  tuple gets spliced as loose scalars and breaks the unpack in `modules/ui.py:883`).
- **GPU work must run via** `modules_forge.main_thread.run_and_wait_result(...)` —
  never directly on the Gradio/FastAPI request thread. Non-negotiable.
- **`p.script_args` must be a full-length list** matching every alwayson script's
  `args_from:args_to` slice (filled with each control's default `.value`), or
  alwayson scripts (ControlNet etc.) crash on missing args even when not actively used.
- **No single "native/recommended resolution" API** exists for the loaded model.
  Needs a lookup keyed on `shared.sd_model.is_sd1`/`.is_sdxl` (set per-subclass in
  `backend/diffusion_engine/*.py`, default `False` in `base.py:46-48`) with a
  `type(shared.sd_model).__name__` fallback for architectures with no dedicated flag.
- **Static JS/CSS auto-injection**: `modules/ui_gradio_extensions.py:14-27` auto-scans
  every extension's `javascript/*.js`/`*.mjs` and root `style.css` — no manual
  `StaticFiles` mount needed for a single bundled file. `canvas_head`-style `head=`
  injection (what `ForgeCanvas` uses) is core-only, not available to real extensions.

---

## Boundary box (Invoke-style operating region) — 2026-08-23

Supersedes the Phase 2.5 item 1 fixed document-size canvas controls. `Document` now
owns `boundaryBox: { x, y, width, height }`, which is the sole operating region for
Fill, Generate export, and newly created blank paint layers. The toolbar's precise
width/height fields resize that box while preserving its dragged position.

`frontend/src/scene/BoundaryBoxOverlay.ts` adds the topmost dotted, interactive
boundary guide. Its body and four corner handles are separate PixiJS federated hit
targets: body drags reposition the box, while handle drags reshape it with the
opposite corner fixed. `globalpointermove` keeps an active drag alive beyond the
original target and `pointerupoutside` completes an out-of-canvas release. Live
visuals update locally and one `setBoundaryBox` mutation is committed only when the
gesture ends, so each drag is one undo entry. A narrow native `pointercancel`
fallback handles browser cancellation not mapped by PixiJS 8.20. No
`Container.mask` is used.

`frontend/src/scene/Compositor.ts` crops export by temporarily translating the
document root by `(-box.x, -box.y)` into a box-sized render texture, then restoring
the root transform; this retains the defensive mask snapshot/null/restore but adds
no clipping primitive. Fill transforms the four box corners into the selected
layer's local texture coordinates, erases only that polygon, then renders the fill
polygon, preserving pixels outside the region even for transformed layers.

Files changed: `frontend/src/state/schema.ts`,
`frontend/src/state/layerStore.svelte.ts`, `frontend/src/app/UltraPaintApp.ts`,
`frontend/src/scene/Compositor.ts`, `frontend/src/scene/BoundaryBoxOverlay.ts`,
`frontend/src/ui/PaintToolbar.svelte`, and this `PLAN.md`.

Still explicitly out of scope: auto-growing/chunked infinite layer canvases;
StableDiffusion masking/inpainting backend wiring, `inpaint_full_res`, and
auto-scale-to-native-resolution; and any on-screen `Container.mask` clipping.
`npm run typecheck` and `npm run build` are verified clean for this change, but it
has not been live-browser-confirmed in this environment; boundary-box drag behavior
especially needs a real interactive test pass.

### Live-test fixes — 2026-08-24

Two regressions from the boundary-box work above, caught by the developer on first
real use:

- **Z-order**: `UltraPaintApp.flattenToDataURL()` detaches `tree.root` from `world`
  before compositing and reattaches it afterward via `parent.addChild(tree.root)`,
  which always appends as the *last* child — silently promoting layer content above
  `boundaryBoxOverlay.container` (added once at init, never touched again) after the
  first Generate call, permanently hiding the box behind new layers/images from then
  on. Fixed by reattaching with `parent.addChildAt(tree.root, 0)` instead, keeping
  `tree.root` always first (bottom) and the overlay always last (top).
- **Generate placement**: `addImageFromDataURL()` created the new layer at the
  default identity transform (x=0, y=0) via `LayerStore.addRasterLayer()`, so once
  `Compositor.flatten()` started cropping to `boundaryBox` instead of always the
  world origin, a generated image would land at world (0,0) instead of at the box's
  actual position — visibly detached whenever the box wasn't at the origin. Fixed by
  re-reading the document after `addRasterLayer()` returns and calling
  `store.setTransform(id, { x: doc.boundaryBox.x, y: doc.boundaryBox.y })` before
  resolving. `addImageFromFile()` (the upload path) was deliberately left untouched.

Files changed: `frontend/src/app/UltraPaintApp.ts` only. `npm run typecheck` and
`npm run build` pass clean; not live-browser-confirmed.

### Boundary-box tool gating and pixel grid — 2026-08-23

The boundary-box overlay now intercepts raw canvas pointer input only while the
new `"boundary-box"` `PaintTool` is active. `BoundaryBoxOverlay` receives the
shared `PaintToolStore` from `UltraPaintApp`, checks the live active tool before
hit testing, and otherwise lets brush, eraser, and pan input fall through. The
toolbar has a visually separated, right-aligned **Boundary Box** button (with a
box icon) that selects this mode; selecting Brush or Eraser switches away as
usual. `UltraPaintApp.beginStroke()` also explicitly declines this non-paint
tool, preventing the previous non-brush fallback from creating an eraser stroke.

`PixelGrid` is a new document-space background scene node, inserted as the first
child of `world` below the layer tree. It draws a low-opacity 8px grid within the
current boundary box and hides it below 75% zoom to keep zoomed-out views clear.
Boundary-box move and corner resize results now snap every position and extent to
8 document pixels; corner resizing maintains an 8px minimum and keeps both
corners on the grid.

Files changed: `frontend/src/scene/BoundaryBoxOverlay.ts`,
`frontend/src/scene/PixelGrid.ts` (new),
`frontend/src/state/paintToolStore.svelte.ts`,
`frontend/src/ui/PaintToolbar.svelte`, `frontend/src/app/UltraPaintApp.ts`, and
this `PLAN.md`. `npm run typecheck` and `npm run build` pass clean. This is not
live-browser-confirmed and needs a real interactive browser test pass for pointer
behavior, drag snapping, and grid visibility.

### Pixel-grid background decoupling — 2026-08-23

`frontend/src/scene/PixelGrid.ts` no longer reads the document boundary box or
subscribes to document mutations. It now draws a large background grid centered on
the document origin, using zoom tiers of 8px (at 100% and above), 32px (25% through
under 100%), and 64px (below 25%). Its render hook redraws only when the active tier
changes, and the tier-scaled extent keeps the line count bounded while following the
visible canvas at normal pan/zoom ranges. `UltraPaintApp.ts` was read but not changed:
its child order already places the grid below `tree.root` and the boundary-box overlay
above it. Files touched: `frontend/src/scene/PixelGrid.ts` and this `PLAN.md`.
Typecheck and production build are verified after this change; it has not been
live-browser-confirmed because no dev server is available in this environment.

### Grid-vs-layer z-order fix, and blank-layer positioning — 2026-08-24

Two more regressions caught live by the developer immediately after the grid landed:

- **Grid rendered above everything.** `world`'s children became
  `[pixelGrid, tree.root, boundaryBoxOverlay]` once `PixelGrid` was added as the
  first child, but `flattenToDataURL()`'s detach/reattach (see the 2026-08-24
  z-order fix above) still reinserted `tree.root` at hardcoded index 0 — which was
  correct back when `world` only had two children, but now landed layer content
  *below* the grid instead of above it, so any Generate call flipped the grid on
  top of all layer content from then on. Fixed by computing the reinsertion index
  dynamically (`pixelGrid.container`'s current index + 1) instead of a hardcoded
  `0`, so layer content always lands directly above the grid regardless of how
  many nodes sit below it.
- **Can't paint on a blank layer.** Same root cause as the earlier Generate-
  placement bug, just missed for this method: `addBlankLayer()` sizes the new
  texture to `boundaryBox.width/height` but never positioned the layer at
  `boundaryBox.x/y`, leaving it at the default identity transform (0,0). Once the
  box had been dragged away from the origin, a new blank layer would be created
  off in the wrong spot relative to what's visually inside the box, so painting
  "inside the box" landed on pixels outside the layer's texture (or just looked
  like nothing happened). Fixed by re-reading the document after
  `addRasterLayer()` returns and calling `store.setTransform(id, { x, y })` with
  the box's position, mirroring `addImageFromDataURL()`'s existing fix.

Files changed: `frontend/src/app/UltraPaintApp.ts` only (`flattenToDataURL()` and
`addBlankLayer()`). `npm run typecheck` and `npm run build` both verified clean.
Not live-browser-confirmed.

### Paint-target trace — 2026-08-23

Investigated the reported case of generated image A at one document position,
generated image B at a different position, B selected, then a brush stroke
appearing at A's local origin. **No source-level divergence matching that
report exists in the current frontend.** `GenerationPanel.svelte` awaits each
`addImageFromDataURL()` before selecting that exact returned id; the id is
already registered by `addRasterLayer()` before the method resolves, and
`LayerStore.setSelectedLayerId()` accepts it synchronously. The same store emit
stack synchronously invokes `LayerTree.reconcile()`: new nodes are constructed
and updated with their current transform before `addRasterLayer()`/
`setTransform()` returns. `StrokeController` has no pointer hit-test or
reseletion path and reads the selected id at pointerdown; `BrushEngine` then
looks up that id's current node and texture together.

Verified directly against the installed PixiJS v8.6.6 source that
`Container.toLocal()` defaults `skipUpdate` to false and recomputes the local
transform through the complete parent chain. A direct installed-package check
with a newer layer at x=640 mapped document point (740, 25) to (100, 25) in
that newer layer and (740, 25) in the older origin layer, so there is no
one-frame stale-world-transform path either. The source also does not share
render textures between raster layers. Consequently, no speculative frontend
fix was applied; changing any of these paths would not correct the observed
result. The remaining unverified boundary is the live runtime event/state
sequence, which needs browser instrumentation or reproduction.

Files touched: `PLAN.md` only. `npm run typecheck` and `npm run build` both
passed clean. This investigation is not live-browser-confirmed.

### Brush commit-render root cause, and a deferred infinite-canvas decision — 2026-08-24

The "paint doesn't persist" bug above was eventually root-caused via a live local
repro (outside this environment): a direct Fill persisted correctly on the same
translated layer, proving the layer's texture itself was valid/writable — so the
defect was isolated specifically to the brush's preview-to-commit path in
`frontend/src/paint/ConsistentOpacityStroke.ts`. `end()` was reusing `strokeSprite`
— the same `Sprite` that had just been parented into `layerContainer` as the live
drag preview (`addPoints()`'s `livePreview: "overlay"` branch) — for the final
standalone commit render (`renderer.render({container: strokeSprite, target:
this.target})`) after removing it from the scene. Despite that standalone render
call only reading the sprite's own local transform (never its former ancestry),
a sprite that has previously participated in a normal per-frame scene render
apparently carries stale render/transform state into a later standalone render in
this PixiJS v8 build, corrupting the commit. **Fixed**: `end()` now builds a
fresh, never-parented `Sprite` (same `strokeTexture`, alpha, and blend mode) for
the commit render only, then destroys it — `strokeSprite` is now used exclusively
for the live overlay preview and never reused for anything else. This explains
why the very first stroke of a session (on a layer that had never been previewed
via the overlay path yet) could appear to work while later strokes silently
failed to persist, and why the failure tracked "layer has been drawn on before"
rather than any position/boundary-box state. File touched:
`frontend/src/paint/ConsistentOpacityStroke.ts`. `npm run typecheck` and
`npm run build` pass clean; not yet live-browser-confirmed — next repro should
specifically re-test the original "paint on a fresh blank layer inside a moved
box" case this whole investigation started from.

### Phase 2.75 — Playwright e2e infrastructure landed — 2026-08-24

§6b's plan executed. Playwright is now wired into `frontend/` as a devDependency
(`@playwright/test`) with a `test:e2e` script, `frontend/playwright.config.ts`
(`webServer` runs `npm run dev`, `baseURL` matches Vite's hardcoded
`/ultra_paint/app/` base exactly, `reuseExistingServer: true`), and one spec file
`frontend/tests/e2e/ultra-paint.spec.ts` with the four representative tests from
the plan: an app-loads/zero-console-errors smoke test, a paint round-trip that
asserts non-transparent pixel data via `flattenToDataURL()`, a boundary-box
corner-drag test asserting the store snapped to the 8px grid, and a Generate flow
test (using `page.route()` fixtures for `options`/`generate`/`progress`) that
asserts the new layer lands at the boundary box's position. Fixtures live in
`frontend/tests/fixtures/{options,generate}.json`, each with a header comment
documenting the accepted gap: route interception never exercises the real
FastAPI handlers' base64/error-path logic — a small stub server is the
documented fallback if that gap ever bites, not built now. `frontend/src/main.ts`
gained a dev-only `window.__ultraPaintTest` hook (`import.meta.env.DEV`-gated,
dead-code-eliminated from production builds) exposing
`getActiveUltraPaintApp`/`layerStore`/`paintToolStore` for the tests to reach
into.

**Real, live-executed verification — a first for this session's testing infra:**
`npm run typecheck` (784 files, 0 errors) and `npm run build` both pass clean.
`npx playwright install chromium` genuinely downloaded and installed Chromium
151.0.7922.34 (~700MB across the browser, headless-shell, ffmpeg, and winldd
components landed under `%LOCALAPPDATA%\ms-playwright`) — the install command
itself reported a spurious `exit 1` after a long stall with no further output,
but the browsers were confirmed fully present on disk regardless. `npm run
test:e2e` (`playwright test`) then ran for real: **4 passed, 0 failed**, all
four tests above, in 7.5s.

One real bug surfaced and was fixed during this live run: the fixture imports
(`import generateFixture from "../fixtures/generate.json"`) initially threw
`TypeError: Module ".../generate.json" needs an import attribute of "type:
json"` under Node's ESM loader — Playwright's Node-native test runner requires
the `with { type: "json" }` import-attribute syntax for JSON imports; without
it, `playwright test` reported "No tests found" rather than a useful error.
Fixed by adding `with { type: "json" }` to both fixture imports in
`ultra-paint.spec.ts`. Everything else in the plan's file set (`package.json`,
`playwright.config.ts`, the fixtures, the `main.ts` hook, the spec's four test
bodies) needed no changes.

**To run locally:** `cd frontend && npx playwright install chromium` (one-time,
~700MB), then `npm run test:e2e`. The dev server starts automatically via
Playwright's `webServer` config; no separate `npm run dev` needed first unless
one is already running (in which case it's reused).

Files touched: `frontend/package.json`, `frontend/playwright.config.ts` (new),
`frontend/tests/e2e/ultra-paint.spec.ts` (new), `frontend/tests/fixtures/
{options,generate}.json` (new), `frontend/src/main.ts`.

**Separately, a real product question surfaced during this investigation, deliberately deferred rather than solved by a quick patch:** moving the boundary box does not move any already-existing layer, so painting on an older, already-positioned layer while the box sits elsewhere lands in the wrong place relative to what's visually inside the box today. The developer's stated preference is for paintable layers to dynamically expand/reposition to follow strokes wherever they're drawn — i.e., a real infinite/sparse-chunk canvas per layer, explicitly modeled on Invoke's approach (chunk-based on-demand texture allocation, viewport-culled rendering, near-zero cost for untouched regions) — rather than a simpler "moving the box also translates the selected layer" compromise. The developer is explicitly unsure of the performance/feasibility tradeoffs and asked to hold off implementing either option now. **Not implemented.** Current behavior stays as-is (box and layers move independently; a layer must be repositioned manually, e.g. by recreating it, to align with a relocated box). This needs a dedicated research/design pass — chunk sizing, per-chunk undo/history interaction, viewport culling, and Compositor/Fill's polygon-clipping math all need to be rethought for a non-monolithic-texture layer model — before any implementation work starts. Revisit alongside Phase 2.75's Playwright infrastructure, since this class of feature is exactly what needs real interactive test coverage rather than blind static changes.
