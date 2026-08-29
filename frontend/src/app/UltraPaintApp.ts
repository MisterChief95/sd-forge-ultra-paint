/**
 * sd-forge-ultra-paint -- top-level orchestrator.
 *
 * Owns the PixiJS `Application`, wires the `LayerStore` to a `LayerTree`, and
 * exposes the small imperative surface used by the Svelte UI (T19/T20/T21)
 * and (later) the Python bridge.
 *
 * Ownership, so nothing fights over the same objects:
 *   LayerStore  -> document state + texture lifetimes
 *   LayerTree   -> scene-graph structure (the only thing that adds/removes nodes)
 *   LayerNode   -> one layer's display objects
 *   Compositor  -> stateless render-to-PNG
 *   UltraPaintApp -> renderer lifecycle + canvas mounting + the public API
 *
 * Phase 2.R (T22): the DOM layer panel and paint toolbar are no longer
 * instantiated here -- they are Svelte components (`ui/LayerPanel.svelte`,
 * `ui/PaintToolbar.svelte`) mounted directly by `App.svelte` into
 * `#upaint-root-panel`/`#upaint-root-toolbar`. Those components read
 * `LayerStore`/`PaintToolStore` via the shared module singletons
 * (`layerStore`/`paintToolStore`, both reactive `$state` under the hood) and
 * reach the instance-bound methods (`addImageFromFile`, `addBlankLayer`, and
 * `fillSelectedLayer`) through {@link getActiveUltraPaintApp}
 * below, rather than through constructor-injected DOM ids.
 */

import {
  Application,
  Color,
  ColorMatrixFilter,
  Container,
  Filter,
  Graphics,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
} from "pixi.js";

import { Compositor } from "../scene/Compositor";
import { BoundaryBoxOverlay } from "../scene/BoundaryBoxOverlay";
import { BrushCursorOverlay } from "../scene/BrushCursorOverlay";
import { FilterPreviewOverlay } from "../scene/FilterPreviewOverlay";
import { GenerationPreviewOverlay } from "../scene/GenerationPreviewOverlay";
import { MagnifierOverlay } from "../scene/MagnifierOverlay";
import { PixelGrid } from "../scene/PixelGrid";
import { BrushEngine } from "../paint/BrushEngine";
import { EraserEngine } from "../paint/EraserEngine";
import { StrokeController, type StrokeSession } from "../paint/StrokeController";
import { LayerTree } from "../scene/LayerTree";
import {
  LayerStore,
  layerStore,
  type LayerStoreMutation,
  type Unsubscribe,
} from "../state/layerStore.svelte";
import {
  PaintToolStore,
  paintToolStore,
  type PaintTool,
  type PaintToolUnsubscribe,
} from "../state/paintToolStore.svelte";
import type { ImageRef, Layer, LayerId, Transform } from "../state/schema";
import { toHexColor } from "../util/color";

const HISTORY_LIMIT = 40;
const HISTORY_MERGE_WINDOW_MS = 500;

type BrushAdjustmentMode = "size-hardness" | "opacity";

interface ActiveBrushAdjustment {
  pointerId: number;
  mode: BrushAdjustmentMode;
  startClientX: number;
  startClientY: number;
  startRadius: number;
  startHardness: number;
  startOpacity: number;
  restingCursor: string;
}

/**
 * The most recently constructed `UltraPaintApp`, or `null` before one exists
 * / after it has been destroyed.
 *
 * Phase 2.R (T22): `App.svelte` constructs exactly one `UltraPaintApp` per
 * page (same one-instance-per-page assumption the `layerStore`/`paintToolStore`
 * module singletons already make). Sibling Svelte components
 * (`ui/LayerPanel.svelte`, `ui/PaintToolbar.svelte`) that need the
 * instance-bound methods (`addImageFromFile`, `addBlankLayer`, and
 * `fillSelectedLayer`) reach them
 * through {@link getActiveUltraPaintApp} rather than via props/context --
 * simpler than threading the instance through the component tree for a value
 * that is process-wide singleton in practice. Reactive layer/tool DATA still
 * comes from the `layerStore`/`paintToolStore` singletons directly, not from
 * this -- this is only for the handful of methods that live on the instance.
 */
let activeInstance: UltraPaintApp | null = null;

/** The active `UltraPaintApp` instance, or `null` if none has been constructed
 * yet (or it has since been destroyed). See {@link activeInstance}. */
export function getActiveUltraPaintApp(): UltraPaintApp | null {
  return activeInstance;
}

/** Options for {@link UltraPaintApp}. All optional; defaults suit the Forge tab. */
export interface UltraPaintAppOptions {
  /** Store to drive the canvas. Defaults to the shared module singleton. */
  store?: LayerStore;
  /** Paint-tool settings shared by the toolbar and stroke pipeline. */
  toolStore?: PaintToolStore;
  /** Canvas backdrop behind the document. Not included in exports. */
  background?: string;
  /** Override the renderer resolution. Defaults to `devicePixelRatio`. */
  resolution?: number;
}

export class UltraPaintApp {
  /** The PixiJS application. `null` until {@link ready} resolves. */
  public app: Application | null = null;

  /** Resolves once the renderer is initialised, mounted, and reconciled. */
  public readonly ready: Promise<void>;

  private readonly rootElementId: string;

  private readonly store: LayerStore;

  private readonly toolStore: PaintToolStore;

  private readonly options: UltraPaintAppOptions;

  private tree: LayerTree | null = null;

  private world: Container | null = null;

  /** Document-space pixel grid, below all layer content. */
  private pixelGrid: PixelGrid | null = null;

  /** Interactive operating-region guide, above all document content. */
  private boundaryBoxOverlay: BoundaryBoxOverlay | null = null;

  /** Unapplied generation preview shown over the document, above masks. */
  private generationPreviewOverlay: GenerationPreviewOverlay | null = null;

  /** Pending filter preview shown through its target layer's existing node. */
  private filterPreviewOverlay: FilterPreviewOverlay | null = null;

  /** Pointer-following brush/eraser size ring, above all document content. */
  private brushCursorOverlay: BrushCursorOverlay | null = null;

  private brushEngine: BrushEngine | null = null;

  private eraserEngine: EraserEngine | null = null;

  private strokeController: StrokeController | null = null;

  private history: UndoHistory | null = null;

  private viewportCanvas: HTMLCanvasElement | null = null;

  private viewportResizeObserver: ResizeObserver | null = null;

  private viewportPositioned = false;

  private panPointerId: number | null = null;

  private panClientX = 0;

  private panClientY = 0;

  private panRestingCursor = "";

  private brushAdjustment: ActiveBrushAdjustment | null = null;

  private brushAdjustmentHud: HTMLDivElement | null = null;

  /** Pixel-zoom loupe shown while the eyedropper tool is active. */
  private magnifierOverlay: MagnifierOverlay | null = null;

  /** Tool to restore when Alt is released after a temporary eyedropper switch. */
  private previousToolBeforeEyedropper: PaintTool | null = null;

  /** Last pointer position over the canvas, so the magnifier can show immediately on Alt-down. */
  private lastPointerEvent: PointerEvent | null = null;

  private unsubscribeToolStore: PaintToolUnsubscribe | null = null;

  private destroyed = false;

  constructor(rootElementId: string, options: UltraPaintAppOptions = {}) {
    this.rootElementId = rootElementId;
    this.options = options;
    this.store = options.store ?? layerStore;
    this.toolStore = options.toolStore ?? paintToolStore;
    activeInstance = this;
    // Constructors cannot be async; callers await `instance.ready`.
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const root = document.getElementById(this.rootElementId);
    if (!root) {
      throw new Error(`[ultra-paint] root element "#${this.rootElementId}" not found`);
    }

    // Advanced (filter-backed) blend modes default to filter resolution 1,
    // which visibly clips/downscales them on a high-DPI render target.
    // "inherit" makes them match the target resolution.
    Filter.defaultOptions.resolution = "inherit";

    const doc = this.store.getDocument();
    const app = new Application();

    await app.init({
      width: Math.max(1, root.clientWidth),
      height: Math.max(1, root.clientHeight),
      resizeTo: root,
      background: this.options.background ?? "#1e1e1e",
      antialias: true,
      autoDensity: true,
      resolution: this.options.resolution ?? window.devicePixelRatio ?? 1,
      eventFeatures: {
        click: true,
        move: true,
        globalMove: true,
        wheel: false,
      },
      // REQUIRED for advanced blend modes (overlay / color-burn /
      // color-dodge / hard-light) on the WebGL renderer -- without it
      // they silently fall back to `normal`.
      useBackBuffer: true,
    });

    if (this.destroyed) {
      // destroy() was called while init was in flight.
      app.destroy(true, { children: true });
      return;
    }

    this.app = app;

    app.canvas.style.display = "block";
    root.replaceChildren(app.canvas);

    this.tree = new LayerTree(this.store);
    this.world = new Container({ label: "ultra-paint:world" });
    this.viewportPositioned =
      root.clientWidth > 0 && root.clientHeight > 0 && this.centerDocument();
    this.pixelGrid = new PixelGrid(this.tree.root, this.store);
    this.world.addChild(this.pixelGrid.container);
    this.world.addChild(this.tree.root);

    this.boundaryBoxOverlay = new BoundaryBoxOverlay(
      app.canvas,
      this.tree.root,
      this.store,
      this.toolStore,
    );
    this.world.addChild(this.boundaryBoxOverlay.container);
    this.generationPreviewOverlay = new GenerationPreviewOverlay(
      this.store,
      this.tree,
      this.boundaryBoxOverlay,
    );
    this.world.addChild(this.generationPreviewOverlay.container);
    this.filterPreviewOverlay = new FilterPreviewOverlay(this.store, this.tree);
    this.brushCursorOverlay = new BrushCursorOverlay(
      app,
      app.canvas,
      this.tree.root,
      this.store,
      this.toolStore,
    );
    this.world.addChild(this.brushCursorOverlay.container);
    app.stage.addChild(this.world);
    this.mountViewportControls(app.canvas, root);
    this.history = new UndoHistory(app, this.store, this.tree, HISTORY_LIMIT);

    this.brushEngine = new BrushEngine(app, this.tree.root, this.tree, this.store);
    this.eraserEngine = new EraserEngine(app, this.tree.root, this.tree, this.store);
    this.strokeController = new StrokeController(
      app.canvas,
      app,
      this.tree.root,
      this.store,
      this.toolStore,
      this.beginStroke,
    );

    console.log(
      `[ultra-paint] renderer ready (${doc.boundaryBox.width}x${doc.boundaryBox.height}, ` +
        `${this.store.getDocument().layers.length} layers)`,
    );
  }

