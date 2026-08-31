/** Interactive, unmasked operating-region guide drawn above document content. */

import { Circle, Container, Graphics, Point, Rectangle } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";

import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
import { filterStore } from "../state/filterStore.svelte";
import type { PaintToolStore, PaintToolUnsubscribe } from "../state/paintToolStore.svelte";
import type { BoundaryBox } from "../state/schema";
import { previewStore } from "../state/previewStore.svelte";

type DragMode = "move" | "nw" | "ne" | "se" | "sw";
type ResizeMode = Exclude<DragMode, "move">;

interface ActiveDrag {
  pointerId: number;
  mode: DragMode;
  startPoint: Point;
  startBox: BoundaryBox;
}

interface BoundaryHandle {
  mode: ResizeMode;
  container: Container;
  visual: Graphics;
  hitArea: Circle;
}

const HANDLE_VISUAL_SIZE_PX = 10;
const HANDLE_HIT_RADIUS_PX = 10;
const SNAP_NORMAL_PX = 32;
const SNAP_FINE_PX = 8;

export class BoundaryBoxOverlay {
  public readonly container = new Container({ label: "ultra-paint:boundary-box" });

  private readonly body = new Container({ label: "ultra-paint:boundary-body" });
  private readonly bodyHitArea = new Rectangle();
  private readonly border = new Graphics();
  private readonly handles: BoundaryHandle[];
  private readonly documentPoint = new Point();
  private unsubscribeStore: Unsubscribe | null = null;
  private unsubscribeTools: PaintToolUnsubscribe | null = null;
  private unsubscribePreview: (() => void) | null = null;
  private unsubscribeFilter: (() => void) | null = null;
  private active: ActiveDrag | null = null;
  private liveBox: BoundaryBox;
  private lastScale = -1;

  public constructor(
    private readonly canvasElement: HTMLCanvasElement,
    private readonly documentRoot: Container,
    private readonly store: LayerStore,
    private readonly toolStore: PaintToolStore,
  ) {
    this.liveBox = { ...store.getDocument().boundaryBox };

    this.body.eventMode = "static";
    this.body.hitArea = this.bodyHitArea;
    this.body.on("pointerdown", this.handleBodyPointerDown);

    this.border.eventMode = "none";
    this.handles = [
      this.createHandle("nw"),
      this.createHandle("ne"),
      this.createHandle("se"),
      this.createHandle("sw"),
    ];

    this.container.addChild(
      this.body,
      this.border,
      ...this.handles.map((handle) => handle.container),
    );
    this.container.on("globalpointermove", this.handlePointerMove);
    this.container.on("pointerup", this.handlePointerEnd);
    this.container.on("pointerupoutside", this.handlePointerEnd);
    this.container.on("pointercancel", this.handlePointerEnd);
    this.container.onRender = () => this.refreshZoom();
    this.redraw(this.liveBox);
    this.refreshInteractivity();
    this.unsubscribeStore = store.subscribe((doc) => {
      if (!this.active) {
        this.liveBox = { ...doc.boundaryBox };
        this.redraw(this.liveBox);
      }
    });
    this.unsubscribeTools = toolStore.subscribe(() => this.refreshInteractivity());
    this.unsubscribePreview = previewStore.subscribe(() => this.refreshInteractivity());
    this.unsubscribeFilter = filterStore.subscribe(() => this.refreshInteractivity());

    // PixiJS 8.20 does not map native pointercancel into the federated event
    // boundary, so keep this narrow lifecycle fallback for interrupted drags.
    canvasElement.addEventListener("pointercancel", this.handleNativePointerCancel);
  }

  public destroy(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeTools?.();
    this.unsubscribeTools = null;
    this.unsubscribePreview?.();
    this.unsubscribePreview = null;
    this.unsubscribeFilter?.();
    this.unsubscribeFilter = null;
    this.canvasElement.removeEventListener("pointercancel", this.handleNativePointerCancel);
    this.active = null;
    this.container.onRender = null;
    this.container.destroy({ children: true });
  }

  private createHandle(mode: ResizeMode): BoundaryHandle {
    const hitArea = new Circle(0, 0, 1);
    const visual = new Graphics();
    visual.eventMode = "none";

    const container = new Container({ label: `ultra-paint:boundary-handle:${mode}` });
    container.eventMode = "static";
    container.hitArea = hitArea;
    container.addChild(visual);
    container.on("pointerdown", (event) => {
      event.stopPropagation();
      this.beginDrag(mode, event);
    });

    return { mode, container, visual, hitArea };
  }

  private readonly handleBodyPointerDown = (event: FederatedPointerEvent): void => {
    event.stopPropagation();
    this.beginDrag("move", event);
  };

  private beginDrag(mode: DragMode, event: FederatedPointerEvent): void {
    if (event.button !== 0 || this.active) return;
    if (this.toolStore.activeTool !== "boundary-box" || isDocumentMutationLocked()) return;

    event.preventDefault();
    const point = this.toDocumentPoint(event);
    this.active = {
      pointerId: event.pointerId,
      mode,
      startPoint: point.clone(),
      startBox: { ...this.liveBox },
    };
  }

  private readonly handlePointerMove = (event: FederatedPointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) return;

