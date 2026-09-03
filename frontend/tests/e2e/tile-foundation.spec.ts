import { expect, test } from "@playwright/test";

import { TileGrid } from "../../src/canvas/TileGrid";
import { selectTileSize } from "../../src/canvas/rendererCapabilities";

test.describe("tile canvas foundation", () => {
  test("uses signed floor coordinates and half-open tile ranges", () => {
    const grid = new TileGrid(1024);

    expect(grid.coordinateForPixel(-1024.01)).toBe(-2);
    expect(grid.coordinateForPixel(-1024)).toBe(-1);
    expect(grid.coordinateForPixel(-0.01)).toBe(-1);
    expect(grid.coordinateForPixel(0)).toBe(0);
    expect(grid.coordinateForPixel(1024)).toBe(1);

    expect(grid.rangeFor({ x: 0, y: 0, width: 1024, height: 1024 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    });
    expect(grid.rangeFor({ x: -1024, y: -1024, width: 1024, height: 1024 })).toEqual({
      minX: -1,
      minY: -1,
      maxX: -1,
      maxY: -1,
    });
    expect(grid.rangeFor({ x: -1, y: -1, width: 2, height: 2 })).toEqual({
      minX: -1,
      minY: -1,
      maxX: 0,
      maxY: 0,
    });
  });

  test("iterates deterministically and uses collision-free signed keys", () => {
    const grid = new TileGrid(16);
    const coords = [...grid.coordinates({ x: -1, y: -1, width: 18, height: 18 })];

    expect(coords).toEqual([
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: -1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    expect(new Set(coords.map((coord) => grid.key(coord))).size).toBe(coords.length);
    expect(grid.key({ x: -3, y: 12 })).toBe("-3,12");
  });

  test("rejects invalid and imprecise coordinate ranges", () => {
    expect(() => new TileGrid(0)).toThrow(/positive safe integer/);
    const grid = new TileGrid(1024);

    expect(() => grid.coordinateForPixel(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => grid.rangeFor({ x: 0, y: 0, width: 0, height: 1 })).toThrow(/positive size/);
    expect(() => grid.boundsFor({ x: Number.MAX_SAFE_INTEGER, y: 0 })).toThrow(
      /safe integer plane/,
    );
  });

  test("negotiates the largest supported power-of-two tile", () => {
    expect(selectTileSize(16384)).toBe(1024);
    expect(selectTileSize(1024)).toBe(1024);
    expect(selectTileSize(1023)).toBe(512);
    expect(selectTileSize(768)).toBe(512);
    expect(() => selectTileSize(255, 1024, 256)).toThrow(/cannot support minimum/);
  });
});
