import type { Application, Container } from "pixi.js";
import { Rectangle } from "pixi.js";

import { toHexColor } from "../util/color";

/** Radius (in document pixels) of the sampled neighborhood around the cursor. */
const RADIUS = 5;
const GRID = RADIUS * 2 + 1;
const CELL_SIZE = 11;
const LOUPE_SIZE = GRID * CELL_SIZE;
const CURSOR_OFFSET = 18;
const VIEWPORT_MARGIN = 8;

/**
 * Floating pixel-zoom loupe shown while the eyedropper tool is active --
 * mirrors a native OS color-picker magnifier. Purely a live preview: it never
 * mutates any store, it only reads pixels via {@link Application.renderer}'s
 * extract API and draws them into its own DOM canvas.
 */
export class MagnifierOverlay {
  private readonly wrapper: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLDivElement;
  private readonly screenPoint = { x: 0, y: 0 };

  constructor(
    private readonly app: Application,
    private readonly documentRoot: Container,
  ) {
    this.wrapper = document.createElement("div");
    this.wrapper.setAttribute("data-testid", "eyedropper-magnifier");
    // Appended to `document.body` (not the canvas host element) so a
    // `position:fixed` box can line up directly with `clientX/clientY`,
    // and so its own <canvas> never collides with "canvas" locators
    // scoped to the paint viewport root in tests.
    this.wrapper.style.cssText =
      "position:fixed;z-index:1000;display:none;pointer-events:none;" +
      "padding:6px;border:1px solid var(--upaint-border);" +
      "border-radius:var(--upaint-radius-sm);background:var(--upaint-surface);" +
      "box-shadow:0 2px 8px rgb(0 0 0 / 35%);";

    this.canvas = document.createElement("canvas");
    this.canvas.width = LOUPE_SIZE;
    this.canvas.height = LOUPE_SIZE;
    this.canvas.style.cssText = "display:block;image-rendering:pixelated;";
    this.wrapper.appendChild(this.canvas);

    this.label = document.createElement("div");
    this.label.style.cssText =
      "margin-top:4px;text-align:center;color:var(--upaint-text);" +
      "font:11px var(--upaint-font);";
    this.wrapper.appendChild(this.label);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("[ultra-paint] could not create a 2D canvas context");
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;

    document.body.appendChild(this.wrapper);
  }

  /** Sample around the pointer and redraw the loupe at its new position. */
  public update(event: PointerEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.hide();
      return;
    }

    this.screenPoint.x = ((event.clientX - rect.left) * this.app.screen.width) / rect.width;
    this.screenPoint.y = ((event.clientY - rect.top) * this.app.screen.height) / rect.height;
    const documentPoint = this.documentRoot.toLocal(this.screenPoint);
    const originX = Math.floor(documentPoint.x) - RADIUS;
    const originY = Math.floor(documentPoint.y) - RADIUS;

    try {
      const { pixels, width, height } = this.app.renderer.extract.pixels({
        target: this.documentRoot,
        frame: new Rectangle(originX, originY, GRID, GRID),
      });
      this.draw(pixels, width, height);
    } catch {
      this.hide();
      return;
    }

    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, event.clientX + CURSOR_OFFSET),
      window.innerWidth - LOUPE_SIZE - VIEWPORT_MARGIN,
    );
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, event.clientY - LOUPE_SIZE - CURSOR_OFFSET),
      window.innerHeight - LOUPE_SIZE - VIEWPORT_MARGIN,
    );
    this.wrapper.style.left = `${left}px`;
    this.wrapper.style.top = `${top}px`;
    this.wrapper.style.display = "block";
  }

  public hide(): void {
    this.wrapper.style.display = "none";
  }

  public destroy(): void {
    this.wrapper.remove();
  }

  /** Canvas 2D colors can't reference CSS custom properties directly. */
  private accentColor(): string {
    const value = getComputedStyle(this.wrapper).getPropertyValue("--upaint-accent").trim();
    return value || "#4f9eff";
  }

  private draw(pixels: Uint8ClampedArray, width: number, height: number): void {
    const ctx = this.ctx;
    const cellW = LOUPE_SIZE / width;
    const cellH = LOUPE_SIZE / height;
    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);

    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

    let centerHex: string | null = null;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const r = pixels[i] ?? 0;
        const g = pixels[i + 1] ?? 0;
        const b = pixels[i + 2] ?? 0;
        const a = pixels[i + 3] ?? 0;
        if (a > 0) {
          ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
          ctx.fillRect(x * cellW, y * cellH, cellW, cellH);
        }
        if (x === centerX && y === centerY && a > 0) {
          centerHex = toHexColor(r, g, b);
        }
      }
    }

    ctx.strokeStyle = this.accentColor();
    ctx.lineWidth = 2;
    ctx.strokeRect(centerX * cellW + 1, centerY * cellH + 1, cellW - 2, cellH - 2);

    this.label.textContent = centerHex ?? "—";
  }
}
