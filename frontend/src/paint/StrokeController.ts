import { Point } from "pixi.js";
import type { Application, Container } from "pixi.js";

import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import type {
    PaintTool,
    PaintToolStore,
    PaintToolUnsubscribe,
} from "../state/paintToolStore.svelte";
import type { LayerId } from "../state/schema";

/** One interpolated sample in document-local coordinates. */
export interface StrokePoint {
    x: number;
    y: number;
    pressure: number;
}

/** A tool-specific consumer created when a stroke begins. */
export interface StrokeSession {
    /** Desired distance between interpolated samples, in document pixels. */
    readonly spacing: number;
    addPoints(points: readonly StrokePoint[]): void;
    end(points: readonly StrokePoint[], cancelled: boolean): void;
}

export type StrokeSessionFactory = (
    tool: PaintTool,
    layerId: LayerId,
) => StrokeSession | null;

interface ActiveStroke {
    pointerId: number;
    session: StrokeSession;
    points: StrokePoint[];
    lastRaw: StrokePoint;
    lastStamped: StrokePoint;
    distanceSinceStamp: number;
}

/** Captures DOM pointer strokes and emits evenly spaced document-space points. */
export class StrokeController {
    private readonly canvas: HTMLCanvasElement;

    private readonly app: Application;

    private readonly documentRoot: Container;

    private readonly store: LayerStore;

    private readonly tools: PaintToolStore;

    private readonly createSession: StrokeSessionFactory;

    private readonly unsubscribeStore: Unsubscribe;

    private readonly unsubscribeTools: PaintToolUnsubscribe;

    private readonly previousTouchAction: string;

    private readonly screenPoint = new Point();

    private readonly documentPoint = new Point();

    private active: ActiveStroke | null = null;

    constructor(
        canvas: HTMLCanvasElement,
        app: Application,
        documentRoot: Container,
        store: LayerStore,
        tools: PaintToolStore,
        createSession: StrokeSessionFactory,
    ) {
        this.canvas = canvas;
        this.app = app;
        this.documentRoot = documentRoot;
        this.store = store;
        this.tools = tools;
        this.createSession = createSession;
        this.previousTouchAction = canvas.style.touchAction;

        canvas.style.touchAction = "none";
        canvas.addEventListener("pointerdown", this.handlePointerDown);
        canvas.addEventListener("pointermove", this.handlePointerMove);
        canvas.addEventListener("pointerup", this.handlePointerEnd);
        canvas.addEventListener("pointercancel", this.handlePointerEnd);
        canvas.addEventListener("lostpointercapture", this.handlePointerEnd);

        this.unsubscribeStore = store.subscribe(() => this.refreshCursor());
        this.unsubscribeTools = tools.subscribe(() => this.refreshCursor());
        this.refreshCursor();
    }

    public destroy(): void {
        this.finishStroke(true);
        this.unsubscribeStore();
        this.unsubscribeTools();
        this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
        this.canvas.removeEventListener("pointermove", this.handlePointerMove);
        this.canvas.removeEventListener("pointerup", this.handlePointerEnd);
        this.canvas.removeEventListener("pointercancel", this.handlePointerEnd);
        this.canvas.removeEventListener(
            "lostpointercapture",
            this.handlePointerEnd,
        );
        this.canvas.style.touchAction = this.previousTouchAction;
        this.canvas.style.cursor = "";
    }

