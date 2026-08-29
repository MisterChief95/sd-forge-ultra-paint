import {
  Color,
  Container,
  FillGradient,
  Graphics,
  Matrix,
  Point,
  RenderTexture,
  Sprite,
} from "pixi.js";
import type { Application, BLEND_MODES, Texture } from "pixi.js";

import type { LayerStore } from "../state/layerStore.svelte";
import type { BrushSettings } from "../state/paintToolStore.svelte";
import type { LayerId } from "../state/schema";
import type { StrokePoint, StrokeSession } from "./StrokeController";

interface ConsistentOpacityStrokeOptions {
  color: string;
  commitBlendMode: BLEND_MODES;
  livePreview: "overlay" | "replace-layer-texture";
  allowGrowth?: boolean;
  /** Photoshop-style "lock transparent pixels": clip the commit to the layer's pre-stroke alpha. */
  preserveAlpha?: boolean;
  setPreviewTexture?: (texture: Texture) => void;
}

const MAX_LAYER_DIMENSION = 8192;
const GROWTH_PADDING = 512;

/**
 * Accumulates stamp coverage separately, then applies it to the layer once.
 * This makes a stroke's opacity consistent where its densely spaced stamps
 * overlap, while allowing separate strokes to build up normally.
 */
export class ConsistentOpacityStroke implements StrokeSession {
  public readonly spacing: number;

  private readonly stampTexture: RenderTexture;
  private strokeTexture: RenderTexture;
  private readonly stamp: Sprite;
  private readonly strokeSprite: Sprite;
  private readonly layerAlphaMaskSprite: Sprite | null;
  private readonly previewTexture: RenderTexture | null;
  private readonly previewSourceSprite: Sprite | null;
  private readonly previewEraseRoot: Container | null;
  private readonly localPoint = new Point();
  private readonly transform = new Matrix();
  private readonly basis: Pick<Matrix, "a" | "b" | "c" | "d">;
  private readonly radius: number;
  private readonly sizePressure: boolean;
  private readonly opacityPressure: boolean;
  private hasStamps = false;
  private ended = false;

  constructor(
    private readonly app: Application,
    private readonly documentRoot: Container,
    private readonly layerContainer: Container,
    private readonly store: LayerStore,
    private readonly layerId: LayerId,
    private target: RenderTexture,
    settings: Readonly<BrushSettings>,
    private readonly options: ConsistentOpacityStrokeOptions,
  ) {
    this.radius = settings.radius;
    this.sizePressure = settings.pressureEnabled && settings.sizePressure;
    this.opacityPressure = settings.pressureEnabled && settings.opacityPressure;
    this.spacing = Math.max(1, settings.radius * 0.25);
    const stamp = createCoverageStamp(app, settings, this.options.color);
    this.stampTexture = stamp.texture;
    this.stamp = stamp.sprite;
    this.stamp.blendMode = "max";

    this.strokeTexture = RenderTexture.create({
      width: target.width,
      height: target.height,
      resolution: target.source.resolution,
      antialias: true,
    });
    this.strokeSprite = new Sprite({ texture: this.strokeTexture });
    this.strokeSprite.alpha = settings.opacity;
    this.strokeSprite.blendMode = this.options.commitBlendMode;
    this.layerAlphaMaskSprite = this.options.preserveAlpha ? new Sprite({ texture: target }) : null;
    if (this.layerAlphaMaskSprite) {
      this.strokeSprite.setMask({ mask: this.layerAlphaMaskSprite, channel: "alpha" });
    }

    if (this.options.livePreview === "replace-layer-texture") {
      this.previewTexture = RenderTexture.create({
        width: target.width,
        height: target.height,
        resolution: target.source.resolution,
        antialias: true,
      });
      this.previewSourceSprite = new Sprite({ texture: target });
      this.previewEraseRoot = new Container();
      this.previewEraseRoot.addChild(this.strokeSprite);
    } else {
      this.previewTexture = null;
      this.previewSourceSprite = null;
      this.previewEraseRoot = null;
    }

    const origin = layerContainer.toLocal({ x: 0, y: 0 }, documentRoot);
    const xAxis = layerContainer.toLocal({ x: 1, y: 0 }, documentRoot);
    const yAxis = layerContainer.toLocal({ x: 0, y: 1 }, documentRoot);
    this.basis = {
      a: xAxis.x - origin.x,
      b: xAxis.y - origin.y,
      c: yAxis.x - origin.x,
      d: yAxis.y - origin.y,
    };
  }

