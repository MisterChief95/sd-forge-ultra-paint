import { RenderTexture, Sprite } from "pixi.js";
import type { Renderer } from "pixi.js";

import { TileGrid } from "./TileGrid";
import type { PixelBounds, TileCoord } from "./TileGrid";

export type TileAllocation = "existing-only" | "allocate-missing";

export interface TileVisit {
  coord: TileCoord;
  originX: number;
  originY: number;
  /** Borrowed for this visit/edit; ownership remains with the canvas. */
  target: RenderTexture;
}

export interface TileStructureEvent {
  type: "added" | "removed" | "replaced";
  coord: TileCoord;
  /** New surface-owned target, or null when the tile was removed. */
  target: RenderTexture | null;
  /** Detached previous target, populated for remove/replace replay events. */
  previousTarget: RenderTexture | null;
}

interface RasterTile {
  coord: TileCoord;
  target: RenderTexture;
}

interface TileBeforeState {
  coord: TileCoord;
  /** Null means the tile did not exist before the edit. */
  snapshot: RenderTexture | null;
}

/**
 * Before-state ownership returned by a committed edit. History will eventually
 * consume this directly; callers that do not retain it must destroy it.
 */
export class TileEditDelta {
  private beforeStates: TileBeforeState[] | null;

  /** @internal */
  constructor(
    private readonly owner: TiledRasterCanvas,
    public readonly label: string,
    public readonly boundsBefore: PixelBounds | null,
    beforeStates: TileBeforeState[],
  ) {
    this.beforeStates = beforeStates;
  }

  public get tileCount(): number {
    return this.beforeStates?.length ?? 0;
  }

  public get estimatedBytes(): number {
    return (this.beforeStates ?? []).reduce(
      (total, state) => total + (state.snapshot ? textureBytes(state.snapshot) : 0),
      0,
    );
  }

  /**
   * Restore this delta's before-state and return the inverse redo/undo delta.
   * Applying consumes this delta; its textures transfer into the surface.
   */
  public apply(): TileEditDelta {
    return this.owner.applyDelta(this);
  }

  public destroy(): void {
    const states = this.beforeStates;
    if (!states) return;
    this.beforeStates = null;
    for (const state of states) state.snapshot?.destroy(true);
  }

  /** @internal */
  public take(owner: TiledRasterCanvas): TileBeforeState[] {
    if (owner !== this.owner) {
      throw new Error("tile edit delta belongs to another canvas");
    }
    const states = this.beforeStates;
    if (!states) throw new Error("tile edit delta was already applied or destroyed");
    this.beforeStates = null;
    return states;
  }
}

/** One atomic multi-tile edit. Call commit() or rollback() exactly once. */
export class TileEditTransaction {
  /** @internal */ readonly beforeStates = new Map<string, TileBeforeState>();

  /** @internal */ boundsToInclude: PixelBounds | null = null;

  /** @internal */ active = true;

  /** @internal */
  constructor(
    private readonly owner: TiledRasterCanvas,
    public readonly label: string,
  ) {}

  /** Explicitly expand logical potential-content bounds on successful commit. */
  public includeBounds(bounds: PixelBounds): void {
    this.owner.includeTransactionBounds(this, bounds);
  }

  public commit(): TileEditDelta {
    return this.owner.commitTransaction(this);
  }

  public rollback(): void {
    this.owner.rollbackTransaction(this);
  }

  /** @internal */
  public assertOwner(owner: TiledRasterCanvas): void {
    if (this.owner !== owner) {
      throw new Error("tile edit transaction belongs to another canvas");
    }
    if (!this.active) {
      throw new Error("tile edit transaction is no longer active");
    }
  }
}

/**
 * Sparse owner of one paintable layer's persistent RenderTexture tiles.
 *
 * The backing Map is intentionally private. All writes pass through an edit
 * transaction so allocation, rollback, bounds, and resource ownership cannot
 * diverge between brush/import/fill callers.
 */
export class TiledRasterCanvas {
  public readonly grid: TileGrid;

  readonly #tiles = new Map<string, RasterTile>();

  private readonly listeners = new Set<(event: TileStructureEvent) => void>();

  private readonly activeTransactions = new Set<TileEditTransaction>();

  private logicalBounds: PixelBounds | null = null;

  private destroyed = false;

  constructor(
    private readonly renderer: Renderer,
    tileSize: number,
  ) {
    this.grid = new TileGrid(tileSize);
  }

