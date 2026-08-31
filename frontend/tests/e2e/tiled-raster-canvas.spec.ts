import { expect, test } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type TestTarget = { uid: number; source: { uid: number } };

type TestDelta = {
  tileCount: number;
  estimatedBytes: number;
  apply(): TestDelta;
  destroy(): void;
};

type TestVisit = {
  coord: { x: number; y: number };
  originX: number;
  originY: number;
  target: TestTarget;
};

type TestTransaction = {
  includeBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  commit(): TestDelta;
};

type TestSurface = {
  tileCount: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
  estimateResidentBytes(): number;
  diagnosticTileCoords(): { x: number; y: number }[];
  subscribe(fn: (event: { type: string; coord: { x: number; y: number } }) => void): () => void;
  beginEdit(label: string): TestTransaction;
  visit(
    bounds: { x: number; y: number; width: number; height: number },
    fn: (tile: TestVisit) => void,
  ): void;
  edit(
    bounds: { x: number; y: number; width: number; height: number },
    options: { allocation: "existing-only" | "allocate-missing"; transaction: unknown },
    fn: (tile: TestVisit) => void,
  ): void;
  destroy(): void;
};

type TestLayerNode = {
  container: {
    position: { set(x: number, y: number): void };
    scale: { set(x: number, y?: number): void };
    rotation: number;
    getBounds(): { x: number; y: number; width: number; height: number };
    getChildByLabel(label: string):
      | {
          children: Array<{ x: number; y: number; texture: TestTarget }>;
        }
      | undefined;
  };
  setTiledVisibleRegion(
    bounds: { x: number; y: number; width: number; height: number } | null,
  ): void;
  destroy(): void;
};

type TestLayer = {
  id: string;
  kind: string;
  image: { storage?: "tiled"; width: number; height: number };
};

type TestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addBlankLayer(): Promise<string>;
      fillSelectedLayer(): void;
      convertLayerToMask(id: string): string;
      convertLayerToControl(id: string): string;
      clipLayerToBoundaryBox(id: string): boolean;
      layerSourceDataURL(id: string): string | null;
      flattenToDataURL(chunkSize?: number): string;
      resizeBoundaryBox(width: number, height: number): void;
      addImageFromFile(file: File): Promise<string>;
      undo(): void;
      redo(): void;
    } | null;
    getRendererName(): string;
    layerStore: {
      setSelectedLayerId(id: string | null): void;
      setBoundaryBox(box: { x: number; y: number; width: number; height: number }): void;
      document: { layers: TestLayer[] };
      getTiledSurface(id: string): TestSurface | undefined;
      getTexture(id: string): TestTarget | undefined;
      removeLayer(id: string): void;
    };
    createTiledRasterCanvas(tileSize?: number): TestSurface;
    createTiledRasterLayerNode(surface: TestSurface): TestLayerNode;
    renderTileColor(target: TestTarget, color: number): void;
    blitTextureToSurface(
      surface: TestSurface,
      source: TestTarget,
      transaction: TestTransaction,
      x: number,
      y: number,
    ): { x: number; y: number; width: number; height: number };
    readTilePixel(target: TestTarget, x?: number, y?: number): Promise<number[]>;
  };
};

test.beforeEach(async ({ page }) => {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 204, body: "" })
      : route.fulfill({ json: {} }),
  );
  await page.route("**/ultra_paint/data/tags.csv", (route) =>
    route.fulfill({ contentType: "text/csv", body: "" }),
  );
  await page.goto("./");
  await page.waitForFunction(() =>
    Boolean((window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );
});

test("allocates signed tiles atomically without exposing the backing map", async ({ page }) => {
  const result = await page.evaluate(() => {
    const surface = (window as TestWindow).__ultraPaintTest!.createTiledRasterCanvas(64);
    const events: string[] = [];
    surface.subscribe((event) => events.push(`${event.type}:${event.coord.x},${event.coord.y}`));

    const transaction = surface.beginEdit("cross origin");
    surface.edit(
      { x: -1, y: -1, width: 2, height: 2 },
      { allocation: "allocate-missing", transaction },
      () => undefined,
    );
    const beforeCommit = {
      tileCount: surface.tileCount,
      events: [...events],
      hasPublicTiles: "tiles" in surface,
    };
    transaction.includeBounds({ x: -1, y: -1, width: 2, height: 2 });
    const delta = transaction.commit();
    const committed = {
      coords: surface.diagnosticTileCoords(),
      bounds: surface.bounds,
      events: [...events],
      deltaTiles: delta.tileCount,
      deltaBytes: delta.estimatedBytes,
      residentBytes: surface.estimateResidentBytes(),
    };
    delta.destroy();
    surface.destroy();
    return { beforeCommit, committed, afterDestroy: surface.tileCount };
  });

  expect(result.beforeCommit).toEqual({ tileCount: 4, events: [], hasPublicTiles: false });
  expect(result.committed.coords).toEqual([
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 0, y: 0 },
  ]);
  expect(result.committed.bounds).toEqual({ x: -1, y: -1, width: 2, height: 2 });
  expect(result.committed.events).toEqual(["added:-1,-1", "added:0,-1", "added:-1,0", "added:0,0"]);
  expect(result.committed.deltaTiles).toBe(4);
  expect(result.committed.deltaBytes).toBe(0);
  expect(result.committed.residentBytes).toBe(4 * 64 * 64 * 4);
  expect(result.afterDestroy).toBe(0);
});

