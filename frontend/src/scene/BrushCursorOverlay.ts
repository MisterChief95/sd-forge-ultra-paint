/** Follows the pointer with a ring matching the active brush/eraser footprint. */

import { Container, Graphics, Point } from "pixi.js";
import type { Application } from "pixi.js";

import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import type { PaintToolStore, PaintToolUnsubscribe } from "../state/paintToolStore.svelte";

export class BrushCursorOverlay {
  public readonly container = new Container({ label: "ultra-paint:brush-cursor" });

  private readonly ring = new Graphics();
  private readonly screenPoint = new Point();
  private readonly documentPoint = new Point();
  private unsubscribeStore: Unsubscribe | null = null;
  private unsubscribeTools: PaintToolUnsubscribe | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private hovering = false;
  private lastRadius = -1;
  private lastScale = -1;

  public constructor(
    private readonly app: Application,
    private readonly canvasElement: HTMLCanvasElement,
    private readonly documentRoot: Container,
    private readonly store: LayerStore,
    private readonly toolStore: PaintToolStore,
  ) {
    this.container.addChild(this.ring);
    this.container.visible = false;
    this.container.eventMode = "none";
    // The ring's stroke width must stay constant in screen pixels, but
    // zoom changes (mouse wheel) drive world.scale directly without
    // going through a store this overlay subscribes to -- checking every
    // frame is simpler than threading a zoom-change event through.
    this.container.onRender = () => this.refresh();

    this.unsubscribeStore = store.subscribe(() => this.refresh());
    this.unsubscribeTools = toolStore.subscribe(() => this.refresh());
    this.mount();
    this.refresh();
  }

  public destroy(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeTools?.();
    this.unsubscribeTools = null;
    const canvas = this.canvas;
    if (canvas) {
      canvas.removeEventListener("pointermove", this.handlePointerMove);
      canvas.removeEventListener("pointerenter", this.handlePointerEnter);
      canvas.removeEventListener("pointerleave", this.handlePointerLeave);
      canvas.removeEventListener("pointerdown", this.handlePointerMove);
    }
    this.canvas = null;
    this.container.onRender = null;
    this.container.destroy({ children: true });
  }

  private mount(): void {
    this.canvas = this.canvasElement;
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerenter", this.handlePointerEnter);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.addEventListener("pointerdown", this.handlePointerMove);
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const canvas = this.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    this.screenPoint.set(
      ((event.clientX - rect.left) * this.app.screen.width) / rect.width,
      ((event.clientY - rect.top) * this.app.screen.height) / rect.height,
    );
    this.documentRoot.toLocal(this.screenPoint, undefined, this.documentPoint);
    this.container.position.set(this.documentPoint.x, this.documentPoint.y);
    this.hovering = true;
    this.refresh();
  };

  private readonly handlePointerEnter = (): void => {
    this.hovering = true;
    this.refresh();
  };

  private readonly handlePointerLeave = (): void => {
    this.hovering = false;
    this.refresh();
  };

  private refresh(): void {
    const tool = this.toolStore.activeTool;
    const isPaintTool = tool === "brush" || tool === "eraser";
    const selectedId = this.store.getSelectedLayerId();
    const selected = selectedId ? this.store.getLayer(selectedId) : undefined;
    const isPaintable = selected?.kind === "raster" || selected?.kind === "mask";

    const visible = this.hovering && isPaintTool && isPaintable;
    this.container.visible = visible;
    if (!visible) return;

    const radius = this.toolStore.brush.radius;
    const scale = this.worldScale();
    if (radius !== this.lastRadius || scale !== this.lastScale) {
      this.lastRadius = radius;
      this.lastScale = scale;
      this.redraw(radius);
    }
  }

  private redraw(radius: number): void {
    const strokeWidth = 1 / this.worldScale();
    this.ring.clear();
    // A thicker dark stroke behind a thinner light one keeps the ring
    // visible on both light and dark canvas content.
    this.ring
      .circle(0, 0, radius)
      .stroke({ width: strokeWidth * 3, color: 0x000000, alpha: 0.45 })
      .circle(0, 0, radius)
      .stroke({ width: strokeWidth, color: 0xffffff, alpha: 0.95 });
  }

  private worldScale(): number {
    return Math.max(0.0001, this.documentRoot.parent?.scale.x ?? 1);
  }
}
