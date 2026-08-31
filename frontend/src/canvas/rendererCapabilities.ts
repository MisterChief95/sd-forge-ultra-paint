import type { Renderer } from "pixi.js";

export const PREFERRED_TILE_SIZE = 1024;

export type RendererBackend = "webgl" | "webgpu" | "canvas" | "unknown";

export interface TileRendererCapabilities {
  backend: RendererBackend;
  rendererName: string;
  /** Null when the active backend exposes no reliable 2D texture limit. */
  maxTextureDimension2D: number | null;
  /** Null when no device-safe tile size can be negotiated. */
  selectedTileSize: number | null;
}

/** Largest power-of-two tile no greater than both the device and preference. */
export function selectTileSize(
  maxTextureDimension2D: number,
  preferred = PREFERRED_TILE_SIZE,
  minimum = 1,
): number {
  for (const [name, value] of [
    ["maxTextureDimension2D", maxTextureDimension2D],
    ["preferred", preferred],
    ["minimum", minimum],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
    }
  }

  const capped = Math.min(maxTextureDimension2D, preferred);
  const selected = 2 ** Math.floor(Math.log2(capped));
  if (selected < minimum) {
    throw new RangeError(
      `renderer limit ${maxTextureDimension2D} cannot support minimum tile size ${minimum}`,
    );
  }
  return selected;
}

/**
 * Read the active backend's real texture limit without reaching through
 * undocumented PixiJS systems. Canvas has no reliable cross-browser query, so
 * it is reported explicitly instead of receiving a guessed safe dimension.
 */
export function getTileRendererCapabilities(renderer: Renderer): TileRendererCapabilities {
  if ("gl" in renderer) {
    const maxTextureDimension2D = renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE) as number;
    return {
      backend: "webgl",
      rendererName: renderer.name,
      maxTextureDimension2D,
      selectedTileSize: selectTileSize(maxTextureDimension2D),
    };
  }

  if ("gpu" in renderer) {
    const maxTextureDimension2D = renderer.gpu.device.limits.maxTextureDimension2D;
    return {
      backend: "webgpu",
      rendererName: renderer.name,
      maxTextureDimension2D,
      selectedTileSize: selectTileSize(maxTextureDimension2D),
    };
  }

  const rendererName = renderer.name ?? "unknown";
  return {
    backend: rendererName.toLowerCase().includes("canvas") ? "canvas" : "unknown",
    rendererName,
    maxTextureDimension2D: null,
    selectedTileSize: null,
  };
}