test("rolls back the whole edit on failure and expands bounds only when requested", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const surface = (window as TestWindow).__ultraPaintTest!.createTiledRasterCanvas(32);
    const events: string[] = [];
    surface.subscribe((event) => events.push(`${event.type}:${event.coord.x},${event.coord.y}`));

    const initial = surface.beginEdit("initial");
    surface.edit(
      { x: 0, y: 0, width: 1, height: 1 },
      { allocation: "allocate-missing", transaction: initial },
      () => undefined,
    );
    initial.includeBounds({ x: 0, y: 0, width: 1, height: 1 });
    initial.commit().destroy();

    let error = "";
    const failed = surface.beginEdit("failed multi-tile write");
    let visits = 0;
    try {
      surface.edit(
        { x: 0, y: 0, width: 33, height: 1 },
        { allocation: "allocate-missing", transaction: failed },
        () => {
          visits += 1;
          if (visits === 2) throw new Error("synthetic render failure");
        },
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const eraser = surface.beginEdit("existing-only no bounds growth");
    surface.edit(
      { x: -100, y: -100, width: 101, height: 101 },
      { allocation: "existing-only", transaction: eraser },
      () => undefined,
    );
    eraser.commit().destroy();

    const output = {
      error,
      tileCount: surface.tileCount,
      coords: surface.diagnosticTileCoords(),
      bounds: surface.bounds,
      events,
    };
    surface.destroy();
    return output;
  });

  expect(result.error).toBe("synthetic render failure");
  expect(result.tileCount).toBe(1);
  expect(result.coords).toEqual([{ x: 0, y: 0 }]);
  expect(result.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  expect(result.events).toEqual(["added:0,0"]);
});

test("replays tile pixels and existence by transferring texture ownership", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const surface = hook.createTiledRasterCanvas(16);
    const events: string[] = [];
    surface.subscribe((event) => events.push(`${event.type}:${event.coord.x},${event.coord.y}`));
    const node = hook.createTiledRasterLayerNode(surface);
    const region = { x: -1, y: 16, width: 1, height: 1 };

    const readPixel = async () => {
      let target: TestTarget | null = null;
      surface.visit(region, (tile) => {
        target = tile.target;
      });
      return target ? hook.readTilePixel(target) : null;
    };

    const create = surface.beginEdit("create red tile");
    surface.edit(region, { allocation: "allocate-missing", transaction: create }, (tile) => {
      hook.renderTileColor(tile.target, 0xff0000);
    });
    create.includeBounds(region);
    const undoCreate = create.commit();
    const red = await readPixel();

    const tileContainer = node.container.getChildByLabel("tiles:test-tiled-raster")!;
    const originalSprite = tileContainer.children[0]!;
    const originalTarget = originalSprite.texture;

    const paint = surface.beginEdit("paint green");
    surface.edit(region, { allocation: "existing-only", transaction: paint }, (tile) => {
      hook.renderTileColor(tile.target, 0x00ff00);
    });
    const undoPaint = paint.commit();
    const green = await readPixel();

    const redoPaint = undoPaint.apply();
    const restoredRed = await readPixel();
    const spriteAfterUndo = tileContainer.children[0]!;
    const undoView = {
      sameSprite: spriteAfterUndo === originalSprite,
      adoptedSnapshot: spriteAfterUndo.texture !== originalTarget,
      spriteCount: tileContainer.children.length,
    };

    const undoPaintAgain = redoPaint.apply();
    const restoredGreen = await readPixel();

    const redoCreate = undoCreate.apply();
    const removed = {
      tileCount: surface.tileCount,
      bounds: surface.bounds,
      spriteCount: tileContainer.children.length,
    };
    const undoCreateAgain = redoCreate.apply();
    const readded = {
      tileCount: surface.tileCount,
      bounds: surface.bounds,
      spriteCount: tileContainer.children.length,
      pixel: await readPixel(),
    };

    undoPaintAgain.destroy();
    undoCreateAgain.destroy();
    node.destroy();
    surface.destroy();
    return {
      red,
      green,
      restoredRed,
      restoredGreen,
      undoView,
      removed,
      readded,
      events,
    };
  });

  expect(result.red).toEqual([255, 0, 0, 255]);
  expect(result.green).toEqual([0, 255, 0, 255]);
  expect(result.restoredRed).toEqual(result.red);
  expect(result.restoredGreen).toEqual(result.green);
  expect(result.undoView).toEqual({ sameSprite: true, adoptedSnapshot: true, spriteCount: 1 });
  expect(result.removed).toEqual({ tileCount: 0, bounds: null, spriteCount: 0 });
  expect(result.readded).toEqual({
    tileCount: 1,
    bounds: { x: -1, y: 16, width: 1, height: 1 },
    spriteCount: 1,
    pixel: [0, 255, 0, 255],
  });
  expect(result.events).toEqual([
    "added:-1,1",
    "replaced:-1,1",
    "replaced:-1,1",
    "removed:-1,1",
    "added:-1,1",
  ]);
});

