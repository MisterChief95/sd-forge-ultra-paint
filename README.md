# Ultra Paint for Forge Classic

Ultra Paint adds a layer-based painting and generation workspace to
`sd-webui-forge-classic`. Paint, import images, build masks and ControlNet guides,
then generate directly through Forge's existing models and processing pipeline.

The workspace runs in an iframe inside the **Ultra Paint** tab. **Pop Out** opens
it in a full-window browser tab connected to the same Forge server.

## Installation

This source checkout requires a frontend build. There is no automatic bundle
download or build on extension startup.

1. Place this repository at
   `sd-webui-forge-classic/extensions/sd-forge-ultra-paint/`.
2. Install Node.js and npm for the build. Node.js 22 is used by this repository's CI.
3. From the extension directory, run:

   ```bash
   cd frontend
   npm ci
   npm run build
   ```

4. Restart Forge and open the **Ultra Paint** tab.

The build creates `frontend/dist/`, which Forge serves at `/ultra_paint/app/`.
Node.js is needed to build the frontend, but not to run a built extension.
After updating the source, rebuild the frontend and restart Forge.

This extension targets Forge Classic. Compatibility with other WebUI forks is
not established by this repository. It uses Forge's Python environment; do not
install it as a separate Python package. Ultra Paint's own routes do not require
Forge's `--api` flag.

## What you can do

- **Paint in layers:** raster, group, mask, and ControlNet layers; opacity, blend
  modes, visibility, locking, preserve-alpha painting, reordering, and merging.
  Pixel layers use sparse tiles that allocate as you paint.
- **Use brush and eraser tools:** size, hardness, opacity, pen pressure, smoothing,
  an eyedropper, and primary/secondary colors. Fill applies to a raster layer
  within the boundary box.
- **Build inpaint masks:** paint coverage with a hatch preview or use polygonal
  and freehand lasso tools on a mask layer. Clear or invert masks and fit the
  boundary box to mask coverage.
- **Position layers:** move, rotate, scale, and mirror one selected layer with
  undoable transforms.
- **Generate and refine:** txt2img, img2img, inpainting, automatic outpainting,
  soft inpainting when available, and ring or gradient coherence passes.
- **Control generation:** model and VAE/text encoder selection, LoRAs, prompts,
  styles, sampler/scheduler, seeds, resolution scaling, and a FIFO job queue with
  progress, live previews, and cancellation.
- **Guide with ControlNet:** paint or import control layers, choose their models
  and guidance settings, or use canvas-wide inpaint ControlNet. The layer Filter
  command previews a ControlNet preprocessor before applying its result.
- **Upscale:** upscale the boundary region with a size multiplier, denoising,
  an upscaler choice, and optional sampling overrides.
- **Keep an editable project:** download/open `.uproj` files and restore the
  latest backend autosave after a reload.

The generation and layer panels resize and collapse. On narrower screens they
open as drawers over the canvas. Panel layout and generation section order
persist between sessions.

## Basic workflow

1. Paint on a raster layer, or import/paste an image. Use the layer panel to add
   raster, mask, group, or ControlNet layers.
2. Set the **Boundary Box** to the region you want to work on. It defines the
   region exported for generation, upscale, and Save Image.
3. Choose your model, prompts, and sampling settings in the generation panel.
   An empty region uses txt2img; existing image content uses img2img. Paint a
   mask to regenerate selected areas.
4. Click **Generate**. Additional clicks queue jobs using the canvas and settings
   captured at submission time. Each job produces one image.
5. Review the generated previews. Toggle a preview to compare it with the canvas,
   apply it as a new layer, save the selected preview, or discard it. Document
   edits stay locked while a preview is selected or a layer filter is active.
6. Use **Save Image** for a flattened output, or **Project → Save Project** to
   keep editing later.

To outpaint, extend the boundary box into transparent space beside opaque image
content and generate. The backend masks fully transparent pixels and seeds them
with a content-aware fill. That mask is combined with any painted mask, so both
regions can be regenerated in the same pass.

## Saving and recovery

| Action                        | What it saves                                                                            | Where it goes                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Save Image** in the top bar | Flattened visible raster content inside the boundary box                                 | Forge's configured Save output directory and image format |
| **Save selected preview**     | The selected generated image                                                             | Forge's configured Save output directory and image format |
| **Project → Save Project**    | Editable document, tile pixels, masks, groups, transforms, and ControlNet layer settings | A downloaded `.uproj` archive                             |
| **Project → Open Project**    | Replaces the current document with a saved project                                       | Loaded in the browser                                     |
| Autosave                      | Latest editable document checkpoint                                                      | `data/autosave/` on the Forge server                      |

Autosave restores before the canvas scene and undo history start. It also saves
when the workspace becomes hidden. It is a **single slot shared by clients of
this extension**, not a project library or a version history; keep `.uproj`
downloads for projects you want to retain. Undo history and generation settings
are not part of a project archive.

Generation panel settings are stored separately in
`data/generation-settings.json`; the file and directory are created on save.
Device preferences such as pressure tuning, smoothing, and touch mode, plus panel
layout, are stored in the browser's localStorage. Prompt styles use Forge's own
style database, so editing them also changes the styles available in Forge.

**Pop Out** saves the document and generation settings before handing off and
freezes the embedded copy. **Bring Back Here**, or closing the popped-out tab,
returns the iframe to the saved workspace. If the browser loses its graphics
context, the canvas freezes behind a reload prompt; recovery uses the last
successful autosave.

