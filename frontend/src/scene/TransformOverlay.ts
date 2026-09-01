/** Interactive move/rotate/scale gizmo for one selected layer. */

import { Circle, Container, Graphics, Point } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";

import type { PixelBounds } from "../canvas/TileGrid";
import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
import { filterStore } from "../state/filterStore.svelte";
import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import type { PaintToolStore, PaintToolUnsubscribe } from "../state/paintToolStore.svelte";
import { previewStore } from "../state/previewStore.svelte";
import type { Layer, LayerId, Transform } from "../state/schema";
import type { LayerNode } from "./LayerNode";
import type { LayerTree } from "./LayerTree";

type DragMode = "move" | "scale-nw" | "scale-ne" | "scale-se" | "scale-sw" | "rotate";
type ScaleMode = Exclude<DragMode, "move" | "rotate">;
type MirrorAxis = "horizontal" | "vertical";

interface TransformTarget {
  layer: Layer;
  node: LayerNode;
  parent: Container;
  bounds: PixelBounds;
}

interface ActiveDrag {
  pointerId: number;
  layerId: LayerId;
  mode: DragMode;
  parent: Container;
  startTransform: Transform;
  startPoint: Point;
  centerLocal: Point;
  centerParent: Point;
  startAngle: number;
  scaleCornerLocal: Point;
  scaleAnchorLocal: Point;
  scaleAnchorParent: Point;
}

interface TransformHandle {
  container: Container;
  visual: Graphics;
  hitArea: Circle;
}

const HANDLE_VISUAL_SIZE_PX = 9;
const HANDLE_HIT_RADIUS_PX = 10;
const ROTATE_OFFSET_PX = 28;
const MIN_SCALE = 0.01;
const MAX_SCALE = 100;
const SNAP_NORMAL_PX = 32;
const SNAP_FINE_PX = 8;

export class TransformOverlay {
  public readonly container = new Container({ label: "ultra-paint:transform" });

  private readonly body = new Container({ label: "ultra-paint:transform-body" });
  private readonly border = new Graphics({ label: "ultra-paint:transform-border" });
  private readonly rotateLine = new Graphics({ label: "ultra-paint:transform-rotate-line" });
  private readonly rotateHandle: TransformHandle;
  private readonly scaleHandles: TransformHandle[];
  private readonly bodyPoints: Point[] = [];
  private unsubscribeStore: Unsubscribe | null = null;
  private unsubscribeTools: PaintToolUnsubscribe | null = null;
  private unsubscribePreview: (() => void) | null = null;
  private unsubscribeFilter: (() => void) | null = null;
  private active: ActiveDrag | null = null;
  private lastScale = -1;

  public constructor(
    private readonly canvasElement: HTMLCanvasElement,
    private readonly documentRoot: Container,
    private readonly tree: LayerTree,
    private readonly store: LayerStore,
    private readonly toolStore: PaintToolStore,
    private readonly breakHistoryMerge: () => void,
  ) {
    this.body.eventMode = "static";
    this.body.hitArea = { contains: (x, y) => this.containsBodyPoint(x, y) };
    this.body.on("pointerdown", this.handleBodyPointerDown);
    this.border.eventMode = "none";
    this.rotateLine.eventMode = "none";

    this.scaleHandles = ["scale-nw", "scale-ne", "scale-se", "scale-sw"].map((mode) =>
      this.createHandle(mode as ScaleMode),
    );
    this.rotateHandle = this.createHandle("rotate");
    this.container.addChild(
      this.body,
      this.border,
      this.rotateLine,
      ...this.scaleHandles.map((handle) => handle.container),
      this.rotateHandle.container,
    );
    this.container.on("globalpointermove", this.handlePointerMove);
    this.container.on("pointerup", this.handlePointerEnd);
    this.container.on("pointerupoutside", this.handlePointerEnd);
    this.container.on("pointercancel", this.handlePointerEnd);
    this.container.onRender = () => this.refreshZoom();

    this.unsubscribeStore = store.subscribe(() => this.refresh());
    this.unsubscribeTools = toolStore.subscribe(() => this.refresh());
    this.unsubscribePreview = previewStore.subscribe(() => this.refresh());
    this.unsubscribeFilter = filterStore.subscribe(() => this.refresh());
    canvasElement.addEventListener("pointercancel", this.handleNativePointerCancel);
    this.refresh();
  }

