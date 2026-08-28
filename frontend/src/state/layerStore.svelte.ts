/**
 * Rune-backed document store with a dual API: Svelte consumers read the public
 * getters for fine-grained reactivity, while PixiJS/history consumers keep using
 * subscribe()/subscribeMutations(). Both paths observe the same rune state; the
 * listener sets are notifications only and do not duplicate document state.
 * Live RenderTextures stay in a $state.raw Map so Svelte never proxies PixiJS.
 */

import { RenderTexture } from "pixi.js";

import type {
  BoundaryBox,
  BlendMode,
  ControlLayer,
  ControlMode,
  ControlResizeMode,
  Document,
  GroupLayer,
  ImageRef,
  Layer,
  LayerId,
  MaskLayer,
  PaintLayer,
  RasterLayer,
  Transform,
} from "./schema";

/** Subscriber signature. Receives the document state *after* the mutation. */
export type Listener = (doc: Document) => void;

/** Unsubscribe handle returned by {@link LayerStore.subscribe}. */
export type Unsubscribe = () => void;

/** Document mutation details consumed by undo/redo history. */
export type LayerStoreMutation =
  | { kind: "add-layer"; layerId: LayerId }
  | { kind: "remove-layer"; layerIds: readonly LayerId[] }
  | {
      kind: "reorder-layer";
      layerId: LayerId;
      previous: number;
      next: number;
    }
  | {
      kind: "set-opacity";
      layerId: LayerId;
      previous: number;
      next: number;
    }
  | {
      kind: "set-blend-mode";
      layerId: LayerId;
      previous: BlendMode;
      next: BlendMode;
    }
  | {
      kind: "set-visible";
      layerId: LayerId;
      previous: boolean;
      next: boolean;
    }
  | {
      kind: "set-locked";
      layerId: LayerId;
      previous: boolean;
      next: boolean;
    }
  | {
      kind: "set-preserve-alpha";
      layerId: LayerId;
      previous: boolean;
      next: boolean;
    }
  | {
      kind: "set-name";
      layerId: LayerId;
      previous: string;
      next: string;
    }
  | {
      kind: "set-transform";
      layerId: LayerId;
      previous: Transform;
      next: Transform;
    }
  | {
      kind: "set-boundary-box";
      previous: BoundaryBox;
      next: BoundaryBox;
    }
  | { kind: "clear" };

/** Subscriber for undoable document mutations. */
export type MutationListener = (mutation: LayerStoreMutation) => void;

/** Identity transform for a freshly created layer. */
function identityTransform(): Transform {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
}

const DEFAULT_MASK_COLOR = "#ff4d4d";

function normaliseHexColor(color: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

type Point = { x: number; y: number };

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

const IDENTITY_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function matrixForTransform(transform: Transform): Matrix {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    a: cos * transform.scaleX,
    b: sin * transform.scaleX,
    c: -sin * transform.scaleY,
    d: cos * transform.scaleY,
    tx: transform.x,
    ty: transform.y,
  };
}

/** Compose `parent` then `child`, matching PixiJS container transforms. */
function multiplyMatrices(parent: Matrix, child: Matrix): Matrix {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
  };
}

function transformPoint(matrix: Matrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
    y: matrix.b * point.x + matrix.d * point.y + matrix.ty,
  };
}

function clipPolygon(
  points: Point[],
  inside: (point: Point) => boolean,
  intersection: (from: Point, to: Point) => Point,
): Point[] {
  const clipped: Point[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index]!;
    const to = points[(index + 1) % points.length]!;
    const fromInside = inside(from);
    const toInside = inside(to);
    if (fromInside && toInside) clipped.push(to);
    else if (fromInside) clipped.push(intersection(from, to));
    else if (toInside) clipped.push(intersection(from, to), to);
  }
  return clipped;
}

