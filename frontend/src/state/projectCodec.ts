import { Rectangle, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";

import { extractStraightCanvas } from "../canvas/extractStraightCanvas";
import { getTileRendererCapabilities } from "../canvas/rendererCapabilities";
import { TiledRasterCanvas } from "../canvas/TiledRasterCanvas";
import type { TileVisit } from "../canvas/TiledRasterCanvas";
import { TileGrid } from "../canvas/TileGrid";
import type { LayerStore } from "./layerStore.svelte";
import type { ControlLayer, Document, ImageRef, Layer, LayerId, Transform } from "./schema";
import { isBlendMode } from "../util/blendModes";
import { MAX_DIMENSION } from "../util/dimensions";

export const PROJECT_FORMAT = "ultra-paint-project";
export const PROJECT_FORMAT_VERSION = 1;

export interface ProjectPixelAsset {
  layerId: LayerId;
  tileX: number;
  tileY: number;
  path: string;
}

export interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  formatVersion: number;
  createdWith: string;
  document: Document;
  pixelAssets: ProjectPixelAsset[];
}

export interface PortableProjectAsset {
  path: string;
  data: Uint8Array;
}

export interface EncodedPortableProject {
  manifest: ProjectManifest;
  assets: PortableProjectAsset[];
}

export interface DecodedPortableProject {
  document: Document;
  surfaces: Map<LayerId, TiledRasterCanvas>;
  unresolvedControlLayerIds: Set<LayerId>;
}

/**
 * Encode serializable metadata plus one PNG for every allocated tile.
 * Tiles are read and encoded one at a time so extraction never creates a
 * document-sized CPU image or a batch of simultaneous PNG encoders.
 */
export async function encodePortableDocument(
  renderer: Renderer,
  store: LayerStore,
  createdWith: string,
): Promise<EncodedPortableProject> {
  const document = JSON.parse(JSON.stringify(store.getDocument())) as Document;
  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    createdWith,
    document,
    pixelAssets: [],
  };
  const assets: PortableProjectAsset[] = [];
  let sequence = 0;

  for (const layer of document.layers) {
    if (layer.kind === "group") continue;
    const surface = store.getTiledSurface(layer.id);
    if (!surface) throw new Error(`Layer "${layer.name}" has no pixel surface.`);

    const tiles: TileVisit[] = [];
    surface.visitAll((tile) => tiles.push(tile));
    for (const tile of tiles) {
      const path = `pixels/${String(sequence).padStart(6, "0")}.png`;
      const canvas = extractStraightCanvas(renderer, {
        target: tile.target,
        frame: new Rectangle(0, 0, surface.tileSize, surface.tileSize),
        resolution: 1,
      });
      const blob = await canvasToPngBlob(canvas);
      assets.push({ path, data: new Uint8Array(await blob.arrayBuffer()) });
      manifest.pixelAssets.push({
        layerId: layer.id,
        tileX: tile.coord.x,
        tileY: tile.coord.y,
        path,
      });
      sequence += 1;
    }
  }

  return { manifest, assets };
}

/** Validate untrusted manifest JSON before any current-document mutation. */
export function validateProjectManifest(value: unknown): ProjectManifest {
  if (!isRecord(value)) throw new Error("Project manifest must be a JSON object.");
  if (value.format !== PROJECT_FORMAT) throw new Error("Not an Ultra Paint project file.");
  if (!Number.isInteger(value.formatVersion)) throw new Error("Project format version is missing.");
  if ((value.formatVersion as number) > PROJECT_FORMAT_VERSION) {
    throw new Error(
      `Project format version ${String(value.formatVersion)} is newer than this app supports.`,
    );
  }
  if ((value.formatVersion as number) < 1) throw new Error("Unsupported project format version.");
  if (typeof value.createdWith !== "string") throw new Error("Project creator version is missing.");

  const document = validateDocument(value.document);
  if (!Array.isArray(value.pixelAssets)) throw new Error("Project pixel asset list is missing.");
  const layers = new Map(document.layers.map((layer) => [layer.id, layer]));
  const assetKeys = new Set<string>();
  const paths = new Set<string>();
  const pixelAssets = value.pixelAssets.map((candidate, index): ProjectPixelAsset => {
    if (!isRecord(candidate)) throw new Error(`Pixel asset ${index} is invalid.`);
    const { layerId, tileX, tileY, path } = candidate;
    if (typeof layerId !== "string" || typeof path !== "string") {
      throw new Error(`Pixel asset ${index} has invalid identifiers.`);
    }
    const layer = layers.get(layerId);
    if (!layer || layer.kind === "group") {
      throw new Error(`Pixel asset ${index} refers to a non-paintable layer.`);
    }
    if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY)) {
      throw new Error(`Pixel asset ${index} has invalid tile coordinates.`);
    }
    const grid = new TileGrid(layer.image.tileSize);
    grid.boundsFor({ x: tileX as number, y: tileY as number });
    if (!/^pixels\/[0-9]+\.png$/.test(path)) {
      throw new Error(`Pixel asset ${index} has an invalid archive path.`);
    }
    const key = `${layerId}:${grid.key({ x: tileX as number, y: tileY as number })}`;
    if (assetKeys.has(key)) throw new Error(`Pixel asset ${index} duplicates a layer tile.`);
    if (paths.has(path)) throw new Error(`Pixel asset ${index} duplicates an archive path.`);
    assetKeys.add(key);
    paths.add(path);
    return { layerId, tileX: tileX as number, tileY: tileY as number, path };
  });

  return {
    format: PROJECT_FORMAT,
    formatVersion: value.formatVersion as number,
    createdWith: value.createdWith,
    document,
    pixelAssets,
  };
}