## Pen, touch, and shortcuts

Pen input supports pressure, the eraser end, and barrel-button color sampling.
The brush options include pressure controls and a pressure/smoothing popover.
Settings provides device preferences and touch mode.

Two fingers pan and pinch-zoom; a quick two-finger tap undoes, and a three-finger
tap redoes. In the default **Auto** touch mode, one finger paints until a pen has
been used, then pans. Touches during or shortly after pen activity are ignored
for palm rejection. Long-press a layer row to open its menu.

| Shortcut                               | Action                                                      |
| -------------------------------------- | ----------------------------------------------------------- |
| `B` / `E` / `V` / `R`                  | Brush / eraser / layer transform / boundary box             |
| Hold `Alt`                             | Temporarily sample a color                                  |
| Hold `Space` or drag with middle mouse | Pan                                                         |
| `[` / `]`                              | Decrease / increase brush size                              |
| `X`                                    | Swap brush colors                                           |
| `F` / `0` / `G`                        | Fit boundary box / reset zoom / toggle grid                 |
| `Shift+F`                              | Fill selected raster layer                                  |
| `Ctrl/Cmd+Z`                           | Undo                                                        |
| `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y`     | Redo                                                        |
| `Ctrl/Cmd+Enter`                       | Generate, including from a prompt field                     |
| `Escape`                               | Cancel an active lasso, otherwise cancel current generation |
| `Enter` with Lasso active              | Close the lasso loop                                        |
| `Ctrl+Up` / `Ctrl+Down` in a prompt    | Increase / decrease prompt weight                           |

Canvas shortcuts are suppressed while typing in text fields, except Generate.
Tooltips show shortcuts, and toolbar controls provide keyboard-free access.

## Optional integrations

### ControlNet and soft inpainting

ControlNet features require a compatible ControlNet installation and its models.
Soft inpainting requires its Forge script. The backend reports availability and
the frontend hides unavailable feature controls. These integrations are optional
for ordinary painting and generation.

### Outpaint fill

Outpainting uses `simple-lama-inpainting` if it is available in Forge's Python
environment. Otherwise, or if LaMA fails, it falls back to OpenCV inpainting.
LaMA retries on CPU after a GPU out-of-memory error. No extra installation is
required to use the fallback.

### Prompt tag completion

Place a tag CSV at `data/tags.csv` in the extension directory and enable tag
autocomplete in Settings. It uses TAC-format rows:

```csv
blue_hair,0,12345,"azure_hair,blue-haired"
```

The columns are tag name, category, count, and a quoted comma-separated alias
list. Suggestions start after two characters; use arrow keys to navigate and
Enter or Tab to insert. Without the CSV, prompts still work normally.

### Third-party generation controls

Enabled Forge extensions can expose controls in Ultra Paint's **Extensions**
section by supplying an `upaint.json` file in their extension root. Controls map
to an existing always-on Forge script; they do not register a new script.

See the [manifest schema](ultra_paint/schemas/upaint.schema.json), the
[NAG example](ultra_paint/schemas/examples/sd-forge-nag.upaint.json), and the
[integration rules in AGENTS.md](AGENTS.md#third-party-extension-controls).

## Current limits and troubleshooting

- **Missing or blank tab:** confirm `frontend/dist/index.html` exists, rebuild,
  and restart Forge. Startup logs warn when the build directory is missing.
- **Backend unavailable:** painting runs in the browser, but generation, Save
  Image, styles, settings persistence, and autosave need the Forge server.
- **Video models:** Wan/video generation is rejected; choose an image model.
- **Upscale guidance:** upscale jobs currently omit ControlNet layers and
  third-party extension values.
- **Lasso and transforms:** lasso edits mask coverage; it is not a general raster
  selection tool. The transform gizmo acts on one layer at a time.
- **Large workspaces:** tiled storage avoids one growing full-layer texture, but
  GPU memory and project/autosave upload limits still apply. Boundary box
  dimensions are capped at 8192 pixels per side.

## Development

The frontend is a Svelte 5 + PixiJS v8 Vite SPA. Python route shims in `scripts/`
load through Forge callbacks; reusable backend code lives in `ultra_paint/`.
See [AGENTS.md](AGENTS.md) for architecture, ownership, and contribution rules.

### Frontend

From `frontend/`:

```bash
npm ci
npm run dev
```

Open the Vite URL with `/ultra_paint/app/`. The dev server proxies
`/ultra_paint/api` and `/ultra_paint/data` to `http://127.0.0.1:7860` by default.
Set `ULTRA_PAINT_BACKEND` before starting it to use another Forge origin. This
development workspace uses the real backend's settings and autosave slot.

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright starts a separate Vite server on port 5179, points the proxy at a dead
origin, and uses mocked API routes. Browser tests do not exercise Forge or GPU
generation. `frontend/dist/` is generated and gitignored.

### Backend

Restart Forge after Python changes. For local checks, use a Python environment
with pytest, Ruff, and the dependencies imported by the tests:

```bash
python -m pytest
ruff check .
ruff format --check .
```

The pytest suite mocks Forge modules rather than requiring a running WebUI.
CI currently runs ESLint, Prettier, and Ruff; typecheck, builds, pytest, and browser
checks are separate local validation steps. Report live Forge validation
separately from static and mocked-browser checks.

## License

[AGPL-3.0](LICENSE).