  public addPoints(points: readonly StrokePoint[]): void {
    const currentTarget = this.store.getTexture(this.layerId);
    if (this.ended || currentTarget !== this.target) return;

    for (const point of points) {
      this.layerContainer.toLocal(point, this.documentRoot, this.localPoint);
      if (this.options.allowGrowth && !this.options.preserveAlpha && this.growForCurrentStamp()) {
        // The atomic store emit synchronously reconciles the layer's
        // compensated transform, so the old local coordinate is stale.
        this.layerContainer.toLocal(point, this.documentRoot, this.localPoint);
      }
      const pressure = Math.max(0, Math.min(1, point.pressure));
      const sizeScale = this.sizePressure ? pressure : 1;
      this.transform.set(
        this.basis.a * sizeScale,
        this.basis.b * sizeScale,
        this.basis.c * sizeScale,
        this.basis.d * sizeScale,
        this.localPoint.x,
        this.localPoint.y,
      );
      this.stamp.setFromMatrix(this.transform);
      this.stamp.alpha = this.opacityPressure ? pressure : 1;
      this.app.renderer.render({
        container: this.stamp,
        target: this.strokeTexture,
        clear: !this.hasStamps,
        clearColor: [0, 0, 0, 0],
      });
      this.hasStamps = true;
    }

    if (!this.hasStamps) return;

    if (this.options.livePreview === "overlay") {
      if (!this.strokeSprite.parent) {
        if (this.layerAlphaMaskSprite) {
          this.layerContainer.addChild(this.layerAlphaMaskSprite);
        }
        this.layerContainer.addChild(this.strokeSprite);
      }
      return;
    }

    this.updateEraserPreview(this.options.setPreviewTexture);
  }

  /** Grow both persistent and per-stroke textures around the current stamp. */
  private growForCurrentStamp(): boolean {
    const width = this.target.width;
    const height = this.target.height;
    const horizontal = calculateAxisGrowth(
      width,
      this.localPoint.x - this.radius,
      this.localPoint.x + this.radius,
    );
    const vertical = calculateAxisGrowth(
      height,
      this.localPoint.y - this.radius,
      this.localPoint.y + this.radius,
    );
    if (horizontal.size === width && vertical.size === height) {
      return false;
    }

    const oldTarget = this.target;
    const oldStrokeTexture = this.strokeTexture;
    const newTarget = createCompatibleRenderTexture(oldTarget, horizontal.size, vertical.size);
    let newStrokeTexture: RenderTexture | null = null;

    try {
      copyTextureAtOffset(this.app, oldTarget, newTarget, horizontal.offset, vertical.offset);
      newStrokeTexture = createCompatibleRenderTexture(
        oldStrokeTexture,
        horizontal.size,
        vertical.size,
      );
      copyTextureAtOffset(
        this.app,
        oldStrokeTexture,
        newStrokeTexture,
        horizontal.offset,
        vertical.offset,
      );
    } catch (error) {
      newStrokeTexture?.destroy(true);
      newTarget.destroy(true);
      throw error;
    }

    // Update these identities before the synchronous store emit so any
    // code reached during reconciliation observes store.getTexture(id)
    // and this.target as the same object.
    this.target = newTarget;
    this.strokeTexture = newStrokeTexture;
    this.strokeSprite.texture = newStrokeTexture;

    const replacedTarget = this.store.growRasterLayer(
      this.layerId,
      oldTarget,
      newTarget,
      horizontal.offset,
      vertical.offset,
    );
    if (replacedTarget !== oldTarget) {
      this.target = oldTarget;
      this.strokeTexture = oldStrokeTexture;
      this.strokeSprite.texture = oldStrokeTexture;
      newStrokeTexture.destroy(true);
      newTarget.destroy(true);
      throw new Error(`[ultra-paint] failed to atomically grow raster layer "${this.layerId}"`);
    }

    // LayerTree reconciliation updates the transform but intentionally
    // does not replace existing raster Sprite textures.
    this.options.setPreviewTexture?.(newTarget);

    // Both old textures are now unreferenced: the store points at
    // newTarget and strokeSprite points at newStrokeTexture.
    oldTarget.destroy(true);
    oldStrokeTexture.destroy(true);
    return true;
  }

