# System and architecture refactor suggestions

This document focuses on reusable patterns inside the app logic and scene/paint systems.

## 1) Shared raster tool engine abstraction

Files:
- `frontend/src/paint/BrushEngine.ts`
- `frontend/src/paint/EraserEngine.ts`

Observation:
- both engines do the same basic setup work
- each differs mainly in callback configuration and blending behavior

Suggested refactor:
- create a shared `RasterToolEngine` or `PaintToolEngine` base class
- provide a tool-specific config object such as:
  - `commitBlendMode`
  - `livePreview`
  - `previewTextureHook`
  - `strokeColor`

This would make future tools (clone, smudge, fill, magic wand, dodge/burn) easier to add without duplicating the same lifecycle logic.

## 2) Central tool session factory

Files:
- `frontend/src/paint/StrokeController.ts`
- `frontend/src/paint/BrushEngine.ts`
- `frontend/src/paint/EraserEngine.ts`

Observation:
- the stroke capture pipeline is already a useful abstraction
- tool-specific behavior is currently injected via `createSession`

Suggested refactor:
- keep `StrokeController` as the input/capture layer
- move tool session creation into a dedicated registry/factory map

Example:
- `toolFactories.brush`
- `toolFactories.eraser`
- `toolFactories.boundary-box`

This makes the tool system easier to reason about and scales better than a growing set of `if` / `switch` branches.

## 3) Reusable state controls and app commands

Files:
- `frontend/src/state/paintToolStore.svelte.ts`
- `frontend/src/app/UltraPaintApp.ts`

Observation:
- the app exposes both store state and imperative instance methods
- many parts of the UI reach into the singleton app for actions

Suggested refactor:
- create a clearer command/service layer that wraps global actions such as:
  - `fillSelectedLayer()`
  - `resizeBoundaryBox()`
  - `addImageFromFile()`
  - `addBlankLayer()`
- keep the UI focused on state and event handling instead of direct singleton app calls

This would make the app easier to test and easier to evolve into a more classic component/service model.

## 4) Distinguish pure view-model logic from Pixi concerns

Files:
- `frontend/src/app/UltraPaintApp.ts`
- `frontend/src/scene/LayerTree.ts`
- `frontend/src/state/layerStore.svelte.ts`

Observation:
- the project already partially separates document state from scene graph state
- several methods still mix document mutations, scene mutation, and UI concerns

Suggested refactor:
- make a small document-view-model layer for rules like:
  - selection behavior
  - layer ordering rules
  - boundary-box sizing constraints
  - validation and sanitization
- let scene/render code stay focused on Pixi composition and rendering logic

This would make state changes easier to test without involving the renderer.

## 5) Shared validation and formatting helpers

Files:
- `frontend/src/ui/PaintToolbar.svelte`
- `frontend/src/ui/GenerationPanel.svelte`
- `frontend/src/state/paintToolStore.svelte.ts`

Observation:
- value clamping and validation is repeated in multiple places
- formatting values as percentages/pixels/decimals is duplicated

Suggested refactor:
- add utility helpers such as:
  - `clamp(value, min, max)`
  - `toPercent`, `toPixels`, `parseNumberInput`
  - `sanitizeColorHex`

This is a small but high-leverage refactor because it reduces logic drift across controls.

## Recommended refactor order

1. `RasterToolEngine` / tool factory cleanup
2. shared validation and formatting helpers
3. clearer app command/service layer
4. document-view-model separation
5. full UI component decomposition after the above stabilizes

This order reduces complexity while improving the maintainability of both the draw pipeline and the UI.