  /**
   * Recenter the camera if the layer being added is the document's first
   * (i.e. `addRasterLayer` just auto-sized `boundaryBox` to it). Must be
   * called with the layer count observed *before* the add, since
   * `addRasterLayer` mutates `boundaryBox` synchronously and the camera
   * would otherwise stay centered on the stale default box size.
   */
  private recenterIfFirstLayer(wasEmpty: boolean): void {
    if (wasEmpty) {
      this.viewportPositioned = this.centerDocument();
    }
  }

  /** Center the current document at its current zoom level in the viewport. */
  private centerDocument(): boolean {
    const app = this.app;
    const world = this.world;
    if (!app || !world || app.screen.width <= 0 || app.screen.height <= 0) {
      return false;
    }

    const doc = this.store.getDocument();
    const box = doc.boundaryBox;
    world.position.set(
      (app.screen.width - box.width * world.scale.x) / 2 - box.x * world.scale.x,
      (app.screen.height - box.height * world.scale.y) / 2 - box.y * world.scale.y,
    );
    return true;
  }

  private mountViewportControls(canvas: HTMLCanvasElement, root: HTMLElement): void {
    this.viewportCanvas = canvas;
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerleave", this.handlePointerLeave);
    canvas.addEventListener("pointerup", this.handlePointerEnd);
    canvas.addEventListener("pointercancel", this.handlePointerEnd);
    canvas.addEventListener("lostpointercapture", this.handlePointerEnd);
    canvas.addEventListener("auxclick", this.handleAuxClick);
    canvas.addEventListener("paste", this.handlePaste);
    canvas.tabIndex = 0;
    window.addEventListener("keydown", this.handleEyedropperKeyDown);
    window.addEventListener("keyup", this.handleEyedropperKeyUp);
    window.addEventListener("blur", this.handleWindowBlur);

    const hud = document.createElement("div");
    hud.setAttribute("role", "status");
    hud.style.cssText =
      "position:absolute;z-index:20;display:none;pointer-events:none;" +
      "padding:4px 7px;border:1px solid var(--upaint-border);" +
      "border-radius:var(--upaint-radius-sm);background:var(--upaint-surface);" +
      "color:var(--upaint-text);font:11px var(--upaint-font);" +
      "box-shadow:0 2px 8px rgb(0 0 0 / 35%);white-space:nowrap;";
    root.appendChild(hud);
    this.brushAdjustmentHud = hud;
    if (this.app && this.tree) {
      this.magnifierOverlay = new MagnifierOverlay(this.app, this.tree.root);
    }
    this.unsubscribeToolStore = this.toolStore.subscribe(() => {
      if (this.toolStore.activeTool === "eyedropper") {
        if (this.lastPointerEvent && this.viewportCanvas) {
          this.magnifierOverlay?.update(this.lastPointerEvent, this.viewportCanvas);
        }
      } else {
        this.magnifierOverlay?.hide();
      }
    });

    if (typeof ResizeObserver !== "undefined") {
      this.viewportResizeObserver = new ResizeObserver(() => {
        const app = this.app;
        const world = this.world;
        const width = root.clientWidth;
        const height = root.clientHeight;
        if (!app || !world || width <= 0 || height <= 0) return;
        if (app.screen.width !== width || app.screen.height !== height) {
          app.renderer.resize(width, height);
          // Resizing clears the WebGL backbuffer immediately; force
          // a redraw now instead of waiting for the ticker's next
          // tick, or rapid-fire resizes (e.g. dragging the panel
          // separator) outrun the ticker and the canvas reads black.
          app.render();
        }
        // A hidden host can initialise at 0x0. Center once when the
        // viewport first becomes measurable, then preserve the camera.
        if (!this.viewportPositioned) {
          this.viewportPositioned = this.centerDocument();
        }
      });
      this.viewportResizeObserver.observe(root);
    }
  }

