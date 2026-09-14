import { Container, Graphics, Point } from "pixi.js";
import type { Application } from "pixi.js";

import type { PixelBounds } from "../canvas/TileGrid";
import type { TiledRasterCanvas } from "../canvas/TiledRasterCanvas";
import { tightAlphaBounds } from "../canvas/TileRasterOps";
import type { LayerNode } from "../scene/LayerNode";
import type { LayerTree } from "../scene/LayerTree";
import { MaskHatchFilter } from "../scene/MaskHatchFilter";
import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
import { filterStore } from "../state/filterStore.svelte";
import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import type {
  LassoMode,
  PaintToolStore,
  PaintToolUnsubscribe,
} from "../state/paintToolStore.svelte";
import { previewStore } from "../state/previewStore.svelte";
import type { LayerId } from "../state/schema";
import {
  LASSO_CURSOR_CLOSE,
  LASSO_CURSOR_DISABLED,
  LASSO_CURSOR_FREEHAND_ADD,
  LASSO_CURSOR_FREEHAND_REPLACE,
  LASSO_CURSOR_FREEHAND_SUBTRACT,
  LASSO_CURSOR_POLYGONAL_ADD,
  LASSO_CURSOR_POLYGONAL_REPLACE,
  LASSO_CURSOR_POLYGONAL_SUBTRACT,
} from "./lassoCursors";
import type { TileEditRecorder } from "./TiledConsistentOpacityStroke";

const CLOSE_TOLERANCE_PX = 10;
const FREEHAND_SAMPLE_DISTANCE = 2;
const INVALID_COLOR = 0xff3b30;
const SUBTRACT_COLOR = 0xff8a3d;

type LassoOperation = "replace" | "add" | "subtract";

interface GesturePoint {
  document: Point;
  local: Point;
}

interface ActiveLasso {
  layerId: LayerId;
  surface: TiledRasterCanvas;
  node: LayerNode;
  mode: LassoMode;
  operation: LassoOperation;
  points: GesturePoint[];
  hover: GesturePoint | null;
  pointerId: number | null;
  firstClientX: number;
  firstClientY: number;
  invalid: boolean;
}