  public get tileSize(): number {
    return this.grid.tileSize;
  }

  public get bounds(): PixelBounds | null {
    return this.logicalBounds ? { ...this.logicalBounds } : null;
  }

  public get tileCount(): number {
    return this.#tiles.size;
  }

  public beginEdit(label: string): TileEditTransaction {
    this.assertAlive();
    if (this.activeTransactions.size > 0) {
      throw new Error("tiled raster canvas already has an active edit transaction");
    }
    const transaction = new TileEditTransaction(this, label);
    this.activeTransactions.add(transaction);
    return transaction;
  }

  /** Visit only already-allocated tiles intersecting region. */
  public visit(region: PixelBounds, fn: (tile: TileVisit) => void): void {
    this.assertAlive();
    for (const coord of this.grid.coordinates(region)) {
      const tile = this.#tiles.get(this.grid.key(coord));
      if (tile) fn(this.visitFor(tile));
    }
  }

  /** Visit every allocated tile in deterministic coordinate order. */
  public visitAll(fn: (tile: TileVisit) => void): void {
    this.assertAlive();
    for (const tile of this.sortedTiles()) fn(this.visitFor(tile));
  }

  /**
   * Visit writable tiles in a region, optionally allocating missing ones.
   * Any thrown callback error rolls back the complete transaction.
   */
  public edit(
    region: PixelBounds,
    options: { allocation: TileAllocation; transaction: TileEditTransaction },
    fn: (tile: TileVisit) => void,
  ): void {
    this.assertAlive();
    const transaction = options.transaction;
    transaction.assertOwner(this);

    try {
      for (const coord of this.grid.coordinates(region)) {
        const key = this.grid.key(coord);
        let tile = this.#tiles.get(key);

        if (!tile) {
          if (options.allocation === "existing-only") continue;
          transaction.beforeStates.set(key, { coord: { ...coord }, snapshot: null });
          tile = { coord: { ...coord }, target: this.createTile() };
          this.#tiles.set(key, tile);
        } else if (!transaction.beforeStates.has(key)) {
          transaction.beforeStates.set(key, {
            coord: { ...coord },
            snapshot: this.copyTexture(tile.target),
          });
        }

        fn(this.visitFor(tile));
      }
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  public subscribe(fn: (event: TileStructureEvent) => void): () => void {
    this.assertAlive();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public estimateResidentBytes(): number {
    let total = 0;
    for (const tile of this.#tiles.values()) total += textureBytes(tile.target);
    return total;
  }

  /** Sorted coordinates for diagnostics/tests; never exposes mutable storage. */
  public diagnosticTileCoords(): TileCoord[] {
    return this.sortedTiles().map((tile) => ({ ...tile.coord }));
  }

  public destroy(): void {
    if (this.destroyed) return;
    for (const transaction of [...this.activeTransactions]) transaction.rollback();
    this.listeners.clear();
    for (const tile of this.#tiles.values()) tile.target.destroy(true);
    this.#tiles.clear();
    this.logicalBounds = null;
    this.destroyed = true;
  }

  /** @internal */
  public includeTransactionBounds(transaction: TileEditTransaction, bounds: PixelBounds): void {
    this.assertAlive();
    transaction.assertOwner(this);
    // Validate the complete half-open bounds and safe coordinate range.
    this.grid.rangeFor(bounds);
    transaction.boundsToInclude = transaction.boundsToInclude
      ? unionBounds(transaction.boundsToInclude, bounds)
      : { ...bounds };
  }

  /** @internal */
  public commitTransaction(transaction: TileEditTransaction): TileEditDelta {
    this.assertAlive();
    transaction.assertOwner(this);

    const boundsBefore = this.bounds;
    if (transaction.boundsToInclude) {
      this.logicalBounds = this.logicalBounds
        ? unionBounds(this.logicalBounds, transaction.boundsToInclude)
        : { ...transaction.boundsToInclude };
    }

    transaction.active = false;
    this.activeTransactions.delete(transaction);
    const beforeStates = [...transaction.beforeStates.values()];
    const delta = new TileEditDelta(this, transaction.label, boundsBefore, beforeStates);

    for (const state of beforeStates) {
      if (state.snapshot !== null) continue;
      const tile = this.#tiles.get(this.grid.key(state.coord));
      if (tile) {
        this.emit({
          type: "added",
          coord: { ...tile.coord },
          target: tile.target,
          previousTarget: null,
        });
      }
    }
    return delta;
  }

  /** @internal */
  public applyDelta(delta: TileEditDelta): TileEditDelta {
    this.assertAlive();
    if (this.activeTransactions.size > 0) {
      throw new Error("cannot replay tile history during an active edit transaction");
    }

    // `take` validates ownership before transferring anything. From here on the
    // operation is a synchronous Map/ownership swap with no renderer work.
    const states = delta.take(this);
    const boundsBefore = this.bounds;
    const inverseStates: TileBeforeState[] = [];
    const events: TileStructureEvent[] = [];

    for (const state of states) {
      const key = this.grid.key(state.coord);
      const current = this.#tiles.get(key);
      inverseStates.push({
        coord: { ...state.coord },
        snapshot: current?.target ?? null,
      });

      if (state.snapshot) {
        const replacement: RasterTile = {
          coord: { ...state.coord },
          target: state.snapshot,
        };
        this.#tiles.set(key, replacement);
        events.push({
          type: current ? "replaced" : "added",
          coord: { ...state.coord },
          target: replacement.target,
          previousTarget: current?.target ?? null,
        });
      } else if (current) {
        this.#tiles.delete(key);
        events.push({
          type: "removed",
          coord: { ...state.coord },
          target: null,
          previousTarget: current.target,
        });
      }
    }

    this.logicalBounds = delta.boundsBefore ? { ...delta.boundsBefore } : null;
    const inverse = new TileEditDelta(this, delta.label, boundsBefore, inverseStates);
    for (const event of events) this.emit(event);
    return inverse;
  }

  /** @internal */
  public rollbackTransaction(transaction: TileEditTransaction): void {
    transaction.assertOwner(this);

    for (const [key, state] of transaction.beforeStates) {
      const tile = this.#tiles.get(key);
      if (state.snapshot === null) {
        if (tile) {
          this.#tiles.delete(key);
          tile.target.destroy(true);
        }
        continue;
      }
      if (tile) this.copyTextureInto(state.snapshot, tile.target);
      state.snapshot.destroy(true);
    }

    transaction.active = false;
    this.activeTransactions.delete(transaction);
  }

  private visitFor(tile: RasterTile): TileVisit {
    const bounds = this.grid.boundsFor(tile.coord);
    return {
      coord: { ...tile.coord },
      originX: bounds.x,
      originY: bounds.y,
      target: tile.target,
    };
  }

  private sortedTiles(): RasterTile[] {
    return [...this.#tiles.values()].sort(
      (left, right) => left.coord.y - right.coord.y || left.coord.x - right.coord.x,
    );
  }

  private createTile(): RenderTexture {
    const target = RenderTexture.create({
      width: this.tileSize,
      height: this.tileSize,
      resolution: 1,
      antialias: false,
    });
    try {
      // `renderer.clear({ target })` clears whatever framebuffer is currently
      // bound rather than binding `target` first (a Pixi 8 gap), which was
      // corrupting whatever tile a prior operation had left bound. Bind the
      // new tile explicitly so the clear lands on it.
      this.renderer.renderTarget.bind({
        target,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      return target;
    } catch (error) {
      target.destroy(true);
      throw error;
    }
  }

  private copyTexture(source: RenderTexture): RenderTexture {
    const copy = RenderTexture.create({
      width: source.width,
      height: source.height,
      resolution: source.source.resolution,
      antialias: source.source.antialias,
      format: source.source.format,
      alphaMode: source.source.alphaMode,
    });
    try {
      this.copyTextureInto(source, copy);
      return copy;
    } catch (error) {
      copy.destroy(true);
      throw error;
    }
  }

  /** Copy via a never-parented Sprite, matching existing Pixi lifecycle rules. */
  private copyTextureInto(source: RenderTexture, destination: RenderTexture): void {
    const sprite = new Sprite({ texture: source });
    try {
      this.renderer.render({
        container: sprite,
        target: destination,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
    } finally {
      sprite.destroy({ texture: false, textureSource: false });
    }
  }

  private emit(event: TileStructureEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[ultra-paint] tile structure listener failed", error);
      }
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("tiled raster canvas is destroyed");
  }
}

function unionBounds(left: PixelBounds, right: PixelBounds): PixelBounds {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function textureBytes(texture: RenderTexture): number {
  return texture.source.pixelWidth * texture.source.pixelHeight * 4;
}