    private readonly handlePointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || this.active !== null) return;

        const layerId = this.store.getSelectedLayerId();
        const layer = layerId ? this.store.getLayer(layerId) : undefined;
        if (
            !layerId ||
            !layer ||
            (layer.kind !== "raster" && layer.kind !== "mask")
        ) {
            return;
        }

        const tool = this.tools.getState().activeTool;
        const session = this.createSession(tool, layerId);
        if (!session) return;

        const point = this.toDocumentPoint(event);
        if (!point) {
            session.end([], true);
            return;
        }

        const initial = { ...point };
        this.active = {
            pointerId: event.pointerId,
            session,
            points: [initial],
            lastRaw: initial,
            lastStamped: initial,
            distanceSinceStamp: 0,
        };

        event.preventDefault();
        this.canvas.setPointerCapture(event.pointerId);
        session.addPoints([initial]);
    };

    private readonly handlePointerMove = (event: PointerEvent): void => {
        if (event.pointerId !== this.active?.pointerId) return;
        event.preventDefault();
        this.appendEventSamples(event);
    };

    private readonly handlePointerEnd = (event: PointerEvent): void => {
        if (event.pointerId !== this.active?.pointerId) return;
        event.preventDefault();

        const cancelled = event.type !== "pointerup";
        if (!cancelled) {
            this.appendEventSamples(event);
            this.appendFinalPoint();
        }
        this.finishStroke(cancelled);

        if (
            event.type !== "lostpointercapture" &&
            this.canvas.hasPointerCapture(event.pointerId)
        ) {
            this.canvas.releasePointerCapture(event.pointerId);
        }
    };

    private appendEventSamples(event: PointerEvent): void {
        const coalesced = event.getCoalescedEvents?.() ?? [];
        const samples = coalesced.length > 0 ? [...coalesced, event] : [event];
        for (const sample of samples) {
            const point = this.toDocumentPoint(sample);
            if (point) this.appendRawPoint(point);
        }
    }

    private appendRawPoint(point: StrokePoint): void {
        const active = this.active;
        if (!active) return;

        let start = active.lastRaw;
        let dx = point.x - start.x;
        let dy = point.y - start.y;
        let remaining = Math.hypot(dx, dy);
        if (remaining <= 0.0001) {
            active.lastRaw = point;
            return;
        }

        const spacing = Math.max(0.25, active.session.spacing);
        const batch: StrokePoint[] = [];

        while (active.distanceSinceStamp + remaining >= spacing) {
            const needed = spacing - active.distanceSinceStamp;
            const ratio = needed / remaining;
            const next: StrokePoint = {
                x: start.x + dx * ratio,
                y: start.y + dy * ratio,
                pressure:
                    start.pressure +
                    (point.pressure - start.pressure) * ratio,
            };
            batch.push(next);
            active.points.push(next);
            active.lastStamped = next;
            active.distanceSinceStamp = 0;

            start = next;
            dx = point.x - start.x;
            dy = point.y - start.y;
            remaining = Math.hypot(dx, dy);
            if (remaining <= 0.0001) break;
        }

        active.distanceSinceStamp += remaining;
        active.lastRaw = point;
        if (batch.length > 0) active.session.addPoints(batch);
    }

    private appendFinalPoint(): void {
        const active = this.active;
        if (!active) return;
        if (distance(active.lastStamped, active.lastRaw) <= 0.01) return;

        const last = { ...active.lastRaw };
        active.points.push(last);
        active.lastStamped = last;
        active.session.addPoints([last]);
    }

    private finishStroke(cancelled: boolean): void {
        const active = this.active;
        if (!active) return;
        this.active = null;
        active.session.end(active.points, cancelled);
    }

    private toDocumentPoint(event: PointerEvent): StrokePoint | null {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        this.screenPoint.set(
            ((event.clientX - rect.left) * this.app.screen.width) / rect.width,
            ((event.clientY - rect.top) * this.app.screen.height) / rect.height,
        );
        this.documentRoot.toLocal(
            this.screenPoint,
            undefined,
            this.documentPoint,
        );
        return {
            x: this.documentPoint.x,
            y: this.documentPoint.y,
            pressure: event.pressure > 0 ? event.pressure : 1,
        };
    }

    private refreshCursor(): void {
        const selectedId = this.store.getSelectedLayerId();
        const selected = selectedId ? this.store.getLayer(selectedId) : undefined;
        const isPaintTool = this.tools.getState().activeTool === "brush" ||
            this.tools.getState().activeTool === "eraser";
        const isPaintable =
            selected?.kind === "raster" || selected?.kind === "mask";
        // The BrushCursorOverlay draws a size-accurate ring for this case;
        // the system cursor would just be a redundant second indicator.
        this.canvas.style.cursor = isPaintTool && isPaintable ? "none" : "";
    }
}

function distance(a: StrokePoint, b: StrokePoint): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}