  public end(_points: readonly StrokePoint[], cancelled: boolean): void {
    if (this.ended) return;
    this.ended = true;

    // Remove/restore the live preview before writing the real texture so
    // the next frame cannot briefly draw both versions of the stroke.
    this.strokeSprite.mask = null;
    this.strokeSprite.removeFromParent();
    this.layerAlphaMaskSprite?.removeFromParent();
    if (this.previewTexture && this.store.getTexture(this.layerId) === this.target) {
      this.options.setPreviewTexture?.(this.target);
    }

    if (!cancelled && this.hasStamps && this.store.getTexture(this.layerId) === this.target) {
      const commitTexture = this.previewTexture ?? this.strokeTexture;
      // Commit through a fresh, never-parented sprite rather than
      // reusing `strokeSprite` after it has lived in the live scene
      // graph as the overlay preview: PixiJS v8 was found (via a live
      // repro) to carry stale transform/render state onto a display
      // object that has previously participated in a normal per-frame
      // scene render, corrupting a later standalone
      // `renderer.render({container})` call even though that call only
      // reads the object's own local transform. A sprite that has
      // never been parented sidesteps this entirely.
      //
      // Eraser previewTexture already contains the complete layer with
      // accumulated coverage removed. Copying that finished preview
      // back avoids sampling the target and erase-blending into that
      // same GPU texture in adjacent render passes, which Chromium's
      // WebGL path can leave unchanged despite a valid stroke session.
      const commitSprite = new Sprite({ texture: commitTexture });
      if (!this.previewTexture) {
        commitSprite.alpha = this.strokeSprite.alpha;
        commitSprite.blendMode = this.strokeSprite.blendMode;
      }

      let alphaMaskTexture: RenderTexture | null = null;
      let alphaMaskSprite: Sprite | null = null;
      if (this.options.preserveAlpha) {
        // Snapshot the layer's pre-commit alpha (already at its final,
        // post-growth size) and clip the commit to it, so paint cannot
        // extend past pixels that were already opaque.
        alphaMaskTexture = createCompatibleRenderTexture(
          this.target,
          this.target.width,
          this.target.height,
        );
        copyTextureAtOffset(this.app, this.target, alphaMaskTexture, 0, 0);
        alphaMaskSprite = new Sprite({ texture: alphaMaskTexture });
        commitSprite.setMask({ mask: alphaMaskSprite, channel: "alpha" });
      }

      this.app.renderer.render({
        container: commitSprite,
        target: this.target,
        clear: this.previewTexture !== null,
        clearColor: [0, 0, 0, 0],
      });

      commitSprite.mask = null;
      alphaMaskSprite?.destroy({ texture: false, textureSource: false });
      alphaMaskTexture?.destroy(true);
      commitSprite.destroy({ texture: false, textureSource: false });
    }

    this.previewSourceSprite?.destroy({ texture: false, textureSource: false });
    this.previewEraseRoot?.destroy({ children: false });
    this.previewTexture?.destroy(true);
    this.layerAlphaMaskSprite?.destroy({ texture: false, textureSource: false });
    this.strokeSprite.destroy({ texture: false, textureSource: false });
    this.strokeTexture.destroy(true);
    this.stamp.destroy({ texture: false, textureSource: false });
    this.stampTexture.destroy(true);
  }

