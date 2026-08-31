import { Container, Matrix, Point, RenderTexture, Sprite } from "pixi.js";
import type { Application } from "pixi.js";

import type { TileAllocation, TileEditDelta, TiledRasterCanvas } from "../canvas/TiledRasterCanvas";
import type { PixelBounds, TileCoord } from "../canvas/TileGrid";
import type { LayerNode } from "../scene/LayerNode";
import type { LayerStore } from "../state/layerStore.svelte";
import type { BrushSettings } from "../state/paintToolStore.svelte";
import type { LayerId } from "../state/schema";
import { createCoverageStamp } from "./ConsistentOpacityStroke";
import type { StrokePoint, StrokeSession } from "./StrokeController";

/** Structural subset of `UndoHistory` needed to record a stroke's tile delta. */
export interface TileEditRecorder {
  recordTileEdit(layerId: LayerId, delta: TileEditDelta): void;
}

export interface TiledConsistentOpacityStrokeOptions {
  mode: "brush" | "eraser";
  color: string;
  /** Ignored for eraser -- erasing under a preserved alpha would be a no-op. */
  preserveAlpha: boolean;
}

interface TileStrokeState {
  coord: TileCoord;
  originX: number;
  originY: number;
  /** Per-stroke coverage accumulator, tile-sized; never touches the persistent tile. */
  strokeTexture: RenderTexture;
  overlaySprite: Sprite;
  /** Brush + preserveAlpha only: masks the live overlay to the tile's existing alpha. */
  alphaMaskSprite: Sprite | null;
  hasStamps: boolean;
  /**
   * Eraser only: tile-sized "already erased" composite that the overlay sprite
   * displays *in place of* the persistent tile sprite (which is hidden for the
   * duration of the stroke -- see `tileFor()`).
   */
  previewTexture: RenderTexture | null;
  /**
   * Eraser only: one-time copy of the tile's pre-stroke pixels, so the
   * composite never samples the persistent tile texture -- see `tileFor()`.
   */
  baseSnapshotTexture: RenderTexture | null;
  baseSprite: Sprite | null;
  eraseRoot: Container | null;
}

/**
 * Per-tile counterpart to {@link ConsistentOpacityStroke} for a tiled (uploaded)
 * layer. Persistent tiles are never touched until `end()` commits one atomic
 * `TileEditTransaction` across every touched tile -- the live preview only ever
 * draws into per-tile scratch textures and throwaway overlay sprites, so a
 * cancelled stroke leaves the surface completely untouched.
 */
export class TiledConsistentOpacityStroke implements StrokeSession {
  public readonly spacing: number;

  private readonly stampTexture: RenderTexture;
  private readonly stamp: Sprite;
  private readonly stampHalfExtent: number;
  private readonly localPoint = new Point();
  private readonly transform = new Matrix();
  private readonly tileTransform = new Matrix();
  private readonly basis: Pick<Matrix, "a" | "b" | "c" | "d">;
  private readonly sizePressure: boolean;
  private readonly opacityPressure: boolean;
  private readonly opacity: number;
  private readonly tileSize: number;
  private readonly tiles = new Map<string, TileStrokeState>();
  private readonly layerContainer: Container;
  private ended = false;

  constructor(
    private readonly app: Application,
    private readonly documentRoot: Container,
    private readonly node: LayerNode,
    private readonly store: LayerStore,
    private readonly history: TileEditRecorder,
    private readonly layerId: LayerId,
    private readonly surface: TiledRasterCanvas,
    settings: Readonly<BrushSettings>,
    private readonly options: TiledConsistentOpacityStrokeOptions,
  ) {
    this.layerContainer = node.container;
    this.opacity = settings.opacity;
    this.sizePressure = settings.pressureEnabled && settings.sizePressure;
    this.opacityPressure = settings.pressureEnabled && settings.opacityPressure;
    this.spacing = Math.max(1, settings.radius * 0.25);
    this.tileSize = surface.tileSize;

    const stamp = createCoverageStamp(app, settings, options.color);
    this.stampTexture = stamp.texture;
    this.stamp = stamp.sprite;
    this.stamp.blendMode = "max";
    this.stampHalfExtent = stamp.texture.width / 2;

    const origin = this.layerContainer.toLocal({ x: 0, y: 0 }, documentRoot);
    const xAxis = this.layerContainer.toLocal({ x: 1, y: 0 }, documentRoot);
    const yAxis = this.layerContainer.toLocal({ x: 0, y: 1 }, documentRoot);
    this.basis = {
      a: xAxis.x - origin.x,
      b: xAxis.y - origin.y,
      c: yAxis.x - origin.x,
      d: yAxis.y - origin.y,
    };
  }