    event.preventDefault();
    this.liveBox = this.dragBox(active, this.toDocumentPoint(event), event.ctrlKey);
    this.redraw(this.liveBox);
    this.toolStore.setLiveBoundaryBox(this.liveBox);
  };

  private readonly handlePointerEnd = (event: FederatedPointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) return;

    event.preventDefault();
    this.finishDrag();
  };

  private readonly handleNativePointerCancel = (event: PointerEvent): void => {
    const active = this.active;
    if (!active || active.pointerId !== event.pointerId) return;

    event.preventDefault();
    this.finishDrag();
  };

  private finishDrag(): void {
    if (!this.active) return;
    this.active = null;
    this.store.setBoundaryBox(this.liveBox);
    this.toolStore.setLiveBoundaryBox(null);
  }

  private refreshInteractivity(): void {
    const interactive = this.toolStore.activeTool === "boundary-box" && !isDocumentMutationLocked();
    if (!interactive) this.finishDrag();
    this.container.eventMode = interactive ? "static" : "none";
  }

  private toDocumentPoint(event: FederatedPointerEvent): Point {
    this.documentRoot.toLocal(event.global, undefined, this.documentPoint);
    return this.documentPoint;
  }

  private dragBox(active: ActiveDrag, point: Point, fineSnap: boolean): BoundaryBox {
    const { mode, startBox, startPoint } = active;
    const dx = point.x - startPoint.x;
    const dy = point.y - startPoint.y;
    if (mode === "move") {
      return {
        ...startBox,
        x: this.snap(startBox.x + dx, fineSnap),
        y: this.snap(startBox.y + dy, fineSnap),
      };
    }
    let left = this.snap(mode === "nw" || mode === "sw" ? startBox.x + dx : startBox.x, fineSnap);
    let top = this.snap(mode === "nw" || mode === "ne" ? startBox.y + dy : startBox.y, fineSnap);
    let right = this.snap(
      mode === "ne" || mode === "se"
        ? startBox.x + startBox.width + dx
        : startBox.x + startBox.width,
      fineSnap,
    );
    let bottom = this.snap(
      mode === "sw" || mode === "se"
        ? startBox.y + startBox.height + dy
        : startBox.y + startBox.height,
      fineSnap,
    );
    if (mode === "nw" || mode === "sw") left = Math.min(left, right - 8);
    else right = Math.max(right, left + 8);
    if (mode === "nw" || mode === "ne") top = Math.min(top, bottom - 8);
    else bottom = Math.max(bottom, top + 8);

    const lockedRatio = this.toolStore.boundaryAspectRatio;
    if (lockedRatio !== null) {
      const width = right - left;
      const height = bottom - top;
      const horizontalChange = Math.abs(width / startBox.width - 1);
      const verticalChange = Math.abs(height / startBox.height - 1);

      if (horizontalChange >= verticalChange) {
        const lockedHeight = Math.max(8, this.snap(width / lockedRatio, fineSnap));
        if (mode === "nw" || mode === "ne") top = bottom - lockedHeight;
        else bottom = top + lockedHeight;
      } else {
        const lockedWidth = Math.max(8, this.snap(height * lockedRatio, fineSnap));
        if (mode === "nw" || mode === "sw") left = right - lockedWidth;
        else right = left + lockedWidth;
      }
    }
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  private redraw(box: BoundaryBox): void {
    const scale = this.worldScale();
    const dash = 8 / scale;
    this.border.clear();
    this.dashedLine(box.x, box.y, box.x + box.width, box.y, dash);
    this.dashedLine(box.x + box.width, box.y, box.x + box.width, box.y + box.height, dash);
    this.dashedLine(box.x + box.width, box.y + box.height, box.x, box.y + box.height, dash);
    this.dashedLine(box.x, box.y + box.height, box.x, box.y, dash);
    this.border.stroke({ width: 1 / scale, color: 0x5b8def, alpha: 0.95 });

    this.bodyHitArea.x = box.x;
    this.bodyHitArea.y = box.y;
    this.bodyHitArea.width = box.width;
    this.bodyHitArea.height = box.height;

    const visualSize = HANDLE_VISUAL_SIZE_PX / scale;
    const hitRadius = HANDLE_HIT_RADIUS_PX / scale;
    const corners: Record<ResizeMode, readonly [number, number]> = {
      nw: [box.x, box.y],
      ne: [box.x + box.width, box.y],
      se: [box.x + box.width, box.y + box.height],
      sw: [box.x, box.y + box.height],
    };
    for (const handle of this.handles) {
      const [x, y] = corners[handle.mode];
      handle.container.position.set(x, y);
      handle.hitArea.radius = hitRadius;
      handle.visual
        .clear()
        .rect(-visualSize / 2, -visualSize / 2, visualSize, visualSize)
        .fill({ color: 0x5b8def, alpha: 1 });
    }
  }

  private refreshZoom(): void {
    const scale = this.worldScale();
    if (scale === this.lastScale) return;
    this.lastScale = scale;
    this.redraw(this.liveBox);
  }

  private dashedLine(x1: number, y1: number, x2: number, y2: number, dash: number): void {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const dx = (x2 - x1) / length;
    const dy = (y2 - y1) / length;
    for (let offset = 0; offset < length; offset += dash * 2) {
      const end = Math.min(length, offset + dash);
      this.border.moveTo(x1 + dx * offset, y1 + dy * offset).lineTo(x1 + dx * end, y1 + dy * end);
    }
  }

  private worldScale(): number {
    return Math.max(0.0001, this.documentRoot.parent?.scale.x ?? 1);
  }

  private snap(value: number, fine: boolean): number {
    const grid = fine ? SNAP_FINE_PX : SNAP_NORMAL_PX;
    return Math.round(value / grid) * grid;
  }
}