/** Native-DOM lasso capture plus one reusable, display-only Pixi preview. */
export class LassoController {
  private readonly overlay = new Graphics({ label: "ultra-paint:lasso-preview" });
  private readonly hatch = new MaskHatchFilter("#ffffff");
  private readonly screenPoint = new Point();
  private readonly documentPoint = new Point();
  private readonly localPoint = new Point();
  private readonly unsubscribeStore: Unsubscribe;
  private readonly unsubscribeTools: PaintToolUnsubscribe;
  private readonly unsubscribePreview: () => void;
  private readonly unsubscribeFilter: () => void;
  private active: ActiveLasso | null = null;
  private lastPointerEvent: PointerEvent | null = null;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly app: Application,
    private readonly documentRoot: Container,
    overlayParent: Container,
    private readonly tree: LayerTree,
    private readonly store: LayerStore,
    private readonly tools: PaintToolStore,
    private readonly history: TileEditRecorder,
  ) {
    this.overlay.eventMode = "none";
    this.overlay.visible = false;
    overlayParent.addChild(this.overlay);

    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerEnd);
    canvas.addEventListener("pointercancel", this.handlePointerEnd);
    canvas.addEventListener("lostpointercapture", this.handlePointerEnd);

    this.unsubscribeStore = store.subscribe(() => {
      this.validateActiveGesture();
      this.updateCursor();
    });
    this.unsubscribeTools = tools.subscribe(() => {
      this.validateActiveGesture();
      this.updateCursor();
    });
    this.unsubscribePreview = previewStore.subscribe(this.validateActiveGesture);
    this.unsubscribeFilter = filterStore.subscribe(this.validateActiveGesture);
  }

  public get inProgress(): boolean {
    return this.active !== null;
  }

  public cancel(): boolean {
    if (!this.active) return false;
    this.finish(false);
    return true;
  }

  /** Close the active polygonal gesture from its last placed vertex, if eligible. */
  public closeFromKeyboard(): boolean {
    const active = this.active;
    if (!active || active.mode !== "polygonal" || active.points.length < 3) return false;
    this.tryCommit();
    return true;
  }

  public destroy(): void {
    this.cancel();
    this.unsubscribeStore();
    this.unsubscribeTools();
    this.unsubscribePreview();
    this.unsubscribeFilter();
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerEnd);
    this.canvas.removeEventListener("pointercancel", this.handlePointerEnd);
    this.canvas.removeEventListener("lostpointercapture", this.handlePointerEnd);
    if (this.canvas.style.cursor && this.tools.activeTool === "lasso")
      this.canvas.style.cursor = "";
    this.overlay.filters = null;
    this.overlay.removeFromParent();
    this.overlay.destroy();
    this.hatch.destroy();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.tools.activeTool !== "lasso") return;
    event.stopImmediatePropagation();
    this.lastPointerEvent = event;

    if (this.active?.invalid) this.finish(false);
    const started = !this.active;
    if (started && !this.begin(event)) return;
    const active = this.active;
    if (!active) return;

    event.preventDefault();
    if (active.mode === "freehand") {
      if (active.pointerId !== null) return;
      active.pointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (started) return;

    const point = this.toGesturePoint(event, active.node);
    if (!point) return;
    const closesNearStart =
      active.points.length >= 3 &&
      Math.hypot(event.clientX - active.firstClientX, event.clientY - active.firstClientY) <=
        CLOSE_TOLERANCE_PX;
    if (closesNearStart || (event.detail >= 2 && active.points.length >= 3)) {
      this.tryCommit();
      return;
    }
    active.points.push(point);
    active.hover = point;
    this.updateCursor();
    this.redraw();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.lastPointerEvent = event;
    this.updateCursor();
    const active = this.active;
    if (!active) return;
    if (active.mode === "freehand") {
      if (event.pointerId !== active.pointerId) return;
      event.preventDefault();
      const coalesced = event.getCoalescedEvents?.() ?? [];
      for (const sample of coalesced.length > 0 ? [...coalesced, event] : [event]) {
        this.appendFreehandPoint(sample, false);
      }
    } else {
      const point = this.toGesturePoint(event, active.node);
      if (point) active.hover = point;
    }
    this.redraw();
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    const active = this.active;
    if (!active) return;
    if (active.mode !== "freehand") {
      if (event.type === "pointercancel") this.finish(false);
      return;
    }
    if (event.pointerId !== active.pointerId) return;
    event.preventDefault();
    if (event.type === "pointerup") {
      this.appendFreehandPoint(event, true);
      this.releaseCapture(active);
      active.pointerId = null;
      this.tryCommit();
    } else {
      this.finish(false);
    }
  };

  private begin(event: PointerEvent): boolean {
    if (isDocumentMutationLocked()) return false;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    const surface = layerId ? this.store.getTiledSurface(layerId) : undefined;
    const node = layerId ? this.tree.getNode(layerId) : undefined;
    if (!layerId || layer?.kind !== "mask" || layer.locked || !surface || !node) return false;
    const first = this.toGesturePoint(event, node);
    if (!first) return false;

    const operation: LassoOperation = event.altKey
      ? "subtract"
      : event.shiftKey
        ? "add"
        : "replace";
    this.active = {
      layerId,
      surface,
      node,
      mode: this.tools.lassoMode,
      operation,
      points: [first],
      hover: first,
      pointerId: null,
      firstClientX: event.clientX,
      firstClientY: event.clientY,
      invalid: false,
    };
    if (operation === "replace") node.setMaskDisplaySuppressed(true);
    this.hatch.setColor(layer.color);
    this.redraw();
    this.updateCursor();
    return true;
  }

  private appendFreehandPoint(event: PointerEvent, force: boolean): void {
    const active = this.active;
    if (!active) return;
    const point = this.toGesturePoint(event, active.node);
    const previous = active.points[active.points.length - 1];
    if (!point || !previous) return;
    if (
      !force &&
      Math.hypot(point.document.x - previous.document.x, point.document.y - previous.document.y) <
        FREEHAND_SAMPLE_DISTANCE
    ) {
      return;
    }
    active.points.push(point);
  }

  private tryCommit(): void {
    const active = this.active;
    if (!active || !this.isStillValid(active)) {
      this.finish(false);
      return;
    }
    const points = downsample(active.points, active.mode === "freehand" ? 2 : 0.5);
    if (points.length < 3 || Math.abs(polygonArea(points)) < 0.5) {
      active.points = points;
      active.hover = null;
      active.invalid = true;
      this.redraw();
      return;
    }
    this.finish(true, points);
  }

  private finish(commit: boolean, points: GesturePoint[] = []): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.releaseCapture(active);
    active.node.setMaskDisplaySuppressed(false);
    this.overlay.visible = false;
    this.overlay.filters = null;
    this.overlay.clear();
    this.updateCursor();
    if (!commit) return;
    try {
      this.commit(active, points);
    } catch (error) {
      console.error("[ultra-paint] lasso commit failed", error);
    }
  }

  private commit(active: ActiveLasso, points: readonly GesturePoint[]): void {
    if (!this.isStillValid(active)) return;
    const localPoints = points.flatMap((point) => [point.local.x, point.local.y]);
    const xs = points.map((point) => point.local.x);
    const ys = points.map((point) => point.local.y);
    const left = Math.floor(Math.min(...xs));
    const top = Math.floor(Math.min(...ys));
    const region = {
      x: left,
      y: top,
      width: Math.ceil(Math.max(...xs)) - left,
      height: Math.ceil(Math.max(...ys)) - top,
    };
    if (region.width <= 0 || region.height <= 0) return;

    const transaction = active.surface.beginEdit(`lasso-${active.operation}`);
    try {
      if (active.operation === "replace") {
        const tileBounds: PixelBounds[] = [];
        active.surface.visitAll((tile) =>
          tileBounds.push(active.surface.grid.boundsFor(tile.coord)),
        );
        for (const bounds of tileBounds) {
          active.surface.edit(bounds, { allocation: "existing-only", transaction }, (tile) => {
            this.app.renderer.renderTarget.bind({
              target: tile.target,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });
          });
        }
      }

      const allocation = active.operation === "subtract" ? "existing-only" : "allocate-missing";
      active.surface.edit(region, { allocation, transaction }, (tile) => {
        const root = new Container();
        const graphics = new Graphics();
        graphics
          .poly(
            localPoints.map((value, index) =>
              index % 2 === 0 ? value - tile.originX : value - tile.originY,
            ),
            true,
          )
          .fill(0xffffff);
        graphics.blendMode = active.operation === "subtract" ? "erase" : "max";
        root.addChild(graphics);
        try {
          this.app.renderer.render({ container: root, target: tile.target, clear: false });
        } finally {
          root.destroy({ children: true });
        }
      });

      if (active.operation === "replace" || active.operation === "subtract") {
        let tightBounds: PixelBounds | null = null;
        active.surface.visitAll((tile) => {
          const tight = tightAlphaBounds(
            this.app.renderer,
            tile.target,
            tile.originX,
            tile.originY,
          );
          if (tight) tightBounds = tightBounds ? unionBounds(tightBounds, tight) : tight;
          else active.surface.removeTile(tile.coord, transaction);
        });
        transaction.replaceBounds(tightBounds);
      } else {
        active.surface.visit(region, (tile) => {
          const tight = tightAlphaBounds(
            this.app.renderer,
            tile.target,
            tile.originX,
            tile.originY,
          );
          if (tight) transaction.includeBounds(tight);
          else active.surface.removeTile(tile.coord, transaction);
        });
      }

      const delta = transaction.commit();
      if (delta.tileCount === 0) {
        delta.destroy();
        return;
      }
      this.history.recordTileEdit(active.layerId, delta);
      this.store.touchTexture(active.layerId);
    } catch (error) {
      if (transaction.active) transaction.rollback();
      throw error;
    }
  }

  private redraw(): void {
    const active = this.active;
    this.overlay.clear();
    if (!active) {
      this.overlay.visible = false;
      return;
    }
    const points = [...active.points];
    if (active.mode === "polygonal" && active.hover && !active.invalid) points.push(active.hover);
    const flat = points.flatMap((point) => [point.document.x, point.document.y]);
    const invalid = active.invalid;
    const subtract = active.operation === "subtract";
    const color = invalid ? INVALID_COLOR : subtract ? SUBTRACT_COLOR : 0xffffff;
    this.overlay.filters = invalid || subtract ? null : [this.hatch];
    if (points.length >= 3) {
      this.overlay
        .poly(flat, true)
        .fill({ color, alpha: invalid ? 0.14 : subtract ? 0.16 : 1 })
        .stroke({ color, alpha: 1, width: 1.5 });
    } else if (points.length >= 2) {
      this.overlay.moveTo(flat[0]!, flat[1]!);
      for (let index = 2; index < flat.length; index += 2) {
        this.overlay.lineTo(flat[index]!, flat[index + 1]!);
      }
      this.overlay.stroke({ color, alpha: 1, width: 1.5 });
    }
    const first = active.points[0]?.document;
    if (first && active.mode === "polygonal") {
      this.overlay.circle(first.x, first.y, 3).fill({ color, alpha: 1 });
    }
    this.overlay.visible = true;
  }

  /** Reflect eligibility, the pending replace/add/subtract operation, and closing range. */
  private updateCursor(): void {
    if (this.tools.activeTool !== "lasso") return;
    const layerId = this.store.getSelectedLayerId();
    const layer = layerId ? this.store.getLayer(layerId) : undefined;
    const eligible = layer?.kind === "mask" && !layer.locked && !isDocumentMutationLocked();
    if (!eligible) {
      this.canvas.style.cursor = LASSO_CURSOR_DISABLED;
      return;
    }

    const active = this.active;
    const event = this.lastPointerEvent;
    if (active?.mode === "polygonal" && active.points.length >= 3 && event) {
      const nearStart =
        Math.hypot(event.clientX - active.firstClientX, event.clientY - active.firstClientY) <=
        CLOSE_TOLERANCE_PX;
      if (nearStart) {
        this.canvas.style.cursor = LASSO_CURSOR_CLOSE;
        return;
      }
    }

    const operation: LassoOperation = active
      ? active.operation
      : event?.altKey
        ? "subtract"
        : event?.shiftKey
          ? "add"
          : "replace";
    const mode: LassoMode = active?.mode ?? this.tools.lassoMode;
    this.canvas.style.cursor =
      mode === "polygonal"
        ? operation === "add"
          ? LASSO_CURSOR_POLYGONAL_ADD
          : operation === "subtract"
            ? LASSO_CURSOR_POLYGONAL_SUBTRACT
            : LASSO_CURSOR_POLYGONAL_REPLACE
        : operation === "add"
          ? LASSO_CURSOR_FREEHAND_ADD
          : operation === "subtract"
            ? LASSO_CURSOR_FREEHAND_SUBTRACT
            : LASSO_CURSOR_FREEHAND_REPLACE;
  }

  private readonly validateActiveGesture = (): void => {
    const active = this.active;
    if (active && !this.isStillValid(active)) this.finish(false);
  };

  private isStillValid(active: ActiveLasso): boolean {
    const layer = this.store.getLayer(active.layerId);
    return (
      this.tools.activeTool === "lasso" &&
      this.tools.lassoMode === active.mode &&
      this.store.getSelectedLayerId() === active.layerId &&
      layer?.kind === "mask" &&
      !layer.locked &&
      this.store.getTiledSurface(active.layerId) === active.surface &&
      this.tree.getNode(active.layerId) === active.node &&
      !isDocumentMutationLocked()
    );
  }

  private toGesturePoint(event: PointerEvent, node: LayerNode): GesturePoint | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.screenPoint.set(
      ((event.clientX - rect.left) * this.app.screen.width) / rect.width,
      ((event.clientY - rect.top) * this.app.screen.height) / rect.height,
    );
    this.documentRoot.toLocal(this.screenPoint, undefined, this.documentPoint);
    node.container.toLocal(this.documentPoint, this.documentRoot, this.localPoint);
    return { document: this.documentPoint.clone(), local: this.localPoint.clone() };
  }

  private releaseCapture(active: ActiveLasso): void {
    if (active.pointerId !== null && this.canvas.hasPointerCapture(active.pointerId)) {
      this.canvas.releasePointerCapture(active.pointerId);
    }
  }
}

function downsample(points: readonly GesturePoint[], minDistance: number): GesturePoint[] {
  const result: GesturePoint[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (
      !previous ||
      Math.hypot(point.document.x - previous.document.x, point.document.y - previous.document.y) >=
        minDistance
    ) {
      result.push(point);
    }
  }
  if (result.length > 1) {
    const first = result[0]!;
    const last = result[result.length - 1]!;
    if (
      Math.hypot(first.document.x - last.document.x, first.document.y - last.document.y) <
      minDistance
    ) {
      result.pop();
    }
  }
  return result;
}

function polygonArea(points: readonly GesturePoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!.document;
    const next = points[(index + 1) % points.length]!.document;
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function unionBounds(left: PixelBounds, right: PixelBounds): PixelBounds {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
}
