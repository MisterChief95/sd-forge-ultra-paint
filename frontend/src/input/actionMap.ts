import type { UltraPaintApp } from "../app/UltraPaintApp";
import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
import type { PaintTool } from "../state/paintToolStore.svelte";
import type { Layer } from "../state/schema";

export type InputActionMapId = "global" | "canvas" | PaintTool;

export type InputActionId =
  | "history.undo"
  | "history.redo"
  | "tool.brush"
  | "tool.eraser"
  | "tool.transform"
  | "tool.boundary-box"
  | "tool.swap-colors"
  | "viewport.fit"
  | "viewport.reset-zoom"
  | "viewport.toggle-grid"
  | "layer.fill"
  | "layer.add-mask"
  | "layer.clear-mask"
  | "layer.invert-mask"
  | "layer.toggle-visibility"
  | "layer.merge-selected"
  | "boundary.fit-to-mask"
  | "generation.generate"
  | "generation.cancel";

export interface InputAction {
  id: InputActionId;
  map: InputActionMapId;
  shortcut: string;
  matches(event: KeyboardEvent): boolean;
  run(app: UltraPaintApp): boolean;
  mutatesDocument?: boolean;
}

interface GenerationActions {
  isGenerating(): boolean;
  generate(): void;
  save(): void;
  cancelCurrent(): void;
  cancelRemaining(): void;
  cancelAll(): void;
}

let generationActions: GenerationActions | null = null;

/** Connect the generation panel to the global action map while it is mounted. */
export function registerGenerationActions(actions: GenerationActions): () => void {
  generationActions = actions;
  return () => {
    if (generationActions === actions) generationActions = null;
  };
}

export function saveGeneration(): boolean {
  if (!generationActions) return false;
  generationActions.save();
  return true;
}

function key(
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {},
): (event: KeyboardEvent) => boolean {
  return (event) =>
    event.key.toLowerCase() === value &&
    event.ctrlKey === (modifiers.ctrlKey ?? false) &&
    event.metaKey === (modifiers.metaKey ?? false) &&
    event.altKey === (modifiers.altKey ?? false) &&
    event.shiftKey === (modifiers.shiftKey ?? false);
}

function primaryKey(value: string, shiftKey = false): (event: KeyboardEvent) => boolean {
  return (event) =>
    event.key.toLowerCase() === value &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.shiftKey === shiftKey;
}

function selectedLayers(app: UltraPaintApp): Layer[] {
  const store = app.getStore();
  return store
    .getSelectedLayerIds()
    .map((id) => store.getLayer(id))
    .filter((layer): layer is Layer => layer !== undefined);
}

