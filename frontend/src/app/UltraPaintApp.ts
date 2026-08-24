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
    Container,
    Filter,
    Graphics,
    RenderTexture,
    Sprite,
    Texture,
} from "pixi.js";

import { Compositor } from "../scene/Compositor";
import { BoundaryBoxOverlay } from "../scene/BoundaryBoxOverlay";
import { BrushCursorOverlay } from "../scene/BrushCursorOverlay";
import { PixelGrid } from "../scene/PixelGrid";
import { BrushEngine } from "../paint/BrushEngine";
import { EraserEngine } from "../paint/EraserEngine";
import {
    StrokeController,
    type StrokeSession,
} from "../paint/StrokeController";
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
} from "../state/paintToolStore.svelte";
import type { ImageRef, LayerId, Transform } from "../state/schema";

const HISTORY_LIMIT = 40;
const HISTORY_MERGE_WINDOW_MS = 500;

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
            throw new Error(
                `[ultra-paint] root element "#${this.rootElementId}" not found`,
            );
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
            root.clientWidth > 0 &&
            root.clientHeight > 0 &&
            this.centerDocument();
        this.pixelGrid = new PixelGrid(this.tree.root, this.store);
        this.world.addChild(this.pixelGrid.container);
        this.world.addChild(this.tree.root);

        this.boundaryBoxOverlay = new BoundaryBoxOverlay(
            app,
            app.canvas,
            this.tree.root,
            this.store,
            this.toolStore,
        );
        this.world.addChild(this.boundaryBoxOverlay.container);
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
        this.history = new UndoHistory(
            app,
            this.store,
            this.tree,
            HISTORY_LIMIT,
        );

        this.brushEngine = new BrushEngine(
            app,
            this.tree.root,
            this.tree,
            this.store,
        );
        this.eraserEngine = new EraserEngine(
            app,
            this.tree.root,
            this.tree,
            this.store,
        );
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

    private mountViewportControls(
        canvas: HTMLCanvasElement,
        root: HTMLElement,
    ): void {
        this.viewportCanvas = canvas;
        canvas.addEventListener("wheel", this.handleWheel, { passive: false });
        canvas.addEventListener("pointerdown", this.handlePointerDown);
        canvas.addEventListener("pointermove", this.handlePointerMove);
        canvas.addEventListener("pointerup", this.handlePointerEnd);
        canvas.addEventListener("pointercancel", this.handlePointerEnd);
        canvas.addEventListener("lostpointercapture", this.handlePointerEnd);
        canvas.addEventListener("auxclick", this.handleAuxClick);
        canvas.addEventListener("keydown", this.handleHistoryKeyDown);
        canvas.tabIndex = 0;

        if (typeof ResizeObserver !== "undefined") {
            this.viewportResizeObserver = new ResizeObserver(() => {
                const app = this.app;
                const world = this.world;
                const width = root.clientWidth;
                const height = root.clientHeight;
                if (!app || !world || width <= 0 || height <= 0) return;
                if (app.screen.width !== width || app.screen.height !== height) {
                    app.renderer.resize(width, height);
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
        canvas.removeEventListener("pointerup", this.handlePointerEnd);
        canvas.removeEventListener("pointercancel", this.handlePointerEnd);
        canvas.removeEventListener("lostpointercapture", this.handlePointerEnd);
        canvas.removeEventListener("auxclick", this.handleAuxClick);
        canvas.removeEventListener("keydown", this.handleHistoryKeyDown);
        this.viewportResizeObserver?.disconnect();
        this.viewportResizeObserver = null;
        this.viewportCanvas = null;
        this.panPointerId = null;
    }

    private readonly handleWheel = (event: WheelEvent): void => {
        const app = this.app;
        const world = this.world;
        const canvas = this.viewportCanvas;
        if (!app || !world || !canvas) return;

        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const cursorX =
            ((event.clientX - rect.left) * app.screen.width) / rect.width;
        const cursorY =
            ((event.clientY - rect.top) * app.screen.height) / rect.height;
        const previousScale = world.scale.x;
        let deltaY = event.deltaY;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) deltaY *= 16;
        if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) deltaY *= rect.height;
        const nextScale = Math.min(
            8,
            Math.max(0.1, previousScale * Math.exp(-deltaY * 0.0015)),
        );
        const documentX = (cursorX - world.x) / previousScale;
        const documentY = (cursorY - world.y) / previousScale;

        world.scale.set(nextScale);
        world.position.set(
            cursorX - documentX * nextScale,
            cursorY - documentY * nextScale,
        );
    };

    private readonly handlePointerDown = (event: PointerEvent): void => {
        const canvas = this.viewportCanvas;
        if (!canvas) return;
        if (event.button === 0 || event.button === 1) {
            canvas.focus({ preventScroll: true });
        }
        if (event.button !== 1) return;
        event.preventDefault();
        this.panRestingCursor = canvas.style.cursor;
        this.panPointerId = event.pointerId;
        this.panClientX = event.clientX;
        this.panClientY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = "grabbing";
    };

    private readonly handlePointerMove = (event: PointerEvent): void => {
        const app = this.app;
        const world = this.world;
        const canvas = this.viewportCanvas;
        if (
            !app ||
            !world ||
            !canvas ||
            event.pointerId !== this.panPointerId
        ) {
            return;
        }

        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        world.position.set(
            world.x +
                ((event.clientX - this.panClientX) * app.screen.width) /
                    rect.width,
            world.y +
                ((event.clientY - this.panClientY) * app.screen.height) /
                    rect.height,
        );
        this.panClientX = event.clientX;
        this.panClientY = event.clientY;
    };

    private readonly handlePointerEnd = (event: PointerEvent): void => {
        const canvas = this.viewportCanvas;
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

    private readonly handleHistoryKeyDown = (event: KeyboardEvent): void => {
        if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;

        const key = event.key.toLowerCase();
        const redo = key === "y" || (key === "z" && event.shiftKey);
        if (key !== "z" && key !== "y") return;

        event.preventDefault();
        try {
            if (redo) this.history?.redo();
            else this.history?.undo();
        } catch (error) {
            console.error("[ultra-paint] undo/redo failed", error);
        }
    };

    private readonly beginStroke = (
        tool: PaintTool,
        layerId: LayerId,
    ): StrokeSession | null => {
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

    /** Fill the selected raster layer with the current brush color/opacity. */
    public readonly fillSelectedLayer = (): void => {
        const app = this.app;
        const layerId = this.store.getSelectedLayerId();
        const layer = layerId ? this.store.getLayer(layerId) : undefined;
        const target = layerId ? this.store.getTexture(layerId) : undefined;
        if (!app || !layerId || !layer || layer.kind !== "raster" || !target) {
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
        world.position.set(
            app.screen.width / 2 - documentX,
            app.screen.height / 2 - documentY,
        );
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
        const scale = Math.min(
            availableWidth / box.width,
            availableHeight / box.height,
        );
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
        const id = this.store.addRasterLayer(
            this.createPaintableTexture(texture),
            name,
            source,
        );
        return id;
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
        const id = this.store.addRasterLayer(
            this.createPaintableTexture(texture),
            name,
            source,
        );
        const doc = this.store.getDocument();
        this.store.setTransform(id, {
            x: doc.boundaryBox.x,
            y: doc.boundaryBox.y,
        });
        return id;
    }

    /**
     * Create a transparent, paintable raster layer at the current document
     * dimensions. Resolves with the new layer's id.
     */
    public async addBlankLayer(name?: string): Promise<LayerId> {
        await this.ready;
        const renderer = this.app?.renderer;
        if (!renderer) {
            throw new Error(
                "[ultra-paint] cannot create a blank layer before the renderer is ready",
            );
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
            const id = this.store.addRasterLayer(texture, name, "paint");
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
        const insertIndex = this.pixelGrid && parent?.children.includes(this.pixelGrid.container)
            ? parent.getChildIndex(this.pixelGrid.container) + 1
            : 0;
        const maskVisibility = doc.layers
            .filter((layer) => layer.kind === "mask")
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

    /** Tear down the renderer, the scene graph, and the DOM canvas. */
    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        if (activeInstance === this) activeInstance = null;

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

        this.app?.destroy(
            { removeView: true, releaseGlobalResources: true },
            { children: true },
        );
        this.app = null;
    }

    /** Copy a decoded image into the paintable backing for a raster layer. */
    private createPaintableTexture(sourceTexture: Texture): RenderTexture {
        const renderer = this.app?.renderer;
        if (!renderer) {
            sourceTexture.destroy(true);
            throw new Error(
                "[ultra-paint] cannot create a raster layer before the renderer is ready",
            );
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
            el.onerror = () =>
                reject(new Error("[ultra-paint] failed to decode image"));
            el.src = url;
        });
        return Texture.from(image, true);
    } finally {
        URL.revokeObjectURL(url);
    }
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

type HistoryEntry = PixelHistoryEntry | StateHistoryEntry;

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

    public end(
        points: Parameters<StrokeSession["end"]>[0],
        cancelled: boolean,
    ): void {
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
        this.unsubscribeMutations = store.subscribeMutations(
            this.recordStoreMutation,
        );
    }

    public beginPixelChange(layerId: LayerId): PendingPixelChange | null {
        const target = this.store.getTexture(layerId);
        const layer = this.store.getLayer(layerId);
        if (
            !target ||
            !layer ||
            (layer.kind !== "raster" && layer.kind !== "mask")
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
            (layer.kind !== "raster" && layer.kind !== "mask")
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

    public clear(): void {
        this.destroyStack(this.undoStack);
        this.destroyStack(this.redoStack);
    }

    public destroy(): void {
        this.unsubscribeMutations();
        this.clear();
    }

    private readonly recordStoreMutation = (
        mutation: LayerStoreMutation,
    ): void => {
        if (this.replaying) return;
        if (
            mutation.kind === "add-layer" ||
            mutation.kind === "remove-layer" ||
            mutation.kind === "clear"
        ) {
            this.clear();
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
            (layer.kind !== "raster" && layer.kind !== "mask")
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
            throw new Error(
                `[ultra-paint] failed to restore paintable layer "${entry.layerId}"`,
            );
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

    private copyTextureInto(
        source: RenderTexture,
        destination: RenderTexture,
    ): void {
        if (
            source.source.pixelWidth !== destination.source.pixelWidth ||
            source.source.pixelHeight !== destination.source.pixelHeight
        ) {
            throw new Error(
                "[ultra-paint] cannot restore a layer snapshot with different dimensions",
            );
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

    private applyStateMutation(
        mutation: LayerStoreMutation,
        usePrevious: boolean,
    ): void {
        switch (mutation.kind) {
            case "reorder-layer":
                this.store.reorderLayer(
                    mutation.layerId,
                    usePrevious ? mutation.previous : mutation.next,
                );
                return;
            case "set-opacity":
                this.store.setOpacity(
                    mutation.layerId,
                    usePrevious ? mutation.previous : mutation.next,
                );
                return;
            case "set-blend-mode":
                this.store.setBlendMode(
                    mutation.layerId,
                    usePrevious ? mutation.previous : mutation.next,
                );
                return;
            case "set-visible":
                this.store.setVisible(
                    mutation.layerId,
                    usePrevious ? mutation.previous : mutation.next,
                );
                return;
            case "set-name":
                this.store.setName(
                    mutation.layerId,
                    usePrevious ? mutation.previous : mutation.next,
                );
                return;
            case "set-transform":
                this.store.setTransform(
                    mutation.layerId,
                    usePrevious ? mutation.previous : mutation.next,
                );
                return;
            case "set-boundary-box": {
                this.store.setBoundaryBox(
                    usePrevious ? mutation.previous : mutation.next,
                );
                return;
            }
            case "add-layer":
            case "remove-layer":
            case "clear":
                throw new Error(
                    `[ultra-paint] structural mutation "${mutation.kind}" is not undoable`,
                );
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
    }
}
