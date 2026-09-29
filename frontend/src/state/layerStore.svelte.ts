/**
 * Rune-backed document store with a dual API: Svelte consumers read the public
 * getters for fine-grained reactivity, while PixiJS/history consumers keep using
 * subscribe()/subscribeMutations(). Both paths observe the same rune state; the
 * listener sets are notifications only and do not duplicate document state.
 * Live tiled surfaces stay in a $state.raw Map so Svelte never proxies PixiJS.
 */

import type { TiledRasterCanvas } from "../canvas/TiledRasterCanvas";
import type { PixelBounds } from "../canvas/TileGrid";
import { clampDimension } from "../util/dimensions";

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
  RasterLayer,
  Transform,
} from "./schema";

/** Subscriber signature. Receives the document state *after* the mutation. */
export type Listener = (doc: Document) => void;

/** Unsubscribe handle returned by {@link LayerStore.subscribe}. */
export type Unsubscribe = () => void;

interface RemovedLayerRecord {
  layer: Layer;
  documentIndex: number;
  tiledSurface: TiledRasterCanvas | undefined;
}

/** Store-owned state detached by one user delete action and transferred to history. */
export interface LayerRemovalSnapshot {
  rootIds: readonly LayerId[];
  placements: readonly { layerId: LayerId; index: number }[];
  layers: readonly RemovedLayerRecord[];
  selectedLayerIds: readonly LayerId[];
}

/** Document mutation details consumed by undo/redo history. */
export type LayerStoreMutation =
  | { kind: "add-layer"; layerId: LayerId }
  | { kind: "remove-layer"; snapshot: LayerRemovalSnapshot }
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

/** Subscriber for every persisted-document revision, including pixel edits. */
export type ProjectRevisionListener = () => void;

/** Identity transform for a freshly created layer. */
function identityTransform(): Transform {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
}

const DEFAULT_MASK_COLOR = "#ff4d4d";
/** Hue order for new masks: red, blue, green, yellow, magenta, cyan, orange, violet. */
const MASK_HUES = [0, 240, 120, 60, 300, 180, 30, 270];

/** HSL(hue, 100%, 65%) -> hex; hue 0 gives DEFAULT_MASK_COLOR. */
function maskHueToHex(hue: number): string {
  const channel = (n: number): string => {
    const k = (n + hue / 30) % 12;
    const value = 0.65 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

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
function intersectsBox(bounds: PixelBounds, matrix: Matrix, box: BoundaryBox): boolean {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return false;
  }
  let polygon = [
    transformPoint(matrix, { x: bounds.x, y: bounds.y }),
    transformPoint(matrix, { x: bounds.x + bounds.width, y: bounds.y }),
    transformPoint(matrix, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }),
    transformPoint(matrix, { x: bounds.x, y: bounds.y + bounds.height }),
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
    boundaryBox: { x: 0, y: 0, width: clampDimension(width), height: clampDimension(height) },
    layers: [],
    layerOrder: [],
  };
}

export class LayerStore {
  /** Deep reactive because this graph contains serializable plain data only. */
  private _document = $state<Document>(createEmptyDocument(1024, 1024));

  /**
   * Sparse-tile pixel backing for every raster/mask/control layer. Raw
   * because PixiJS/TiledRasterCanvas objects must not be Svelte-proxied.
   */
  private readonly _tiledSurfaces = $state.raw(new Map<LayerId, TiledRasterCanvas>());

  private readonly listeners = new Set<Listener>();

  private readonly mutationListeners = new Set<MutationListener>();

  private readonly projectRevisionListeners = new Set<ProjectRevisionListener>();

  private _selectedLayerId = $state<LayerId | null>(null);

  private _selectedLayerIds = $state<LayerId[]>([]);

  /** Bumped by {@link touchTexture} whenever a layer's pixels change in place, for thumbnail cache invalidation. */
  private _textureVersions = $state<Record<LayerId, number>>({});

  /** Monotonic revision covering every persisted document or pixel mutation. */
  private _projectRevision = $state(0);

  /** Import-only UI state; the serialized ControlLayer.model string remains untouched. */
  private _unresolvedControlModels = $state<Record<LayerId, true>>({});