  public addPoints(points: readonly StrokePoint[]): void {
    if (this.ended || this.store.getTiledSurface(this.layerId) !== this.surface) return;

    const touchedThisBatch = new Set<TileStrokeState>();

    for (const point of points) {
      this.layerContainer.toLocal(point, this.documentRoot, this.localPoint);
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
      const stampAlpha = this.opacityPressure ? pressure : 1;

      for (const coord of this.tileRangeForStamp(sizeScale)) {
        const state = this.tileFor(coord);
        if (!state) continue;

        this.tileTransform.set(
          this.transform.a,
          this.transform.b,
          this.transform.c,
          this.transform.d,
          this.transform.tx - state.originX,
          this.transform.ty - state.originY,
        );
        this.stamp.setFromMatrix(this.tileTransform);
        this.stamp.alpha = stampAlpha;
        this.app.renderer.render({
          container: this.stamp,
          target: state.strokeTexture,
          clear: !state.hasStamps,
          clearColor: [0, 0, 0, 0],
        });
        state.hasStamps = true;
        touchedThisBatch.add(state);
      }
    }

    if (this.options.mode === "eraser") {
      for (const state of touchedThisBatch) this.updateEraserPreview(state);
    }
  }

  public end(_points: readonly StrokePoint[], cancelled: boolean): void {
    if (this.ended) return;
    this.ended = true;

    for (const state of this.tiles.values()) {
      state.overlaySprite.mask = null;
      state.overlaySprite.removeFromParent();
      state.alphaMaskSprite?.removeFromParent();
      // Restore whatever the overlay was standing in for. Safe to do before
      // commit(): no frame renders between here and the commit renders below.
      if (this.options.mode === "eraser") this.node.setTileSpriteHidden(state.coord, false);
    }

    const touched = [...this.tiles.values()].filter((state) => state.hasStamps);
    if (
      !cancelled &&
      touched.length > 0 &&
      this.store.getTiledSurface(this.layerId) === this.surface
    ) {
      this.commit(touched);
    }

    for (const state of this.tiles.values()) {
      state.overlaySprite.destroy({ texture: false, textureSource: false });
      state.alphaMaskSprite?.destroy({ texture: false, textureSource: false });
      state.eraseRoot?.destroy({ children: true, texture: false, textureSource: false });
      state.baseSprite?.destroy({ texture: false, textureSource: false });
      state.previewTexture?.destroy(true);
      state.baseSnapshotTexture?.destroy(true);
      state.strokeTexture.destroy(true);
    }
    this.tiles.clear();

    this.stamp.destroy({ texture: false, textureSource: false });
    this.stampTexture.destroy(true);
  }

  private commit(states: TileStrokeState[]): void {
    const allocation: TileAllocation =
      this.options.mode === "eraser" || this.options.preserveAlpha
        ? "existing-only"
        : "allocate-missing";
    const transaction = this.surface.beginEdit(this.options.mode === "eraser" ? "erase" : "brush");

    for (const state of states) {
      const region: PixelBounds = {
        x: state.originX,
        y: state.originY,
        width: this.tileSize,
        height: this.tileSize,
      };
      this.surface.edit(region, { allocation, transaction }, (tile) => {
        if (this.options.mode === "eraser") {
          if (!state.previewTexture) return;
          const commitSprite = new Sprite({ texture: state.previewTexture });
          try {
            this.app.renderer.render({
              container: commitSprite,
              target: tile.target,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });
          } finally {
            commitSprite.destroy({ texture: false, textureSource: false });
          }
          return;
        }

        const commitSprite = new Sprite({ texture: state.strokeTexture });
        commitSprite.alpha = this.opacity;
        let alphaMaskTexture: RenderTexture | null = null;
        let alphaMaskSprite: Sprite | null = null;
        try {
          if (this.options.preserveAlpha) {
            alphaMaskTexture = RenderTexture.create({
              width: tile.target.width,
              height: tile.target.height,
              resolution: tile.target.source.resolution,
              antialias: tile.target.source.antialias,
            });
            const snapshot = new Sprite({ texture: tile.target });
            try {
              this.app.renderer.render({
                container: snapshot,
                target: alphaMaskTexture,
                clear: true,
                clearColor: [0, 0, 0, 0],
              });
            } finally {
              snapshot.destroy({ texture: false, textureSource: false });
            }
            alphaMaskSprite = new Sprite({ texture: alphaMaskTexture });
            commitSprite.setMask({ mask: alphaMaskSprite, channel: "alpha" });
          }
          this.app.renderer.render({ container: commitSprite, target: tile.target, clear: false });
        } finally {
          commitSprite.mask = null;
          alphaMaskSprite?.destroy({ texture: false, textureSource: false });
          alphaMaskTexture?.destroy(true);
          commitSprite.destroy({ texture: false, textureSource: false });
        }
      });
      if (allocation === "allocate-missing") transaction.includeBounds(region);
    }

    const delta = transaction.commit();
    if (delta.tileCount === 0) {
      delta.destroy();
      return;
    }
    this.history.recordTileEdit(this.layerId, delta);
    this.store.touchTexture(this.layerId);
  }

