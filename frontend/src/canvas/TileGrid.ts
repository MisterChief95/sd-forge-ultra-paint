/** Half-open layer-local pixel bounds: [x, x + width) x [y, y + height). */
export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Signed integer tile coordinate. */
export interface TileCoord {
  x: number;
  y: number;
}

/** Inclusive tile-coordinate range. */
export interface TileRange {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Pure signed tile geometry shared by storage, painting, culling, and export.
 *
 * Pixel rectangles are half-open. Therefore a rectangle ending exactly on a
 * tile boundary does not include the tile on the other side of that boundary.
 */
export class TileGrid {
  public readonly tileSize: number;

  constructor(tileSize: number) {
    if (!Number.isSafeInteger(tileSize) || tileSize <= 0) {
      throw new RangeError(`tileSize must be a positive safe integer, got ${tileSize}`);
    }
    this.tileSize = tileSize;
  }

  /** Signed tile coordinate containing one layer-local pixel coordinate. */
  public coordinateForPixel(value: number): number {
    if (!Number.isFinite(value)) {
      throw new RangeError(`pixel coordinate must be finite, got ${value}`);
    }
    const coordinate = normaliseZero(Math.floor(value / this.tileSize));
    this.assertCoordinate(coordinate);
    return coordinate;
  }

  public coordinateAt(x: number, y: number): TileCoord {
    return {
      x: this.coordinateForPixel(x),
      y: this.coordinateForPixel(y),
    };
  }

  /** Stable collision-free key; does not truncate coordinates to 32 bits. */
  public key(coord: TileCoord): string {
    this.assertCoord(coord);
    return `${normaliseZero(coord.x)},${normaliseZero(coord.y)}`;
  }

  /** Exact layer-local bounds occupied by a tile. */
  public boundsFor(coord: TileCoord): PixelBounds {
    this.assertCoord(coord);
    return {
      x: coord.x * this.tileSize,
      y: coord.y * this.tileSize,
      width: this.tileSize,
      height: this.tileSize,
    };
  }

  /** Inclusive signed tile range intersecting positive-area half-open bounds. */
  public rangeFor(bounds: PixelBounds): TileRange {
    assertBounds(bounds);

    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    if (!Number.isFinite(right) || !Number.isFinite(bottom)) {
      throw new RangeError("pixel bounds overflowed the finite coordinate plane");
    }

    const range = {
      minX: this.coordinateForPixel(bounds.x),
      minY: this.coordinateForPixel(bounds.y),
      maxX: normaliseZero(Math.ceil(right / this.tileSize) - 1),
      maxY: normaliseZero(Math.ceil(bottom / this.tileSize) - 1),
    };
    this.assertCoordinate(range.maxX);
    this.assertCoordinate(range.maxY);
    return range;
  }

  /** Number of tiles in a range, with overflow rejection before iteration. */
  public count(range: TileRange): number {
    this.assertRange(range);
    const width = range.maxX - range.minX + 1;
    const height = range.maxY - range.minY + 1;
    const count = width * height;
    if (!Number.isSafeInteger(count)) {
      throw new RangeError("tile range contains more entries than can be counted safely");
    }
    return count;
  }

  /** Deterministic row-major iteration: Y first, then X. */
  public *coordinates(bounds: PixelBounds): Generator<TileCoord> {
    const range = this.rangeFor(bounds);
    this.count(range);

    for (let y = range.minY; ; y += 1) {
      for (let x = range.minX; ; x += 1) {
        yield { x, y };
        if (x === range.maxX) break;
      }
      if (y === range.maxY) break;
    }
  }

  private assertRange(range: TileRange): void {
    this.assertCoordinate(range.minX);
    this.assertCoordinate(range.minY);
    this.assertCoordinate(range.maxX);
    this.assertCoordinate(range.maxY);
    if (range.maxX < range.minX || range.maxY < range.minY) {
      throw new RangeError("tile range must have inclusive maxima at or above its minima");
    }
  }

  private assertCoord(coord: TileCoord): void {
    this.assertCoordinate(coord.x);
    this.assertCoordinate(coord.y);
  }

  private assertCoordinate(value: number): void {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(value * this.tileSize)) {
      throw new RangeError(`tile coordinate is outside the safe integer plane: ${value}`);
    }
  }
}

function assertBounds(bounds: PixelBounds): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new RangeError(
      `pixel bounds must be finite with positive size, got (${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height})`,
    );
  }
}

function normaliseZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