  /**
   * Display-only "hide all masks" toggle. Independent of each mask's own
   * `visible` flag: a mask hidden this way still participates in generation
   * (see `Compositor.flattenMask`, which filters on `layer.visible` only).
   */
  private _masksHidden = $state(false);

  /**
   * Display-only "hide all regular layers" toggle (raster/group). Same
   * independence from each layer's own `visible` flag as `_masksHidden`.
   */
  private _layersHidden = $state(false);

  /**
   * Display-only "hide all control layers" toggle. Same independence from
   * each layer's own `visible` flag as `_masksHidden`.
   */
  private _controlsHidden = $state(false);

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

  /** Reactive getter for the "hide all masks" display toggle. */
  public get masksHidden(): boolean {
    return this._masksHidden;
  }

  /** Toggle whether masks are hidden from the canvas without deactivating them. */
  public setMasksHidden(hidden: boolean): void {
    if (this._masksHidden === hidden) return;
    this._masksHidden = hidden;
    this.emit();
  }

  /** Reactive getter for the "hide all regular layers" display toggle. */
  public get layersHidden(): boolean {
    return this._layersHidden;
  }

  /** Toggle whether regular layers are hidden from the canvas without deactivating them. */
  public setLayersHidden(hidden: boolean): void {
    if (this._layersHidden === hidden) return;
    this._layersHidden = hidden;
    this.emit();
  }

  /** Reactive getter for the "hide all control layers" display toggle. */
  public get controlsHidden(): boolean {
    return this._controlsHidden;
  }

  /** Toggle whether control layers are hidden from the canvas without deactivating them. */
  public setControlsHidden(hidden: boolean): void {
    if (this._controlsHidden === hidden) return;
    this._controlsHidden = hidden;
    this.emit();
  }