  /**
   * Erase blend mode operates on the complete framebuffer. Rendering an
   * erase sprite directly in the scene would therefore punch through lower
   * layers as well as this one. Instead, redraw a disposable copy of this
   * layer's texture, erase into that copy, and show the copy in the layer's
   * existing raster sprite until the real commit happens.
   */
  private updateEraserPreview(setPreviewTexture: ((texture: Texture) => void) | undefined): void {
    if (
      !this.previewTexture ||
      !this.previewSourceSprite ||
      !this.previewEraseRoot ||
      !setPreviewTexture
    ) {
      return;
    }

    this.app.renderer.render({
      container: this.previewSourceSprite,
      target: this.previewTexture,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    this.app.renderer.render({
      // PixiJS treats the supplied render object as the root of a pass;
      // keeping the erase sprite as a child makes its blend state part
      // of the collected render instructions on WebGL and WebGPU.
      container: this.previewEraseRoot,
      target: this.previewTexture,
      clear: false,
    });
    setPreviewTexture(this.previewTexture);
  }
}

interface AxisGrowth {
  size: number;
  offset: number;
}

/** Return an integer-sized capped axis that preserves the complete old axis. */
function calculateAxisGrowth(currentSize: number, stampMin: number, stampMax: number): AxisGrowth {
  if (currentSize >= MAX_LAYER_DIMENSION) {
    return { size: currentSize, offset: 0 };
  }

  const available = MAX_LAYER_DIMENSION - currentSize;
  const desiredBefore = stampMin < 0 ? Math.ceil(-stampMin + GROWTH_PADDING) : 0;
  const offset = Math.min(desiredBefore, available);
  const remaining = available - offset;
  const desiredAfter =
    stampMax > currentSize ? Math.ceil(stampMax - currentSize + GROWTH_PADDING) : 0;
  const after = Math.min(desiredAfter, remaining);

  return {
    size: currentSize + offset + after,
    offset,
  };
}

function createCompatibleRenderTexture(
  source: RenderTexture,
  width: number,
  height: number,
): RenderTexture {
  return RenderTexture.create({
    width,
    height,
    resolution: source.source.resolution,
    antialias: source.source.antialias,
    format: source.source.format,
    alphaMode: source.source.alphaMode,
  });
}

/** Copy with a fresh, never-parented Sprite so no stale scene state is reused. */
function copyTextureAtOffset(
  app: Application,
  source: RenderTexture,
  destination: RenderTexture,
  x: number,
  y: number,
): void {
  const sprite = new Sprite({ texture: source, x, y });
  try {
    app.renderer.render({
      container: sprite,
      target: destination,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
  } finally {
    sprite.destroy({ texture: false, textureSource: false });
  }
}

function createCoverageStamp(
  app: Application,
  settings: Readonly<BrushSettings>,
  color: string,
): { texture: RenderTexture; sprite: Sprite } {
  const padding = 2;
  const size = Math.ceil(settings.radius * 2) + padding * 2;
  const center = size / 2;
  const graphics = new Graphics();
  let gradient: FillGradient | null = null;

  if (settings.hardness >= 0.999) {
    graphics.circle(center, center, settings.radius).fill({
      color: new Color(color).toNumber(),
      alpha: 1,
    });
  } else {
    const rgb = new Color(color).toUint8RgbArray();
    const solid = `rgba(${rgb[0] ?? 0},${rgb[1] ?? 0},${rgb[2] ?? 0},1)`;
    const transparent = `rgba(${rgb[0] ?? 0},${rgb[1] ?? 0},${rgb[2] ?? 0},0)`;
    const colorStops = [{ offset: 0, color: solid }];
    if (settings.hardness > 0) colorStops.push({ offset: settings.hardness, color: solid });
    colorStops.push({ offset: 1, color: transparent });

    gradient = new FillGradient({
      type: "radial",
      center: { x: 0.5, y: 0.5 },
      innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.5,
      colorStops,
      textureSpace: "local",
    });
    graphics.circle(center, center, settings.radius).fill(gradient);
  }

  const texture = RenderTexture.create({
    width: size,
    height: size,
    resolution: 1,
    antialias: true,
  });
  try {
    app.renderer.render({
      container: graphics,
      target: texture,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
  } catch (error) {
    texture.destroy(true);
    throw error;
  } finally {
    graphics.destroy();
    gradient?.destroy();
  }

  const sprite = new Sprite({ texture });
  sprite.anchor.set(0.5);
  return { texture, sprite };
}
