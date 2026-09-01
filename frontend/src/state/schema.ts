/**
 * sd-forge-ultra-paint -- document / layer data model.
 *
 * This is the finalised serialisable shape that every later phase (layer panel
 * UI, Python bridge, masking, ControlNet) builds on. Two rules matter:
 *
 *  1. Nothing in here holds a live PixiJS object. `ImageRef` is metadata only;
 *     the actual `Texture` lives in a side-map on the store. That keeps the
 *     document JSON-serialisable in spirit even though nothing is serialised
 *     yet this phase.
 *  2. `Document.layers` is a FLAT array. The tree is encoded by `parentId` plus
 *     the ordered id lists (`Document.layerOrder` for the root, and
 *     `GroupLayer.children` for groups). There is no nested serialisation.
 */

import type { PixelBounds } from "../canvas/TileGrid";

/** Opaque per-layer identifier. Unique within a document. */
export type LayerId = string;

/**
 * Compositing mode for a layer.
 *
 * `overlay`, `color-burn`, `color-dodge` and `hard-light` are PixiJS *advanced*
 * blend modes: they are filter-backed and require both the
 * `pixi.js/advanced-blend-modes` import and `useBackBuffer: true` at renderer
 * init. See `util/blendModes.ts`.
 */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "add"
  | "erase"
  | "min"
  | "max"
  | "color-burn"
  | "color-dodge"
  | "hard-light";

/** Affine placement of a layer inside its parent's coordinate space. */
export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Radians (PixiJS `Container.rotation` units), not degrees. */
  rotation: number;
}

/**
 * Layer discriminant.
 *
 * Deliberately a string union rather than an enum so that later phases can add
 * `"shape"` / `"adjustment"` variants without a breaking change. `"shape"` is
 * reserved and intentionally NOT implemented in this phase.
 */
export type LayerKind = "raster" | "group" | "mask" | "control";

/** Fields shared by every layer variant. */
export interface LayerBase {
  id: LayerId;
  name: string;
  kind: LayerKind;
  visible: boolean;
  /** Blocks paint strokes and fills on this layer while true. */
  locked: boolean;
  /** Photoshop-style "lock transparent pixels": brush strokes cannot extend past existing alpha. */
  preserveAlpha: boolean;
  /** 0-1, maps to PixiJS `Container.alpha`. */
  opacity: number;
  blendMode: BlendMode;
  transform: Transform;
  /** `null` means the layer sits at the document root. */
  parentId: LayerId | null;
  /** Reserved for a future masking phase. Not implemented. */
  mask?: unknown;
}

/**
 * `balanced` / `prompt` / `control` mirror Forge ControlNet's `ControlMode`
 * enum (`BALANCED` / `MY_PROMPT_IS_MORE_IMPORTANT` / `CONTROL_IS_MORE_IMPORTANT`).
 * Kept as a frontend-friendly string union; the backend maps it by name.
 */
export type ControlMode = "balanced" | "prompt" | "control";

/** Mirrors Forge ControlNet's `ResizeMode` enum, frontend-friendly names. */
export type ControlResizeMode = "resize" | "crop" | "fill";

/** A pixel layer backed by a texture registered in the store's texture map. */
export interface RasterLayer extends LayerBase {
  kind: "raster";
  image: ImageRef;
}

/** Paintable alpha coverage exported as an inpainting mask. */
export interface MaskLayer extends LayerBase {
  kind: "mask";
  image: ImageRef;
  /** CSS six-digit hex color used only by the on-canvas hatch display. */
  color: string;
}

/** A container layer. Draws nothing itself; composites its children. */
export interface GroupLayer extends LayerBase {
  kind: "group";
  /** Ordered child ids. Index 0 is the TOP of the stack within the group. */
  children: LayerId[];
}

/**
 * A control-guidance layer (ControlNet). Its `image` is the exact pixels sent
 * to Forge's ControlNet script, pre-baked by the Filter tool or painted directly
 * on the layer.
 */
export interface ControlLayer extends LayerBase {
  kind: "control";
  image: ImageRef;
  /** ControlNet model name, from `GET /controlnet/control_types`. */
  model: string;
  weight: number;
  guidanceStart: number;
  guidanceEnd: number;
  controlMode: ControlMode;
  pixelPerfect: boolean;
  resizeMode: ControlResizeMode;
}

export type Layer = RasterLayer | GroupLayer | MaskLayer | ControlLayer;

/** Layer variants backed by a paintable texture. */
export type PaintLayer = RasterLayer | MaskLayer | ControlLayer;

/**
 * Metadata about a raster layer's pixels. Deliberately does NOT carry a
 * `RenderTexture` handle -- look the texture up via `LayerStore.getTexture(id)`.
 */
export interface ImageRef {
  source: "upload" | "generated" | "paint";
  width: number;
  height: number;
  /** Present when the layer's pixels live in a sparse `TiledRasterCanvas` rather than one `RenderTexture`. */
  storage?: "tiled";
  /** Tiled backing's immutable tile edge length; omitted for monolithic textures. */
  tileSize?: number;
  /**
   * Layer-local logical bounds for tiled pixels. Unlike width/height, this
   * retains negative origins after a layer grows up or left of local (0, 0).
   * `null` represents a truly empty tiled layer.
   */
  bounds?: PixelBounds | null;
}

/** The fully populated metadata shape for a `TiledRasterCanvas`-backed layer. */
export interface TiledImageRef extends ImageRef {
  storage: "tiled";
  tileSize: number;
  bounds: PixelBounds | null;
}

/** Editable document-space operating region used by fill and generation. */
export interface BoundaryBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The whole editable document. */
export interface Document {
  id: string;
  boundaryBox: BoundaryBox;
  /** FLAT array -- `parentId` encodes the tree, not nested serialisation. */
  layers: Layer[];
  /** Root-level stacking order. Index 0 is the TOP of the stack. */
  layerOrder: LayerId[];
}
