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
  Matrix,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
} from "pixi.js";

import { Compositor } from "../scene/Compositor";
import { BoundaryBoxOverlay } from "../scene/BoundaryBoxOverlay";
import { fitDimensions } from "../util/dimensions";
import { BrushCursorOverlay } from "../scene/BrushCursorOverlay";
import { FilterPreviewOverlay } from "../scene/FilterPreviewOverlay";
import { GenerationPreviewOverlay } from "../scene/GenerationPreviewOverlay";
import { MagnifierOverlay } from "../scene/MagnifierOverlay";
import { TransformOverlay } from "../scene/TransformOverlay";
import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
import { PixelGrid } from "../scene/PixelGrid";
import { BrushEngine } from "../paint/BrushEngine";
import { EraserEngine } from "../paint/EraserEngine";
import { StrokeController, type StrokeSession } from "../paint/StrokeController";
import { LayerTree } from "../scene/LayerTree";
import {
  LayerStore,
  layerStore,
  type LayerRemovalSnapshot,
  type LayerStoreMutation,
  type Unsubscribe,
} from "../state/layerStore.svelte";
import {
  PaintToolStore,
  paintToolStore,
  type PaintTool,
  type PaintToolUnsubscribe,
} from "../state/paintToolStore.svelte";
import type {
  BoundaryBox,
  ImageRef,
  Layer,
  LayerId,
  MaskLayer,
  RasterLayer,
  Transform,
} from "../state/schema";
import { toHexColor } from "../util/color";
import { toPixiBlendMode } from "../util/blendModes";
import { getTileRendererCapabilities, PREFERRED_TILE_SIZE } from "../canvas/rendererCapabilities";
import type { TileAllocation, TileEditDelta } from "../canvas/TiledRasterCanvas";
import type { PixelBounds } from "../canvas/TileGrid";
import { TiledRasterCanvas } from "../canvas/TiledRasterCanvas";
import { blitTexture, copyTiledSurfaceTileByTile, flattenToTexture } from "../canvas/TileRasterOps";

const HISTORY_LIMIT = 40;
const HISTORY_MERGE_WINDOW_MS = 500;