test("keeps signed tile pixels local under layer rotation and scale", async ({ page }) => {
  const result = await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const surface = hook.createTiledRasterCanvas(16);
    const transaction = surface.beginEdit("signed transform fixture");
    surface.edit(
      { x: -1, y: 16, width: 1, height: 1 },
      { allocation: "allocate-missing", transaction },
      () => undefined,
    );
    transaction.commit().destroy();

    const node = hook.createTiledRasterLayerNode(surface);
    const tileContainer = node.container.getChildByLabel("tiles:test-tiled-raster")!;
    const sprite = tileContainer.children[0]!;
    node.container.position.set(100, 50);
    node.container.scale.set(2);
    node.container.rotation = Math.PI / 2;
    const bounds = node.container.getBounds();
    node.setTiledVisibleRegion({ x: 0, y: 0, width: 16, height: 16 });
    const culledSpriteCount = tileContainer.children.length;
    node.setTiledVisibleRegion({ x: -16, y: 16, width: 16, height: 16 });
    const selectedSpriteCount = tileContainer.children.length;
    node.setTiledVisibleRegion(null);
    const output = {
      tilePosition: { x: sprite.x, y: sprite.y },
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      surfaceCoords: surface.diagnosticTileCoords(),
      culledSpriteCount,
      selectedSpriteCount,
      restoredSpriteCount: tileContainer.children.length,
    };
    node.destroy();
    surface.destroy();
    return output;
  });

  expect(result.tilePosition).toEqual({ x: -16, y: 16 });
  expect(result.surfaceCoords).toEqual([{ x: -1, y: 1 }]);
  expect(result.culledSpriteCount).toBe(0);
  expect(result.selectedSpriteCount).toBe(1);
  expect(result.restoredSpriteCount).toBe(1);
  expect(result.bounds.x).toBeCloseTo(36);
  expect(result.bounds.y).toBeCloseTo(18);
  expect(result.bounds.width).toBeCloseTo(32);
  expect(result.bounds.height).toBeCloseTo(32);
});

test("stitches a forced multi-chunk export pixel-identically", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;
    app.resizeBoundaryBox(23, 19);
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    app.fillSelectedLayer();

    const singleChunk = app.flattenToDataURL(64);
    const manyChunks = app.flattenToDataURL(7);
    const image = new Image();
    image.src = manyChunks;
    await image.decode();
    return {
      equal: manyChunks === singleChunk,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  });

  expect(result).toEqual({ equal: true, width: 23, height: 19 });
});