/** True when the transformed rectangle shares non-zero area with `box`. */
function intersectsBox(width: number, height: number, matrix: Matrix, box: BoundaryBox): boolean {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    width <= 0 ||
    height <= 0 ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return false;
  }
  let polygon = [
    transformPoint(matrix, { x: 0, y: 0 }),
    transformPoint(matrix, { x: width, y: 0 }),
    transformPoint(matrix, { x: width, y: height }),
    transformPoint(matrix, { x: 0, y: height }),
  ];
  const clipX =
    (x: number) =>
    (from: Point, to: Point): Point => {
      const ratio = (x - from.x) / (to.x - from.x);
      return { x, y: from.y + (to.y - from.y) * ratio };
    };
  const clipY =
    (y: number) =>
    (from: Point, to: Point): Point => {
      const ratio = (y - from.y) / (to.y - from.y);
      return { x: from.x + (to.x - from.x) * ratio, y };
    };
  polygon = clipPolygon(polygon, (point) => point.x >= box.x, clipX(box.x));
  polygon = clipPolygon(polygon, (point) => point.x <= box.x + box.width, clipX(box.x + box.width));
  polygon = clipPolygon(polygon, (point) => point.y >= box.y, clipY(box.y));
  polygon = clipPolygon(
    polygon,
    (point) => point.y <= box.y + box.height,
    clipY(box.y + box.height),
  );
  if (polygon.length < 3) return false;

  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index]!;
    const to = polygon[(index + 1) % polygon.length]!;
    twiceArea += from.x * to.y - to.x * from.y;
  }
  return Math.abs(twiceArea) > 0;
}

/**
 * `crypto.randomUUID()` where available, with a fallback for insecure LAN
 * deployments where the API is unavailable.
 */