/**
 * Decode every PNG into temporary, codec-owned tiled surfaces. The caller
 * adopts the returned surfaces only after this function succeeds completely.
 */
export async function decodePortableDocument(
  renderer: Renderer,
  manifestValue: unknown,
  readAsset: (path: string) => Uint8Array | undefined,
  controlModels: readonly string[],
): Promise<DecodedPortableProject> {
  const manifest = validateProjectManifest(manifestValue);
  const surfaces = new Map<LayerId, TiledRasterCanvas>();
  const capabilities = getTileRendererCapabilities(renderer);

  try {
    for (const layer of manifest.document.layers) {
      if (layer.kind === "group") continue;
      if (
        capabilities.maxTextureDimension2D !== null &&
        layer.image.tileSize > capabilities.maxTextureDimension2D
      ) {
        throw new Error(
          `Layer "${layer.name}" uses ${layer.image.tileSize}px tiles, larger than this renderer supports.`,
        );
      }
      surfaces.set(layer.id, new TiledRasterCanvas(renderer, layer.image.tileSize));
    }

    const byLayer = new Map<LayerId, ProjectPixelAsset[]>();
    for (const asset of manifest.pixelAssets) {
      const list = byLayer.get(asset.layerId) ?? [];
      list.push(asset);
      byLayer.set(asset.layerId, list);
    }

    for (const layer of manifest.document.layers) {
      if (layer.kind === "group") continue;
      const surface = surfaces.get(layer.id)!;
      const transaction = surface.beginEdit("open-project");
      try {
        for (const asset of byLayer.get(layer.id) ?? []) {
          const bytes = readAsset(asset.path);
          if (!bytes) throw new Error(`Project is missing "${asset.path}".`);
          const texture = await decodePngTexture(bytes, layer.image.tileSize, asset.path);
          try {
            const originX = asset.tileX * surface.tileSize;
            const originY = asset.tileY * surface.tileSize;
            surface.edit(
              {
                x: originX,
                y: originY,
                width: surface.tileSize,
                height: surface.tileSize,
              },
              { allocation: "allocate-missing", transaction },
              (tile) => {
                const sprite = new Sprite({ texture });
                try {
                  renderer.render({
                    container: sprite,
                    target: tile.target,
                    clear: true,
                    clearColor: [0, 0, 0, 0],
                  });
                } finally {
                  sprite.destroy({ texture: false, textureSource: false });
                }
              },
            );
          } finally {
            texture.destroy(true);
          }
        }
        transaction.replaceBounds(layer.image.bounds);
        transaction.commit().destroy();
      } catch (error) {
        if (transaction.active) transaction.rollback();
        throw error;
      }
    }

    const knownModels = new Set(controlModels);
    const unresolvedControlLayerIds = new Set(
      manifest.document.layers
        .filter(
          (layer): layer is ControlLayer =>
            layer.kind === "control" && layer.model !== "None" && !knownModels.has(layer.model),
        )
        .map((layer) => layer.id),
    );
    return {
      document: manifest.document,
      surfaces,
      unresolvedControlLayerIds,
    };
  } catch (error) {
    for (const surface of surfaces.values()) surface.destroy();
    throw error;
  }
}

