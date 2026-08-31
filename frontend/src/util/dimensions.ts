/** Maximum width or height accepted by Ultra Paint's monolithic textures. */
export const MAX_DIMENSION = 8192;

/** Clamp a finite numeric dimension to a renderable integer. */
export function clampDimension(value: number, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(1, Math.round(value)));
}

/** Keep a decoded image within the renderer's per-axis texture ceiling. */
export function fitDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError("Image dimensions must be finite positive numbers");
  }
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  return {
    width: clampDimension(width * scale),
    height: clampDimension(height * scale),
  };
}