  public destroy(): void {
    this.finishDrag();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeTools?.();
    this.unsubscribeTools = null;
    this.unsubscribePreview?.();
    this.unsubscribePreview = null;
    this.unsubscribeFilter?.();
    this.unsubscribeFilter = null;
    this.canvasElement.removeEventListener("pointercancel", this.handleNativePointerCancel);
    this.container.onRender = null;
    this.container.destroy({ children: true });
  }

  /** Mirror the selected layer around the center of its current pixel bounds. */
  public mirrorSelected(axis: MirrorAxis): boolean {
    const target = this.getTarget();
    if (!target || target.layer.locked || isDocumentMutationLocked()) return false;

    const centerLocal = this.boundsCenter(target.bounds);
    const centerParent = this.transformPoint(target.layer.transform, centerLocal);
    const next = { ...target.layer.transform };
    if (axis === "horizontal") next.scaleX *= -1;
    else next.scaleY *= -1;

    this.breakHistoryMerge();
    this.setTransformAroundPoint(target.layer.id, next, centerLocal, centerParent);
    this.breakHistoryMerge();
    return true;
  }

  private createHandle(mode: ScaleMode | "rotate"): TransformHandle {
    const hitArea = new Circle(0, 0, 1);
    const visual = new Graphics();
    visual.eventMode = "none";
    const container = new Container({ label: `ultra-paint:transform-handle:${mode}` });
    container.eventMode = "static";
    container.hitArea = hitArea;
    container.addChild(visual);
    container.on("pointerdown", (event) => {
      event.stopPropagation();
      this.beginDrag(mode, event);
    });
    return { container, visual, hitArea };
  }

  private readonly handleBodyPointerDown = (event: FederatedPointerEvent): void => {
    event.stopPropagation();
    this.beginDrag("move", event);
  };

  private beginDrag(mode: DragMode, event: FederatedPointerEvent): void {
    if (event.button !== 0 || this.active || this.toolStore.activeTool !== "transform") return;
    const target = this.getTarget();
    if (!target || target.layer.locked || isDocumentMutationLocked()) return;

    event.preventDefault();
    const centerLocal = this.boundsCenter(target.bounds);
    const centerParent = this.transformPoint(target.layer.transform, centerLocal);
    const startPoint = target.parent.toLocal(event.global);
    const scalePoints =
      mode !== "move" && mode !== "rotate" ? this.scalePoints(mode, target.bounds) : null;
    this.breakHistoryMerge();
    this.active = {
      pointerId: event.pointerId,
      layerId: target.layer.id,
      mode,
      parent: target.parent,
      startTransform: { ...target.layer.transform },
      startPoint: startPoint.clone(),
      centerLocal,
      centerParent,
      startAngle: Math.atan2(startPoint.y - centerParent.y, startPoint.x - centerParent.x),
      scaleCornerLocal: scalePoints?.corner ?? centerLocal,
      scaleAnchorLocal: scalePoints?.anchor ?? centerLocal,
      scaleAnchorParent: this.transformPoint(
        target.layer.transform,
        scalePoints?.anchor ?? centerLocal,
      ),
    };
  }

  private readonly handlePointerMove = (event: FederatedPointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();

    const point = active.parent.toLocal(event.global);
    if (active.mode === "move") {
      let dx = point.x - active.startPoint.x;
      let dy = point.y - active.startPoint.y;
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const snapped = this.snapParentPoint(
        active.parent,
        new Point(active.startTransform.x + dx, active.startTransform.y + dy),
        event.ctrlKey,
      );
      this.store.setTransform(active.layerId, { x: snapped.x, y: snapped.y });
      return;
    }

    if (active.mode === "rotate") {
      let rotation =
        active.startTransform.rotation +
        Math.atan2(point.y - active.centerParent.y, point.x - active.centerParent.x) -
        active.startAngle;
      if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      this.setTransformAroundPoint(
        active.layerId,
        { ...active.startTransform, rotation },
        active.centerLocal,
        active.centerParent,
      );
      return;
    }

    const snapped = this.snapEventPoint(active.parent, event.global, event.ctrlKey);
    const dx = snapped.x - active.scaleAnchorParent.x;
    const dy = snapped.y - active.scaleAnchorParent.y;
    const cosine = Math.cos(active.startTransform.rotation);
    const sine = Math.sin(active.startTransform.rotation);
    const axisX = cosine * dx + sine * dy;
    const axisY = -sine * dx + cosine * dy;
    const localX = active.scaleCornerLocal.x - active.scaleAnchorLocal.x;
    const localY = active.scaleCornerLocal.y - active.scaleAnchorLocal.y;
    let scaleX: number;
    let scaleY: number;

    if (event.shiftKey) {
      const startX = active.startTransform.scaleX * localX;
      const startY = active.startTransform.scaleY * localY;
      const divisor = startX * startX + startY * startY;
      if (divisor <= 0.0001) return;
      const factor = this.clampFactor(
        (axisX * startX + axisY * startY) / divisor,
        active.startTransform,
      );
      scaleX = active.startTransform.scaleX * factor;
      scaleY = active.startTransform.scaleY * factor;
    } else {
      scaleX = this.clampScale(axisX / localX, active.startTransform.scaleX);
      scaleY = this.clampScale(axisY / localY, active.startTransform.scaleY);
    }

    this.setTransformAroundPoint(
      active.layerId,
      {
        ...active.startTransform,
        scaleX,
        scaleY,
      },
      active.scaleAnchorLocal,
      active.scaleAnchorParent,
    );
  };