  /** Whether an effectively visible raster layer has positive-area BB overlap. */
  public get hasVisibleRasterContent(): boolean {
    const layers = new Map(this._document.layers.map((layer) => [layer.id, layer]));
    return this._document.layers.some((layer) => {
      if (layer.kind !== "raster" || !this.isEffectivelyVisible(layer, layers)) {
        return false;
      }
      const bounds = this.getLayerPixelBounds(layer.id);
      if (!bounds) return false;
      return intersectsBox(bounds, this.worldMatrixFor(layer, layers), this._document.boundaryBox);
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

  /** The live sparse-tile surface for a raster layer, if it is tile-backed. */
  public getTiledSurface(id: LayerId): TiledRasterCanvas | undefined {
    return this._tiledSurfaces.get(id);
  }

  /** Current layer-local pixel bounds, with a tiled surface as the source of truth. */
  public getLayerPixelBounds(id: LayerId): PixelBounds | null {
    const layer = this.getLayer(id);
    if (!layer || (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control")) {
      return null;
    }
    const tiledBounds = this._tiledSurfaces.get(id)?.bounds;
    if (tiledBounds !== undefined) return tiledBounds;
    return { x: 0, y: 0, width: layer.image.width, height: layer.image.height };
  }

  /** Reactive change counter for a layer's texture; bumped by {@link touchTexture}. */
  public getTextureVersion(id: LayerId): number {
    return this._textureVersions[id] ?? 0;
  }

  public get projectRevision(): number {
    return this._projectRevision;
  }

  public isControlModelUnresolved(id: LayerId): boolean {
    return this._unresolvedControlModels[id] === true;
  }

  /**
   * Mark a layer's texture as freshly committed. Not a {@link LayerStoreMutation}
   * because pixel undo is already recorded by `UndoHistory`; it still advances
   * the portable-project revision and invalidates thumbnail caches.
   */
  public touchTexture(id: LayerId): void {
    this.syncTiledImageMetadata(id);
    if (!this.getLayer(id)) return;
    this._textureVersions = {
      ...this._textureVersions,
      [id]: (this._textureVersions[id] ?? 0) + 1,
    };
    this.bumpProjectRevision();
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
   * Create a raster layer backed by a sparse `TiledRasterCanvas`.
   *
   * If the document is still empty (no layers yet -- the common "start a
   * new canvas from an uploaded/generated image" path), the document is
   * auto-sized to this layer's dimensions first. The surface's logical
   * bounds (from whatever pixels were already blitted into it) become the
   * layer's reported image size.
   */
  public addRasterLayerTiled(
    surface: TiledRasterCanvas,
    name?: string,
    source: ImageRef["source"] = "upload",
  ): LayerId {
    const bounds = surface.bounds ?? { x: 0, y: 0, width: 0, height: 0 };

    if (this._document.layers.length === 0) {
      this._document.boundaryBox = {
        x: 0,
        y: 0,
        width: clampDimension(bounds.width),
        height: clampDimension(bounds.height),
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
        width: bounds.width,
        height: bounds.height,
        tileSize: surface.tileSize,
        bounds: surface.bounds,
      } satisfies ImageRef,
    };

    this._tiledSurfaces.set(id, surface);
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

  /**
   * First unused color: the curated MASK_HUES, then golden-angle hues (each lands far from
   * the previous ones), so deleting a mask frees its slot and colors never repeat in practice.
   */
  private nextMaskColor(): string {
    const used = new Set(
      this._document.layers.flatMap((layer) => (layer.kind === "mask" ? [layer.color] : [])),
    );
    for (let i = 0; i < 360; i++) {
      const hue =
        i < MASK_HUES.length ? MASK_HUES[i]! : ((i - MASK_HUES.length) * 137.508 + 15) % 360;
      const color = maskHueToHex(hue);
      if (!used.has(color)) return color;
    }
    return DEFAULT_MASK_COLOR;
  }

  /** Create a paintable mask layer backed by sparse tiles. */
  public addMaskLayerTiled(
    surface: TiledRasterCanvas,
    name?: string,
    color = this.nextMaskColor(),
  ): LayerId {
    const box = this._document.boundaryBox;
    const bounds = surface.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
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
      transform: { ...identityTransform(), x: box.x, y: box.y },
      parentId: null,
      image: {
        source: "paint",
        width: bounds.width,
        height: bounds.height,
        tileSize: surface.tileSize,
        bounds: surface.bounds,
      } satisfies ImageRef,
      color: normaliseHexColor(color, DEFAULT_MASK_COLOR),
    };

    this._tiledSurfaces.set(id, surface);
    this._document.layers.push(layer);
    this._document.layerOrder.unshift(id);
    this.emit();
    this.emitMutation({ kind: "add-layer", layerId: id });
    return id;
  }

  /** Create a ControlNet layer backed by sparse tiles. */
  public addControlLayerTiled(surface: TiledRasterCanvas, name?: string): LayerId {
    const bounds = surface.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
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
        width: bounds.width,
        height: bounds.height,
        tileSize: surface.tileSize,
        bounds: surface.bounds,
      } satisfies ImageRef,
      model: "None",
      weight: 1,
      guidanceStart: 0,
      guidanceEnd: 1,
      controlMode: "balanced",
      pixelPerfect: false,
      resizeMode: "resize",
    };

    this._tiledSurfaces.set(id, surface);
    this._document.layers.push(layer);
    this._document.layerOrder.unshift(id);
    this.emit();
    this.emitMutation({ kind: "add-layer", layerId: id });
    return id;
  }

  /**
   * Patch a control layer's ControlNet settings. Not undoable, same as
   * {@link setMaskColor} -- these are config fields, not pixel or structural
   * document state.
   */
  public setControlParams(
    id: LayerId,
    patch: Partial<{
      model: string;
      weight: number;
      guidanceStart: number;
      guidanceEnd: number;
      controlMode: ControlMode;
      pixelPerfect: boolean;
      resizeMode: ControlResizeMode;
    }>,
  ): void {
    const layer = this.getLayer(id);
    if (!layer || layer.kind !== "control") return;
    Object.assign(layer, patch);
    if (patch.model !== undefined && this._unresolvedControlModels[id]) {
      const remaining = { ...this._unresolvedControlModels };
      delete remaining[id];
      this._unresolvedControlModels = remaining;
    }
    this.emit();
    this.bumpProjectRevision();
  }

  /** Apply the user-visible settings from a same-kind source to a newly created copy. */
  public copyLayerSettings(id: LayerId, source: Layer): void {
    const target = this.getLayer(id);
    if (!target || target.kind !== source.kind) return;

    Object.assign(target, {
      name: `${source.name} copy`,
      visible: source.visible,
      locked: source.locked,
      preserveAlpha: source.preserveAlpha,
      opacity: source.opacity,
      blendMode: source.blendMode,
      transform: { ...source.transform },
    });
    if (target.kind === "mask" && source.kind === "mask") target.color = source.color;
    if (target.kind === "control" && source.kind === "control") {
      Object.assign(target, {
        model: source.model,
        weight: source.weight,
        guidanceStart: source.guidanceStart,
        guidanceEnd: source.guidanceEnd,
        controlMode: source.controlMode,
        pixelPerfect: source.pixelPerfect,
        resizeMode: source.resizeMode,
      });
    }
    this.emit();
    this.bumpProjectRevision();
  }

  /**
   * Remove a single non-group layer for undo/redo of an "add-layer"
   * mutation only. Unlike {@link removeLayer}, the tiled surface is NOT
   * destroyed (the caller -- UndoHistory -- keeps it alive to support redo)
   * and no subtree is collected, since app operations that need this (merge,
   * layer conversion, ...) only ever undo the single top-level layer they
   * just created. Returns the removed layer, its tiled surface (if any), and
   * its former index within its sibling list so {@link restoreLayerForUndo}
   * can put it back exactly where it was.
   */
  public extractLayerForUndo(id: LayerId):
    | {
        layer: Layer;
        index: number;
        tiledSurface: TiledRasterCanvas | undefined;
      }
    | undefined {
    const layer = this.getLayer(id);
    const siblings = this.getSiblingOrder(id);
    if (!layer || !siblings) return undefined;

    const index = siblings.indexOf(id);
    if (index === -1) return undefined;

    siblings.splice(index, 1);
    this._document.layers = this._document.layers.filter((candidate) => candidate.id !== id);
    const tiledSurface = this._tiledSurfaces.get(id);
    this._tiledSurfaces.delete(id);

    this._selectedLayerIds = this._selectedLayerIds.filter((selected) => selected !== id);
    if (this._selectedLayerId === id) {
      this._selectedLayerId = this._selectedLayerIds[this._selectedLayerIds.length - 1] ?? null;
    }

    this.emit();
    this.bumpProjectRevision();
    return { layer, index, tiledSurface };
  }

  /** Reinsert a layer previously removed by {@link extractLayerForUndo}, at the same sibling index. */
  public restoreLayerForUndo(layer: Layer, index: number, tiledSurface?: TiledRasterCanvas): void {
    if (tiledSurface) this._tiledSurfaces.set(layer.id, tiledSurface);
    this._document.layers.push(layer);
    const siblings = this.getSiblingOrder(layer.id);
    if (siblings) {
      siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, layer.id);
    }
    this.emit();
    this.bumpProjectRevision();
  }

  /** Remove `id` and, if it is a group, every descendant. */
  public removeLayer(id: LayerId): void {
    this.removeLayers([id]);
  }

  /** Remove several selected roots as one undoable user action. */
  public removeLayers(ids: readonly LayerId[]): void {
    const snapshot = this.extractLayersForUndo(ids);
    if (!snapshot) return;

    if (this.mutationListeners.size === 0) {
      this.destroyLayerRemovalSnapshot(snapshot);
      return;
    }
    this.emitMutation({ kind: "remove-layer", snapshot });
  }

  /** Detach layers and pixel backings without destroying them or recording history. */
  public extractLayersForUndo(ids: readonly LayerId[]): LayerRemovalSnapshot | undefined {
    const requested = new Set(ids.filter((id) => this.getLayer(id) !== undefined));
    if (requested.size === 0) return undefined;

    const rootIds = [...requested].filter((id) => {
      let parentId = this.getLayer(id)?.parentId ?? null;
      while (parentId !== null) {
        if (requested.has(parentId)) return false;
        parentId = this.getLayer(parentId)?.parentId ?? null;
      }
      return true;
    });
    const placements = rootIds.map((layerId) => ({
      layerId,
      index: this.getSiblingOrder(layerId)?.indexOf(layerId) ?? -1,
    }));
    const doomed = new Set<LayerId>();
    for (const rootId of rootIds) {
      for (const doomedId of this.collectSubtree(rootId)) doomed.add(doomedId);
    }

    const layers = this._document.layers.flatMap((layer, documentIndex) =>
      doomed.has(layer.id)
        ? [
            {
              layer,
              documentIndex,
              tiledSurface: this._tiledSurfaces.get(layer.id),
            },
          ]
        : [],
    );

    for (const { layerId, index } of [...placements].sort((a, b) => b.index - a.index)) {
      const siblings = this.getSiblingOrder(layerId);
      if (siblings && index >= 0) siblings.splice(index, 1);
    }

    this._document.layers = this._document.layers.filter((layer) => !doomed.has(layer.id));
    for (const doomedId of doomed) {
      this._tiledSurfaces.delete(doomedId);
    }
    this._unresolvedControlModels = Object.fromEntries(
      Object.entries(this._unresolvedControlModels).filter(([id]) => !doomed.has(id)),
    );

    const selectedLayerIds = [...this._selectedLayerIds];
    this._selectedLayerIds = this._selectedLayerIds.filter((selected) => !doomed.has(selected));
    this._selectedLayerId = this._selectedLayerIds[this._selectedLayerIds.length - 1] ?? null;
    this.emit();
    this.bumpProjectRevision();
    return { rootIds, placements, layers, selectedLayerIds };
  }

  /** Restore a detached delete snapshot at its exact document and sibling positions. */
  public restoreLayersForUndo(snapshot: LayerRemovalSnapshot): void {
    for (const record of [...snapshot.layers].sort(
      (left, right) => left.documentIndex - right.documentIndex,
    )) {
      const at = Math.max(0, Math.min(record.documentIndex, this._document.layers.length));
      this._document.layers.splice(at, 0, record.layer);
      if (record.tiledSurface) this._tiledSurfaces.set(record.layer.id, record.tiledSurface);
    }

    for (const placement of [...snapshot.placements].sort(
      (left, right) => left.index - right.index,
    )) {
      const siblings = this.getSiblingOrder(placement.layerId);
      if (!siblings) continue;
      siblings.splice(
        Math.max(0, Math.min(placement.index, siblings.length)),
        0,
        placement.layerId,
      );
    }

    this._selectedLayerIds = snapshot.selectedLayerIds.filter(
      (id) => this.getLayer(id) !== undefined,
    );
    this._selectedLayerId = this._selectedLayerIds[this._selectedLayerIds.length - 1] ?? null;
    this.emit();
    this.bumpProjectRevision();
  }

  /** Release a detached delete snapshot after it falls out of bounded history. */
  public destroyLayerRemovalSnapshot(snapshot: LayerRemovalSnapshot): void {
    const surfaces = new Set(
      snapshot.layers.flatMap((record) => (record.tiledSurface ? [record.tiledSurface] : [])),
    );
    for (const surface of surfaces) {
      if (!this.isTiledSurfaceStillReferenced(surface)) surface.destroy();
    }
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
    this.bumpProjectRevision();
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

  /** Set the operating region without touching layer pixels. */
  public setBoundaryBox(box: BoundaryBox): void {
    const next = this.normaliseBoundaryBox(box);
    if (
      this._document.boundaryBox.x === next.x &&
      this._document.boundaryBox.y === next.y &&
      this._document.boundaryBox.width === next.width &&
      this._document.boundaryBox.height === next.height
    ) {
      return;
    }
    const previous = { ...this._document.boundaryBox };
    this._document.boundaryBox = next;
    this.emit();
    this.emitMutation({
      kind: "set-boundary-box",
      previous,
      next: { ...next },
    });
  }

  /** Ensure all boundary-box mutations stay safe for later texture allocation. */
  private normaliseBoundaryBox(box: BoundaryBox): BoundaryBox {
    const previous = this._document.boundaryBox;
    const coordinate = (value: number, fallback: number) =>
      Number.isFinite(value) && Number.isSafeInteger(Math.round(value))
        ? Math.round(value)
        : fallback;
    return {
      x: coordinate(box.x, previous.x),
      y: coordinate(box.y, previous.y),
      width: clampDimension(box.width, previous.width),
      height: clampDimension(box.height, previous.height),
    };
  }

  /** Drop every layer and destroy every owned surface. */
  public clear(): void {
    for (const surface of this._tiledSurfaces.values()) {
      surface.destroy();
    }
    this._tiledSurfaces.clear();
    this._document.layers = [];
    this._document.layerOrder = [];
    this._selectedLayerId = null;
    this._selectedLayerIds = [];
    this._unresolvedControlModels = {};
    this.emit();
    this.emitMutation({ kind: "clear" });
  }

  /**
   * Atomically adopt a fully decoded portable document. The incoming surfaces
   * transfer to this store; prior surfaces are destroyed only after subscribers
   * have reconciled against the complete replacement.
   */
  public replaceDocument(
    document: Document,
    surfaces: Map<LayerId, TiledRasterCanvas>,
    unresolvedControlLayerIds: ReadonlySet<LayerId> = new Set(),
  ): void {
    const previousDocument = this._document;
    const previousSurfaceEntries = [...this._tiledSurfaces.entries()];
    const previousSelectedLayerId = this._selectedLayerId;
    const previousSelectedLayerIds = this._selectedLayerIds;
    const previousTextureVersions = this._textureVersions;
    const previousUnresolvedControlModels = this._unresolvedControlModels;
    this._document = document;
    this._tiledSurfaces.clear();
    for (const [id, surface] of surfaces) this._tiledSurfaces.set(id, surface);
    this._selectedLayerId = null;
    this._selectedLayerIds = [];
    this._textureVersions = {};
    this._unresolvedControlModels = Object.fromEntries(
      [...unresolvedControlLayerIds].map((id) => [id, true] as const),
    );
    try {
      this.emit();
    } catch (error) {
      this._document = previousDocument;
      this._tiledSurfaces.clear();
      for (const [id, surface] of previousSurfaceEntries) this._tiledSurfaces.set(id, surface);
      this._selectedLayerId = previousSelectedLayerId;
      this._selectedLayerIds = previousSelectedLayerIds;
      this._textureVersions = previousTextureVersions;
      this._unresolvedControlModels = previousUnresolvedControlModels;
      this.emit();
      throw error;
    }
    this.emitMutation({ kind: "clear" });

    const adopted = new Set(this._tiledSurfaces.values());
    for (const surface of new Set(previousSurfaceEntries.map(([, surface]) => surface))) {
      if (!adopted.has(surface)) surface.destroy();
    }
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

  /** Subscribe to the monotonic portable-project revision. */
  public subscribeProjectRevisions(fn: ProjectRevisionListener): Unsubscribe {
    this.projectRevisionListeners.add(fn);
    return () => {
      this.projectRevisionListeners.delete(fn);
    };
  }

  /** Notify legacy listeners with the current rune-backed document. */
  public emit(): void {
    for (const fn of [...this.listeners]) {
      fn(this._document);
    }
  }

  private emitMutation(mutation: LayerStoreMutation): void {
    this.bumpProjectRevision();
    for (const fn of [...this.mutationListeners]) {
      fn(mutation);
    }
  }

  private bumpProjectRevision(): void {
    this._projectRevision += 1;
    for (const fn of [...this.projectRevisionListeners]) fn();
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

  private isTiledSurfaceStillReferenced(surface: TiledRasterCanvas): boolean {
    for (const other of this._tiledSurfaces.values()) {
      if (other === surface) return true;
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

  /** Mirror the sparse surface's authoritative logical bounds into serializable metadata. */
  private syncTiledImageMetadata(id: LayerId): void {
    const layer = this.getLayer(id);
    const surface = this._tiledSurfaces.get(id);
    if (
      !layer ||
      !surface ||
      (layer.kind !== "raster" && layer.kind !== "mask" && layer.kind !== "control")
    ) {
      return;
    }
    const bounds = surface.bounds;
    layer.image.tileSize = surface.tileSize;
    layer.image.bounds = bounds;
    layer.image.width = bounds?.width ?? 0;
    layer.image.height = bounds?.height ?? 0;
  }
}

/** Shared default instance used by the app and Svelte UI. */
export const layerStore = new LayerStore();