function validateDocument(value: unknown): Document {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Project document is invalid.");
  }
  const boundaryBox = validateBounds(value.boundaryBox, "Document boundary box");
  if (boundaryBox.width > MAX_DIMENSION || boundaryBox.height > MAX_DIMENSION) {
    throw new Error(`Document boundary box exceeds ${MAX_DIMENSION}px.`);
  }
  if (!Array.isArray(value.layers) || !Array.isArray(value.layerOrder)) {
    throw new Error("Project layer lists are invalid.");
  }
  const layers = value.layers.map((candidate, index) => validateLayer(candidate, index));
  const byId = new Map<LayerId, Layer>();
  for (const layer of layers) {
    if (byId.has(layer.id)) throw new Error(`Duplicate layer id "${layer.id}".`);
    byId.set(layer.id, layer);
  }

  const rootOrder = validateOrder(value.layerOrder, "root layer order", byId);
  const placements = new Map<LayerId, string>();
  for (const id of rootOrder) {
    const layer = byId.get(id)!;
    if (layer.parentId !== null) throw new Error(`Root order contains child layer "${id}".`);
    placements.set(id, "root");
  }
  for (const layer of layers) {
    if (layer.parentId !== null) {
      const parent = byId.get(layer.parentId);
      if (!parent || parent.kind !== "group") {
        throw new Error(`Layer "${layer.id}" has an invalid parent.`);
      }
    }
    if (layer.kind !== "group") continue;
    for (const id of layer.children) {
      const child = byId.get(id);
      if (!child) throw new Error(`Group "${layer.id}" refers to unknown layer "${id}".`);
      if (child.parentId !== layer.id) {
        throw new Error(`Group "${layer.id}" contains a layer with a different parent.`);
      }
      if (placements.has(id)) throw new Error(`Layer "${id}" appears more than once in ordering.`);
      placements.set(id, layer.id);
    }
  }
  if (placements.size !== layers.length)
    throw new Error("Every layer must appear once in ordering.");

  for (const layer of layers) {
    const seen = new Set<LayerId>();
    let current: Layer | undefined = layer;
    while (current) {
      if (current.parentId === null) break;
      if (seen.has(current.id))
        throw new Error(`Layer hierarchy contains a cycle at "${layer.id}".`);
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
  }
  return { id: value.id, boundaryBox, layers, layerOrder: rootOrder };
}

function validateLayer(value: unknown, index: number): Layer {
  if (!isRecord(value)) throw new Error(`Layer ${index} is invalid.`);
  const kinds = new Set(["raster", "group", "mask", "control"]);
  if (typeof value.kind !== "string" || !kinds.has(value.kind)) {
    throw new Error(`Layer ${index} has an unknown kind.`);
  }
  if (typeof value.id !== "string" || value.id.length === 0 || typeof value.name !== "string") {
    throw new Error(`Layer ${index} has invalid identity fields.`);
  }
  for (const key of ["visible", "locked", "preserveAlpha"] as const) {
    if (typeof value[key] !== "boolean") throw new Error(`Layer "${value.id}" has invalid ${key}.`);
  }
  if (
    typeof value.opacity !== "number" ||
    !Number.isFinite(value.opacity) ||
    value.opacity < 0 ||
    value.opacity > 1
  ) {
    throw new Error(`Layer "${value.id}" has invalid opacity.`);
  }
  if (!isBlendMode(value.blendMode))
    throw new Error(`Layer "${value.id}" has an unknown blend mode.`);
  const transform = validateTransform(value.transform, value.id);
  const parentId = value.parentId;
  if (parentId !== null && typeof parentId !== "string") {
    throw new Error(`Layer "${value.id}" has an invalid parent id.`);
  }

  const base = {
    id: value.id,
    name: value.name,
    kind: value.kind,
    visible: value.visible as boolean,
    locked: value.locked as boolean,
    preserveAlpha: value.preserveAlpha as boolean,
    opacity: value.opacity,
    blendMode: value.blendMode,
    transform,
    parentId,
    ...(Object.hasOwn(value, "mask") ? { mask: value.mask } : {}),
  };
  if (value.kind === "group") {
    return {
      ...base,
      kind: "group",
      children: validateStringArray(value.children, `Group "${value.id}" children`),
    };
  }

  const image = validateImageRef(value.image, value.id);
  if (value.kind === "raster") return { ...base, kind: "raster", image };
  if (value.kind === "mask") {
    if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) {
      throw new Error(`Mask layer "${value.id}" has an invalid color.`);
    }
    return { ...base, kind: "mask", image, color: value.color };
  }

  if (
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    !finiteInRange(value.weight, 0, 2) ||
    !finiteInRange(value.guidanceStart, 0, 1) ||
    !finiteInRange(value.guidanceEnd, 0, 1) ||
    (value.guidanceStart as number) > (value.guidanceEnd as number) ||
    !["balanced", "prompt", "control"].includes(String(value.controlMode)) ||
    typeof value.pixelPerfect !== "boolean" ||
    !["resize", "crop", "fill"].includes(String(value.resizeMode))
  ) {
    throw new Error(`Control layer "${value.id}" has invalid parameters.`);
  }
  return {
    ...base,
    kind: "control",
    image,
    model: value.model,
    weight: value.weight as number,
    guidanceStart: value.guidanceStart as number,
    guidanceEnd: value.guidanceEnd as number,
    controlMode: value.controlMode as ControlLayer["controlMode"],
    pixelPerfect: value.pixelPerfect,
    resizeMode: value.resizeMode as ControlLayer["resizeMode"],
  };
}

