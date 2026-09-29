/**
 * Document-aligned grid rendered below all layer content.
 *
 * Lines are always 1 screen pixel wide (`pixelLine`) and land on document-pixel
 * multiples. The document spacing is the smallest power of two whose on-screen
 * size is at least MIN_SCREEN_SPACING, so the grid never gets too dense or too
 * sparse as the camera zooms; every MAJOR_EVERY-th line is emphasized. Only the
 * visible region is drawn, and only when the camera or viewport changes.
 */

import { Container, Graphics, Point } from "pixi.js";

const MIN_SCREEN_SPACING = 16;
const MAJOR_EVERY = 4;
const LINE_COLOR = 0xffffff;
const MINOR_ALPHA = 0.07;
const MAJOR_ALPHA = 0.16;

/** Document-pixel spacing for `zoom`: a power of two, never below one pixel. */
export function gridSpacingForZoom(zoom: number): number {
  const spacing = 2 ** Math.ceil(Math.log2(MIN_SCREEN_SPACING / Math.max(zoom, 1e-4)));
  return Math.max(1, spacing);
}

export class PixelGrid {
  public readonly container = new Container({ label: "ultra-paint:pixel-grid" });

  private readonly minor = new Graphics();
  private readonly major = new Graphics();
  private cameraKey = "";

  public constructor(
    private readonly documentRoot: Container,
    /** Live renderer screen rectangle (`app.screen`), updated on resize. */
    private readonly screen: { width: number; height: number },
  ) {
    this.container.eventMode = "none";
    this.container.addChild(this.minor, this.major);
    this.container.onRender = () => this.redrawIfCameraChanged();
  }

  public destroy(): void {
    this.container.onRender = null;
    this.container.destroy({ children: true });
  }

  /** Show or hide the grid. */
  public setVisible(visible: boolean): void {
    this.container.visible = visible;
  }

  /** Whether the grid is currently rendered. */
  public isVisible(): boolean {
    return this.container.visible;
  }

  private redrawIfCameraChanged(): void {
    const world = this.documentRoot.parent;
    if (!world) return;
    const { width, height } = this.screen;
    const key = `${world.scale.x},${world.position.x},${world.position.y},${width},${height}`;
    if (key === this.cameraKey) return;
    this.cameraKey = key;

    // Visible region in the grid's (world-local) space.
    const topLeft = this.container.toLocal(new Point(0, 0));
    const bottomRight = this.container.toLocal(new Point(width, height));
    const spacing = gridSpacingForZoom(world.scale.x);
    const majorSpacing = spacing * MAJOR_EVERY;
    const x0 = Math.floor(topLeft.x / spacing) * spacing;
    const y0 = Math.floor(topLeft.y / spacing) * spacing;

    this.minor.clear();
    this.major.clear();
    for (let x = x0; x <= bottomRight.x; x += spacing) {
      (x % majorSpacing === 0 ? this.major : this.minor)
        .moveTo(x, topLeft.y)
        .lineTo(x, bottomRight.y);
    }
    for (let y = y0; y <= bottomRight.y; y += spacing) {
      (y % majorSpacing === 0 ? this.major : this.minor)
        .moveTo(topLeft.x, y)
        .lineTo(bottomRight.x, y);
    }
    this.minor.stroke({ width: 1, pixelLine: true, color: LINE_COLOR, alpha: MINOR_ALPHA });
    this.major.stroke({ width: 1, pixelLine: true, color: LINE_COLOR, alpha: MAJOR_ALPHA });
  }
}
