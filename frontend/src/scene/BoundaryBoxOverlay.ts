/** Interactive, unmasked operating-region guide drawn above document content. */

import { Container, Graphics, Point } from "pixi.js";
import type { Application } from "pixi.js";

import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import type { PaintToolStore } from "../state/paintToolStore.svelte";
import type { BoundaryBox } from "../state/schema";

type DragMode = "move" | "nw" | "ne" | "se" | "sw";

interface ActiveDrag {
    pointerId: number;
    mode: DragMode;
    startPoint: Point;
    startBox: BoundaryBox;
}

export class BoundaryBoxOverlay {
    public readonly container = new Container({ label: "ultra-paint:boundary-box" });

    private readonly border = new Graphics();
    private readonly handles = new Graphics();
    private readonly screenPoint = new Point();
    private readonly documentPoint = new Point();
    private unsubscribe: Unsubscribe | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private active: ActiveDrag | null = null;
    private liveBox: BoundaryBox;

    public constructor(
        private readonly app: Application,
        private readonly canvasElement: HTMLCanvasElement,
        private readonly documentRoot: Container,
        private readonly store: LayerStore,
        private readonly toolStore: PaintToolStore,
    ) {
        this.liveBox = { ...store.getDocument().boundaryBox };
        this.container.addChild(this.border, this.handles);
        this.redraw(this.liveBox);
        this.unsubscribe = store.subscribe((doc) => {
            if (!this.active) {
                this.liveBox = { ...doc.boundaryBox };
                this.redraw(this.liveBox);
            }
        });
        this.mount();
    }

    public destroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        const canvas = this.canvas;
        if (canvas) {
            canvas.removeEventListener("pointerdown", this.handlePointerDown);
            canvas.removeEventListener("pointermove", this.handlePointerMove);
            canvas.removeEventListener("pointerup", this.handlePointerEnd);
            canvas.removeEventListener("pointercancel", this.handlePointerEnd);
            canvas.removeEventListener("lostpointercapture", this.handlePointerEnd);
        }
        this.canvas = null;
        this.active = null;
        this.container.destroy({ children: true });
    }

    private mount(): void {
        this.canvas = this.canvasElement;
        this.canvas.addEventListener("pointerdown", this.handlePointerDown);
        this.canvas.addEventListener("pointermove", this.handlePointerMove);
        this.canvas.addEventListener("pointerup", this.handlePointerEnd);
        this.canvas.addEventListener("pointercancel", this.handlePointerEnd);
        this.canvas.addEventListener("lostpointercapture", this.handlePointerEnd);
    }

    private readonly handlePointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || this.active) return;
        if (this.toolStore.activeTool !== "boundary-box") return;
        const point = this.toDocumentPoint(event);
        if (!point) return;
        const mode = this.hitTest(point);
        if (!mode) return;

        event.stopImmediatePropagation();
        event.preventDefault();
        this.active = {
            pointerId: event.pointerId,
            mode,
            startPoint: point.clone(),
            startBox: { ...this.liveBox },
        };
        this.canvas?.setPointerCapture(event.pointerId);
    };

    private readonly handlePointerMove = (event: PointerEvent): void => {
        const active = this.active;
        if (!active || active.pointerId !== event.pointerId) return;
        const point = this.toDocumentPoint(event);
        if (!point) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        this.liveBox = this.dragBox(active, point);
        this.redraw(this.liveBox);
    };

    private readonly handlePointerEnd = (event: PointerEvent): void => {
        const active = this.active;
        if (!active || active.pointerId !== event.pointerId) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        this.active = null;
        if (this.canvas?.hasPointerCapture(event.pointerId)) {
            this.canvas.releasePointerCapture(event.pointerId);
        }
        this.store.setBoundaryBox(this.liveBox);
    };

    private toDocumentPoint(event: PointerEvent): Point | null {
        const canvas = this.canvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        this.screenPoint.set(
            ((event.clientX - rect.left) * this.app.screen.width) / rect.width,
            ((event.clientY - rect.top) * this.app.screen.height) / rect.height,
        );
        this.documentRoot.toLocal(this.screenPoint, undefined, this.documentPoint);
        return this.documentPoint;
    }

    private hitTest(point: Point): DragMode | null {
        const box = this.liveBox;
        const radius = this.handleRadius();
        const corners: Array<[DragMode, number, number]> = [
            ["nw", box.x, box.y],
            ["ne", box.x + box.width, box.y],
            ["se", box.x + box.width, box.y + box.height],
            ["sw", box.x, box.y + box.height],
        ];
        for (const [mode, x, y] of corners) {
            if (Math.hypot(point.x - x, point.y - y) <= radius) return mode;
        }
        return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
            ? "move"
            : null;
    }

    private dragBox(active: ActiveDrag, point: Point): BoundaryBox {
        const { mode, startBox, startPoint } = active;
        const dx = point.x - startPoint.x;
        const dy = point.y - startPoint.y;
        if (mode === "move") {
            return {
                ...startBox,
                x: this.snap(startBox.x + dx),
                y: this.snap(startBox.y + dy),
            };
        }
        let left = this.snap(mode === "nw" || mode === "sw" ? startBox.x + dx : startBox.x);
        let top = this.snap(mode === "nw" || mode === "ne" ? startBox.y + dy : startBox.y);
        let right = this.snap(
            mode === "ne" || mode === "se" ? startBox.x + startBox.width + dx : startBox.x + startBox.width,
        );
        let bottom = this.snap(
            mode === "sw" || mode === "se" ? startBox.y + startBox.height + dy : startBox.y + startBox.height,
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
                const lockedHeight = Math.max(8, this.snap(width / lockedRatio));
                if (mode === "nw" || mode === "ne") top = bottom - lockedHeight;
                else bottom = top + lockedHeight;
            } else {
                const lockedWidth = Math.max(8, this.snap(height * lockedRatio));
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
        const dash = 8 / this.worldScale();
        this.border.clear();
        this.dashedLine(box.x, box.y, box.x + box.width, box.y, dash);
        this.dashedLine(box.x + box.width, box.y, box.x + box.width, box.y + box.height, dash);
        this.dashedLine(box.x + box.width, box.y + box.height, box.x, box.y + box.height, dash);
        this.dashedLine(box.x, box.y + box.height, box.x, box.y, dash);
        this.border.stroke({ width: 1 / this.worldScale(), color: 0x5b8def, alpha: 0.95 });

        const radius = this.handleRadius();
        this.handles.clear();
        const corners: Array<readonly [number, number]> = [
            [box.x, box.y],
            [box.x + box.width, box.y],
            [box.x + box.width, box.y + box.height],
            [box.x, box.y + box.height],
        ];
        for (const [x, y] of corners) {
            this.handles.rect(x - radius / 2, y - radius / 2, radius, radius).fill({ color: 0x5b8def, alpha: 1 });
        }
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

    private handleRadius(): number {
        return 10 / this.worldScale();
    }

    private snap(value: number): number {
        return Math.round(value / 8) * 8;
    }
}