test("blits one source across four signed destination tiles", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const sourceSurface = hook.createTiledRasterCanvas(4);
    const sourceEdit = sourceSurface.beginEdit("source");
    sourceSurface.edit(
      { x: 0, y: 0, width: 4, height: 4 },
      { allocation: "allocate-missing", transaction: sourceEdit },
      (tile) => hook.renderTileColor(tile.target, 0xff0000),
    );
    sourceEdit.commit().destroy();
    let source: TestTarget | null = null;
    sourceSurface.visit({ x: 0, y: 0, width: 1, height: 1 }, (tile) => {
      source = tile.target;
    });
    if (!source) throw new Error("Source tile is unavailable");

    const destination = hook.createTiledRasterCanvas(4);
    const edit = destination.beginEdit("paste across origin");
    const bounds = hook.blitTextureToSurface(destination, source, edit, -2, -2);
    const delta = edit.commit();
    const visits: TestVisit[] = [];
    destination.visit(bounds, (tile) => visits.push(tile));
    const samples = await Promise.all(
      visits.map((tile) =>
        hook.readTilePixel(tile.target, tile.coord.x < 0 ? 3 : 0, tile.coord.y < 0 ? 3 : 0),
      ),
    );
    const outside = await hook.readTilePixel(visits[0]!.target, 0, 0);
    const output = {
      bounds: destination.bounds,
      coords: destination.diagnosticTileCoords(),
      samples,
      outside,
      deltaTiles: delta.tileCount,
    };
    delta.destroy();
    destination.destroy();
    sourceSurface.destroy();
    return output;
  });

  expect(result.bounds).toEqual({ x: -2, y: -2, width: 4, height: 4 });
  expect(result.coords).toEqual([
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 0, y: 0 },
  ]);
  expect(result.samples).toEqual(Array.from({ length: 4 }, () => [255, 0, 0, 255]));
  expect(result.outside).toEqual([0, 0, 0, 0]);
  expect(result.deltaTiles).toBe(4);
});

test("uploading an image spanning multiple tiles ingests through the tiled surface", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // 1500x1100 at a 1024 tile size spans a 2x2 tile grid; four solid
    // quadrant colors let a single flatten confirm placement is exact.
    const canvas = document.createElement("canvas");
    canvas.width = 1500;
    canvas.height = 1100;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 750, 550);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(750, 0, 750, 550);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 550, 750, 550);
    ctx.fillStyle = "#ffff00";
    ctx.fillRect(750, 550, 750, 550);
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );

    const id = await app.addImageFromFile(new File([blob], "quadrants.png", { type: blob.type }));
    const layer = hook.layerStore.document.layers.find((candidate) => candidate.id === id);
    const surface = hook.layerStore.getTiledSurface(id);
    const hasMonolithicTexture = hook.layerStore.getTexture(id) !== undefined;
    if (!surface) throw new Error("uploaded layer has no tiled surface");
    const imageStorage = layer?.image.storage;
    const tileCoords = surface.diagnosticTileCoords();

    app.resizeBoundaryBox(1500, 1100);
    const dataUrl = app.flattenToDataURL(2048);

    // Undo the add, then redo it, and confirm the same surface comes back alive.
    app.undo();
    const layerCountAfterUndo = hook.layerStore.document.layers.length;
    app.redo();
    const survivedRedoTileCount = hook.layerStore.getTiledSurface(id)?.tileCount;

    hook.layerStore.removeLayer(id);
    const survivedRemoval = hook.layerStore.getTiledSurface(id) !== undefined;

    return {
      imageStorage,
      hasMonolithicTexture,
      tileCoords,
      dataUrl,
      layerCountAfterUndo,
      survivedRedoTileCount,
      survivedRemoval,
    };
  });

  expect(result.imageStorage).toBe("tiled");
  expect(result.hasMonolithicTexture).toBe(false);
  expect(result.tileCoords).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ]);
  expect(result.layerCountAfterUndo).toBe(0);
  expect(result.survivedRedoTileCount).toBe(4);
  expect(result.survivedRemoval).toBe(false);

  const image = await page.evaluate(
    (url) =>
      new Promise<{ width: number; height: number; quadrants: number[][] }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          const sample = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
          resolve({
            width: img.naturalWidth,
            height: img.naturalHeight,
            quadrants: [sample(300, 200), sample(1200, 200), sample(300, 900), sample(1200, 900)],
          });
        };
        img.onerror = () => reject(new Error("failed to decode flattened PNG"));
        img.src = url;
      }),
    result.dataUrl,
  );

  expect(image.width).toBe(1500);
  expect(image.height).toBe(1100);
  expect(image.quadrants).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
  ]);
});

/** Decode a data URL in-page and sample a handful of pixels from it. */
async function samplePixels(
  page: import("@playwright/test").Page,
  url: string,
  points: Array<[number, number]>,
): Promise<number[][]> {
  return page.evaluate(
    ({ url: src, points: pts }) =>
      new Promise<number[][]>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(image, 0, 0);
          resolve(pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data)));
        };
        image.onerror = () => reject(new Error("failed to decode sampled PNG"));
        image.src = src;
      }),
    { url, points },
  );
}