function newId(prefix: string): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    return `${prefix}-${c.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build the empty starting document. */
function createEmptyDocument(width: number, height: number): Document {
  return {
    id: newId("doc"),
    boundaryBox: { x: 0, y: 0, width, height },
    layers: [],
    layerOrder: [],
  };
}

export class LayerStore {
  /** Deep reactive because this graph contains serializable plain data only. */
  private _document = $state<Document>(createEmptyDocument(1024, 1024));

  /**
   * Live GPU objects must retain their exact identity. This Map is intentionally
   * raw: callers observe texture changes through store methods, not rune reads.
   */
  private readonly _textures = $state.raw(new Map<LayerId, RenderTexture>());

  private readonly listeners = new Set<Listener>();

  private readonly mutationListeners = new Set<MutationListener>();

  private _selectedLayerId = $state<LayerId | null>(null);

  private _selectedLayerIds = $state<LayerId[]>([]);

  /** Bumped by {@link touchTexture} whenever a layer's pixels change in place, for thumbnail cache invalidation. */
  private _textureVersions = $state<Record<LayerId, number>>({});

  constructor(width = 1024, height = 1024) {
    this._document = createEmptyDocument(width, height);
  }

  // ---------------------------------------------------------------- reads

  /** Reactive document getter for Svelte consumers. Treat as immutable. */
  public get document(): Readonly<Document> {
    return this._document;
  }

  /** Reactive selection getter for Svelte consumers. */
  public get selectedLayerId(): LayerId | null {
    return this._selectedLayerId;
  }

  /** Reactive multi-selection getter for layer-panel consumers. */
  public get selectedLayerIds(): readonly LayerId[] {
    return this._selectedLayerIds;
  }

  /** Whether an effectively visible raster layer has positive-area BB overlap. */
  public get hasVisibleRasterContent(): boolean {
    const layers = new Map(this._document.layers.map((layer) => [layer.id, layer]));
    return this._document.layers.some((layer) => {
      if (layer.kind !== "raster" || !this.isEffectivelyVisible(layer, layers)) {
        return false;
      }
      return intersectsBox(
        layer.image.width,
        layer.image.height,
        this.worldMatrixFor(layer, layers),
        this._document.boundaryBox,
      );
    });
  }

  /** Legacy method form retained for PixiJS-facing and non-Svelte consumers. */
  public getDocument(): Readonly<Document> {
    return this._document;
  }

  public getLayer(id: LayerId): Layer | undefined {
    return this._document.layers.find((layer) => layer.id === id);
  }

  public getSelectedLayerId(): LayerId | null {
    return this._selectedLayerId;
  }

  public getSelectedLayerIds(): readonly LayerId[] {
    return this._selectedLayerIds;
  }

  /** The live paintable texture for a raster layer, if one is registered. */
  public getTexture(id: LayerId): RenderTexture | undefined {
    return this._textures.get(id);
  }

  /** Reactive change counter for a layer's texture; bumped by {@link touchTexture}. */
  public getTextureVersion(id: LayerId): number {
    return this._textureVersions[id] ?? 0;
  }

  /**
   * Mark a layer's texture as freshly painted, without touching document
   * state. Not a {@link LayerStoreMutation} -- purely a cache-invalidation
   * signal for UI (e.g. layer thumbnails) to observe.
   */
  public touchTexture(id: LayerId): void {
    if (!this.getLayer(id)) return;
    this._textureVersions = {
      ...this._textureVersions,
      [id]: (this._textureVersions[id] ?? 0) + 1,
    };
  }

  /**
   * The ordered sibling id list that `id` lives in: the document root order
   * when the layer is top-level, or its parent group's `children` otherwise.
   */
  public getSiblingOrder(id: LayerId): LayerId[] | undefined {
    const layer = this.getLayer(id);
    if (!layer) return undefined;
    if (layer.parentId === null) return this._document.layerOrder;
    const parent = this.getLayer(layer.parentId);
    if (!parent || parent.kind !== "group") return undefined;
    return parent.children;
  }

  // ------------------------------------------------------------ mutations

  /** Select an existing layer, or clear selection with `null`. */
  public setSelectedLayerId(id: LayerId | null): void {
    const next = id !== null && this.getLayer(id) ? id : null;
    const nextIds = next === null ? [] : [next];
    if (
      this._selectedLayerId === next &&
      this._selectedLayerIds.length === nextIds.length &&
      this._selectedLayerIds.every((selected, index) => selected === nextIds[index])
    ) {
      return;
    }
    this._selectedLayerId = next;
    this._selectedLayerIds = nextIds;
    this.emit();
  }

  /** Replace selection with existing layer ids; the last id is primary. */
  public setSelectedLayerIds(ids: readonly LayerId[]): void {
    const live = new Set(this._document.layers.map((layer) => layer.id));
    const next = [...new Set(ids)].filter((id) => live.has(id));
    const primary = next[next.length - 1] ?? null;
    if (
      this._selectedLayerId === primary &&
      this._selectedLayerIds.length === next.length &&
      this._selectedLayerIds.every((id, index) => id === next[index])
    ) {
      return;
    }
    this._selectedLayerId = primary;
    this._selectedLayerIds = next;
    this.emit();
  }

  /** Toggle one existing layer in the current selection. */
  public toggleSelectedLayerId(id: LayerId): void {
    if (!this.getLayer(id)) return;
    const next = this._selectedLayerIds.includes(id)
      ? this._selectedLayerIds.filter((selected) => selected !== id)
      : [...this._selectedLayerIds, id];
    this._selectedLayerIds = next;
    this._selectedLayerId = next[next.length - 1] ?? null;
    this.emit();
  }

  /**
   * Create a raster layer at the top (index 0) of the root stack.
   *
   * If the document is still empty (no layers yet -- the common "start a
   * new canvas from an uploaded/generated image" path), the document is
   * auto-sized to this layer's dimensions first. Without this, the
   * document stayed at its 1024x1024 construction default forever (no UI
   * exists yet to resize it -- PLAN.md Phase 2.5 item 1), which silently
   * cropped/misaligned every composite sent to img2img against whatever
   * arbitrary size the canvas happened to start at.
   */
  public addRasterLayer(
    texture: RenderTexture,
    name?: string,
    source: ImageRef["source"] = "upload",
  ): LayerId {
    if (this._document.layers.length === 0) {
      this._document.boundaryBox = {
        x: 0,
        y: 0,
        width: texture.width,
        height: texture.height,
      };
    }

    const id = newId("layer");
    const layer: RasterLayer = {
      id,
      name: name ?? `Layer ${this._document.layers.length + 1}`,
      kind: "raster",
      visible: true,
      locked: false,
      preserveAlpha: false,
      opacity: 1,
      blendMode: "normal",
      transform: identityTransform(),
      parentId: null,
      image: {
        source,
        width: texture.width,
        height: texture.height,
      },
    };

    this._textures.set(id, texture);
    this._document.layers.push(layer);
    this._document.layerOrder.unshift(id);
    this.emit();
    this.emitMutation({ kind: "add-layer", layerId: id });
    return id;
  }

  /** Create an empty group at the top of the root stack. */
  public addGroupLayer(name?: string): LayerId {
    const id = newId("group");
    const layer: GroupLayer = {
      id,
      name: name ?? `Group ${this._document.layers.length + 1}`,
      kind: "group",
      visible: true,
      locked: false,
      preserveAlpha: false,
      opacity: 1,
      blendMode: "normal",
      transform: identityTransform(),
      parentId: null,
      children: [],
    };

    this._document.layers.push(layer);
    this._document.layerOrder.unshift(id);
    this.emit();
    this.emitMutation({ kind: "add-layer", layerId: id });
    return id;
  }

  /** Create a transparent, boundary-box-sized paintable mask layer. */
  public addMaskLayer(name?: string, color = DEFAULT_MASK_COLOR): LayerId {
    const box = this._document.boundaryBox;
    const id = newId("mask");
    const texture = RenderTexture.create({
      width: box.width,
      height: box.height,
      resolution: 1,
      antialias: false,
    });
    const layer: MaskLayer = {
      id,
      name:
        name ??
        `Mask ${this._document.layers.filter((candidate) => candidate.kind === "mask").length + 1}`,
      kind: "mask",
      visible: true,
      locked: false,
      preserveAlpha: false,
      opacity: 1,
      blendMode: "normal",
      transform: {
        ...identityTransform(),
        x: box.x,
        y: box.y,
      },
      parentId: null,
      image: {
        source: "paint",
        width: box.width,
        height: box.height,
      },
      color: normaliseHexColor(color, DEFAULT_MASK_COLOR),
    };

    this._textures.set(id, texture);
    this._document.layers.push(layer);
    this._document.layerOrder.unshift(id);
    this.emit();
    this.emitMutation({ kind: "add-layer", layerId: id });
    return id;
  }

  /** Create a paintable mask layer pre-filled from an existing (coverage) texture. */
  public addMaskLayerFromTexture(
    texture: RenderTexture,
    name?: string,
    color = DEFAULT_MASK_COLOR,
  ): LayerId {
    const box = this._document.boundaryBox;
    const id = newId("mask");
    const layer: MaskLayer = {
      id,
      name:
        name ??
        `Mask ${this._document.layers.filter((candidate) => candidate.kind === "mask").length + 1}`,
      kind: "mask",
      visible: true,
      locked: false,
      preserveAlpha: false,
      opacity: 1,
      blendMode: "normal",
      transform: {
        ...identityTransform(),
        x: box.x,
        y: box.y,
      },
      parentId: null,
      image: {
        source: "paint",
        width: texture.width,
        height: texture.height,
      },
      color: normaliseHexColor(color, DEFAULT_MASK_COLOR),
    };

    this._textures.set(id, texture);
    this._document.layers.push(layer);
    this._document.layerOrder.unshift(id);
    this.emit();
    this.emitMutation({ kind: "add-layer", layerId: id });
    return id;
  }

  /** Create a control (ControlNet) layer backed by the given source texture. */
  public addControlLayer(texture: RenderTexture, name?: string): LayerId {
    const id = newId("control");
    const layer: ControlLayer = {
      id,
      name:
        name ??
        `Control ${
          this._document.layers.filter((candidate) => candidate.kind === "control").length + 1
        }`,
      kind: "control",
      visible: true,
      locked: false,
      preserveAlpha: false,
      opacity: 1,
      blendMode: "normal",
      transform: identityTransform(),
      parentId: null,
      image: {
        source: "upload",
        width: texture.width,
        height: texture.height,
      },
      model: "None",
      preprocessor: "None",
      preprocessorResolution: -1,
      preprocessorThresholdA: -1,
      preprocessorThresholdB: -1,
      weight: 1,
      guidanceStart: 0,
      guidanceEnd: 1,
      controlMode: "balanced",
      pixelPerfect: false,
      resizeMode: "resize",
      maskLayerId: null,
      preview: null,
    };

    this._textures.set(id, texture);
    this._document.layers.push(layer);
    this._document.layerOrder.unshift(id);
    this.emit();
    this.emitMutation({ kind: "add-layer", layerId: id });
    return id;
  }

  /**
   * Patch a control layer's ControlNet settings (model, preprocessor,
   * weight, guidance range, mode, mask reference...). Not undoable, same as
   * {@link setMaskColor} -- these are cosmetic/config fields, not pixel or
   * structural document state.
   */
  public setControlParams(
    id: LayerId,
    patch: Partial<{
      model: string;
      preprocessor: string;
      preprocessorResolution: number;
      preprocessorThresholdA: number;
      preprocessorThresholdB: number;
      weight: number;
      guidanceStart: number;
      guidanceEnd: number;
      controlMode: ControlMode;
      pixelPerfect: boolean;
      resizeMode: ControlResizeMode;
      maskLayerId: LayerId | null;
    }>,
  ): void {
    const layer = this.getLayer(id);
    if (!layer || layer.kind !== "control") return;
    Object.assign(layer, patch);
    this.emit();
  }

  /** Cache (or clear) a control layer's on-canvas preprocessor preview. */
  public setControlPreview(id: LayerId, preview: ImageRef | null): void {
    const layer = this.getLayer(id);
    if (!layer || layer.kind !== "control") return;
    layer.preview = preview;
    this.emit();
  }

  /** Remove `id` and, if it is a group, every descendant. */
  public removeLayer(id: LayerId): void {
    const layer = this.getLayer(id);
    if (!layer) return;

    const doomed = this.collectSubtree(id);
    const siblings = this.getSiblingOrder(id);
    if (siblings) {
      const at = siblings.indexOf(id);
      if (at !== -1) siblings.splice(at, 1);
    }

    this._document.layers = this._document.layers.filter((candidate) => !doomed.has(candidate.id));

    for (const doomedId of doomed) {
      const texture = this._textures.get(doomedId);
      this._textures.delete(doomedId);
      if (texture && !this.isTextureStillReferenced(texture)) {
        texture.destroy(true);
      }
    }

    this._selectedLayerIds = this._selectedLayerIds.filter((selected) => !doomed.has(selected));
    if (this._selectedLayerId === null || doomed.has(this._selectedLayerId)) {
      this._selectedLayerId = this._selectedLayerIds[this._selectedLayerIds.length - 1] ?? null;
    }

    this.emit();
    this.emitMutation({ kind: "remove-layer", layerIds: [...doomed] });
  }

  /** Move `id` within its current parent, clamping index to the valid range. */
  public reorderLayer(id: LayerId, newIndex: number): void {
    const siblings = this.getSiblingOrder(id);
    if (!siblings) return;

    const from = siblings.indexOf(id);
    if (from === -1) return;

    const to = Math.max(0, Math.min(newIndex, siblings.length - 1));
    if (from === to) return;

    siblings.splice(from, 1);
    siblings.splice(to, 0, id);
    this.emit();
    this.emitMutation({
      kind: "reorder-layer",
      layerId: id,
      previous: from,
      next: to,
    });
  }

  /** Set layer alpha. Clamped to 0-1. */
  public setOpacity(id: LayerId, opacity: number): void {
    const layer = this.getLayer(id);
    if (!layer) return;
    const clamped = Math.max(0, Math.min(1, opacity));
    if (layer.opacity === clamped) return;
    const previous = layer.opacity;
    layer.opacity = clamped;
    this.emit();
    this.emitMutation({
      kind: "set-opacity",
      layerId: id,
      previous,
      next: clamped,
    });
  }

  public setBlendMode(id: LayerId, mode: BlendMode): void {
    const layer = this.getLayer(id);
    if (!layer || layer.blendMode === mode) return;
    const previous = layer.blendMode;
    layer.blendMode = mode;
    this.emit();
    this.emitMutation({
      kind: "set-blend-mode",
      layerId: id,
      previous,
      next: mode,
    });
  }

  public setVisible(id: LayerId, visible: boolean): void {
    const layer = this.getLayer(id);
    if (!layer || layer.visible === visible) return;
    const previous = layer.visible;
    layer.visible = visible;
    this.emit();
    this.emitMutation({
      kind: "set-visible",
      layerId: id,
      previous,
      next: visible,
    });
  }

  public setLocked(id: LayerId, locked: boolean): void {
    const layer = this.getLayer(id);
    if (!layer || layer.locked === locked) return;
    const previous = layer.locked;
    layer.locked = locked;
    this.emit();
    this.emitMutation({ kind: "set-locked", layerId: id, previous, next: locked });
  }

  public setPreserveAlpha(id: LayerId, preserveAlpha: boolean): void {
    const layer = this.getLayer(id);
    if (!layer || layer.preserveAlpha === preserveAlpha) return;
    const previous = layer.preserveAlpha;
    layer.preserveAlpha = preserveAlpha;
    this.emit();
    this.emitMutation({
      kind: "set-preserve-alpha",
      layerId: id,
      previous,
      next: preserveAlpha,
    });
  }

  public setName(id: LayerId, name: string): void {
    const layer = this.getLayer(id);
    if (!layer || layer.name === name) return;
    const previous = layer.name;
    layer.name = name;
    this.emit();
    this.emitMutation({ kind: "set-name", layerId: id, previous, next: name });
  }

  /** Update a mask's display-only hatch color. */
  public setMaskColor(id: LayerId, color: string): void {
    const layer = this.getLayer(id);
    if (!layer || layer.kind !== "mask") return;
    const next = normaliseHexColor(color, layer.color);
    if (layer.color === next) return;
    layer.color = next;
    this.emit();
  }

  /** Patch any subset of a layer's transform. */
  public setTransform(id: LayerId, patch: Partial<Transform>): void {
    const layer = this.getLayer(id);
    if (!layer) return;
    const previous = { ...layer.transform };
    const next = { ...layer.transform, ...patch };
    if (
      previous.x === next.x &&
      previous.y === next.y &&
      previous.scaleX === next.scaleX &&
      previous.scaleY === next.scaleY &&
      previous.rotation === next.rotation
    ) {
      return;
    }
    layer.transform = next;
    this.emit();
    this.emitMutation({
      kind: "set-transform",
      layerId: id,
      previous,
      next: { ...next },
    });
  }

  /**
   * Atomically grow a paintable layer's backing texture and compensate its
   * position for pixels inserted above/left of the old texture origin.
   *
   * This deliberately emits only the ordinary document notification, not a
   * LayerStoreMutation: growth belongs to the pixel-history entry for the
   * brush stroke that caused it. The returned old texture is no longer
   * store-owned after this call; destroying it is the caller's responsibility.
   */
  public growRasterLayer(
    id: LayerId,
    expectedTexture: RenderTexture,
    texture: RenderTexture,
    deltaLeft: number,
    deltaTop: number,
  ): RenderTexture | null {
    const layer = this.getLayer(id);
    const previousTexture = this._textures.get(id);
    if (
      !layer ||
      (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control") ||
      previousTexture !== expectedTexture
    ) {
      return null;
    }

    this.replacePaintLayerState(id, layer, texture, {
      ...layer.transform,
      x: layer.transform.x - deltaLeft * layer.transform.scaleX,
      y: layer.transform.y - deltaTop * layer.transform.scaleY,
    });
    return previousTexture;
  }

  /**
   * Atomically replace a paintable texture and restore an absolute transform.
   * Used by pixel undo/redo, so it intentionally emits no LayerStoreMutation.
   * The returned old texture must be destroyed by the caller when safe.
   */
  public replaceLayerTexture(
    id: LayerId,
    expectedTexture: RenderTexture,
    texture: RenderTexture,
    transform: Transform,
  ): RenderTexture | null {
    const layer = this.getLayer(id);
    const previousTexture = this._textures.get(id);
    if (
      !layer ||
      (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control") ||
      previousTexture !== expectedTexture
    ) {
      return null;
    }

    this.replacePaintLayerState(id, layer, texture, { ...transform });
    return previousTexture;
  }

  /** Set the operating region without touching layer pixels. */
  public setBoundaryBox(box: BoundaryBox): void {
    if (
      this._document.boundaryBox.x === box.x &&
      this._document.boundaryBox.y === box.y &&
      this._document.boundaryBox.width === box.width &&
      this._document.boundaryBox.height === box.height
    ) {
      return;
    }
    const previous = { ...this._document.boundaryBox };
    this._document.boundaryBox = { ...box };
    this.emit();
    this.emitMutation({
      kind: "set-boundary-box",
      previous,
      next: { ...box },
    });
  }

  /** Restore a persisted operating region without adding an undo-history entry. */
  public restoreBoundaryBox(box: BoundaryBox): void {
    if (
      this._document.boundaryBox.x === box.x &&
      this._document.boundaryBox.y === box.y &&
      this._document.boundaryBox.width === box.width &&
      this._document.boundaryBox.height === box.height
    ) {
      return;
    }
    this._document.boundaryBox = { ...box };
    this.emit();
  }

  /** Drop every layer and destroy every owned texture. */
  public clear(): void {
    for (const texture of this._textures.values()) {
      texture.destroy(true);
    }
    this._textures.clear();
    this._document.layers = [];
    this._document.layerOrder = [];
    this._selectedLayerId = null;
    this._selectedLayerIds = [];
    this.emit();
    this.emitMutation({ kind: "clear" });
  }

  // ----------------------------------------------------------- observers

  /** Subscribe to document changes. Returns an unsubscribe function. */
  public subscribe(fn: Listener): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Subscribe to mutation details used by document history. */
  public subscribeMutations(fn: MutationListener): Unsubscribe {
    this.mutationListeners.add(fn);
    return () => {
      this.mutationListeners.delete(fn);
    };
  }

  /** Notify legacy listeners with the current rune-backed document. */
  public emit(): void {
    for (const fn of [...this.listeners]) {
      fn(this._document);
    }
  }

  private emitMutation(mutation: LayerStoreMutation): void {
    for (const fn of [...this.mutationListeners]) {
      fn(mutation);
    }
  }

  // ------------------------------------------------------------ internals

  /** `id` plus every descendant id, following group `children`. */
  private collectSubtree(id: LayerId): Set<LayerId> {
    const out = new Set<LayerId>();
    const stack: LayerId[] = [id];

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || out.has(current)) continue;
      out.add(current);

      const layer = this.getLayer(current);
      if (layer && layer.kind === "group") {
        stack.push(...layer.children);
      }
    }
    return out;
  }

  private isTextureStillReferenced(texture: RenderTexture): boolean {
    for (const other of this._textures.values()) {
      if (other === texture) return true;
    }
    return false;
  }

  private isEffectivelyVisible(layer: Layer, layers: ReadonlyMap<LayerId, Layer>): boolean {
    const seen = new Set<LayerId>();
    let current: Layer | undefined = layer;
    while (current) {
      if (
        seen.has(current.id) ||
        !current.visible ||
        !Number.isFinite(current.opacity) ||
        current.opacity <= 0
      ) {
        return false;
      }
      seen.add(current.id);
      if (current.parentId === null) return true;
      const parent = layers.get(current.parentId);
      if (!parent || parent.kind !== "group") return false;
      current = parent;
    }
    return false;
  }

  private worldMatrixFor(layer: Layer, layers: ReadonlyMap<LayerId, Layer>): Matrix {
    const chain: Layer[] = [];
    const seen = new Set<LayerId>();
    let current: Layer | undefined = layer;
    while (current && !seen.has(current.id)) {
      chain.push(current);
      seen.add(current.id);
      current = current.parentId === null ? undefined : layers.get(current.parentId);
    }
    return chain
      .reverse()
      .reduce(
        (matrix, currentLayer) =>
          multiplyMatrices(matrix, matrixForTransform(currentLayer.transform)),
        IDENTITY_MATRIX,
      );
  }

  /** Apply texture, transform, and size metadata before one synchronous emit. */
  private replacePaintLayerState(
    id: LayerId,
    layer: PaintLayer,
    texture: RenderTexture,
    transform: Transform,
  ): void {
    this._textures.set(id, texture);
    layer.transform = transform;
    layer.image.width = texture.width;
    layer.image.height = texture.height;
    this.emit();
  }
}

/** Shared default instance used by the app and Svelte UI. */
export const layerStore = new LayerStore();