  /** Existing tiles only for eraser/preserveAlpha; a fresh scratch tile otherwise. */
  private tileFor(coord: TileCoord): TileStrokeState | null {
    const key = this.surface.grid.key(coord);
    const existing = this.tiles.get(key);
    if (existing) return existing;

    const bounds = this.surface.grid.boundsFor(coord);
    const needsExisting = this.options.mode === "eraser" || this.options.preserveAlpha;
    let baseTarget: RenderTexture | null = null;
    if (needsExisting) {
      this.surface.visit(bounds, (tile) => {
        baseTarget = tile.target;
      });
      if (!baseTarget) return null;
    }

    const strokeTexture = RenderTexture.create({
      width: this.tileSize,
      height: this.tileSize,
      resolution: 1,
      antialias: true,
    });
    const overlaySprite = new Sprite({ texture: strokeTexture });

    const state: TileStrokeState = {
      coord,
      originX: bounds.x,
      originY: bounds.y,
      strokeTexture,
      overlaySprite,
      alphaMaskSprite: null,
      hasStamps: false,
      previewTexture: null,
      baseSnapshotTexture: null,
      baseSprite: null,
      eraseRoot: null,
    };

    if (this.options.mode === "eraser") {
      // The overlay *replaces* this tile for the duration of the stroke rather
      // than drawing over it: an erase is only visible if the original pixels
      // stop being drawn. Leaving the tile sprite visible underneath is what
      // made the live preview appear to do nothing -- the preview's erased
      // (transparent) pixels simply revealed the untouched tile below.
      this.node.setTileSpriteHidden(coord, true);
      // No antialias: this texture only ever receives whole-pixel copies and
      // an erase-blend composite, never vector edges, so there's nothing for
      // MSAA to smooth.
      state.previewTexture = RenderTexture.create({
        width: this.tileSize,
        height: this.tileSize,
        resolution: 1,
        antialias: false,
      });
      // Snapshot the tile once rather than sampling `baseTarget` every batch:
      // the persistent tile texture is also the commit target at stroke end,
      // and compositing from a texture that is elsewhere a live render target
      // hits the Chromium/WebGL staleness hazard documented in
      // ConsistentOpacityStroke.end().
      state.baseSnapshotTexture = RenderTexture.create({
        width: this.tileSize,
        height: this.tileSize,
        resolution: 1,
        antialias: false,
      });
      const liveBaseSprite = new Sprite({ texture: baseTarget! });
      this.app.renderer.render({
        container: liveBaseSprite,
        target: state.baseSnapshotTexture,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      liveBaseSprite.destroy({ texture: false, textureSource: false });
      state.baseSprite = new Sprite({ texture: state.baseSnapshotTexture });
      const eraseStrokeSprite = new Sprite({ texture: strokeTexture });
      eraseStrokeSprite.blendMode = "erase";
      state.eraseRoot = new Container();
      state.eraseRoot.addChild(eraseStrokeSprite);
      overlaySprite.texture = state.previewTexture;
      // Seed the preview with the tile as-is, so the frame between hiding the
      // tile sprite and the first stamp shows the tile rather than nothing.
      // (Only the base copy: `strokeTexture` has no defined contents until
      // `addPoints()` renders its first stamp with `clear: true`.)
      this.app.renderer.render({
        container: state.baseSprite,
        target: state.previewTexture,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
    } else {
      overlaySprite.alpha = this.opacity;
      overlaySprite.blendMode = "normal";
      if (this.options.preserveAlpha) {
        state.alphaMaskSprite = new Sprite({ texture: baseTarget! });
        overlaySprite.setMask({ mask: state.alphaMaskSprite, channel: "alpha" });
        this.layerContainer.addChild(state.alphaMaskSprite);
      }
    }

    overlaySprite.position.set(bounds.x, bounds.y);
    this.layerContainer.addChild(overlaySprite);
    this.tiles.set(key, state);
    return state;
  }

  /**
   * Redraw one tile's "already erased" preview from its pre-stroke snapshot.
   * Erase blend mode operates on the whole framebuffer, so it can only be used
   * inside this private off-screen composite -- never rendered directly into
   * the live scene, where it would punch through the layers below.
   */
  private updateEraserPreview(state: TileStrokeState): void {
    if (!state.previewTexture || !state.baseSprite || !state.eraseRoot) return;
    this.app.renderer.render({
      container: state.baseSprite,
      target: state.previewTexture,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    this.app.renderer.render({
      container: state.eraseRoot,
      target: state.previewTexture,
      clear: false,
    });
  }

  /** Tile coordinates intersecting the current stamp's affine bounding box. */
  private *tileRangeForStamp(sizeScale: number): Generator<TileCoord> {
    const half = this.stampHalfExtent * sizeScale;
    const corners = [
      this.transform.apply({ x: -half, y: -half }),
      this.transform.apply({ x: half, y: -half }),
      this.transform.apply({ x: half, y: half }),
      this.transform.apply({ x: -half, y: half }),
    ];
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    yield* this.surface.grid.coordinates({
      x: minX,
      y: minY,
      width: Math.max(1e-6, maxX - minX),
      height: Math.max(1e-6, maxY - minY),
    });
  }
}