function validateTransform(value: unknown, layerId: string): Transform {
  if (!isRecord(value)) throw new Error(`Layer "${layerId}" has an invalid transform.`);
  const keys = ["x", "y", "scaleX", "scaleY", "rotation"] as const;
  if (keys.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
    throw new Error(`Layer "${layerId}" has a non-finite transform.`);
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as Transform;
}

function validateImageRef(value: unknown, layerId: string): ImageRef {
  if (!isRecord(value) || !["upload", "generated", "paint"].includes(String(value.source))) {
    throw new Error(`Layer "${layerId}" has invalid image metadata.`);
  }
  if (
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    (value.width as number) < 0 ||
    (value.height as number) < 0
  ) {
    throw new Error(`Layer "${layerId}" has invalid image dimensions.`);
  }
  if (!Number.isSafeInteger(value.tileSize) || (value.tileSize as number) <= 0) {
    throw new Error(`Layer "${layerId}" has invalid tile size.`);
  }
  const bounds =
    value.bounds === null ? null : validateBounds(value.bounds, `Layer "${layerId}" bounds`);
  if ((bounds?.width ?? 0) !== value.width || (bounds?.height ?? 0) !== value.height) {
    throw new Error(`Layer "${layerId}" image dimensions do not match its bounds.`);
  }
  return {
    source: value.source as ImageRef["source"],
    width: value.width as number,
    height: value.height as number,
    tileSize: value.tileSize as number,
    bounds,
  };
}

function validateBounds(
  value: unknown,
  label: string,
): { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  const { x, y, width, height } = value;
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    !Number.isSafeInteger((x as number) + (width as number)) ||
    !Number.isSafeInteger((y as number) + (height as number))
  ) {
    throw new Error(`${label} must contain finite, positive, safe-integer bounds.`);
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function validateOrder(
  value: unknown,
  label: string,
  layers: ReadonlyMap<LayerId, Layer>,
): LayerId[] {
  const ids = validateStringArray(value, label);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!layers.has(id)) throw new Error(`${label} refers to unknown layer "${id}".`);
    if (seen.has(id)) throw new Error(`${label} contains duplicate layer "${id}".`);
    seen.add(id);
  }
  return ids;
}

function validateStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return [...value] as string[];
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function canvasToPngBlob(canvas: unknown): Promise<Blob> {
  const candidate = canvas as {
    toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void;
    convertToBlob?: (options?: { type?: string }) => Promise<Blob>;
  };
  if (typeof candidate.toBlob === "function") {
    return await new Promise<Blob>((resolve, reject) => {
      candidate.toBlob!(
        (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))),
        "image/png",
      );
    });
  }
  if (typeof candidate.convertToBlob === "function") {
    return await candidate.convertToBlob({ type: "image/png" });
  }
  throw new Error("Renderer returned an unsupported extraction canvas.");
}

async function decodePngTexture(
  bytes: Uint8Array,
  tileSize: number,
  path: string,
): Promise<Texture> {
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width !== tileSize || bitmap.height !== tileSize) {
      bitmap.close();
      throw new Error(`Pixel asset "${path}" has the wrong dimensions.`);
    }
    return Texture.from(bitmap, true);
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Could not decode pixel asset "${path}".`));
      element.src = url;
    });
    if (image.naturalWidth !== tileSize || image.naturalHeight !== tileSize) {
      throw new Error(`Pixel asset "${path}" has the wrong dimensions.`);
    }
    return Texture.from(image, true);
  } finally {
    URL.revokeObjectURL(url);
  }
}