  private readonly handlePointerEnd = (event: FederatedPointerEvent): void => {
    if (event.pointerId !== this.active?.pointerId) return;
    event.preventDefault();
    this.finishDrag();
  };

  private readonly handleNativePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.active?.pointerId) return;
    event.preventDefault();
    this.finishDrag();
  };

  private finishDrag(): void {
    if (!this.active) return;
    this.active = null;
    this.breakHistoryMerge();
  }

  private refresh(): void {
    const target = this.getTarget();
    const selected = this.toolStore.activeTool === "transform" && target !== null;
    const interactive = selected && !target.layer.locked && !isDocumentMutationLocked();
    if (!interactive) this.finishDrag();
    this.container.visible = selected;
    this.container.eventMode = interactive ? "static" : "none";
    if (selected) this.redraw(target);
  }

  private redraw(target: TransformTarget): void {
    const { x, y, width, height } = target.bounds;
    const corners = [
      this.toDocumentPoint(target.node, x, y),
      this.toDocumentPoint(target.node, x + width, y),
      this.toDocumentPoint(target.node, x + width, y + height),
      this.toDocumentPoint(target.node, x, y + height),
    ];
    this.bodyPoints.splice(0, this.bodyPoints.length, ...corners);

    const scale = this.worldScale();
    this.border
      .clear()
      .poly(
        corners.flatMap((point) => [point.x, point.y]),
        true,
      )
      .stroke({ width: 1 / scale, color: 0x5b8def, alpha: 1 });

    const center = new Point(
      corners.reduce((sum, point) => sum + point.x, 0) / 4,
      corners.reduce((sum, point) => sum + point.y, 0) / 4,
    );
    const top = new Point((corners[0]!.x + corners[1]!.x) / 2, (corners[0]!.y + corners[1]!.y) / 2);
    const outwardX = top.x - center.x;
    const outwardY = top.y - center.y;
    const outwardLength = Math.max(0.0001, Math.hypot(outwardX, outwardY));
    const rotatePoint = new Point(
      top.x + (outwardX / outwardLength) * (ROTATE_OFFSET_PX / scale),
      top.y + (outwardY / outwardLength) * (ROTATE_OFFSET_PX / scale),
    );
    this.rotateLine
      .clear()
      .moveTo(top.x, top.y)
      .lineTo(rotatePoint.x, rotatePoint.y)
      .stroke({ width: 1 / scale, color: 0x5b8def, alpha: 1 });

    const handlePoints = [corners[0]!, corners[1]!, corners[2]!, corners[3]!];
    for (let index = 0; index < this.scaleHandles.length; index += 1) {
      this.redrawHandle(this.scaleHandles[index]!, handlePoints[index]!, scale, false);
    }
    this.redrawHandle(this.rotateHandle, rotatePoint, scale, true);
  }

  private redrawHandle(handle: TransformHandle, point: Point, scale: number, round: boolean): void {
    const size = HANDLE_VISUAL_SIZE_PX / scale;
    handle.container.position.copyFrom(point);
    handle.hitArea.radius = HANDLE_HIT_RADIUS_PX / scale;
    handle.visual.clear();
    if (round) handle.visual.circle(0, 0, size / 2);
    else handle.visual.rect(-size / 2, -size / 2, size, size);
    handle.visual.fill({ color: 0x5b8def, alpha: 1 });
  }

  private refreshZoom(): void {
    const scale = this.worldScale();
    if (scale === this.lastScale) return;
    this.lastScale = scale;
    const target = this.getTarget();
    if (this.container.visible && target) this.redraw(target);
  }

  private getTarget(): TransformTarget | null {
    const selected = this.store.getSelectedLayerIds();
    if (selected.length !== 1) return null;
    const layer = this.store.getLayer(selected[0]!);
    const node = layer ? this.tree.getNode(layer.id) : undefined;
    const parent = node?.container.parent;
    if (!layer || !node || !parent) return null;

    let bounds = this.store.getLayerPixelBounds(layer.id);
    if (layer.kind === "group") {
      const local = node.container.getLocalBounds();
      bounds = { x: local.x, y: local.y, width: local.width, height: local.height };
    }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    return { layer, node, parent, bounds };
  }

  private toDocumentPoint(node: LayerNode, x: number, y: number): Point {
    return this.documentRoot.toLocal(node.container.toGlobal(new Point(x, y)));
  }

  private boundsCenter(bounds: PixelBounds): Point {
    return new Point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }

  private transformPoint(transform: Transform, point: Point): Point {
    const cosine = Math.cos(transform.rotation);
    const sine = Math.sin(transform.rotation);
    return new Point(
      transform.x + cosine * transform.scaleX * point.x - sine * transform.scaleY * point.y,
      transform.y + sine * transform.scaleX * point.x + cosine * transform.scaleY * point.y,
    );
  }

  private setTransformAroundPoint(
    layerId: LayerId,
    next: Transform,
    fixedLocal: Point,
    fixedParent: Point,
  ): void {
    const transformedPoint = this.transformPoint({ ...next, x: 0, y: 0 }, fixedLocal);
    this.store.setTransform(layerId, {
      ...next,
      x: fixedParent.x - transformedPoint.x,
      y: fixedParent.y - transformedPoint.y,
    });
  }

  private scalePoints(mode: ScaleMode, bounds: PixelBounds): { corner: Point; anchor: Point } {
    const left = bounds.x;
    const top = bounds.y;
    const right = left + bounds.width;
    const bottom = top + bounds.height;
    switch (mode) {
      case "scale-nw":
        return { corner: new Point(left, top), anchor: new Point(right, bottom) };
      case "scale-ne":
        return { corner: new Point(right, top), anchor: new Point(left, bottom) };
      case "scale-se":
        return { corner: new Point(right, bottom), anchor: new Point(left, top) };
      case "scale-sw":
        return { corner: new Point(left, bottom), anchor: new Point(right, top) };
    }
  }

  private clampScale(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    const sign = value < 0 ? -1 : value > 0 ? 1 : Math.sign(fallback) || 1;
    return sign * Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.abs(value)));
  }

  private clampFactor(value: number, transform: Transform): number {
    const minFactor = Math.max(
      MIN_SCALE / Math.max(MIN_SCALE, Math.abs(transform.scaleX)),
      MIN_SCALE / Math.max(MIN_SCALE, Math.abs(transform.scaleY)),
    );
    const maxFactor = Math.min(
      MAX_SCALE / Math.max(MIN_SCALE, Math.abs(transform.scaleX)),
      MAX_SCALE / Math.max(MIN_SCALE, Math.abs(transform.scaleY)),
    );
    const sign = value < 0 ? -1 : 1;
    return sign * Math.min(maxFactor, Math.max(minFactor, Math.abs(value)));
  }

  /** Snap a parent-local point to the document's pixel grid, including nested groups. */
  private snapParentPoint(parent: Container, point: Point, fine: boolean): Point {
    const documentPoint = this.documentRoot.toLocal(parent.toGlobal(point));
    documentPoint.set(this.snap(documentPoint.x, fine), this.snap(documentPoint.y, fine));
    return parent.toLocal(this.documentRoot.toGlobal(documentPoint));
  }

  private snapEventPoint(parent: Container, global: Point, fine: boolean): Point {
    const documentPoint = this.documentRoot.toLocal(global);
    documentPoint.set(this.snap(documentPoint.x, fine), this.snap(documentPoint.y, fine));
    return parent.toLocal(this.documentRoot.toGlobal(documentPoint));
  }

  private snap(value: number, fine: boolean): number {
    const grid = fine ? SNAP_FINE_PX : SNAP_NORMAL_PX;
    return Math.round(value / grid) * grid;
  }

  private containsBodyPoint(x: number, y: number): boolean {
    let inside = false;
    for (
      let index = 0, previous = this.bodyPoints.length - 1;
      index < this.bodyPoints.length;
      previous = index++
    ) {
      const from = this.bodyPoints[index]!;
      const to = this.bodyPoints[previous]!;
      if (
        from.y > y !== to.y > y &&
        x < ((to.x - from.x) * (y - from.y)) / (to.y - from.y) + from.x
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  private worldScale(): number {
    return Math.max(0.0001, Math.abs(this.documentRoot.parent?.scale.x ?? 1));
  }
}