test("fill, mask/control conversion, and clip-to-boundary-box all work on a tiled raster layer", async ({
  page,
}) => {
  const setup = await page.evaluate(async () => {
    type Hook = NonNullable<TestWindow["__ultraPaintTest"]> & {
      paintToolStore: {
        setBrushSettings(settings: { color?: string; opacity?: number }): void;
      };
    };
    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook!.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    const canvas = document.createElement("canvas");
    canvas.width = 1500;
    canvas.height = 1100;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 750, 550);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(750, 0, 750, 550);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 550, 750, 550);
    ctx.fillStyle = "#ffff00";
    ctx.fillRect(750, 550, 750, 550);
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
    const id = await app.addImageFromFile(new File([blob], "quadrants.png", { type: blob.type }));
    const storageBeforeAnyEdit = hook!.layerStore.document.layers.find((l) => l.id === id)?.image
      .storage;

    // Read-only conversions must work directly off the tiled surface.
    const maskId = app.convertLayerToMask(id);
    const controlId = app.convertLayerToControl(id);
    const maskLayer = hook!.layerStore.document.layers.find((l) => l.id === maskId);
    const controlLayer = hook!.layerStore.document.layers.find((l) => l.id === controlId);

    // Fill a rect crossing all four tiles, then undo and redo it.
    hook!.layerStore.setSelectedLayerId(id);
    hook!.paintToolStore.setBrushSettings({ color: "#000000", opacity: 1 });
    hook!.layerStore.setBoundaryBox({ x: 600, y: 400, width: 300, height: 300 });
    app.fillSelectedLayer();
    const afterFillUrl = app.layerSourceDataURL(id)!;
    app.undo();
    const afterFillUndoUrl = app.layerSourceDataURL(id)!;
    app.redo();
    const afterFillRedoUrl = app.layerSourceDataURL(id)!;

    // Clip to a smaller box: downgrades the layer to a monolithic texture.
    hook!.layerStore.setBoundaryBox({ x: 200, y: 150, width: 1100, height: 800 });
    const clipped = app.clipLayerToBoundaryBox(id);
    // `.image` is mutated in place by undo/redo below, so snapshot each step
    // into a plain object instead of keeping a live reference to it.
    const afterClip = { ...hook!.layerStore.document.layers.find((l) => l.id === id)?.image };
    app.undo();
    const afterClipUndo = { ...hook!.layerStore.document.layers.find((l) => l.id === id)?.image };
    const tileCountAfterClipUndo = hook!.layerStore.getTiledSurface(id)?.tileCount;
    app.redo();
    const afterClipRedo = { ...hook!.layerStore.document.layers.find((l) => l.id === id)?.image };

    return {
      storageBeforeAnyEdit,
      maskKind: maskLayer?.kind,
      maskDims: { width: maskLayer?.image.width, height: maskLayer?.image.height },
      controlKind: controlLayer?.kind,
      controlDims: { width: controlLayer?.image.width, height: controlLayer?.image.height },
      afterFillUrl,
      afterFillUndoUrl,
      afterFillRedoUrl,
      clipped,
      afterClip,
      afterClipUndo,
      tileCountAfterClipUndo,
      afterClipRedo,
    };
  });

  expect(setup.storageBeforeAnyEdit).toBe("tiled");
  expect(setup.maskKind).toBe("mask");
  expect(setup.maskDims).toEqual({ width: 1500, height: 1100 });
  expect(setup.controlKind).toBe("control");
  expect(setup.controlDims).toEqual({ width: 1500, height: 1100 });

  // Points span all four tiles, inside vs. outside the {600,400,300,300} fill rect.
  const points: Array<[number, number]> = [
    [650, 450],
    [800, 450],
    [650, 600],
    [800, 600],
    [100, 100],
  ];
  const black = [0, 0, 0, 255];
  const original = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
    [255, 0, 0, 255],
  ];

  expect(await samplePixels(page, setup.afterFillUrl, points)).toEqual([
    black,
    black,
    black,
    black,
    original[4],
  ]);
  expect(await samplePixels(page, setup.afterFillUndoUrl, points)).toEqual(original);
  expect(await samplePixels(page, setup.afterFillRedoUrl, points)).toEqual([
    black,
    black,
    black,
    black,
    original[4],
  ]);

  expect(setup.clipped).toBe(true);
  expect(setup.afterClip?.storage).toBeUndefined();
  expect(setup.afterClip?.width).toBeLessThan(1500);
  expect(setup.afterClip?.height).toBeLessThan(1100);
  expect(setup.afterClipUndo?.storage).toBe("tiled");
  expect(setup.afterClipUndo?.width).toBe(1500);
  expect(setup.afterClipUndo?.height).toBe(1100);
  expect(setup.tileCountAfterClipUndo).toBe(4);
  expect(setup.afterClipRedo?.storage).toBeUndefined();
  expect(setup.afterClipRedo?.width).toBe(setup.afterClip?.width);
  expect(setup.afterClipRedo?.height).toBe(setup.afterClip?.height);
});
