/**
 * sd-forge-ultra-paint -- BlendMode <-> PixiJS blend mode bridge.
 *
 * PixiJS v8 has NO runtime `BLEND_MODES` enum -- `BLEND_MODES` is a TypeScript
 * string-literal union only, and `container.blendMode` is assigned a plain
 * string. (Using `BLEND_MODES.ADD` the way v7 did throws at runtime.)
 *
 * Standard modes (`normal`, `add`, `multiply`, `screen`, `erase`, `min`, `max`)
 * are hardware GPU blend equations and are always available. The remaining four
 * -- `overlay`, `color-burn`, `color-dodge`, `hard-light` -- are *advanced*
 * blend modes implemented as filters. They need two things or they silently
 * fall back to `normal`:
 *
 *   1. The side-effect import below, which registers the blend extensions.
 *   2. `useBackBuffer: true` passed to `app.init()` (WebGL reads the back
 *      buffer to compute them; WebGPU enables it unconditionally).
 *
 * `UltraPaintApp` sets `useBackBuffer: true`, and also sets
 * `Filter.defaultOptions.resolution = "inherit"` so advanced blends are not
 * clipped/downscaled on high-DPI displays (their filter default resolution is
 * 1, which visibly breaks on retina render targets).
 */

// Side-effect import: registers OverlayBlend / ColorBurnBlend / ColorDodgeBlend
// / HardLightBlend etc. with the renderer. Must be imported for the advanced
// entries in the map below to do anything.
import "pixi.js/advanced-blend-modes";

import type { BLEND_MODES } from "pixi.js";

import type { BlendMode } from "../state/schema";

/**
 * Our schema's blend modes mapped onto PixiJS v8 blend mode strings.
 *
 * Every one of our modes happens to have a same-named PixiJS counterpart, so
 * this is currently an identity mapping -- but keeping it explicit means the
 * schema stays decoupled from PixiJS naming, and the compiler enforces that
 * every `BlendMode` variant has a real PixiJS target (the `Record` is total).
 */
export const BLEND_MODE_MAP: Record<BlendMode, BLEND_MODES> = {
  // --- standard (GPU blend equations, cheap) ---
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  add: "add",
  erase: "erase",
  min: "min", // WebGL2+ only
  max: "max", // WebGL2+ only

  // --- advanced (filter-backed; need the import above + useBackBuffer) ---
  overlay: "overlay",
  "color-burn": "color-burn",
  "color-dodge": "color-dodge",
  "hard-light": "hard-light",
};

/**
 * Blend modes that are implemented as filters rather than GPU blend equations.
 * Exposed so UI can warn about their cost, and so tests can assert the
 * back-buffer requirement.
 */
export const ADVANCED_BLEND_MODES: ReadonlySet<BlendMode> = new Set<BlendMode>([
  "overlay",
  "color-burn",
  "color-dodge",
  "hard-light",
]);

/** All blend modes, in a sensible order for a dropdown. */
export const BLEND_MODE_ORDER: readonly BlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "add",
  "color-burn",
  "color-dodge",
  "hard-light",
  "min",
  "max",
  "erase",
];

/** Translate a schema blend mode into the string PixiJS expects. */
export function toPixiBlendMode(mode: BlendMode): BLEND_MODES {
  return BLEND_MODE_MAP[mode] ?? "normal";
}

/** Narrowing helper for untrusted input (e.g. values coming back from Python). */
export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === "string" && value in BLEND_MODE_MAP;
}

/** True if `mode` needs the advanced-blend-modes filter path. */
export function isAdvancedBlendMode(mode: BlendMode): boolean {
  return ADVANCED_BLEND_MODES.has(mode);
}