function pointInPolygon(
  point: { x: number; y: number },
  polygon: readonly { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const from = polygon[index]!;
    const to = polygon[previous]!;
    if (
      from.y > point.y !== to.y > point.y &&
      point.x < ((to.x - from.x) * (point.y - from.y)) / (to.y - from.y) + from.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

type BrushAdjustmentMode = "size-hardness" | "opacity";

interface ActiveBrushAdjustment {
  pointerId: number;
  mode: BrushAdjustmentMode;
  startClientX: number;
  startClientY: number;
  startRadius: number;
  startHardness: number;
  startOpacity: number;
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

  /** Debug-only tile-border outline toggle; survives across a fresh `LayerTree`. */
  private tileDebugBordersVisible = false;

  private world: Container | null = null;

  /** Document-space pixel grid, below all layer content. */
  private pixelGrid: PixelGrid | null = null;

  /** Interactive operating-region guide, above all document content. */
  private boundaryBoxOverlay: BoundaryBoxOverlay | null = null;

  /** Interactive layer move/rotate/scale gizmo. */
  private transformOverlay: TransformOverlay | null = null;

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
    if (this.tileDebugBordersVisible) this.tree.setTileDebugBorders(true);
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
    const history = new UndoHistory(app, this.store, this.tree, HISTORY_LIMIT);
    this.history = history;
    this.transformOverlay = new TransformOverlay(
      app.canvas,
      this.tree.root,
      this.tree,
      this.store,
      this.toolStore,
      () => history.finishContinuousMutation(),
    );
    this.world.addChild(this.transformOverlay.container);
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
    this.brushEngine = new BrushEngine(app, this.tree.root, this.tree, this.store, history);
    this.eraserEngine = new EraserEngine(app, this.tree.root, this.tree, this.store, history);
    this.strokeController = new StrokeController(
      app.canvas,
      app,
      this.tree.root,
      this.store,
      this.toolStore,
      this.beginStroke,
    );

    const tileCapabilities = getTileRendererCapabilities(app.renderer);

    console.log(
      `[ultra-paint] renderer ready (${doc.boundaryBox.width}x${doc.boundaryBox.height}, ` +
        `${this.store.getDocument().layers.length} layers; ` +
        `${tileCapabilities.backend}, max texture ${tileCapabilities.maxTextureDimension2D ?? "unknown"}, ` +
        `planned tile ${tileCapabilities.selectedTileSize ?? "unsupported"})`,
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
    this.updateTiledVisibleRegions();
    return true;
  }

  /**
   * Recompute each tiled layer's attached-tile set from the current camera.
   *
   * Layer containers can be rotated relative to the viewport, so the screen
   * rect's four corners are mapped into each layer's local space individually
   * and the axis-aligned bounding box of those points is used -- a superset of
   * the true visible area, never a subset, so culling can only ever drop tiles
   * that are genuinely fully off-screen.
   */
  private updateTiledVisibleRegions(): void {
    const app = this.app;
    const tree = this.tree;
    if (!app || !tree || app.screen.width <= 0 || app.screen.height <= 0) return;

    const corners = [
      { x: 0, y: 0 },
      { x: app.screen.width, y: 0 },
      { x: 0, y: app.screen.height },
      { x: app.screen.width, y: app.screen.height },
    ];
    tree.forEachNode((node) => {
      if (!node.hasTiledView) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const corner of corners) {
        const local = node.container.toLocal(corner);
        if (local.x < minX) minX = local.x;
        if (local.x > maxX) maxX = local.x;
        if (local.y < minY) minY = local.y;
        if (local.y > maxY) maxY = local.y;
      }
      if (maxX <= minX || maxY <= minY) return;
      node.setTiledVisibleRegion({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    });
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
        } else {
          this.updateTiledVisibleRegions();
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
    this.updateTiledVisibleRegions();
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
    this.panPointerId = event.pointerId;
    this.panClientX = event.clientX;
    this.panClientY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
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
    this.updateTiledVisibleRegions();
  };

  private readonly handlePointerLeave = (): void => {
    this.lastPointerEvent = null;
    this.magnifierOverlay?.hide();
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    const canvas = this.viewportCanvas;
    if (canvas && event.pointerId === this.brushAdjustment?.pointerId) {
      event.stopImmediatePropagation();
      event.preventDefault();
      this.brushAdjustment = null;
      if (this.brushAdjustmentHud) this.brushAdjustmentHud.style.display = "none";
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (!canvas || event.pointerId !== this.panPointerId) return;
    this.panPointerId = null;
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
    if (!file || isDocumentMutationLocked()) return;

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
    };
    event.stopImmediatePropagation();
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
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
    if (isDocumentMutationLocked()) return;
    try {
      this.history?.undo();
    } catch (error) {
      console.error("[ultra-paint] undo failed", error);
    }
  }

  /** Redo the most recently undone document or pixel operation. */
  public redo(): void {
    if (isDocumentMutationLocked()) return;
    try {
      this.history?.redo();
    } catch (error) {
      console.error("[ultra-paint] redo failed", error);
    }
  }

  private readonly beginStroke = (tool: PaintTool, layerId: LayerId): StrokeSession | null => {
    if (isDocumentMutationLocked()) return null;
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
    if (!app) return null;
    const texture = this.store.getTexture(id);
    const tiledSurface = texture ? undefined : this.store.getTiledSurface(id);
    if (!texture && !tiledSurface) return null;

    const width = texture ? texture.width : (tiledSurface?.bounds?.width ?? 0);
    const height = texture ? texture.height : (tiledSurface?.bounds?.height ?? 0);
    if (width <= 0 || height <= 0) return null;

    const resolution = Math.min(1, maxSize / Math.max(width, height));
    const root: Container = texture
      ? new Sprite(texture)
      : this.buildTiledThumbnailRoot(tiledSurface!);
    const filter = maskColor ? new ColorMatrixFilter() : undefined;
    if (filter) {
      const { red, green, blue } = new Color(maskColor);
      filter.matrix = [0, 0, 0, 0, red, 0, 0, 0, 0, green, 0, 0, 0, 0, blue, 0, 0, 0, 1, 0];
      root.filters = [filter];
    }
    try {
      // Tile sprites can extend past the layer's logical bounds at edge tiles
      // (a full tile is allocated even for a partial-tile image); an explicit
      // frame crops the export to exactly the ingested pixels instead of
      // whatever coarse tile-aligned area the container's auto bounds would use.
      const frame = tiledSurface ? new Rectangle(0, 0, width, height) : undefined;
      const canvas = app.renderer.extract.canvas({ target: root, resolution, frame });
      return (canvas as HTMLCanvasElement).toDataURL("image/png");
    } catch (error) {
      console.warn("[ultra-paint] thumbnail extraction failed:", error);
      return null;
    } finally {
      filter?.destroy();
      root.destroy({ children: true, texture: false, textureSource: false });
    }
  }

  /** Assemble a throwaway container of tile sprites for thumbnail extraction only. */
  private buildTiledThumbnailRoot(surface: TiledRasterCanvas): Container {
    const root = new Container();
    surface.visitAll((tile) => {
      const sprite = new Sprite({ texture: tile.target });
      sprite.position.set(tile.originX, tile.originY);
      root.addChild(sprite);
    });
    return root;
  }

  /** Fill the selected raster layer with the current brush color/opacity. */
  public readonly fillSelectedLayer = (): void => {
    if (isDocumentMutationLocked()) return;
    const app = this.app;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    if (!app || !layerId || !layer || layer.kind !== "raster" || layer.locked) return;
    const target = this.store.getTexture(layerId);
    const tiledSurface = target ? undefined : this.store.getTiledSurface(layerId);
    if (!target && !tiledSurface) return;

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
    const fillColor = new Color(settings.color).toNumber();

    if (target) {
      this.fillMonolithicRaster(app, layerId, layer, target, points, fillColor, settings.opacity);
    } else if (tiledSurface) {
      this.fillTiledRaster(app, layerId, layer, tiledSurface, points, fillColor, settings.opacity);
    }
  };

  private fillMonolithicRaster(
    app: Application,
    layerId: LayerId,
    layer: RasterLayer,
    target: RenderTexture,
    points: number[],
    fillColor: number,
    opacity: number,
  ): void {
    const history = this.history;
    const pending = history?.beginPixelChange(layerId) ?? null;
    const eraseGraphics = new Graphics();
    eraseGraphics.poly(points, true).fill({ color: 0xffffff, alpha: 1 });
    eraseGraphics.blendMode = "erase";
    const fillGraphics = new Graphics();
    fillGraphics.poly(points, true).fill({ color: fillColor, alpha: opacity });
    let alphaMaskTexture: RenderTexture | null = null;
    let alphaMaskSprite: Sprite | null = null;

    try {
      if (layer.preserveAlpha) {
        alphaMaskTexture = RenderTexture.create({
          width: target.width,
          height: target.height,
          resolution: target.source.resolution,
          antialias: target.source.antialias,
        });
        const snapshot = new Sprite({ texture: target });
        try {
          app.renderer.render({
            container: snapshot,
            target: alphaMaskTexture,
            clear: true,
            clearColor: [0, 0, 0, 0],
          });
        } finally {
          snapshot.destroy({ texture: false, textureSource: false });
        }
        alphaMaskSprite = new Sprite({ texture: alphaMaskTexture });
        fillGraphics.setMask({ mask: alphaMaskSprite, channel: "alpha" });
      } else {
        app.renderer.render({
          container: eraseGraphics,
          target,
          clear: false,
        });
      }
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
      fillGraphics.mask = null;
      alphaMaskSprite?.destroy({ texture: false, textureSource: false });
      alphaMaskTexture?.destroy(true);
      eraseGraphics.destroy();
      fillGraphics.destroy();
    }
  }

  /**
   * Tiled counterpart of {@link fillMonolithicRaster}: same erase+fill
   * per-tile, over only already-allocated tiles (fill never grows a tiled
   * layer's extent, matching the monolithic path's fixed-size target). One
   * `TileEditDelta` covers every touched tile so the whole fill undoes atomically.
   */
  private fillTiledRaster(
    app: Application,
    layerId: LayerId,
    layer: RasterLayer,
    surface: TiledRasterCanvas,
    points: number[],
    fillColor: number,
    opacity: number,
  ): void {
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    const left = Math.floor(Math.min(...xs));
    const top = Math.floor(Math.min(...ys));
    const rawRegion = {
      x: left,
      y: top,
      width: Math.ceil(Math.max(...xs)) - left,
      height: Math.ceil(Math.max(...ys)) - top,
    };
    if (rawRegion.width <= 0 || rawRegion.height <= 0) return;

    // Fill never grows a tiled layer's footprint, matching the monolithic
    // path (whose target texture is a fixed size) -- clip to the surface's
    // current logical bounds before allocating tiles. A blank layer's
    // surface starts with zero tiles but real logical bounds, so this still
    // lets Fill populate it; preserve-alpha additionally never allocates a
    // tile it hasn't already touched (a brand-new tile is fully transparent,
    // so painting into it under an alpha mask would be an invisible no-op).
    const region = intersectBounds(rawRegion, surface.bounds);
    if (!region) return;
    const allocation: TileAllocation = layer.preserveAlpha ? "existing-only" : "allocate-missing";
    const transaction = surface.beginEdit("fill");
    surface.edit(region, { allocation, transaction }, (tile) => {
      const localPoints = points.map((value, index) =>
        index % 2 === 0 ? value - tile.originX : value - tile.originY,
      );
      const eraseGraphics = new Graphics();
      const fillGraphics = new Graphics();
      fillGraphics.poly(localPoints, true).fill({ color: fillColor, alpha: opacity });
      let alphaMaskTexture: RenderTexture | null = null;
      let alphaMaskSprite: Sprite | null = null;
      try {
        if (layer.preserveAlpha) {
          alphaMaskTexture = RenderTexture.create({
            width: tile.target.width,
            height: tile.target.height,
            resolution: tile.target.source.resolution,
            antialias: tile.target.source.antialias,
          });
          const snapshot = new Sprite({ texture: tile.target });
          try {
            app.renderer.render({
              container: snapshot,
              target: alphaMaskTexture,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });
          } finally {
            snapshot.destroy({ texture: false, textureSource: false });
          }
          alphaMaskSprite = new Sprite({ texture: alphaMaskTexture });
          fillGraphics.setMask({ mask: alphaMaskSprite, channel: "alpha" });
        } else {
          eraseGraphics.poly(localPoints, true).fill({ color: 0xffffff, alpha: 1 });
          eraseGraphics.blendMode = "erase";
          app.renderer.render({ container: eraseGraphics, target: tile.target, clear: false });
        }
        app.renderer.render({ container: fillGraphics, target: tile.target, clear: false });
      } finally {
        fillGraphics.mask = null;
        alphaMaskSprite?.destroy({ texture: false, textureSource: false });
        alphaMaskTexture?.destroy(true);
        eraseGraphics.destroy();
        fillGraphics.destroy();
      }
    });

    const delta = transaction.commit();
    if (delta.tileCount === 0) {
      delta.destroy();
      return;
    }
    this.history?.recordTileEdit(layerId, delta);
    this.store.touchTexture(layerId);
  }

  /** Clear the selected mask's pixels without removing the layer. */
  public clearSelectedMask(): boolean {
    if (isDocumentMutationLocked()) return false;
    const app = this.app;
    const history = this.history;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    const target = layerId ? this.store.getTexture(layerId) : undefined;
    const surface = layerId ? this.store.getTiledSurface(layerId) : undefined;
    if (
      !app ||
      !history ||
      !layerId ||
      layer?.kind !== "mask" ||
      layer.locked ||
      (!target && !surface)
    ) {
      return false;
    }

    if (surface) {
      const transaction = surface.beginEdit("clear-mask");
      try {
        const bounds = surface.bounds;
        if (bounds) {
          surface.edit(bounds, { allocation: "existing-only", transaction }, (tile) => {
            app.renderer.renderTarget.bind({
              target: tile.target,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });
          });
        }
        const delta = transaction.commit();
        if (delta.tileCount > 0) history.recordTileEdit(layerId, delta);
        else delta.destroy();
        this.store.touchTexture(layerId);
        return true;
      } catch (error) {
        if (transaction.active) transaction.rollback();
        throw error;
      }
    }

    const pending = history.beginPixelChange(layerId);
    if (!pending) return false;
    const empty = new Container();
    try {
      app.renderer.render({
        container: empty,
        target: target!,
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
    if (isDocumentMutationLocked()) return false;
    const app = this.app;
    const history = this.history;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    const target = layerId ? this.store.getTexture(layerId) : undefined;
    const surface = layerId ? this.store.getTiledSurface(layerId) : undefined;
    const documentRoot = this.tree?.root;
    const layerContainer = layerId ? this.tree?.getNode(layerId)?.container : undefined;
    if (
      !app ||
      !history ||
      !layerId ||
      layer?.kind !== "mask" ||
      layer.locked ||
      (!target && !surface) ||
      !documentRoot ||
      !layerContainer
    ) {
      return false;
    }

    const box = this.store.getDocument().boundaryBox;
    const corners = [
      layerContainer.toLocal({ x: box.x, y: box.y }, documentRoot),
      layerContainer.toLocal({ x: box.x + box.width, y: box.y }, documentRoot),
      layerContainer.toLocal({ x: box.x + box.width, y: box.y + box.height }, documentRoot),
      layerContainer.toLocal({ x: box.x, y: box.y + box.height }, documentRoot),
    ];
    const points = corners.flatMap((point) => [point.x, point.y]);

    if (surface) {
      const polygonBounds = {
        x: Math.floor(Math.min(...corners.map((point) => point.x))),
        y: Math.floor(Math.min(...corners.map((point) => point.y))),
        width:
          Math.ceil(Math.max(...corners.map((point) => point.x))) -
          Math.floor(Math.min(...corners.map((point) => point.x))),
        height:
          Math.ceil(Math.max(...corners.map((point) => point.y))) -
          Math.floor(Math.min(...corners.map((point) => point.y))),
      };
      const invertFilter = new ColorMatrixFilter();
      invertFilter.matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 1];
      const transaction = surface.beginEdit("invert-mask");
      const processed = new Set<string>();
      const invertTile = (tile: {
        coord: { x: number; y: number };
        originX: number;
        originY: number;
        target: RenderTexture;
      }): void => {
        const key = surface.grid.key(tile.coord);
        if (processed.has(key)) return;
        processed.add(key);

        const inverted = RenderTexture.create({
          width: tile.target.width,
          height: tile.target.height,
          resolution: tile.target.source.resolution,
          antialias: tile.target.source.antialias,
        });
        const sourceSprite = new Sprite({ texture: tile.target });
        sourceSprite.filters = [invertFilter];
        const clippedSprite = new Sprite({ texture: inverted });
        const clip = new Graphics();
        clip
          .poly(
            corners.flatMap((point) => [point.x - tile.originX, point.y - tile.originY]),
            true,
          )
          .fill(0xffffff);
        clippedSprite.mask = clip;
        const root = new Container();
        root.addChild(clippedSprite, clip);
        try {
          app.renderer.render({
            container: sourceSprite,
            target: inverted,
            clear: true,
            clearColor: [0, 0, 0, 0],
          });
          app.renderer.render({
            container: root,
            target: tile.target,
            clear: true,
            clearColor: [0, 0, 0, 0],
          });
        } finally {
          clippedSprite.mask = null;
          sourceSprite.filters = null;
          sourceSprite.destroy({ texture: false, textureSource: false });
          root.destroy({ children: true, texture: false, textureSource: false });
          inverted.destroy(true);
        }
      };

      try {
        const bounds = surface.bounds;
        if (bounds) surface.edit(bounds, { allocation: "existing-only", transaction }, invertTile);
        if (polygonBounds.width > 0 && polygonBounds.height > 0) {
          surface.edit(polygonBounds, { allocation: "allocate-missing", transaction }, invertTile);
          transaction.includeBounds(polygonBounds);
        }
        const delta = transaction.commit();
        if (delta.tileCount > 0) history.recordTileEdit(layerId, delta);
        else delta.destroy();
        this.store.touchTexture(layerId);
        return true;
      } catch (error) {
        if (transaction.active) transaction.rollback();
        throw error;
      } finally {
        invertFilter.destroy();
      }
    }

    const pending = history.beginPixelChange(layerId);
    if (!pending) return false;

    // Straight (non-premultiplied) alpha invert: a' = 1 - a, RGB unchanged
    // (RGB is display-irrelevant for masks -- MaskHatchFilter/flattenMask
    // both only read alpha -- but preserved anyway for a clean copy).
    const invertFilter = new ColorMatrixFilter();
    invertFilter.matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 1];
    const invertedSprite = new Sprite({ texture: target! });
    invertedSprite.filters = [invertFilter];

    const scratch = RenderTexture.create({
      width: target!.width,
      height: target!.height,
      resolution: target!.source.resolution,
      antialias: target!.source.antialias,
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
        target: target!,
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

  /** Mirror the single selected layer without rewriting its pixels or tiles. */
  public mirrorSelectedLayer(axis: "horizontal" | "vertical"): boolean {
    return this.transformOverlay?.mirrorSelected(axis) ?? false;
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
    this.updateTiledVisibleRegions();
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
    this.updateTiledVisibleRegions();
  }

  /** Toggle the document-space pixel grid. */
  public setGridVisible(visible: boolean): void {
    this.pixelGrid?.setVisible(visible);
  }

  /** Whether the document-space pixel grid is currently visible. */
  public isGridVisible(): boolean {
    return this.pixelGrid?.isVisible() ?? true;
  }

  /** Debug-only: outline every tiled layer's tiles in green. No-op for monolithic layers. */
  public setTileDebugBorders(visible: boolean): void {
    this.tileDebugBordersVisible = visible;
    this.tree?.setTileDebugBorders(visible);
  }

  /** Whether the tile-debug outline is currently enabled. */
  public isTileDebugBordersVisible(): boolean {
    return this.tileDebugBordersVisible;
  }

  /**
   * Decode an uploaded `File`/`Blob` into a texture and add it as a new
   * top-level raster layer. Resolves with the new layer's id.
   */
  public async addImageFromFile(
    file: File | Blob,
    source: ImageRef["source"] = "upload",
  ): Promise<LayerId> {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    await this.ready;
    const texture = await decodeToTexture(file);
    const name = file instanceof File ? file.name : undefined;
    const wasEmpty = this.store.getDocument().layers.length === 0;
    const surface = this.createPaintableTiledSurface(texture);
    const id = this.store.addRasterLayerTiled(surface, name, source);
    this.recenterIfFirstLayer(wasEmpty);
    return id;
  }

  /**
   * Decode an uploaded `File`/`Blob` into a texture and add it as a new
   * top-level control (ControlNet) layer. Resolves with the new layer's id.
   */
  public async addControlLayerFromFile(file: File | Blob): Promise<LayerId> {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    await this.ready;
    const texture = await decodeToTexture(file);
    const name = file instanceof File ? file.name : undefined;
    return this.store.addControlLayerTiled(this.createPaintableTiledSurface(texture), name);
  }

  /**
   * Decode an uploaded `File`/`Blob`, convert it to an 8-bit grayscale
   * coverage texture (white RGB, alpha = luminance), and add it as a new
   * mask layer. Resolves with the new layer's id.
   */
  public async addMaskLayerFromFile(file: File | Blob): Promise<LayerId> {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    await this.ready;
    const app = this.app;
    if (!app) {
      throw new Error("[ultra-paint] cannot create a mask layer before the renderer is ready");
    }

    // Ingest first (tile-by-tile GPU blit from the one decoded texture, same
    // as a plain image upload), then run the luminance conversion per tile --
    // avoids a single whole-image CPU `extract.pixels()`/canvas, which for an
    // upload at the 8192x8192 cap would be a quarter-gigabyte readback.
    const texture = await decodeToTexture(file);
    const ingested = this.createPaintableTiledSurface(texture);
    try {
      const converted = copyTiledSurfaceTileByTile(app.renderer, ingested, (tile) => {
        const { pixels, width, height } = app.renderer.extract.pixels({ target: tile.target });
        return Texture.from(luminanceCoverageCanvas(pixels, width, height), true);
      });
      const name = file instanceof File ? file.name : undefined;
      return this.store.addMaskLayerTiled(converted, name);
    } finally {
      ingested.destroy();
    }
  }

  /**
   * Create a transparent, paintable control (ControlNet) layer at the
   * current document dimensions, for hand-drawing a control scribble.
   */
  public async addBlankControlLayer(name?: string): Promise<LayerId> {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    await this.ready;

    const doc = this.store.getDocument();
    const surface = this.createBlankTiledSurface(doc.boundaryBox.width, doc.boundaryBox.height);
    try {
      const id = this.store.addControlLayerTiled(surface, name);
      const current = this.store.getDocument();
      this.store.setTransform(id, {
        x: current.boundaryBox.x,
        y: current.boundaryBox.y,
      });
      return id;
    } catch (error) {
      surface.destroy();
      throw error;
    }
  }

  /** Create a transparent boundary-box-sized mask with no resident tiles. */
  public async addBlankMaskLayer(name?: string): Promise<LayerId> {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    await this.ready;
    const box = this.store.getDocument().boundaryBox;
    return this.store.addMaskLayerTiled(this.createBlankTiledSurface(box.width, box.height), name);
  }

  /**
   * Copy an existing raster or control layer's pixels into a new mask layer via an
   * alpha (luminance-as-coverage) conversion, same as {@link addMaskLayerFromFile}.
   * The source layer is left untouched.
   */
  public convertLayerToMask(id: LayerId): LayerId {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    const app = this.app;
    const layer = this.store.getLayer(id);
    if (!app || !layer || (layer.kind !== "raster" && layer.kind !== "control")) {
      throw new Error("[ultra-paint] only a raster or control layer can be copied to a mask");
    }

    const tiledSource = this.store.getTiledSurface(id);
    if (tiledSource) {
      // Convert tile-by-tile, straight from the source's own tiles -- no
      // full-boundary-box flatten, and the destination keeps the same tile
      // origins as the source, so the layer's transform needs no compensation.
      const converted = copyTiledSurfaceTileByTile(app.renderer, tiledSource, (tile) => {
        const { pixels, width, height } = app.renderer.extract.pixels({ target: tile.target });
        return Texture.from(luminanceCoverageCanvas(pixels, width, height), true);
      });
      let adopted = false;
      try {
        const newId = this.store.addMaskLayerTiled(converted, `${layer.name} (Mask)`);
        adopted = true;
        this.store.setTransform(newId, layer.transform);
        this.store.setSelectedLayerId(newId);
        return newId;
      } catch (error) {
        if (!adopted) converted.destroy();
        throw error;
      }
    }

    const source = this.readLayerPixels(id);
    if (!source)
      throw new Error("[ultra-paint] only a raster or control layer can be copied to a mask");
    try {
      const { pixels, width, height } = app.renderer.extract.pixels({ target: source.texture });
      const canvas = luminanceCoverageCanvas(pixels, width, height);
      const converted = this.createPaintableTiledSurface(Texture.from(canvas, true));
      let adopted = false;
      try {
        const newId = this.store.addMaskLayerTiled(converted, `${layer.name} (Mask)`);
        adopted = true;
        this.store.setTransform(newId, this.transformForPixelSnapshot(layer.transform, source));
        this.store.setSelectedLayerId(newId);
        return newId;
      } catch (error) {
        if (!adopted) converted.destroy();
        throw error;
      }
    } finally {
      source.dispose();
    }
  }

  /**
   * Copy an existing raster layer's pixels as-is into a new control
   * (ControlNet) layer. No pixel processing -- a preprocessor filter is
   * applied later by the ControlNet panel. The source layer is left untouched.
   */
  public convertLayerToControl(id: LayerId): LayerId {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    const app = this.app;
    const layer = this.store.getLayer(id);
    if (!app || !layer || layer.kind !== "raster") {
      throw new Error("[ultra-paint] only a raster layer can be converted to a control layer");
    }

    const tiledSource = this.store.getTiledSurface(id);
    if (tiledSource) {
      // Control conversion is a bit-for-bit copy -- ControlNet's
      // luminance-to-alpha treatment is display-only (ControlLayerDisplayFilter),
      // never baked into stored pixels -- so this is a pure per-tile GPU copy
      // with no CPU readback and no full-boundary-box flatten.
      const copy = copyTiledSurfaceTileByTile(app.renderer, tiledSource);
      let adopted = false;
      try {
        const newId = this.store.addControlLayerTiled(copy, `${layer.name} (Control)`);
        adopted = true;
        this.store.setTransform(newId, layer.transform);
        this.store.setSelectedLayerId(newId);
        return newId;
      } catch (error) {
        if (!adopted) copy.destroy();
        throw error;
      }
    }

    const source = this.readLayerPixels(id);
    if (!source)
      throw new Error("[ultra-paint] only a raster layer can be converted to a control layer");
    try {
      const copy = this.createPaintableTiledSurface(this.cloneTexture(source.texture));
      let adopted = false;
      try {
        const newId = this.store.addControlLayerTiled(copy, `${layer.name} (Control)`);
        adopted = true;
        this.store.setTransform(newId, this.transformForPixelSnapshot(layer.transform, source));
        this.store.setSelectedLayerId(newId);
        return newId;
      } catch (error) {
        if (!adopted) copy.destroy();
        throw error;
      }
    } finally {
      source.dispose();
    }
  }

  /** Create an independent copy of any layer type. Group copies are empty because groups are not yet nestable in the UI. */
  public duplicateLayer(id: LayerId): LayerId {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    const layer = this.store.getLayer(id);
    if (!layer) throw new Error("[ultra-paint] layer no longer exists");

    if (layer.kind === "group") {
      const newId = this.store.addGroupLayer();
      this.store.copyLayerSettings(newId, layer);
      this.store.setSelectedLayerId(newId);
      return newId;
    }

    const source = this.readLayerPixels(id);
    if (!source) throw new Error("[ultra-paint] layer has no copyable pixel data");
    try {
      const copy = this.cloneTexture(source.texture);
      const tiledCopy = layer.kind === "raster" ? null : this.createPaintableTiledSurface(copy);
      let adopted = false;
      try {
        const newId =
          layer.kind === "raster"
            ? this.store.addRasterLayer(copy)
            : layer.kind === "mask"
              ? this.store.addMaskLayerTiled(tiledCopy!)
              : this.store.addControlLayerTiled(tiledCopy!);
        adopted = true;
        this.store.copyLayerSettings(newId, layer);
        this.store.setTransform(newId, this.transformForPixelSnapshot(layer.transform, source));
        this.store.setSelectedLayerId(newId);
        return newId;
      } catch (error) {
        if (!adopted) {
          if (tiledCopy) tiledCopy.destroy();
          else copy.destroy(true);
        }
        throw error;
      }
    } finally {
      source.dispose();
    }
  }

  /**
   * Crop a paintable layer's texture to its intersection with the document's
   * boundary box, and shift its transform to match. No-op (returns `false`)
   * if the layer and boundary box don't overlap at all.
   */
  public clipLayerToBoundaryBox(id: LayerId): boolean {
    if (isDocumentMutationLocked()) return false;
    const app = this.app;
    const history = this.history;
    const layer = this.store.getLayer(id);
    if (!app || !history || !layer || layer.locked) return false;
    if (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control") return false;
    const monolithicTarget = this.store.getTexture(id);
    const tiledSurface = monolithicTarget ? undefined : this.store.getTiledSurface(id);
    if (!monolithicTarget && !tiledSurface) return false;

    const tree = this.tree;
    const node = tree?.getNode(id);
    if (!tree || !node || !node.container.parent) return false;

    const { boundaryBox: box } = this.store.getDocument();
    // The boundary box lives in document-root coordinates. Let Pixi map it
    // into this layer's texture space, including every ancestor transform.
    const polygon = [
      node.container.toLocal({ x: box.x, y: box.y }, tree.root),
      node.container.toLocal({ x: box.x + box.width, y: box.y }, tree.root),
      node.container.toLocal({ x: box.x + box.width, y: box.y + box.height }, tree.root),
      node.container.toLocal({ x: box.x, y: box.y + box.height }, tree.root),
    ];

    if (tiledSurface) {
      const boundsBefore = tiledSurface.bounds;
      if (!boundsBefore) return false;
      const left = Math.floor(Math.min(...polygon.map((point) => point.x)));
      const top = Math.floor(Math.min(...polygon.map((point) => point.y)));
      const right = Math.ceil(Math.max(...polygon.map((point) => point.x)));
      const bottom = Math.ceil(Math.max(...polygon.map((point) => point.y)));
      const newBounds = intersectBounds(
        { x: left, y: top, width: right - left, height: bottom - top },
        boundsBefore,
      );
      if (!newBounds) return false;

      const transaction = tiledSurface.beginEdit("clip");
      let delta: TileEditDelta;
      try {
        tiledSurface.visitAll((tile) => {
          const tileBounds = tiledSurface.grid.boundsFor(tile.coord);
          if (!intersectBounds(tileBounds, newBounds)) {
            tiledSurface.removeTile(tile.coord, transaction);
            return;
          }

          tiledSurface.edit(
            tileBounds,
            { allocation: "existing-only", transaction },
            (editable) => {
              const scratch = RenderTexture.create({
                width: editable.target.width,
                height: editable.target.height,
                resolution: editable.target.source.resolution,
                antialias: editable.target.source.antialias,
                format: editable.target.source.format,
                alphaMode: editable.target.source.alphaMode,
              });
              const mask = new Graphics()
                .poly(
                  polygon.map((point) => ({
                    x: point.x - editable.originX,
                    y: point.y - editable.originY,
                  })),
                )
                .fill(0xffffff);
              const sprite = new Sprite({ texture: scratch });
              sprite.setMask({ mask, channel: "alpha" });
              const snapshot = new Sprite({ texture: editable.target });
              const root = new Container();
              root.addChild(mask, sprite);
              try {
                app.renderer.render({
                  container: snapshot,
                  target: scratch,
                  clear: true,
                  clearColor: [0, 0, 0, 0],
                });
                app.renderer.render({
                  container: root,
                  target: editable.target,
                  clear: true,
                  clearColor: [0, 0, 0, 0],
                });
              } finally {
                sprite.mask = null;
                snapshot.destroy({ texture: false, textureSource: false });
                root.destroy({ children: true, texture: false, textureSource: false });
                scratch.destroy(true);
              }
            },
          );
          // The axis-aligned candidate range can include corner tiles wholly
          // outside a rotated clip polygon. Read their masked pixels back
          // before committing so fully transparent tiles do not stay resident.
          const { pixels } = app.renderer.extract.pixels({ target: tile.target });
          for (let offset = 3; offset < pixels.length; offset += 4) {
            if (pixels[offset] !== 0) return;
          }
          tiledSurface.removeTile(tile.coord, transaction);
        });
        transaction.replaceBounds(newBounds);
        delta = transaction.commit();
      } catch (error) {
        if (transaction.active) transaction.rollback();
        throw error;
      }

      if (delta.tileCount === 0 && boundsEqual(newBounds, boundsBefore)) {
        delta.destroy();
        return false;
      }
      history.recordTileEdit(id, delta);
      return true;
    }

    const target = monolithicTarget!;
    const localLeft = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.x))));
    const localTop = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.y))));
    const localRight = Math.min(
      target.width,
      Math.ceil(Math.max(...polygon.map((point) => point.x))),
    );
    const localBottom = Math.min(
      target.height,
      Math.ceil(Math.max(...polygon.map((point) => point.y))),
    );
    if (localRight <= localLeft || localBottom <= localTop) {
      return false;
    }

    const sourceCorners = [
      { x: 0, y: 0 },
      { x: target.width, y: 0 },
      { x: target.width, y: target.height },
      { x: 0, y: target.height },
    ];
    if (sourceCorners.every((point) => pointInPolygon(point, polygon))) {
      return false;
    }

    const width = localRight - localLeft;
    const height = localBottom - localTop;
    const cropped = RenderTexture.create({
      width,
      height,
      resolution: target.source.resolution,
      antialias: target.source.antialias,
      format: target.source.format,
      alphaMode: target.source.alphaMode,
    });
    const root = new Container();
    const mask = new Graphics()
      .poly(polygon.map((point) => ({ x: point.x - localLeft, y: point.y - localTop })))
      .fill(0xffffff);
    const sprite = new Sprite({ texture: target, x: -localLeft, y: -localTop });
    sprite.setMask({ mask, channel: "alpha" });
    root.addChild(mask, sprite);
    try {
      app.renderer.render({
        container: root,
        target: cropped,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
    } catch (error) {
      cropped.destroy(true);
      throw error;
    } finally {
      sprite.mask = null;
      root.destroy({ children: true, texture: false, textureSource: false });
    }

    const nextPosition = node.container.parent.toLocal(
      node.container.toGlobal({ x: localLeft, y: localTop }),
    );
    const transform = layer.transform;
    const nextTransform = { ...transform, x: nextPosition.x, y: nextPosition.y };

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
    if (!app) return null;
    const source = this.readLayerPixels(id);
    if (!source) return null;
    try {
      const canvas = app.renderer.extract.canvas({ target: source.texture, resolution: 1 });
      return typeof canvas.toDataURL === "function" ? canvas.toDataURL("image/png") : null;
    } finally {
      source.dispose();
    }
  }

  /** Encode one textured layer's untransformed source pixels as PNG. */
  public async layerSourcePngBlob(id: LayerId): Promise<Blob | null> {
    await this.ready;
    const app = this.app;
    if (!app) return null;
    const source = this.readLayerPixels(id);
    if (!source) return null;

    try {
      const canvas = app.renderer.extract.canvas({ target: source.texture, resolution: 1 }) as {
        convertToBlob?: (options?: { type?: string }) => Promise<Blob>;
        toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void;
      };
      if (typeof canvas.convertToBlob === "function") {
        return await canvas.convertToBlob({ type: "image/png" });
      }
      if (typeof canvas.toBlob === "function") {
        return await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob?.(
            (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
            "image/png",
          );
        });
      }
      return null;
    } finally {
      source.dispose();
    }
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
    const surface = this.createPaintableTiledSurface(texture);
    const id = this.store.addRasterLayerTiled(surface, name, source);
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
    const surface = this.store.getTiledSurface(layerId);
    if (!app || !history || layer?.kind !== "control" || layer.locked || (!target && !surface)) {
      throw new Error(`[ultra-paint] cannot accept a filter result for layer "${layerId}"`);
    }

    const response = await fetch(dataUrl);
    const decoded = await decodeToTexture(await response.blob());

    if (surface) {
      const bounds = surface.bounds;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        decoded.destroy(true);
        throw new Error(`[ultra-paint] filter target layer "${layerId}" has no pixel bounds`);
      }
      const transaction = surface.beginEdit("accept-control-filter");
      try {
        surface.edit(bounds, { allocation: "allocate-missing", transaction }, (tile) => {
          const sprite = new Sprite({ texture: decoded });
          sprite.position.set(bounds.x - tile.originX, bounds.y - tile.originY);
          sprite.width = bounds.width;
          sprite.height = bounds.height;
          try {
            app.renderer.render({
              container: sprite,
              target: tile.target,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });
          } finally {
            sprite.destroy({ texture: false, textureSource: false });
          }
        });
        transaction.includeBounds(bounds);
        const delta = transaction.commit();
        if (delta.tileCount === 0) {
          delta.destroy();
          throw new Error(`[ultra-paint] filter result did not change layer "${layerId}"`);
        }
        history.recordTileEdit(layerId, delta);
        this.store.touchTexture(layerId);
        return;
      } catch (error) {
        if (transaction.active) transaction.rollback();
        throw error;
      } finally {
        decoded.destroy(true);
      }
    }

    let replacement: RenderTexture | null = null;
    let sprite: Sprite | null = null;
    try {
      replacement = RenderTexture.create({
        width: target!.width,
        height: target!.height,
        resolution: target!.source.resolution,
        antialias: target!.source.antialias,
        format: target!.source.format,
        alphaMode: target!.source.alphaMode,
      });
      sprite = new Sprite({ texture: decoded });
      sprite.width = target!.width;
      sprite.height = target!.height;
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
        target!,
        replacement,
        layer.transform,
      );
      if (previous !== target!) {
        throw new Error(`[ultra-paint] filter target layer "${layerId}" changed`);
      }
      adopted = true;
      this.tree?.getNode(layerId)?.setTexture(replacement);
      history.commitPixelChange(pending);
      target!.destroy(true);
    } catch (error) {
      history.discardPixelChange(pending);
      if (adopted) {
        const rolledBack = this.store.replaceLayerTexture(
          layerId,
          replacement,
          target!,
          layer.transform,
        );
        if (rolledBack === replacement) {
          this.tree?.getNode(layerId)?.setTexture(target!);
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
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
    await this.ready;

    const doc = this.store.getDocument();
    const surface = this.createBlankTiledSurface(doc.boundaryBox.width, doc.boundaryBox.height);
    try {
      const wasEmpty = this.store.getDocument().layers.length === 0;
      const id = this.store.addRasterLayerTiled(surface, name, "paint");
      this.recenterIfFirstLayer(wasEmpty);
      const current = this.store.getDocument();
      this.store.setTransform(id, {
        x: current.boundaryBox.x,
        y: current.boundaryBox.y,
      });
      return id;
    } catch (error) {
      surface.destroy();
      throw error;
    }
  }

  /** Rasterize selected top-level regular layers into a new document-space layer. */
  public mergeLayersToNewLayer(ids: readonly LayerId[]): LayerId {
    if (isDocumentMutationLocked()) throw new Error("Document is locked while previewing");
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
    const bounds = this.getSelectionBounds(selected);

    const surface = this.flattenSelectedToTiledSurface(selected);
    let adopted = false;
    try {
      const id = this.store.addRasterLayerTiled(
        surface,
        `Merged ${selected.length} layers`,
        "paint",
      );
      adopted = true;
      this.store.setTransform(id, { x: bounds.x, y: bounds.y });
      this.store.reorderLayer(id, Math.min(...selected.map((sid) => preOrder.indexOf(sid))));
      this.store.setSelectedLayerId(id);
      return id;
    } catch (error) {
      if (!adopted) surface.destroy();
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
    const bounds = this.getSelectionBounds(selected);

    const surface = this.mergeMasksToTiledSurface(selected);
    let adopted = false;
    try {
      const id = this.store.addMaskLayerTiled(surface, `Merged ${selected.length} masks`);
      adopted = true;
      this.store.setTransform(id, { x: bounds.x, y: bounds.y });
      this.store.reorderLayer(id, Math.min(...selected.map((sid) => preOrder.indexOf(sid))));
      this.store.setSelectedLayerId(id);
      return id;
    } catch (error) {
      if (!adopted) surface.destroy();
      throw error;
    }
  }

  /**
   * Union of `ids`' rendered content bounds, in document space -- independent
   * of the document's boundary box, so merging layers that sit outside (or
   * only partly inside) it keeps all of their content instead of clipping to
   * the box.
   */
  private getSelectionBounds(ids: readonly LayerId[]): BoundaryBox {
    const tree = this.tree;
    if (!tree) {
      throw new Error("[ultra-paint] cannot merge layers before the app is ready");
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const node = tree.getNode(id);
      if (!node) continue;
      // getBounds() is in stage (global/screen) space, which includes the
      // camera pan/zoom applied above `tree.root` -- reproject the AABB
      // corners into `tree.root`'s own (document) space before unioning.
      const bounds = node.container.getBounds();
      const topLeft = tree.root.toLocal({ x: bounds.x, y: bounds.y });
      const bottomRight = tree.root.toLocal({
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
      });
      minX = Math.min(minX, topLeft.x);
      minY = Math.min(minY, topLeft.y);
      maxX = Math.max(maxX, bottomRight.x);
      maxY = Math.max(maxY, bottomRight.y);
    }
    if (!Number.isFinite(minX)) {
      throw new Error("[ultra-paint] selected layers have no visible content to merge");
    }
    minX = Math.floor(minX);
    minY = Math.floor(minY);
    return { x: minX, y: minY, width: Math.ceil(maxX) - minX, height: Math.ceil(maxY) - minY };
  }

  /**
   * Render just `ids` (temporarily hiding every other layer), chunk by
   * chunk, straight into a fresh tiled surface -- no full-boundary-box
   * intermediate `RenderTexture` is ever allocated. Each chunk is exactly
   * one tile, so the render lands directly on that tile's persistent
   * target; there is no separate stitching step.
   */
  private flattenSelectedToTiledSurface(ids: readonly LayerId[]): TiledRasterCanvas {
    const app = this.app;
    const tree = this.tree;
    if (!app || !tree) {
      throw new Error("[ultra-paint] cannot merge layers before the app is ready");
    }
    const box = this.getSelectionBounds(ids);
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(`[ultra-paint] cannot merge ${box.width}x${box.height} of content`);
    }

    return this.withOnlySelectedRenderable(ids, () =>
      this.withTileDebugBordersHidden(() => {
        const root = tree.root;
        const previousMask = root.mask;
        root.mask = null;
        const tileSize =
          getTileRendererCapabilities(app.renderer).selectedTileSize ?? PREFERRED_TILE_SIZE;
        const surface = new TiledRasterCanvas(app.renderer, tileSize);
        const transform = new Matrix();

        try {
          const transaction = surface.beginEdit("merge");
          try {
            for (let offsetY = 0; offsetY < box.height; offsetY += tileSize) {
              for (let offsetX = 0; offsetX < box.width; offsetX += tileSize) {
                const region = { x: offsetX, y: offsetY, width: tileSize, height: tileSize };
                transform.set(1, 0, 0, 1, -box.x - offsetX, -box.y - offsetY);
                surface.edit(region, { allocation: "allocate-missing", transaction }, (tile) => {
                  app.renderer.render({
                    container: root,
                    target: tile.target,
                    transform,
                    clear: true,
                    clearColor: [0, 0, 0, 0],
                  });
                });
              }
            }
            transaction.includeBounds({ x: 0, y: 0, width: box.width, height: box.height });
            transaction.commit().destroy();
          } catch (error) {
            transaction.rollback();
            throw error;
          }
          return surface;
        } catch (error) {
          surface.destroy();
          throw error;
        } finally {
          root.mask = previousMask;
        }
      }),
    );
  }

  /**
   * Render just the mask layers in `ids`, chunk by chunk, straight into a
   * fresh tiled surface -- no full-boundary-box intermediate `RenderTexture`.
   *
   * Unlike {@link flattenSelectedToTiledSurface}, this builds its own
   * temporary raw-texture `Container` (mirroring `Compositor.flattenMask()`)
   * instead of rendering `tree.root` directly: mask layer nodes in the live
   * scene carry a display-only `MaskHatchFilter` tint, which would otherwise
   * get baked into the merged layer's actual stored pixels.
   */
  private mergeMasksToTiledSurface(ids: readonly LayerId[]): TiledRasterCanvas {
    const app = this.app;
    if (!app) {
      throw new Error("[ultra-paint] cannot merge masks before the app is ready");
    }
    const box = this.getSelectionBounds(ids);
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(`[ultra-paint] cannot merge ${box.width}x${box.height} of content`);
    }

    const idSet = new Set(ids);
    const byId = new Map(this.store.getDocument().layers.map((layer) => [layer.id, layer]));
    // Pixi draws last-child-on-top; document index 0 is the top (see the
    // matching comment in Compositor.flattenMask()).
    const ordered = [...this.store.getDocument().layerOrder]
      .reverse()
      .map((id) => byId.get(id))
      .filter(
        (layer): layer is MaskLayer =>
          layer !== undefined && layer.kind === "mask" && idSet.has(layer.id),
      );

    const root = new Container({ label: "ultra-paint:mask-merge" });
    try {
      for (const layer of ordered) {
        const texture = this.store.getTexture(layer.id);
        const surface = this.store.getTiledSurface(layer.id);
        if (!texture && !surface) continue;

        const layerContainer = new Container({ label: `mask-merge:${layer.id}` });
        layerContainer.position.set(layer.transform.x, layer.transform.y);
        layerContainer.scale.set(layer.transform.scaleX, layer.transform.scaleY);
        layerContainer.rotation = layer.transform.rotation;
        layerContainer.alpha = layer.opacity;
        layerContainer.blendMode = toPixiBlendMode(layer.blendMode);

        if (texture) {
          layerContainer.addChild(new Sprite({ texture }));
        } else {
          surface!.visitAll((tile) => {
            const sprite = new Sprite({ texture: tile.target });
            sprite.position.set(tile.originX, tile.originY);
            layerContainer.addChild(sprite);
          });
        }
        root.addChild(layerContainer);
      }

      const tileSize =
        getTileRendererCapabilities(app.renderer).selectedTileSize ?? PREFERRED_TILE_SIZE;
      const destination = new TiledRasterCanvas(app.renderer, tileSize);
      const transaction = destination.beginEdit("merge-masks");
      const transform = new Matrix();
      try {
        for (let offsetY = 0; offsetY < box.height; offsetY += tileSize) {
          for (let offsetX = 0; offsetX < box.width; offsetX += tileSize) {
            const region = { x: offsetX, y: offsetY, width: tileSize, height: tileSize };
            transform.set(1, 0, 0, 1, -box.x - offsetX, -box.y - offsetY);
            destination.edit(region, { allocation: "allocate-missing", transaction }, (tile) => {
              app.renderer.render({
                container: root,
                target: tile.target,
                transform,
                clear: true,
                clearColor: [0, 0, 0, 0],
              });
            });
          }
        }
        transaction.includeBounds({ x: 0, y: 0, width: box.width, height: box.height });
        transaction.commit().destroy();
        return destination;
      } catch (error) {
        transaction.rollback();
        destination.destroy();
        throw error;
      }
    } finally {
      root.destroy({ children: true });
    }
  }

  /**
   * Force only `ids` renderable/visible for the duration of `render`, then
   * restore every layer's prior state. Shared by the merge/flatten helpers
   * above.
   *
   * Both `renderable` and `visible` are forced: a mask can be
   * document-visible but still forced off-screen by the "hide all masks"
   * toggle or an active generation preview (`GenerationPreviewOverlay` sets
   * `container.visible` directly), and Pixi skips rendering either way.
   */
  private withOnlySelectedRenderable<T>(ids: readonly LayerId[], render: () => T): T {
    const tree = this.tree;
    if (!tree) {
      throw new Error("[ultra-paint] cannot merge layers before the app is ready");
    }
    const selectedSet = new Set(ids);
    const saved = this.store
      .getDocument()
      .layerOrder.map((id) => {
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
      return render();
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
  public flattenToDataURL(chunkSize?: number): string {
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
    // The preview-comparison controls change scene visibility directly. Export
    // instead follows the document's persisted raster/group visibility, while
    // continuing to exclude masks and ControlNet inputs from the composite.
    const sceneVisibility = doc.layers
      .map((layer) => {
        const node = tree.getNode(layer.id);
        return node
          ? { layer, node, renderable: node.container.renderable, visible: node.container.visible }
          : null;
      })
      .filter((entry) => entry !== null);
    tree.root.removeFromParent();
    for (const entry of sceneVisibility) {
      const include = entry.layer.kind !== "mask" && entry.layer.kind !== "control";
      entry.node.container.renderable = include;
      entry.node.container.visible = include && entry.layer.visible;
    }
    try {
      return this.withTileDebugBordersHidden(() =>
        Compositor.flatten(app, tree.root, doc.boundaryBox, chunkSize),
      );
    } finally {
      for (const entry of sceneVisibility) {
        entry.node.container.renderable = entry.renderable;
        entry.node.container.visible = entry.visible;
      }
      parent?.addChildAt(tree.root, insertIndex);
    }
  }

  /**
   * Temporarily hide the debug tile-border overlay for one render, so a
   * Save/Generate/merge export never bakes it in. No-op (and cheap to check)
   * when the overlay is already off.
   */
  private withTileDebugBordersHidden<T>(render: () => T): T {
    const wasVisible = this.tileDebugBordersVisible;
    if (!wasVisible) return render();
    this.tree?.setTileDebugBorders(false);
    try {
      return render();
    } finally {
      this.tree?.setTileDebugBorders(true);
    }
  }

  /** Export visible inpainting masks, or `null` when none are enabled. */
  public flattenMaskToDataURL(chunkSize?: number): string | null {
    const app = this.app;
    if (!app) {
      throw new Error(
        "[ultra-paint] flattenMaskToDataURL() called before the app was ready; await `app.ready` first",
      );
    }
    const doc = this.store.getDocument();
    return Compositor.flattenMask(app, this.store, doc.boundaryBox, chunkSize);
  }

  /** Resize the operating region and center it in the current viewport. */
  public resizeBoundaryBox(width: number, height: number): void {
    if (isDocumentMutationLocked()) return;
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
    if (isDocumentMutationLocked()) return;
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

      const bounds = this.store.getLayerPixelBounds(layer.id);
      if (!bounds) continue;
      const { x, y, width, height } = bounds;
      const corners: Array<[number, number]> = [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
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
    if (isDocumentMutationLocked()) return false;
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
      const monolithicTexture = this.store.getTexture(layer.id);
      const tiledSurface = monolithicTexture ? undefined : this.store.getTiledSurface(layer.id);
      const node = tree.getNode(layer.id);
      if ((!monolithicTexture && !tiledSurface) || !node) continue;

      // A tiled mask's flattened snapshot is positioned at its surface's
      // logical bounds origin, not layer-local (0, 0) -- same offset
      // `readLayerPixels()` exposes via `originX`/`originY` for other
      // consumers (see `transformForPixelSnapshot()`).
      const texture = tiledSurface
        ? flattenToTexture(app.renderer, tiledSurface)
        : monolithicTexture!;
      const boundsOriginX = tiledSurface ? (tiledSurface.bounds?.x ?? 0) : 0;
      const boundsOriginY = tiledSurface ? (tiledSurface.bounds?.y ?? 0) : 0;
      try {
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
          const x = boundsOriginX + (pixel % extracted.width) * stepX;
          const y = boundsOriginY + Math.floor(pixel / extracted.width) * stepY;
          const x0 = origin.x + a * x + c * y;
          const y0 = origin.y + b * x + d * y;
          minX = Math.min(minX, x0, x0 + ax, x0 + cx, x0 + ax + cx);
          minY = Math.min(minY, y0, y0 + ay, y0 + cy, y0 + ay + cy);
          maxX = Math.max(maxX, x0, x0 + ax, x0 + cx, x0 + ax + cx);
          maxY = Math.max(maxY, y0, y0 + ay, y0 + cy, y0 + ay + cy);
        }
      } finally {
        if (tiledSurface) texture.destroy(true);
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

    this.transformOverlay?.destroy();
    this.transformOverlay = null;

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

  /**
   * Read-only access to a paintable layer's pixels regardless of backing.
   * Monolithic layers return their live texture (`dispose` is a no-op);
   * tiled layers get a throwaway flattened snapshot the caller must dispose.
   */
  private readLayerPixels(
    id: LayerId,
  ): { texture: RenderTexture; originX: number; originY: number; dispose: () => void } | undefined {
    const texture = this.store.getTexture(id);
    if (texture) return { texture, originX: 0, originY: 0, dispose: () => {} };
    const tiledSurface = this.store.getTiledSurface(id);
    const renderer = this.app?.renderer;
    if (!tiledSurface || !renderer) return undefined;
    const bounds = tiledSurface.bounds;
    const flattened = flattenToTexture(renderer, tiledSurface);
    return {
      texture: flattened,
      originX: bounds?.x ?? 0,
      originY: bounds?.y ?? 0,
      dispose: () => flattened.destroy(true),
    };
  }

  /** Preserve world placement after a non-zero tiled origin is flattened to texture (0, 0). */
  private transformForPixelSnapshot(
    transform: Transform,
    snapshot: { originX: number; originY: number },
  ): Transform {
    if (snapshot.originX === 0 && snapshot.originY === 0) return transform;
    const scaledX = snapshot.originX * transform.scaleX;
    const scaledY = snapshot.originY * transform.scaleY;
    const cosine = Math.cos(transform.rotation);
    const sine = Math.sin(transform.rotation);
    return {
      ...transform,
      x: transform.x + scaledX * cosine - scaledY * sine,
      y: transform.y + scaledX * sine + scaledY * cosine,
    };
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

  /**
   * A tiled surface with logical bounds already set to `width x height` but
   * zero allocated tiles -- brush/fill allocate tiles on demand as the layer
   * is actually painted, matching the "a new blank layer owns zero GPU
   * tiles" invariant.
   */
  private createBlankTiledSurface(width: number, height: number): TiledRasterCanvas {
    const renderer = this.app?.renderer;
    if (!renderer) {
      throw new Error("[ultra-paint] cannot create a raster layer before the renderer is ready");
    }

    const tileSize = getTileRendererCapabilities(renderer).selectedTileSize ?? PREFERRED_TILE_SIZE;
    const surface = new TiledRasterCanvas(renderer, tileSize);
    try {
      const transaction = surface.beginEdit("blank-layer");
      transaction.includeBounds({ x: 0, y: 0, width, height });
      transaction.commit().destroy();
      return surface;
    } catch (error) {
      surface.destroy();
      throw error;
    }
  }

  private createPaintableTiledSurface(sourceTexture: Texture): TiledRasterCanvas {
    const renderer = this.app?.renderer;
    if (!renderer) {
      sourceTexture.destroy(true);
      throw new Error("[ultra-paint] cannot create a raster layer before the renderer is ready");
    }

    const tileSize = getTileRendererCapabilities(renderer).selectedTileSize ?? PREFERRED_TILE_SIZE;
    const surface = new TiledRasterCanvas(renderer, tileSize);
    try {
      const transaction = surface.beginEdit("ingest-image");
      try {
        blitTexture(renderer, surface, sourceTexture, transaction);
        transaction.commit().destroy();
      } catch (error) {
        transaction.rollback();
        throw error;
      }
      return surface;
    } catch (error) {
      surface.destroy();
      throw error;
    } finally {
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
    const dimensions = fitDimensions(bitmap.width, bitmap.height);
    if (dimensions.width === bitmap.width && dimensions.height === bitmap.height) {
      return Texture.from(bitmap, true);
    }
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      throw new Error("[ultra-paint] cannot resize decoded image");
    }
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    bitmap.close();
    return Texture.from(canvas, true);
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("[ultra-paint] failed to decode image"));
      el.src = url;
    });
    const dimensions = fitDimensions(image.naturalWidth, image.naturalHeight);
    if (dimensions.width === image.naturalWidth && dimensions.height === image.naturalHeight) {
      return Texture.from(image, true);
    }
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("[ultra-paint] cannot resize decoded image");
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    return Texture.from(canvas, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Overlap of two pixel rects, or `null` when they don't overlap (or `bounds` is absent). */
function intersectBounds(region: PixelBounds, bounds: PixelBounds | null): PixelBounds | null {
  if (!bounds) return null;
  const left = Math.max(region.x, bounds.x);
  const top = Math.max(region.y, bounds.y);
  const right = Math.min(region.x + region.width, bounds.x + bounds.width);
  const bottom = Math.min(region.y + region.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function boundsEqual(left: PixelBounds, right: PixelBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
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

/** Undo step for a tiled-surface edit (e.g. Fill on an uploaded layer). */
interface TilePixelHistoryEntry {
  kind: "tile-pixels";
  layerId: LayerId;
  delta: TileEditDelta;
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
  tiledSurface: TiledRasterCanvas | undefined;
}

/** Undo state for a user deletion; owns every detached pixel backing. */
interface DeletedLayersHistoryEntry {
  kind: "deleted-layers";
  snapshot: LayerRemovalSnapshot;
}

/** Redo state after a deletion was undone; the layers are live in the store. */
interface DeleteLayersHistoryEntry {
  kind: "delete-layers";
  rootIds: readonly LayerId[];
}

type HistoryEntry =
  | PixelHistoryEntry
  | TilePixelHistoryEntry
  | StateHistoryEntry
  | AddLayerHistoryEntry
  | RemovedLayerHistoryEntry
  | DeletedLayersHistoryEntry
  | DeleteLayersHistoryEntry;

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

  /** Record an already-committed tiled-surface edit (e.g. Fill) as one undo step. */
  public recordTileEdit(layerId: LayerId, delta: TileEditDelta): void {
    this.record({ kind: "tile-pixels", layerId, delta });
  }

  /** Keep adjacent transform gestures from merging into one undo step. */
  public finishContinuousMutation(): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last?.kind === "state") last.recordedAt = Number.NEGATIVE_INFINITY;
  }

  public undo(): void {
    if (this.pendingPixelChanges > 0) return;
    const entry = this.undoStack.pop();
    if (!entry) return;

    if (entry.kind === "pixels") {
      this.restorePixelEntry(entry, this.undoStack, this.redoStack);
      return;
    }
    if (entry.kind === "tile-pixels") {
      this.restoreTileEntry(entry, this.undoStack, this.redoStack);
      return;
    }
    if (entry.kind === "add-layer") {
      this.undoAddLayer(entry);
      return;
    }
    if (entry.kind === "deleted-layers") {
      this.undoDeleteLayers(entry);
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
    if (entry.kind === "tile-pixels") {
      this.restoreTileEntry(entry, this.redoStack, this.undoStack);
      return;
    }
    if (entry.kind === "removed-layer") {
      this.redoAddLayer(entry);
      return;
    }
    if (entry.kind === "delete-layers") {
      this.redoDeleteLayers(entry);
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
      this.store.restoreLayerForUndo(entry.layer, entry.index, entry.texture, entry.tiledSurface);
      this.undoStack.push({ kind: "add-layer", layerId: entry.layer.id });
    } finally {
      this.replaying = false;
    }
  }

  private undoDeleteLayers(entry: DeletedLayersHistoryEntry): void {
    try {
      this.replaying = true;
      this.store.restoreLayersForUndo(entry.snapshot);
      this.redoStack.push({ kind: "delete-layers", rootIds: entry.snapshot.rootIds });
    } catch (error) {
      this.undoStack.push(entry);
      throw error;
    } finally {
      this.replaying = false;
    }
  }

  private redoDeleteLayers(entry: DeleteLayersHistoryEntry): void {
    try {
      this.replaying = true;
      const snapshot = this.store.extractLayersForUndo(entry.rootIds);
      if (snapshot) this.undoStack.push({ kind: "deleted-layers", snapshot });
      else this.redoStack.push(entry);
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
    if (mutation.kind === "clear") {
      this.clear();
      return;
    }
    if (mutation.kind === "remove-layer") {
      this.destroyStack(this.redoStack);
      // ponytail: deleted GPU backings stay resident for the bounded history;
      // spill snapshots to IndexedDB only if profiling shows real VRAM pressure.
      this.undoStack.push({ kind: "deleted-layers", snapshot: mutation.snapshot });
      this.trimUndoStack();
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

  /**
   * Swap a tiled edit's delta for its inverse. `TileEditDelta.apply()` already
   * emits the add/remove/replace events `TiledRasterView` needs to resync
   * sprites, so there is no scene-graph work here.
   */
  private restoreTileEntry(
    entry: TilePixelHistoryEntry,
    sourceStack: HistoryEntry[],
    destinationStack: HistoryEntry[],
  ): void {
    const surface = this.store.getTiledSurface(entry.layerId);
    if (!surface) {
      entry.delta.destroy();
      this.clear();
      return;
    }

    let inverse: TileEditDelta;
    try {
      inverse = entry.delta.apply();
    } catch (error) {
      sourceStack.push(entry);
      throw error;
    }
    destinationStack.push({ kind: "tile-pixels", layerId: entry.layerId, delta: inverse });
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
    if (entry.kind === "tile-pixels") entry.delta.destroy();
    if (entry.kind === "removed-layer") {
      entry.texture?.destroy(true);
      entry.tiledSurface?.destroy();
    }
    if (entry.kind === "deleted-layers") {
      this.store.destroyLayerRemovalSnapshot(entry.snapshot);
    }
  }
}