export const INPUT_ACTIONS: readonly InputAction[] = [
  {
    id: "history.redo",
    map: "global",
    shortcut: "Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y",
    matches: (event) => primaryKey("y")(event) || primaryKey("z", true)(event),
    run: (app) => (app.redo(), true),
    mutatesDocument: true,
  },
  {
    id: "history.undo",
    map: "global",
    shortcut: "Ctrl/Cmd+Z",
    matches: primaryKey("z"),
    run: (app) => (app.undo(), true),
    mutatesDocument: true,
  },
  {
    id: "boundary.fit-to-mask",
    map: "global",
    shortcut: "Ctrl/Cmd+Shift+B",
    matches: (event) => primaryKey("b", true)(event),
    run: (app) => app.fitBoundaryBoxToCompositeMask(8),
    mutatesDocument: true,
  },
  {
    id: "layer.clear-mask",
    map: "global",
    shortcut: "Shift+C",
    matches: key("c", { shiftKey: true }),
    run: (app) => app.clearSelectedMask(),
    mutatesDocument: true,
  },
  {
    id: "layer.invert-mask",
    map: "global",
    shortcut: "Shift+V",
    matches: key("v", { shiftKey: true }),
    run: (app) => app.invertSelectedMask(),
    mutatesDocument: true,
  },
  {
    id: "layer.add-mask",
    map: "global",
    shortcut: "Ctrl/Cmd+Shift+M",
    matches: (event) => primaryKey("m", true)(event),
    run: (app) => {
      void app
        .addBlankMaskLayer()
        .then((id) => app.getStore().setSelectedLayerId(id))
        .catch((error) => console.error("[ultra-paint] could not add a mask layer:", error));
      return true;
    },
    mutatesDocument: true,
  },
  {
    id: "layer.merge-selected",
    map: "global",
    shortcut: "Ctrl/Cmd+E",
    matches: (event) => primaryKey("e")(event),
    run: (app) => {
      const layers = selectedLayers(app).filter(
        (layer) => layer.kind === "raster" || layer.kind === "group",
      );
      if (layers.length < 2) return false;
      try {
        app.mergeLayersToNewLayer(layers.map((layer) => layer.id));
        return true;
      } catch (error) {
        console.error("[ultra-paint] merge shortcut failed", error);
        return false;
      }
    },
    mutatesDocument: true,
  },
  {
    id: "generation.generate",
    map: "global",
    shortcut: "Ctrl/Cmd+Enter",
    matches: (event) => primaryKey("enter")(event),
    run: () => {
      if (!generationActions) return false;
      generationActions.generate();
      return true;
    },
  },
  {
    id: "generation.cancel",
    map: "global",
    shortcut: "Escape",
    matches: key("escape"),
    run: () => {
      if (!generationActions?.isGenerating()) return false;
      generationActions.cancelCurrent();
      return true;
    },
  },
  {
    id: "layer.fill",
    map: "canvas",
    shortcut: "Shift+F",
    matches: key("f", { shiftKey: true }),
    run: (app) => {
      const selectedId = app.getStore().getSelectedLayerId();
      if (!selectedId || app.getStore().getLayer(selectedId)?.kind !== "raster") return false;
      app.fillSelectedLayer();
      return true;
    },
    mutatesDocument: true,
  },
  {
    id: "layer.toggle-visibility",
    map: "canvas",
    shortcut: "H",
    matches: key("h"),
    run: (app) => {
      const layers = selectedLayers(app);
      if (layers.length === 0) return false;
      const visible = !layers.every((layer) => layer.visible);
      for (const layer of layers) app.getStore().setVisible(layer.id, visible);
      return true;
    },
    mutatesDocument: true,
  },
  {
    id: "viewport.fit",
    map: "canvas",
    shortcut: "F",
    matches: key("f"),
    run: (app) => (app.fitToBoundaryBox(8), true),
  },
  {
    id: "viewport.reset-zoom",
    map: "canvas",
    shortcut: "0",
    matches: key("0"),
    run: (app) => (app.resetZoom(), true),
  },
  {
    id: "viewport.toggle-grid",
    map: "canvas",
    shortcut: "G",
    matches: key("g"),
    run: (app) => (app.setGridVisible(!app.isGridVisible()), true),
  },
  {
    id: "tool.brush",
    map: "global",
    shortcut: "B",
    matches: key("b"),
    run: (app) => (app.getToolStore().setActiveTool("brush"), true),
  },
  {
    id: "tool.eraser",
    map: "global",
    shortcut: "E",
    matches: key("e"),
    run: (app) => (app.getToolStore().setActiveTool("eraser"), true),
  },
  {
    id: "tool.transform",
    map: "global",
    shortcut: "V",
    matches: key("v"),
    run: (app) => (app.getToolStore().setActiveTool("transform"), true),
  },
  {
    id: "tool.boundary-box",
    map: "global",
    shortcut: "R",
    matches: key("r"),
    run: (app) => (app.getToolStore().setActiveTool("boundary-box"), true),
  },
  {
    id: "tool.swap-colors",
    map: "brush",
    shortcut: "X",
    matches: key("x"),
    run: (app) => (app.getToolStore().swapColors(), true),
  },
];

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
      null
  );
}

/** Resolve the first matching, currently available action. */
export function handleInputKeyDown(event: KeyboardEvent, app: UltraPaintApp | null): boolean {
  if (!app || event.defaultPrevented || event.repeat || isEditableTarget(event.target))
    return false;
  const activeMaps = new Set<InputActionMapId>(["global", "canvas", app.getToolStore().activeTool]);
  const action = INPUT_ACTIONS.find(
    (candidate) => activeMaps.has(candidate.map) && candidate.matches(event),
  );
  if (!action) return false;
  if (action.mutatesDocument && isDocumentMutationLocked()) return false;
  try {
    if (!action.run(app)) return false;
  } catch (error) {
    console.error(`[ultra-paint] input action "${action.id}" failed`, error);
    return false;
  }
  event.preventDefault();
  return true;
}