  private unmountViewportControls(): void {
    const canvas = this.viewportCanvas;
    if (!canvas) return;
    canvas.removeEventListener("wheel", this.handleWheel);
    canvas.removeEventListener("pointerdown", this.handlePointerDown);
    canvas.removeEventListener("pointermove", this.handlePointerMove);
    canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    canvas.removeEventListener("pointerup", this.handlePointerEnd);
    canvas.removeEventListener("pointercancel", this.handlePointerEnd);
    canvas.removeEventListener("lostpointercapture", this.handlePointerEnd);
    canvas.removeEventListener("auxclick", this.handleAuxClick);
    canvas.removeEventListener("paste", this.handlePaste);
    window.removeEventListener("keydown", this.handleEyedropperKeyDown);
    window.removeEventListener("keyup", this.handleEyedropperKeyUp);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.brushAdjustmentHud?.remove();
    this.brushAdjustmentHud = null;
    this.magnifierOverlay?.destroy();
    this.magnifierOverlay = null;
    this.unsubscribeToolStore?.();
    this.unsubscribeToolStore = null;
    this.viewportCanvas = null;
    this.panPointerId = null;
    this.brushAdjustment = null;
    this.restorePreviousTool();
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    const app = this.app;
    const world = this.world;
    const canvas = this.viewportCanvas;
    if (!app || !world || !canvas) return;

    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cursorX = ((event.clientX - rect.left) * app.screen.width) / rect.width;
    const cursorY = ((event.clientY - rect.top) * app.screen.height) / rect.height;
    const previousScale = world.scale.x;
    let deltaY = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) deltaY *= 16;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) deltaY *= rect.height;
    const nextScale = Math.min(8, Math.max(0.1, previousScale * Math.exp(-deltaY * 0.0015)));
    const documentX = (cursorX - world.x) / previousScale;
    const documentY = (cursorY - world.y) / previousScale;

    world.scale.set(nextScale);
    world.position.set(cursorX - documentX * nextScale, cursorY - documentY * nextScale);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    const canvas = this.viewportCanvas;
    if (!canvas) return;
    if (event.button === 0 || event.button === 1) {
      canvas.focus({ preventScroll: true });
    }
    if (event.button === 0 && this.toolStore.activeTool === "eyedropper") {
      this.sampleEyedropperColor(event);
      return;
    }
    if (event.button === 0 && this.beginBrushAdjustment(event)) return;
    if (event.button !== 1) return;
    event.preventDefault();
    this.panRestingCursor = canvas.style.cursor;
    this.panPointerId = event.pointerId;
    this.panClientX = event.clientX;
    this.panClientY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
  };

  /** Restore the tool active before a temporary Alt-held eyedropper switch, if any. */
  private restorePreviousTool(): void {
    const previous = this.previousToolBeforeEyedropper;
    this.previousToolBeforeEyedropper = null;
    if (previous && this.toolStore.activeTool === "eyedropper") {
      this.toolStore.setActiveTool(previous);
      this.magnifierOverlay?.hide();
    }
  }

  private readonly handleEyedropperKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Control" || event.key === "Shift" || event.key === "Meta") {
      // Ctrl+Alt / Shift+Alt are the existing brush size/hardness and
      // opacity drag shortcuts (see beginBrushAdjustment). Bare Alt can
      // land first if the user presses Alt then the other modifier --
      // restore the previous tool the moment that combo starts.
      this.restorePreviousTool();
      return;
    }
    if (
      event.key !== "Alt" ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      this.previousToolBeforeEyedropper !== null
    ) {
      return;
    }
    const tool = this.toolStore.activeTool;
    if (tool === "eyedropper") return;
    this.previousToolBeforeEyedropper = tool;
    this.toolStore.setActiveTool("eyedropper");
  };

  private readonly handleEyedropperKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== "Alt") return;
    this.restorePreviousTool();
  };

  private readonly handleWindowBlur = (): void => {
    this.restorePreviousTool();
  };

  /** Sample the composited pixel under the pointer into the primary brush color. */
  private sampleEyedropperColor(event: PointerEvent): void {
    const app = this.app;
    const canvas = this.viewportCanvas;
    const documentRoot = this.tree?.root;
    if (!app || !canvas || !documentRoot) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const screenPoint = {
      x: ((event.clientX - rect.left) * app.screen.width) / rect.width,
      y: ((event.clientY - rect.top) * app.screen.height) / rect.height,
    };
    const documentPoint = documentRoot.toLocal(screenPoint);

    try {
      const { pixels } = app.renderer.extract.pixels({
        target: documentRoot,
        frame: new Rectangle(Math.floor(documentPoint.x), Math.floor(documentPoint.y), 1, 1),
      });
      const [r, g, b, a] = pixels;
      if (a === undefined || a === 0 || r === undefined || g === undefined || b === undefined)
        return;
      this.toolStore.setBrushSettings({ color: toHexColor(r, g, b) });
    } catch {
      // Sampling point outside the renderable content -- ignore.
    }
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.lastPointerEvent = event;
    if (this.toolStore.activeTool === "eyedropper" && this.viewportCanvas) {
      this.magnifierOverlay?.update(event, this.viewportCanvas);
    } else {
      this.magnifierOverlay?.hide();
    }
    if (event.pointerId === this.brushAdjustment?.pointerId) {
      event.stopImmediatePropagation();
      event.preventDefault();
      this.updateBrushAdjustment(event);
      return;
    }
    const app = this.app;
    const world = this.world;
    const canvas = this.viewportCanvas;
    if (!app || !world || !canvas || event.pointerId !== this.panPointerId) {
      return;
    }

    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    world.position.set(
      world.x + ((event.clientX - this.panClientX) * app.screen.width) / rect.width,
      world.y + ((event.clientY - this.panClientY) * app.screen.height) / rect.height,
    );
    this.panClientX = event.clientX;
    this.panClientY = event.clientY;
  };

  private readonly handlePointerLeave = (): void => {
    this.lastPointerEvent = null;
    this.magnifierOverlay?.hide();
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    const canvas = this.viewportCanvas;
    if (canvas && event.pointerId === this.brushAdjustment?.pointerId) {
      const restingCursor = this.brushAdjustment.restingCursor;
      event.stopImmediatePropagation();
      event.preventDefault();
      this.brushAdjustment = null;
      if (this.brushAdjustmentHud) this.brushAdjustmentHud.style.display = "none";
      canvas.style.cursor = restingCursor;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (!canvas || event.pointerId !== this.panPointerId) return;
    this.panPointerId = null;
    canvas.style.cursor = this.panRestingCursor;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  private readonly handleAuxClick = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  /**
   * Set by the Svelte shell to show a "paste as..." picker. When unset,
   * pasting falls back to adding a raster layer directly.
   */
  public pasteRequestHandler: ((file: File) => void) | null = null;

  /** Route the first clipboard image to the paste-as picker (or a raster layer) when the canvas has focus. */
  private readonly handlePaste = (event: ClipboardEvent): void => {
    const item = [...(event.clipboardData?.items ?? [])].find((candidate) =>
      candidate.type.startsWith("image/"),
    );
    const file = item?.getAsFile();
    if (!file) return;

    event.preventDefault();
    if (this.pasteRequestHandler) {
      this.pasteRequestHandler(file);
      return;
    }
    void this.addImageFromFile(file)
      .then((id) => this.store.setSelectedLayerId(id))
      .catch((error) => console.error("[ultra-paint] could not paste image:", error));
  };

  private beginBrushAdjustment(event: PointerEvent): boolean {
    const canvas = this.viewportCanvas;
    const tool = this.toolStore.activeTool;
    if (!canvas || (tool !== "brush" && tool !== "eraser") || this.brushAdjustment) {
      return false;
    }
    const primaryModifier = event.ctrlKey || event.metaKey;
    const mode: BrushAdjustmentMode | null =
      event.altKey && primaryModifier && !event.shiftKey
        ? "size-hardness"
        : event.altKey && event.shiftKey && !primaryModifier
          ? "opacity"
          : null;
    if (!mode) return false;

    const brush = this.toolStore.brush;
    this.brushAdjustment = {
      pointerId: event.pointerId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRadius: brush.radius,
      startHardness: brush.hardness,
      startOpacity: brush.opacity,
      restingCursor: canvas.style.cursor,
    };
    event.stopImmediatePropagation();
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "ew-resize";
    this.updateBrushAdjustment(event);
    return true;
  }

  private updateBrushAdjustment(event: PointerEvent): void {
    const active = this.brushAdjustment;
    const hud = this.brushAdjustmentHud;
    const canvas = this.viewportCanvas;
    if (!active || !canvas) return;

    const deltaX = event.clientX - active.startClientX;
    const deltaY = event.clientY - active.startClientY;
    if (active.mode === "size-hardness") {
      this.toolStore.setBrushSettings({
        radius: Math.round(active.startRadius + deltaX),
        hardness: active.startHardness - deltaY / 200,
      });
    } else {
      this.toolStore.setBrushSettings({
        opacity: active.startOpacity + deltaX / 200,
      });
    }

    if (!hud) return;
    const brush = this.toolStore.brush;
    hud.textContent =
      active.mode === "size-hardness"
        ? `Size ${Math.round(brush.radius)}px · Hardness ${Math.round(brush.hardness * 100)}%`
        : `Opacity ${Math.round(brush.opacity * 100)}%`;
    const rect = canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
    hud.style.left = `${event.clientX - rect.left + 12}px`;
    hud.style.top = `${event.clientY - rect.top + 12}px`;
    hud.style.display = "block";
  }

  /** Undo the most recent document or pixel operation. */
  public undo(): void {
    try {
      this.history?.undo();
    } catch (error) {
      console.error("[ultra-paint] undo failed", error);
    }
  }

  /** Redo the most recently undone document or pixel operation. */
  public redo(): void {
    try {
      this.history?.redo();
    } catch (error) {
      console.error("[ultra-paint] redo failed", error);
    }
  }

  private readonly beginStroke = (tool: PaintTool, layerId: LayerId): StrokeSession | null => {
    if (tool !== "brush" && tool !== "eraser") return null;
    const history = this.history;
    const pending = history?.beginPixelChange(layerId) ?? null;
    const settings = this.toolStore.getState().brush;
    let session: StrokeSession | null;

    try {
      session =
        tool === "brush"
          ? (this.brushEngine?.beginStroke(layerId, settings) ?? null)
          : (this.eraserEngine?.beginStroke(layerId, settings) ?? null);
    } catch (error) {
      if (pending) history?.discardPixelChange(pending);
      throw error;
    }

    if (!session || !history || !pending) {
      if (pending) history?.discardPixelChange(pending);
      return session;
    }
    return new HistoryStrokeSession(session, history, pending);
  };

  /**
   * Sample a layer's render texture down to a small PNG data URL for the
   * layer panel thumbnail. Renders through a Sprite (not the raw texture)
   * so `resolution` actually downsamples on the GPU instead of extracting
   * at full size and letting the caller shrink it.
   */
  public getLayerThumbnail(id: LayerId, maxSize: number, maskColor?: string): string | null {
    const app = this.app;
    const texture = this.store.getTexture(id);
    if (!app || !texture || texture.width <= 0 || texture.height <= 0) return null;

    const resolution = Math.min(1, maxSize / Math.max(texture.width, texture.height));
    const sprite = new Sprite(texture);
    const filter = maskColor ? new ColorMatrixFilter() : undefined;
    if (filter) {
      const { red, green, blue } = new Color(maskColor);
      filter.matrix = [0, 0, 0, 0, red, 0, 0, 0, 0, green, 0, 0, 0, 0, blue, 0, 0, 0, 1, 0];
      sprite.filters = [filter];
    }
    try {
      const canvas = app.renderer.extract.canvas({ target: sprite, resolution });
      return (canvas as HTMLCanvasElement).toDataURL("image/png");
    } catch (error) {
      console.warn("[ultra-paint] thumbnail extraction failed:", error);
      return null;
    } finally {
      filter?.destroy();
      sprite.destroy({ texture: false, textureSource: false });
    }
  }

  /** Fill the selected raster layer with the current brush color/opacity. */
  public readonly fillSelectedLayer = (): void => {
    const app = this.app;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    const target = layerId ? this.store.getTexture(layerId) : undefined;
    if (!app || !layerId || !layer || layer.kind !== "raster" || !target || layer.locked) {
      return;
    }

    const history = this.history;
    const pending = history?.beginPixelChange(layerId) ?? null;
    const settings = this.toolStore.getState().brush;
    const documentRoot = this.tree?.root;
    const layerContainer = this.tree?.getNode(layerId)?.container;
    if (!documentRoot || !layerContainer) return;
    const box = this.store.getDocument().boundaryBox;
    const corners = [
      layerContainer.toLocal({ x: box.x, y: box.y }, documentRoot),
      layerContainer.toLocal({ x: box.x + box.width, y: box.y }, documentRoot),
      layerContainer.toLocal({ x: box.x + box.width, y: box.y + box.height }, documentRoot),
      layerContainer.toLocal({ x: box.x, y: box.y + box.height }, documentRoot),
    ];
    const points = corners.flatMap((point) => [point.x, point.y]);
    const eraseGraphics = new Graphics();
    eraseGraphics.poly(points, true).fill({ color: 0xffffff, alpha: 1 });
    eraseGraphics.blendMode = "erase";
    const fillGraphics = new Graphics();
    fillGraphics.poly(points, true).fill({
      color: new Color(settings.color).toNumber(),
      alpha: settings.opacity,
    });

    try {
      app.renderer.render({
        container: eraseGraphics,
        target,
        clear: false,
      });
      app.renderer.render({
        container: fillGraphics,
        target,
        clear: false,
      });
      if (pending) history?.commitPixelChange(pending);
    } catch (error) {
      if (pending) history?.discardPixelChange(pending);
      throw error;
    } finally {
      eraseGraphics.destroy();
      fillGraphics.destroy();
    }
  };

  /** Clear the selected mask's pixels without removing the layer. */
  public clearSelectedMask(): boolean {
    const app = this.app;
    const history = this.history;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    const target = layerId ? this.store.getTexture(layerId) : undefined;
    if (!app || !history || !layerId || layer?.kind !== "mask" || !target) {
      return false;
    }

    const pending = history.beginPixelChange(layerId);
    if (!pending) return false;
    const empty = new Container();
    try {
      app.renderer.render({
        container: empty,
        target,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      history.commitPixelChange(pending);
      return true;
    } catch (error) {
      history.discardPixelChange(pending);
      throw error;
    } finally {
      empty.destroy();
    }
  }

  /**
   * Invert the selected mask's coverage inside the current boundary box,
   * and clear it (no coverage) outside the box -- mirrors InvokeAI's
   * Invert Mask.
   */
  public invertSelectedMask(): boolean {
    const app = this.app;
    const history = this.history;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    const target = layerId ? this.store.getTexture(layerId) : undefined;
    const documentRoot = this.tree?.root;
    const layerContainer = layerId ? this.tree?.getNode(layerId)?.container : undefined;
    if (
      !app ||
      !history ||
      !layerId ||
      layer?.kind !== "mask" ||
      !target ||
      !documentRoot ||
      !layerContainer
    ) {
      return false;
    }

    const pending = history.beginPixelChange(layerId);
    if (!pending) return false;

    const box = this.store.getDocument().boundaryBox;
    const corners = [
      layerContainer.toLocal({ x: box.x, y: box.y }, documentRoot),
      layerContainer.toLocal({ x: box.x + box.width, y: box.y }, documentRoot),
      layerContainer.toLocal({ x: box.x + box.width, y: box.y + box.height }, documentRoot),
      layerContainer.toLocal({ x: box.x, y: box.y + box.height }, documentRoot),
    ];
    const points = corners.flatMap((point) => [point.x, point.y]);

    // Straight (non-premultiplied) alpha invert: a' = 1 - a, RGB unchanged
    // (RGB is display-irrelevant for masks -- MaskHatchFilter/flattenMask
    // both only read alpha -- but preserved anyway for a clean copy).
    const invertFilter = new ColorMatrixFilter();
    invertFilter.matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 1];
    const invertedSprite = new Sprite({ texture: target });
    invertedSprite.filters = [invertFilter];

    const scratch = RenderTexture.create({
      width: target.width,
      height: target.height,
      resolution: target.source.resolution,
      antialias: target.source.antialias,
    });
    const clipped = new Graphics();
    clipped.poly(points, true).fill({ texture: scratch, textureSpace: "global" });

    try {
      // Pass 1: full-texture alpha inversion into a scratch copy.
      app.renderer.render({
        container: invertedSprite,
        target: scratch,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      // Pass 2: paste the inverted copy back, but only inside the
      // boundary box -- everywhere else in the mask ends up cleared.
      app.renderer.render({
        container: clipped,
        target,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      history.commitPixelChange(pending);
      return true;
    } catch (error) {
      history.discardPixelChange(pending);
      throw error;
    } finally {
      invertedSprite.destroy({ texture: false, textureSource: false });
      invertFilter.destroy();
      clipped.destroy();
      scratch.destroy(true);
    }
  }

  // ------------------------------------------------------------ public API

  /** The document store. Layer panel and Python bridge both go through this. */
  public getStore(): LayerStore {
    return this.store;
  }

  /** Shared active-tool and brush settings. */
  public getToolStore(): PaintToolStore {
    return this.toolStore;
  }

  /** The document-root container that `LayerTree` reconciles into. */
  public getDocumentRoot(): Container | null {
    return this.tree?.root ?? null;
  }

  /** The `LayerTree`, for callers that need node-level access. */
  public getTree(): LayerTree | null {
    return this.tree;
  }

  /** Current document-to-viewport zoom scale. */
  public getZoom(): number {
    return this.world?.scale.x ?? 1;
  }

  /**
   * Restore 100% zoom while preserving the document point at viewport center.
   */
  public resetZoom(): void {
    const app = this.app;
    const world = this.world;
    if (!app || !world || app.screen.width <= 0 || app.screen.height <= 0) {
      return;
    }

    const previousScale = world.scale.x;
    const documentX = (app.screen.width / 2 - world.x) / previousScale;
    const documentY = (app.screen.height / 2 - world.y) / previousScale;
    world.scale.set(1);
    world.position.set(app.screen.width / 2 - documentX, app.screen.height / 2 - documentY);
  }

  /** Center and scale the current boundary box within the viewport. */
  public fitToBoundaryBox(paddingPx = 8): void {
    const app = this.app;
    const world = this.world;
    if (!app || !world || app.screen.width <= 0 || app.screen.height <= 0) {
      return;
    }

    const box = this.store.getDocument().boundaryBox;
    const padding = Math.max(0, paddingPx);
    const availableWidth = Math.max(1, app.screen.width - padding * 2);
    const availableHeight = Math.max(1, app.screen.height - padding * 2);
    const scale = Math.min(availableWidth / box.width, availableHeight / box.height);
    world.scale.set(scale);
    world.position.set(
      (app.screen.width - box.width * scale) / 2 - box.x * scale,
      (app.screen.height - box.height * scale) / 2 - box.y * scale,
    );
  }

  /** Toggle the document-space pixel grid. */
  public setGridVisible(visible: boolean): void {
    this.pixelGrid?.setVisible(visible);
  }

  /** Whether the document-space pixel grid is currently visible. */
  public isGridVisible(): boolean {
    return this.pixelGrid?.isVisible() ?? true;
  }

  /**
   * Decode an uploaded `File`/`Blob` into a texture and add it as a new
   * top-level raster layer. Resolves with the new layer's id.
   */
  public async addImageFromFile(
    file: File | Blob,
    source: ImageRef["source"] = "upload",
  ): Promise<LayerId> {
    await this.ready;
    const texture = await decodeToTexture(file);
    const name = file instanceof File ? file.name : undefined;
    const wasEmpty = this.store.getDocument().layers.length === 0;
    const id = this.store.addRasterLayer(this.createPaintableTexture(texture), name, source);
    this.recenterIfFirstLayer(wasEmpty);
    return id;
  }

  /**
   * Decode an uploaded `File`/`Blob` into a texture and add it as a new
   * top-level control (ControlNet) layer. Resolves with the new layer's id.
   */
  public async addControlLayerFromFile(file: File | Blob): Promise<LayerId> {
    await this.ready;
    const texture = await decodeToTexture(file);
    const name = file instanceof File ? file.name : undefined;
    return this.store.addControlLayer(this.createPaintableTexture(texture), name);
  }

  /**
   * Decode an uploaded `File`/`Blob`, convert it to an 8-bit grayscale
   * coverage texture (white RGB, alpha = luminance), and add it as a new
   * mask layer. Resolves with the new layer's id.
   */
  public async addMaskLayerFromFile(file: File | Blob): Promise<LayerId> {
    await this.ready;
    const app = this.app;
    if (!app) {
      throw new Error("[ultra-paint] cannot create a mask layer before the renderer is ready");
    }

    const texture = await decodeToTexture(file);
    const { pixels, width, height } = app.renderer.extract.pixels({ target: texture });
    texture.destroy(true);

    const canvas = luminanceCoverageCanvas(pixels, width, height);
    const name = file instanceof File ? file.name : undefined;
    return this.store.addMaskLayerFromTexture(
      this.createPaintableTexture(Texture.from(canvas)),
      name,
    );
  }

  /**
   * Copy an existing raster layer's pixels into a new mask layer via an
   * alpha (luminance-as-coverage) conversion, same as {@link addMaskLayerFromFile}.
   * The source layer is left untouched.
   */
  public convertLayerToMask(id: LayerId): LayerId {
    const app = this.app;
    const layer = this.store.getLayer(id);
    const texture = this.store.getTexture(id);
    if (!app || !layer || layer.kind !== "raster" || !texture) {
      throw new Error("[ultra-paint] only a raster layer can be converted to a mask");
    }

    const { pixels, width, height } = app.renderer.extract.pixels({ target: texture });
    const canvas = luminanceCoverageCanvas(pixels, width, height);
    const converted = this.createPaintableTexture(Texture.from(canvas));
    let adopted = false;
    try {
      const newId = this.store.addMaskLayerFromTexture(converted, `${layer.name} (Mask)`);
      adopted = true;
      this.store.setTransform(newId, layer.transform);
      this.store.setSelectedLayerId(newId);
      return newId;
    } catch (error) {
      if (!adopted) converted.destroy(true);
      throw error;
    }
  }

  /**
   * Copy an existing raster layer's pixels as-is into a new control
   * (ControlNet) layer. No pixel processing -- a preprocessor filter is
   * applied later by the ControlNet panel. The source layer is left untouched.
   */
  public convertLayerToControl(id: LayerId): LayerId {
    const layer = this.store.getLayer(id);
    const texture = this.store.getTexture(id);
    if (!layer || layer.kind !== "raster" || !texture) {
      throw new Error("[ultra-paint] only a raster layer can be converted to a control layer");
    }

    const copy = this.cloneTexture(texture);
    let adopted = false;
    try {
      const newId = this.store.addControlLayer(copy, `${layer.name} (Control)`);
      adopted = true;
      this.store.setTransform(newId, layer.transform);
      this.store.setSelectedLayerId(newId);
      return newId;
    } catch (error) {
      if (!adopted) copy.destroy(true);
      throw error;
    }
  }

  /**
   * Crop a paintable layer's texture to its intersection with the document's
   * boundary box, and shift its transform to match. No-op (returns `false`)
   * if the layer and boundary box don't overlap at all.
   */
  public clipLayerToBoundaryBox(id: LayerId): boolean {
    const app = this.app;
    const history = this.history;
    const layer = this.store.getLayer(id);
    const target = this.store.getTexture(id);
    if (!app || !history || !layer || !target) return false;
    if (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control") return false;

    const { boundaryBox: box } = this.store.getDocument();
    const { transform } = layer;
    const left = Math.max(transform.x, box.x);
    const top = Math.max(transform.y, box.y);
    const right = Math.min(transform.x + target.width * transform.scaleX, box.x + box.width);
    const bottom = Math.min(transform.y + target.height * transform.scaleY, box.y + box.height);
    if (right <= left || bottom <= top) return false;

    const localLeft = (left - transform.x) / transform.scaleX;
    const localTop = (top - transform.y) / transform.scaleY;
    const width = Math.round((right - left) / transform.scaleX);
    const height = Math.round((bottom - top) / transform.scaleY);
    if (width <= 0 || height <= 0) return false;
    if (width === target.width && height === target.height && localLeft === 0 && localTop === 0) {
      return false;
    }

    const cropped = RenderTexture.create({ width, height, resolution: 1, antialias: false });
    const sprite = new Sprite({ texture: target });
    sprite.position.set(-localLeft, -localTop);
    try {
      app.renderer.render({ container: sprite, target: cropped, clear: true, clearColor: [0, 0, 0, 0] });
    } catch (error) {
      cropped.destroy(true);
      throw error;
    } finally {
      sprite.destroy({ texture: false, textureSource: false });
    }

    const nextTransform = { ...transform, x: left, y: top };
    const pending = history.beginPixelChange(id);
    if (!pending) {
      cropped.destroy(true);
      throw new Error(`[ultra-paint] could not begin clip history for layer "${id}"`);
    }
    let adopted = false;
    try {
      const previous = this.store.replaceLayerTexture(id, target, cropped, nextTransform);
      if (previous !== target) throw new Error(`[ultra-paint] clip target layer "${id}" changed`);
      adopted = true;
      this.tree?.getNode(id)?.setTexture(cropped);
      history.commitPixelChange(pending);
      target.destroy(true);
      return true;
    } catch (error) {
      history.discardPixelChange(pending);
      if (adopted) {
        const rolledBack = this.store.replaceLayerTexture(id, cropped, target, transform);
        if (rolledBack === cropped) {
          this.tree?.getNode(id)?.setTexture(target);
          cropped.destroy(true);
        }
      } else {
        cropped.destroy(true);
      }
      throw error;
    }
  }

  /**
   * Extract a layer's own source texture (ignoring its transform and any
   * compositing with other layers) as a `data:image/png;base64,...` URL.
   * Used for ControlNet preprocessing/preview, which operates on one
   * layer's raw pixels, not the flattened canvas. `null` if the layer has
   * no registered texture (group layers, or before the app is ready).
   */
  public layerSourceDataURL(id: LayerId): string | null {
    const app = this.app;
    const texture = this.store.getTexture(id);
    if (!app || !texture) return null;
    const canvas = app.renderer.extract.canvas({ target: texture, resolution: 1 });
    return typeof canvas.toDataURL === "function" ? canvas.toDataURL("image/png") : null;
  }

  /** Encode one textured layer's untransformed source pixels as PNG. */
  public async layerSourcePngBlob(id: LayerId): Promise<Blob | null> {
    await this.ready;
    const app = this.app;
    const texture = this.store.getTexture(id);
    if (!app || !texture) return null;

    const canvas = app.renderer.extract.canvas({ target: texture, resolution: 1 }) as {
      convertToBlob?: (options?: { type?: string }) => Promise<Blob>;
      toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void;
    };
    if (typeof canvas.convertToBlob === "function") {
      return canvas.convertToBlob({ type: "image/png" });
    }
    if (typeof canvas.toBlob === "function") {
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob?.(
          (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
          "image/png",
        );
      });
    }
    return null;
  }

  /**
   * Add a layer from a data URL or any fetchable image URL. This is the entry
   * point the Python bridge will use for generated images.
   */
  public async addImageFromDataURL(
    url: string,
    name?: string,
    source: ImageRef["source"] = "generated",
  ): Promise<LayerId> {
    await this.ready;
    const response = await fetch(url);
    const blob = await response.blob();
    const texture = await decodeToTexture(blob);
    const wasEmpty = this.store.getDocument().layers.length === 0;
    const id = this.store.addRasterLayer(this.createPaintableTexture(texture), name, source);
    this.recenterIfFirstLayer(wasEmpty);
    const doc = this.store.getDocument();
    this.store.setTransform(id, {
      x: doc.boundaryBox.x,
      y: doc.boundaryBox.y,
    });
    return id;
  }

  /** Bake a pending ControlNet preprocessor result into one control layer. */
  public async acceptFilterResult(layerId: LayerId, dataUrl: string): Promise<void> {
    await this.ready;
    const app = this.app;
    const history = this.history;
    const layer = this.store.getLayer(layerId);
    const target = this.store.getTexture(layerId);
    if (!app || !history || layer?.kind !== "control" || !target) {
      throw new Error(`[ultra-paint] cannot accept a filter result for layer "${layerId}"`);
    }

    const response = await fetch(dataUrl);
    const decoded = await decodeToTexture(await response.blob());
    let replacement: RenderTexture | null = null;
    let sprite: Sprite | null = null;
    try {
      replacement = RenderTexture.create({
        width: target.width,
        height: target.height,
        resolution: target.source.resolution,
        antialias: target.source.antialias,
        format: target.source.format,
        alphaMode: target.source.alphaMode,
      });
      sprite = new Sprite({ texture: decoded });
      sprite.width = target.width;
      sprite.height = target.height;
      app.renderer.render({
        container: sprite,
        target: replacement,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
    } catch (error) {
      replacement?.destroy(true);
      throw error;
    } finally {
      sprite?.destroy({ texture: false, textureSource: false });
      decoded.destroy(true);
    }

    if (!replacement) {
      throw new Error(`[ultra-paint] could not render a filter result for layer "${layerId}"`);
    }

    const pending = history.beginPixelChange(layerId);
    if (!pending) {
      replacement.destroy(true);
      throw new Error(`[ultra-paint] could not begin filter history for layer "${layerId}"`);
    }

    let adopted = false;
    try {
      const previous = this.store.replaceLayerTexture(
        layerId,
        target,
        replacement,
        layer.transform,
      );
      if (previous !== target) {
        throw new Error(`[ultra-paint] filter target layer "${layerId}" changed`);
      }
      adopted = true;
      this.tree?.getNode(layerId)?.setTexture(replacement);
      history.commitPixelChange(pending);
      target.destroy(true);
    } catch (error) {
      history.discardPixelChange(pending);
      if (adopted) {
        const rolledBack = this.store.replaceLayerTexture(
          layerId,
          replacement,
          target,
          layer.transform,
        );
        if (rolledBack === replacement) {
          this.tree?.getNode(layerId)?.setTexture(target);
          replacement.destroy(true);
        }
      } else {
        replacement.destroy(true);
      }
      throw error;
    }
  }

  /**
   * Create a transparent, paintable raster layer at the current document
   * dimensions. Resolves with the new layer's id.
   */
  public async addBlankLayer(name?: string): Promise<LayerId> {
    await this.ready;
    const renderer = this.app?.renderer;
    if (!renderer) {
      throw new Error("[ultra-paint] cannot create a blank layer before the renderer is ready");
    }

    const doc = this.store.getDocument();
    const texture = RenderTexture.create({
      width: doc.boundaryBox.width,
      height: doc.boundaryBox.height,
      resolution: 1,
      antialias: false,
    });
    const empty = new Container();

    try {
      renderer.render({
        container: empty,
        target: texture,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      const wasEmpty = this.store.getDocument().layers.length === 0;
      const id = this.store.addRasterLayer(texture, name, "paint");
      this.recenterIfFirstLayer(wasEmpty);
      const current = this.store.getDocument();
      this.store.setTransform(id, {
        x: current.boundaryBox.x,
        y: current.boundaryBox.y,
      });
      return id;
    } catch (error) {
      texture.destroy(true);
      throw error;
    } finally {
      empty.destroy();
    }
  }

  /** Rasterize selected top-level regular layers into a new document-space layer. */
  public mergeLayersToNewLayer(ids: readonly LayerId[]): LayerId {
    const doc = this.store.getDocument();
    const selected = [...new Set(ids)].filter((id) => {
      const layer = this.store.getLayer(id);
      return layer?.parentId === null && (layer.kind === "raster" || layer.kind === "group");
    });
    if (selected.length < 2) {
      throw new Error("Select at least two raster or group layers to merge");
    }
    // Snapshot the stack order before adding the merged layer -- `doc` is a
    // live reference, and `addRasterLayer` below mutates `doc.layerOrder` in
    // place (it unshifts the new id), which would shift every index read
    // from it afterward and place the merged layer one slot too low.
    const preOrder = [...doc.layerOrder];

    const texture = this.flattenSelectedToTexture(selected);
    let adopted = false;
    try {
      const id = this.store.addRasterLayer(texture, `Merged ${selected.length} layers`, "paint");
      adopted = true;
      this.store.setTransform(id, { x: doc.boundaryBox.x, y: doc.boundaryBox.y });
      this.store.reorderLayer(id, Math.min(...selected.map((sid) => preOrder.indexOf(sid))));
      this.store.setSelectedLayerId(id);
      return id;
    } catch (error) {
      if (!adopted) texture.destroy(true);
      throw error;
    }
  }

  /** Merge every effectively visible top-level raster/group layer into one new raster layer. */
  public mergeVisibleLayersToNewLayer(): LayerId {
    const doc = this.store.getDocument();
    const ids = doc.layers
      .filter(
        (layer) =>
          layer.parentId === null &&
          (layer.kind === "raster" || layer.kind === "group") &&
          layer.visible,
      )
      .map((layer) => layer.id);
    return this.mergeLayersToNewLayer(ids);
  }

  /** Merge every visible top-level mask layer into one new mask layer. */
  public mergeVisibleMasksToNewMask(): LayerId {
    const doc = this.store.getDocument();
    const selected = doc.layers
      .filter((layer) => layer.kind === "mask" && layer.parentId === null && layer.visible)
      .map((layer) => layer.id);
    if (selected.length < 2) {
      throw new Error("Show at least two mask layers to merge");
    }
    // See the matching comment in mergeLayersToNewLayer: snapshot the order
    // now, since adding the merged layer below mutates `doc.layerOrder` in place.
    const preOrder = [...doc.layerOrder];

    const texture = this.flattenSelectedToTexture(selected);
    let adopted = false;
    try {
      const id = this.store.addMaskLayerFromTexture(texture, `Merged ${selected.length} masks`);
      adopted = true;
      this.store.setTransform(id, { x: doc.boundaryBox.x, y: doc.boundaryBox.y });
      this.store.reorderLayer(id, Math.min(...selected.map((sid) => preOrder.indexOf(sid))));
      this.store.setSelectedLayerId(id);
      return id;
    } catch (error) {
      if (!adopted) texture.destroy(true);
      throw error;
    }
  }

  /** Flatten just `ids` (temporarily hiding every other layer) into a fresh `RenderTexture`. */
  private flattenSelectedToTexture(ids: readonly LayerId[]): RenderTexture {
    const app = this.app;
    const tree = this.tree;
    if (!app || !tree) {
      throw new Error("[ultra-paint] cannot merge layers before the app is ready");
    }

    const doc = this.store.getDocument();
    const selectedSet = new Set(ids);
    // Force both `renderable` and `visible` for the selected set: a mask can
    // be document-visible but still forced off-screen by the "hide all
    // masks" toggle or an active generation preview (GenerationPreviewOverlay
    // sets container.visible directly), and Pixi skips rendering either way.
    const saved = doc.layerOrder
      .map((id) => {
        const node = tree.getNode(id);
        return node
          ? { node, renderable: node.container.renderable, visible: node.container.visible }
          : null;
      })
      .filter((entry) => entry !== null);

    for (const entry of saved) {
      const include = selectedSet.has(entry.node.id);
      entry.node.container.renderable = include;
      if (include) entry.node.container.visible = true;
    }

    try {
      return Compositor.flattenToTexture(app, tree.root, doc.boundaryBox);
    } finally {
      for (const entry of saved) {
        entry.node.container.renderable = entry.renderable;
        entry.node.container.visible = entry.visible;
      }
    }
  }

  /**
   * Composite every visible layer and return the result as a
   * `data:image/png;base64,...` string at document resolution.
   *
   * Synchronous, so it can be read straight into a Gradio hidden field.
   * Throws if called before {@link ready} resolves.
   */
  public flattenToDataURL(): string {
    const app = this.app;
    const tree = this.tree;
    if (!app || !tree) {
      throw new Error(
        "[ultra-paint] flattenToDataURL() called before the app was ready; await `app.ready` first",
      );
    }
    const doc = this.store.getDocument();
    const parent = tree.root.parent;
    // Reinsert right above the pixel grid (if present) so layer content
    // stays above the grid but below the boundary box overlay, mirroring
    // world's normal [grid, tree.root, boundaryBoxOverlay] child order.
    const insertIndex =
      this.pixelGrid && parent?.children.includes(this.pixelGrid.container)
        ? parent.getChildIndex(this.pixelGrid.container) + 1
        : 0;
    const maskVisibility = doc.layers
      .filter((layer) => layer.kind === "mask" || layer.kind === "control")
      .map((layer) => {
        const node = tree.getNode(layer.id);
        return node ? { node, visible: node.container.visible } : null;
      })
      .filter((entry) => entry !== null);
    tree.root.removeFromParent();
    for (const entry of maskVisibility) entry.node.container.visible = false;
    try {
      return Compositor.flatten(app, tree.root, doc.boundaryBox);
    } finally {
      for (const entry of maskVisibility) {
        entry.node.container.visible = entry.visible;
      }
      parent?.addChildAt(tree.root, insertIndex);
    }
  }

  /** Export visible inpainting masks, or `null` when none are enabled. */
  public flattenMaskToDataURL(): string | null {
    const app = this.app;
    if (!app) {
      throw new Error(
        "[ultra-paint] flattenMaskToDataURL() called before the app was ready; await `app.ready` first",
      );
    }
    const doc = this.store.getDocument();
    return Compositor.flattenMask(app, this.store, doc.boundaryBox);
  }

  /** Resize the operating region and center it in the current viewport. */
  public resizeBoundaryBox(width: number, height: number): void {
    const box = this.store.getDocument().boundaryBox;
    this.store.setBoundaryBox({ ...box, width, height });
    this.centerDocument();
  }

  /**
   * Resize and reposition the boundary box to tightly enclose every
   * visible raster layer (masks and hidden layers are excluded), then
   * fit the camera to it. No-op if there is nothing visible to measure.
   */
  public fitBoundaryBoxToContent(paddingPx = 8): void {
    const tree = this.tree;
    if (!tree) return;

    const doc = this.store.getDocument();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const layer of doc.layers) {
      if (layer.kind !== "raster" || !layer.visible) continue;
      const node = tree.getNode(layer.id);
      if (!node) continue;

      const { width, height } = layer.image;
      const corners: Array<[number, number]> = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ];
      for (const [x, y] of corners) {
        const point = tree.root.toLocal({ x, y }, node.container);
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

    this.store.setBoundaryBox({
      x: minX,
      y: minY,
      width: Math.max(8, maxX - minX),
      height: Math.max(8, maxY - minY),
    });
    this.fitToBoundaryBox(paddingPx);
  }

  /** Fit the operating region to non-transparent pixels in visible masks. */
  public fitBoundaryBoxToCompositeMask(paddingPx = 8): boolean {
    const app = this.app;
    const tree = this.tree;
    if (!app || !tree) return false;

    const doc = this.store.getDocument();
    const byId = new Map(doc.layers.map((layer) => [layer.id, layer]));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const layer of doc.layers) {
      if (layer.kind !== "mask" || !this.isEffectivelyVisible(layer, byId)) continue;
      const texture = this.store.getTexture(layer.id);
      const node = tree.getNode(layer.id);
      if (!texture || !node) continue;

      const origin = tree.root.toLocal({ x: 0, y: 0 }, node.container);
      const xUnit = tree.root.toLocal({ x: 1, y: 0 }, node.container);
      const yUnit = tree.root.toLocal({ x: 0, y: 1 }, node.container);
      const a = xUnit.x - origin.x;
      const b = xUnit.y - origin.y;
      const c = yUnit.x - origin.x;
      const d = yUnit.y - origin.y;
      const extracted = app.renderer.extract.pixels(texture);
      const stepX = texture.width / extracted.width;
      const stepY = texture.height / extracted.height;
      const ax = a * stepX;
      const ay = b * stepX;
      const cx = c * stepY;
      const cy = d * stepY;

      for (let offset = 3, pixel = 0; offset < extracted.pixels.length; offset += 4, pixel += 1) {
        if (extracted.pixels[offset] === 0) continue;
        const x = (pixel % extracted.width) * stepX;
        const y = Math.floor(pixel / extracted.width) * stepY;
        const x0 = origin.x + a * x + c * y;
        const y0 = origin.y + b * x + d * y;
        minX = Math.min(minX, x0, x0 + ax, x0 + cx, x0 + ax + cx);
        minY = Math.min(minY, y0, y0 + ay, y0 + cy, y0 + ay + cy);
        maxX = Math.max(maxX, x0, x0 + ax, x0 + cx, x0 + ax + cx);
        maxY = Math.max(maxY, y0, y0 + ay, y0 + cy, y0 + ay + cy);
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return false;
    const left = Math.floor(minX);
    const top = Math.floor(minY);
    const right = Math.ceil(maxX);
    const bottom = Math.ceil(maxY);
    this.store.setBoundaryBox({
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    });
    this.fitToBoundaryBox(paddingPx);
    return true;
  }

  private isEffectivelyVisible(layer: Layer, byId: ReadonlyMap<LayerId, Layer>): boolean {
    const seen = new Set<LayerId>();
    let current: Layer | undefined = layer;
    while (current) {
      if (
        seen.has(current.id) ||
        !current.visible ||
        !Number.isFinite(current.opacity) ||
        current.opacity <= 0
      ) {
        return false;
      }
      seen.add(current.id);
      if (current.parentId === null) return true;
      current = byId.get(current.parentId);
    }
    return false;
  }

  /** Tear down the renderer, the scene graph, and the DOM canvas. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (activeInstance === this) activeInstance = null;

    this.generationPreviewOverlay?.destroy();
    this.generationPreviewOverlay = null;

    this.filterPreviewOverlay?.destroy();
    this.filterPreviewOverlay = null;

    this.boundaryBoxOverlay?.destroy();
    this.boundaryBoxOverlay = null;

    this.brushCursorOverlay?.destroy();
    this.brushCursorOverlay = null;

    this.pixelGrid?.destroy();
    this.pixelGrid = null;

    this.strokeController?.destroy();
    this.strokeController = null;
    this.brushEngine = null;
    this.eraserEngine = null;

    this.history?.destroy();
    this.history = null;

    this.unmountViewportControls();

    this.tree?.destroy();
    this.tree = null;

    this.world = null;

    this.app?.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
    this.app = null;
  }

  /** Copy a live texture into a fresh, independent `RenderTexture`. Does not destroy `source`. */
  private cloneTexture(source: RenderTexture): RenderTexture {
    const renderer = this.app?.renderer;
    if (!renderer) {
      throw new Error("[ultra-paint] cannot clone a texture before the renderer is ready");
    }

    const copy = RenderTexture.create({
      width: source.width,
      height: source.height,
      resolution: source.source.resolution,
      antialias: source.source.antialias,
    });
    const sprite = new Sprite({ texture: source });
    try {
      renderer.render({ container: sprite, target: copy, clear: true, clearColor: [0, 0, 0, 0] });
      return copy;
    } catch (error) {
      copy.destroy(true);
      throw error;
    } finally {
      sprite.destroy({ texture: false, textureSource: false });
    }
  }

  /** Copy a decoded image into the paintable backing for a raster layer. */
  private createPaintableTexture(sourceTexture: Texture): RenderTexture {
    const renderer = this.app?.renderer;
    if (!renderer) {
      sourceTexture.destroy(true);
      throw new Error("[ultra-paint] cannot create a raster layer before the renderer is ready");
    }

    const renderTexture = RenderTexture.create({
      width: sourceTexture.width,
      height: sourceTexture.height,
      resolution: 1,
      antialias: false,
    });
    const sprite = new Sprite({ texture: sourceTexture });

    try {
      renderer.render({
        container: sprite,
        target: renderTexture,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      return renderTexture;
    } catch (error) {
      renderTexture.destroy(true);
      throw error;
    } finally {
      sprite.destroy({ texture: false, textureSource: false });
      sourceTexture.destroy(true);
    }
  }
}

/**
 * Blob/File -> `Texture`.
 *
 * `createImageBitmap` is the fast path (decodes off the main thread and hands
 * PixiJS an `ImageBitmap`, which `Texture.from` accepts directly). The
 * `HTMLImageElement` fallback covers browsers/contexts where it is missing.
 *
 * `skipCache: true` keeps the temporary decoded source out of PixiJS's global
 * texture cache. It is copied into a store-owned `RenderTexture` then destroyed.
 */
async function decodeToTexture(blob: Blob): Promise<Texture> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return Texture.from(bitmap, true);
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("[ultra-paint] failed to decode image"));
      el.src = url;
    });
    return Texture.from(image, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** White RGB, alpha = luminance*alpha -- turns an opaque image into mask coverage. */
function luminanceCoverageCanvas(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): HTMLCanvasElement {
  const coverage = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const a = pixels[i + 3] ?? 255;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    coverage[i] = 255;
    coverage[i + 1] = 255;
    coverage[i + 2] = 255;
    coverage[i + 3] = Math.round((luminance * a) / 255);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("[ultra-paint] could not create a 2D canvas context");
  }
  ctx.putImageData(new ImageData(coverage, width, height), 0, 0);
  return canvas;
}

interface PendingPixelChange {
  layerId: LayerId;
  snapshot: RenderTexture;
  transform: Transform;
  active: boolean;
}

interface PixelHistoryEntry {
  kind: "pixels";
  layerId: LayerId;
  snapshot: RenderTexture;
  transform: Transform;
}

interface StateHistoryEntry {
  kind: "state";
  mutation: LayerStoreMutation;
  recordedAt: number;
}

/** Undo step for an "add-layer" mutation: the layer still lives in the store. */
interface AddLayerHistoryEntry {
  kind: "add-layer";
  layerId: LayerId;
}

/** Redo step for an undone "add-layer": the layer's full snapshot, held outside the store. */
interface RemovedLayerHistoryEntry {
  kind: "removed-layer";
  layer: Layer;
  index: number;
  texture: RenderTexture | undefined;
}

type HistoryEntry =
  PixelHistoryEntry | StateHistoryEntry | AddLayerHistoryEntry | RemovedLayerHistoryEntry;

class HistoryStrokeSession implements StrokeSession {
  public readonly spacing: number;

  private ended = false;

  constructor(
    private readonly session: StrokeSession,
    private readonly history: UndoHistory,
    private readonly pending: PendingPixelChange,
  ) {
    this.spacing = session.spacing;
  }

  public addPoints(points: Parameters<StrokeSession["addPoints"]>[0]): void {
    this.session.addPoints(points);
  }

  public end(points: Parameters<StrokeSession["end"]>[0], cancelled: boolean): void {
    if (this.ended) return;
    this.ended = true;
    try {
      this.session.end(points, cancelled);
    } finally {
      if (points.length > 0) {
        this.history.commitPixelChange(this.pending);
      } else {
        this.history.discardPixelChange(this.pending);
      }
    }
  }
}

class UndoHistory {
  private readonly undoStack: HistoryEntry[] = [];

  private readonly redoStack: HistoryEntry[] = [];

  private readonly unsubscribeMutations: Unsubscribe;

  private replaying = false;

  private pendingPixelChanges = 0;

  constructor(
    private readonly app: Application,
    private readonly store: LayerStore,
    private readonly tree: LayerTree,
    private readonly limit: number,
  ) {
    this.unsubscribeMutations = store.subscribeMutations(this.recordStoreMutation);
  }

  public beginPixelChange(layerId: LayerId): PendingPixelChange | null {
    const target = this.store.getTexture(layerId);
    const layer = this.store.getLayer(layerId);
    if (
      !target ||
      !layer ||
      (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control")
    ) {
      return null;
    }

    const pending: PendingPixelChange = {
      layerId,
      snapshot: this.copyTexture(target),
      transform: { ...layer.transform },
      active: true,
    };
    this.pendingPixelChanges += 1;
    return pending;
  }

  public commitPixelChange(pending: PendingPixelChange): void {
    if (!this.finishPending(pending)) return;
    const target = this.store.getTexture(pending.layerId);
    const layer = this.store.getLayer(pending.layerId);
    if (
      !target ||
      !layer ||
      (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control")
    ) {
      pending.snapshot.destroy(true);
      this.clear();
      return;
    }
    this.record({
      kind: "pixels",
      layerId: pending.layerId,
      snapshot: pending.snapshot,
      transform: pending.transform,
    });
    this.store.touchTexture(pending.layerId);
  }

  public discardPixelChange(pending: PendingPixelChange): void {
    if (!this.finishPending(pending)) return;
    pending.snapshot.destroy(true);
  }

  public undo(): void {
    if (this.pendingPixelChanges > 0) return;
    const entry = this.undoStack.pop();
    if (!entry) return;

    if (entry.kind === "pixels") {
      this.restorePixelEntry(entry, this.undoStack, this.redoStack);
      return;
    }
    if (entry.kind === "add-layer") {
      this.undoAddLayer(entry);
      return;
    }
    if (entry.kind !== "state") return;

    try {
      this.replaying = true;
      this.applyStateMutation(entry.mutation, true);
      this.redoStack.push(entry);
    } catch (error) {
      this.undoStack.push(entry);
      throw error;
    } finally {
      this.replaying = false;
    }
  }

  public redo(): void {
    if (this.pendingPixelChanges > 0) return;
    const entry = this.redoStack.pop();
    if (!entry) return;

    if (entry.kind === "pixels") {
      this.restorePixelEntry(entry, this.redoStack, this.undoStack);
      return;
    }
    if (entry.kind === "removed-layer") {
      this.redoAddLayer(entry);
      return;
    }
    if (entry.kind !== "state") return;

    try {
      this.replaying = true;
      this.applyStateMutation(entry.mutation, false);
      this.undoStack.push(entry);
    } catch (error) {
      this.redoStack.push(entry);
      throw error;
    } finally {
      this.replaying = false;
    }
  }

  private undoAddLayer(entry: AddLayerHistoryEntry): void {
    try {
      this.replaying = true;
      const extracted = this.store.extractLayerForUndo(entry.layerId);
      if (extracted) this.redoStack.push({ kind: "removed-layer", ...extracted });
      else this.undoStack.push(entry);
    } finally {
      this.replaying = false;
    }
  }

  private redoAddLayer(entry: RemovedLayerHistoryEntry): void {
    try {
      this.replaying = true;
      this.store.restoreLayerForUndo(entry.layer, entry.index, entry.texture);
      this.undoStack.push({ kind: "add-layer", layerId: entry.layer.id });
    } finally {
      this.replaying = false;
    }
  }

  public clear(): void {
    this.destroyStack(this.undoStack);
    this.destroyStack(this.redoStack);
  }

  public destroy(): void {
    this.unsubscribeMutations();
    this.clear();
  }

  private readonly recordStoreMutation = (mutation: LayerStoreMutation): void => {
    if (this.replaying) return;
    if (mutation.kind === "remove-layer" || mutation.kind === "clear") {
      this.clear();
      return;
    }
    if (mutation.kind === "add-layer") {
      this.destroyStack(this.redoStack);
      this.undoStack.push({ kind: "add-layer", layerId: mutation.layerId });
      this.trimUndoStack();
      return;
    }

    this.destroyStack(this.redoStack);
    const now = Date.now();
    const previous = this.undoStack[this.undoStack.length - 1];
    if (
      previous?.kind === "state" &&
      now - previous.recordedAt <= HISTORY_MERGE_WINDOW_MS &&
      this.mergeContinuousMutation(previous, mutation, now)
    ) {
      return;
    }

    this.undoStack.push({ kind: "state", mutation, recordedAt: now });
    this.trimUndoStack();
  };

  private record(entry: HistoryEntry): void {
    this.destroyStack(this.redoStack);
    this.undoStack.push(entry);
    this.trimUndoStack();
  }

  private finishPending(pending: PendingPixelChange): boolean {
    if (!pending.active) return false;
    pending.active = false;
    this.pendingPixelChanges = Math.max(0, this.pendingPixelChanges - 1);
    return true;
  }

  private restorePixelEntry(
    entry: PixelHistoryEntry,
    sourceStack: HistoryEntry[],
    destinationStack: HistoryEntry[],
  ): void {
    const target = this.store.getTexture(entry.layerId);
    const layer = this.store.getLayer(entry.layerId);
    if (
      !target ||
      !layer ||
      (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control")
    ) {
      entry.snapshot.destroy(true);
      this.clear();
      return;
    }

    let inverse: RenderTexture;
    try {
      inverse = this.copyTexture(target);
    } catch (error) {
      sourceStack.push(entry);
      throw error;
    }

    let restored: RenderTexture;
    try {
      restored = this.copyTexture(entry.snapshot);
    } catch (error) {
      // Neither texture has reached the store yet in this branch.
      inverse.destroy(true);
      sourceStack.push(entry);
      throw error;
    }

    const inverseTransform = { ...layer.transform };
    const replaced = this.store.replaceLayerTexture(
      entry.layerId,
      target,
      restored,
      entry.transform,
    );
    if (replaced !== target) {
      inverse.destroy(true);
      restored.destroy(true);
      sourceStack.push(entry);
      throw new Error(`[ultra-paint] failed to restore paintable layer "${entry.layerId}"`);
    }

    this.tree.getNode(entry.layerId)?.setTexture(restored);
    target.destroy(true);
    entry.snapshot.destroy(true);
    destinationStack.push({
      kind: "pixels",
      layerId: entry.layerId,
      snapshot: inverse,
      transform: inverseTransform,
    });
    this.store.touchTexture(entry.layerId);
  }

  private copyTexture(source: RenderTexture): RenderTexture {
    const snapshot = RenderTexture.create({
      width: source.width,
      height: source.height,
      resolution: source.source.resolution,
      antialias: false,
      format: source.source.format,
      alphaMode: source.source.alphaMode,
    });

    try {
      this.copyTextureInto(source, snapshot);
      return snapshot;
    } catch (error) {
      snapshot.destroy(true);
      throw error;
    }
  }

  private copyTextureInto(source: RenderTexture, destination: RenderTexture): void {
    if (
      source.source.pixelWidth !== destination.source.pixelWidth ||
      source.source.pixelHeight !== destination.source.pixelHeight
    ) {
      throw new Error("[ultra-paint] cannot restore a layer snapshot with different dimensions");
    }

    this.app.renderer.renderTarget.copyToTexture(
      source,
      destination,
      { x: 0, y: 0 },
      {
        width: source.source.pixelWidth,
        height: source.source.pixelHeight,
      },
      { x: 0, y: 0 },
    );
  }

  private applyStateMutation(mutation: LayerStoreMutation, usePrevious: boolean): void {
    switch (mutation.kind) {
      case "reorder-layer":
        this.store.reorderLayer(mutation.layerId, usePrevious ? mutation.previous : mutation.next);
        return;
      case "set-opacity":
        this.store.setOpacity(mutation.layerId, usePrevious ? mutation.previous : mutation.next);
        return;
      case "set-blend-mode":
        this.store.setBlendMode(mutation.layerId, usePrevious ? mutation.previous : mutation.next);
        return;
      case "set-visible":
        this.store.setVisible(mutation.layerId, usePrevious ? mutation.previous : mutation.next);
        return;
      case "set-locked":
        this.store.setLocked(mutation.layerId, usePrevious ? mutation.previous : mutation.next);
        return;
      case "set-preserve-alpha":
        this.store.setPreserveAlpha(
          mutation.layerId,
          usePrevious ? mutation.previous : mutation.next,
        );
        return;
      case "set-name":
        this.store.setName(mutation.layerId, usePrevious ? mutation.previous : mutation.next);
        return;
      case "set-transform":
        this.store.setTransform(mutation.layerId, usePrevious ? mutation.previous : mutation.next);
        return;
      case "set-boundary-box": {
        this.store.setBoundaryBox(usePrevious ? mutation.previous : mutation.next);
        return;
      }
      case "add-layer":
      case "remove-layer":
      case "clear":
        throw new Error(`[ultra-paint] structural mutation "${mutation.kind}" is not undoable`);
    }
  }

  private mergeContinuousMutation(
    previous: StateHistoryEntry,
    next: LayerStoreMutation,
    recordedAt: number,
  ): boolean {
    if (
      previous.mutation.kind === "set-opacity" &&
      next.kind === "set-opacity" &&
      previous.mutation.layerId === next.layerId
    ) {
      previous.mutation = {
        ...next,
        previous: previous.mutation.previous,
      };
      previous.recordedAt = recordedAt;
      return true;
    }
    if (
      previous.mutation.kind === "set-transform" &&
      next.kind === "set-transform" &&
      previous.mutation.layerId === next.layerId
    ) {
      previous.mutation = {
        ...next,
        previous: previous.mutation.previous,
      };
      previous.recordedAt = recordedAt;
      return true;
    }
    return false;
  }

  private trimUndoStack(): void {
    while (this.undoStack.length > this.limit) {
      const dropped = this.undoStack.shift();
      if (dropped) this.destroyEntry(dropped);
    }
  }

  private destroyStack(stack: HistoryEntry[]): void {
    for (const entry of stack.splice(0)) this.destroyEntry(entry);
  }

  private destroyEntry(entry: HistoryEntry): void {
    if (entry.kind === "pixels") entry.snapshot.destroy(true);
    if (entry.kind === "removed-layer") entry.texture?.destroy(true);
  }
}
