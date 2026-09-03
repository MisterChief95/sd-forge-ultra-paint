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
  image: { width: number; height: number };
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
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
      flattenMaskToDataURL(chunkSize?: number): string | null;
      resizeBoundaryBox(width: number, height: number): void;
      addImageFromFile(file: File): Promise<string>;
      addImageFromDataURL(url: string, name?: string, source?: string): Promise<string>;
      addMaskLayerFromFile(file: File): Promise<string>;
      mergeVisibleMasksToNewMask(): string;
      undo(): void;
      redo(): void;
    } | null;
    getRendererName(): string;
    layerStore: {
      setSelectedLayerId(id: string | null): void;
      setBoundaryBox(box: { x: number; y: number; width: number; height: number }): void;
      setTransform(id: string, value: TestLayer["transform"]): void;
      document: { layers: TestLayer[] };
      getTiledSurface(id: string): TestSurface | undefined;
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

test("a rotated layer keeps a fractional-zoom stroke continuous across four tile seams", async ({
  page,
}) => {
  const setup = await page.evaluate(async () => {
    type Hook = {
      getActiveUltraPaintApp(): { ready: Promise<void>; addBlankLayer(): Promise<string> } | null;
      layerStore: {
        setBoundaryBox(box: { x: number; y: number; width: number; height: number }): void;
        setSelectedLayerId(id: string): void;
        setTransform(
          id: string,
          transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
        ): void;
      };
      paintToolStore: {
        setBrushSettings(settings: {
          color?: string;
          radius?: number;
          hardness?: number;
          opacity?: number;
        }): void;
      };
    };
    type PrivateApp = {
      app: { renderer: { width: number; height: number } };
      world: { position: { set(x: number, y: number): void }; scale: { set(value: number): void } };
      tree: {
        getNode(id: string): {
          container: { toGlobal(point: { x: number; y: number }): { x: number; y: number } };
        };
      };
    };

    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // The diagonal crosses the corner shared by tiles (0,0), (1,0), (0,1), and
    // (1,1), with both a rotated layer and a 0.63 camera scale in effect.
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 2048, height: 2048 });
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    hook.layerStore.setTransform(id, {
      x: 180,
      y: 90,
      scaleX: 0.82,
      scaleY: 0.82,
      rotation: 0.31,
    });
    hook.paintToolStore.setBrushSettings({
      color: "#e11d48",
      radius: 64,
      hardness: 1,
      opacity: 1,
    });

    const privateApp = app as unknown as PrivateApp;
    const node = privateApp.tree.getNode(id);
    privateApp.world.scale.set(0.63);
    privateApp.world.position.set(0, 0);
    const seam = node.container.toGlobal({ x: 1024, y: 1024 });
    privateApp.world.position.set(
      privateApp.app.renderer.width / 2 - seam.x,
      privateApp.app.renderer.height / 2 - seam.y,
    );
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas");
    if (!canvas) throw new Error("Canvas is unavailable");
    const bounds = canvas.getBoundingClientRect();
    const toClient = (point: { x: number; y: number }) => {
      const global = node.container.toGlobal(point);
      return {
        x: bounds.x + (global.x * bounds.width) / privateApp.app.renderer.width,
        y: bounds.y + (global.y * bounds.height) / privateApp.app.renderer.height,
      };
    };
    return { id, from: toClient({ x: 960, y: 960 }), to: toClient({ x: 1088, y: 1088 }) };
  });

  await page.mouse.move(setup.from.x, setup.from.y);
  await page.mouse.down();
  await page.mouse.move(setup.to.x, setup.to.y, { steps: 24 });
  await page.mouse.up();

  const result = await page.evaluate(async (id) => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const surface = hook.layerStore.getTiledSurface(id);
    if (!surface) throw new Error("Painted tiled surface is unavailable");
    const seamPixels = await Promise.all(
      [
        { x: 1023, y: 1023 },
        { x: 1024, y: 1023 },
        { x: 1023, y: 1024 },
        { x: 1024, y: 1024 },
      ].map(async (point) => {
        let tile: TestVisit | null = null;
        surface.visit({ ...point, width: 1, height: 1 }, (visit) => {
          tile = visit;
        });
        if (!tile) throw new Error(`Missing tile at ${point.x},${point.y}`);
        return hook.readTilePixel(tile.target, point.x - tile.originX, point.y - tile.originY);
      }),
    );
    return { coords: surface.diagnosticTileCoords(), seamPixels };
  }, setup.id);

  expect(result.coords).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ]);
  expect(result.seamPixels).toEqual([
    [225, 29, 72, 255],
    [225, 29, 72, 255],
    [225, 29, 72, 255],
    [225, 29, 72, 255],
  ]);
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

test("stitches a forced multi-chunk mask export pixel-identically", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;
    app.resizeBoundaryBox(23, 19);
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    app.fillSelectedLayer();
    app.convertLayerToMask(id);

    const singleChunk = app.flattenMaskToDataURL(64);
    const manyChunks = app.flattenMaskToDataURL(7);
    if (!singleChunk || !manyChunks) throw new Error("Mask export is unavailable");
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
    const surface = hook.layerStore.getTiledSurface(id);
    if (!surface) throw new Error("uploaded layer has no tiled surface");
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
      tileCoords,
      dataUrl,
      layerCountAfterUndo,
      survivedRedoTileCount,
      survivedRemoval,
    };
  });

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

test("pasting a multi-tile image as a mask converts tile-by-tile, straight off the ingested surface", async ({
  page,
}) => {
  const setup = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // Same 1500x1100 quadrant image as the upload/conversion tests -- spans
    // a 2x2 tile grid at the default 1024 tile size.
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

    const maskId = await app.addMaskLayerFromFile(
      new File([blob], "quadrants.png", { type: blob.type }),
    );
    const maskLayer = hook.layerStore.document.layers.find((l) => l.id === maskId);
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 1500, height: 1100 });
    const maskUrl = app.flattenMaskToDataURL()!;

    return {
      kind: maskLayer?.kind,
      dims: { width: maskLayer?.image.width, height: maskLayer?.image.height },
      transform: maskLayer?.transform,
      maskUrl,
    };
  });

  expect(setup.kind).toBe("mask");
  expect(setup.dims).toEqual({ width: 1500, height: 1100 });
  expect(setup.transform).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });

  const quadrantPoints: Array<[number, number]> = [
    [300, 200],
    [1200, 200],
    [300, 900],
    [1200, 900],
  ];
  const maskGray = (r: number, g: number, b: number) =>
    Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  expect(await samplePixels(page, setup.maskUrl, quadrantPoints)).toEqual([
    [maskGray(255, 0, 0), maskGray(255, 0, 0), maskGray(255, 0, 0), 255],
    [maskGray(0, 255, 0), maskGray(0, 255, 0), maskGray(0, 255, 0), 255],
    [maskGray(0, 0, 255), maskGray(0, 0, 255), maskGray(0, 0, 255), 255],
    [maskGray(255, 255, 0), maskGray(255, 255, 0), maskGray(255, 255, 0), 255],
  ]);
});

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
    const sourceTransform = {
      ...hook!.layerStore.document.layers.find((l) => l.id === id)!.transform,
    };

    // Read-only conversions must work tile-by-tile, straight off the tiled
    // surface, with no full-boundary-box flatten in between.
    const maskId = app.convertLayerToMask(id);
    const controlId = app.convertLayerToControl(id);
    const maskLayer = hook!.layerStore.document.layers.find((l) => l.id === maskId);
    const controlLayer = hook!.layerStore.document.layers.find((l) => l.id === controlId);
    const maskUrl = app.flattenMaskToDataURL()!;
    const controlUrl = app.layerSourceDataURL(controlId)!;

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

    // Clip to a smaller box: its bottom edge (y=950) stays above the tile
    // boundary at y=1024, so the entire bottom tile row falls fully outside it.
    hook!.layerStore.setBoundaryBox({ x: 200, y: 150, width: 1100, height: 800 });
    const clipped = app.clipLayerToBoundaryBox(id);
    const tileCountAfterClip = hook!.layerStore.getTiledSurface(id)?.tileCount;
    const afterClipUrl = app.layerSourceDataURL(id)!;
    app.undo();
    const tileCountAfterClipUndo = hook!.layerStore.getTiledSurface(id)?.tileCount;
    app.redo();
    const tileCountAfterClipRedo = hook!.layerStore.getTiledSurface(id)?.tileCount;

    hook!.layerStore.setBoundaryBox({ x: 2000, y: 2000, width: 100, height: 100 });
    const noOverlapClipped = app.clipLayerToBoundaryBox(id);
    const tileCountAfterNoOverlap = hook!.layerStore.getTiledSurface(id)?.tileCount;

    return {
      sourceTransform,
      maskKind: maskLayer?.kind,
      maskDims: { width: maskLayer?.image.width, height: maskLayer?.image.height },
      maskTransform: maskLayer?.transform,
      maskUrl,
      controlKind: controlLayer?.kind,
      controlDims: { width: controlLayer?.image.width, height: controlLayer?.image.height },
      controlTransform: controlLayer?.transform,
      controlUrl,
      afterFillUrl,
      afterFillUndoUrl,
      afterFillRedoUrl,
      clipped,
      tileCountAfterClip,
      afterClipUrl,
      tileCountAfterClipUndo,
      tileCountAfterClipRedo,
      noOverlapClipped,
      tileCountAfterNoOverlap,
    };
  });

  expect(setup.maskKind).toBe("mask");
  expect(setup.maskDims).toEqual({ width: 1500, height: 1100 });
  expect(setup.maskTransform).toEqual(setup.sourceTransform);
  expect(setup.controlKind).toBe("control");
  expect(setup.controlDims).toEqual({ width: 1500, height: 1100 });
  expect(setup.controlTransform).toEqual(setup.sourceTransform);

  // A per-tile luminance conversion of solid red/green/blue/yellow quadrants
  // must land as the correct per-channel-weighted gray in each quadrant, at
  // the right position -- catching a broken or misaligned per-tile loop.
  const quadrantPoints: Array<[number, number]> = [
    [300, 200],
    [1200, 200],
    [300, 900],
    [1200, 900],
  ];
  const maskGray = (r: number, g: number, b: number) =>
    Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  expect(await samplePixels(page, setup.maskUrl, quadrantPoints)).toEqual([
    [maskGray(255, 0, 0), maskGray(255, 0, 0), maskGray(255, 0, 0), 255],
    [maskGray(0, 255, 0), maskGray(0, 255, 0), maskGray(0, 255, 0), 255],
    [maskGray(0, 0, 255), maskGray(0, 0, 255), maskGray(0, 0, 255), 255],
    [maskGray(255, 255, 0), maskGray(255, 255, 0), maskGray(255, 255, 0), 255],
  ]);
  // Control conversion is a bit-for-bit copy: the quadrant colors carry over exactly.
  expect(await samplePixels(page, setup.controlUrl, quadrantPoints)).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
  ]);

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
  expect(setup.tileCountAfterClip).toBe(2);
  expect(setup.tileCountAfterClipUndo).toBe(4);
  expect(setup.tileCountAfterClipRedo).toBe(2);
  expect(await samplePixels(page, setup.afterClipUrl, [[1000, 350]])).toEqual([[0, 255, 0, 255]]);
  expect(setup.noOverlapClipped).toBe(false);
  expect(setup.tileCountAfterNoOverlap).toBe(2);
});

test("Clip to BBox deallocates transparent corner tiles from a rotated tiled layer", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    const canvas = document.createElement("canvas");
    canvas.width = 3072;
    canvas.height = 3072;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context is unavailable");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("toBlob failed"))),
        "image/png",
      ),
    );
    const id = await app.addImageFromFile(new File([blob], "solid.png", { type: blob.type }));

    // In layer-local space this document-space square becomes a diamond centered
    // at (1536, 1536). Its AABB reaches all nine source tiles, but the four
    // corner tiles have no covered pixels after the rotated clip.
    hook.layerStore.setTransform(id, {
      x: 1500,
      y: 500,
      scaleX: 1,
      scaleY: 1,
      rotation: Math.PI / 4,
    });
    hook.layerStore.setBoundaryBox({ x: 800, y: 1972, width: 1400, height: 1400 });
    const tileCountBeforeClip = hook.layerStore.getTiledSurface(id)?.tileCount;
    const clipped = app.clipLayerToBoundaryBox(id);

    return {
      clipped,
      tileCountBeforeClip,
      tileCoordsAfterClip: hook.layerStore.getTiledSurface(id)?.diagnosticTileCoords(),
    };
  });

  expect(result.clipped).toBe(true);
  expect(result.tileCountBeforeClip).toBe(9);
  expect(result.tileCoordsAfterClip).toEqual([
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 1, y: 2 },
  ]);
});

test("Clip to BBox snaps a fractionally-positioned unrotated layer to a crisp, fully opaque edge", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    type Hook = NonNullable<TestWindow["__ultraPaintTest"]> & {
      paintToolStore: { setBrushSettings(settings: { color?: string; opacity?: number }): void };
    };
    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 300, height: 250 });
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    hook.paintToolStore.setBrushSettings({ color: "#ff0000", opacity: 1 });
    app.fillSelectedLayer();

    // A fractional position -- e.g. left behind by a Transform-tool nudge or
    // a paste -- puts this layer's pixels off the document's integer grid.
    const before = hook.layerStore.document.layers.find((l) => l.id === id)!;
    hook.layerStore.setTransform(id, {
      ...before.transform,
      x: before.transform.x - 0.4,
      y: before.transform.y - 0.4,
    });

    hook.layerStore.setBoundaryBox({ x: 50, y: 50, width: 200, height: 150 });
    const clipped = app.clipLayerToBoundaryBox(id);
    const after = hook.layerStore.document.layers.find((l) => l.id === id)!;
    const dataUrl = app.flattenToDataURL();

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let minAlpha = 255;
    for (let i = 3; i < data.length; i += 4) minAlpha = Math.min(minAlpha, data[i]);

    return { clipped, transform: after.transform, minAlpha };
  });

  expect(result.clipped).toBe(true);
  // -0 from Math.round(-0.4) is numerically 0; only exact-equality assertions
  // (like Playwright's toBe) can tell the difference.
  expect(Object.is(result.transform.x, -0) ? 0 : result.transform.x).toBe(0);
  expect(Object.is(result.transform.y, -0) ? 0 : result.transform.y).toBe(0);
  // Before the fix this was ~100: a soft, partially-transparent edge band
  // instead of a crisp match to the boundary box.
  expect(result.minAlpha).toBe(255);
});

test("brush and eraser strokes paint and undo/redo correctly on a tiled raster layer", async ({
  page,
}) => {
  const setup = await page.evaluate(async () => {
    type Hook = NonNullable<TestWindow["__ultraPaintTest"]> & {
      paintToolStore: {
        setBrushSettings(settings: {
          color?: string;
          radius?: number;
          hardness?: number;
          opacity?: number;
          pressureEnabled?: boolean;
        }): void;
      };
    };
    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook!.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // A single solid-color tile (well under the 1024 tile size) keeps this
    // focused on the stroke/commit/history mechanics, not multi-tile crossing
    // (already exercised for Fill above, which uses the same edit/transaction API).
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#202020";
    ctx.fillRect(0, 0, 400, 300);
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
    const id = await app.addImageFromFile(new File([blob], "solid.png", { type: blob.type }));

    hook!.layerStore.setSelectedLayerId(id);
    hook!.paintToolStore.setBrushSettings({
      color: "#ffffff",
      radius: 40,
      hardness: 1,
      opacity: 1,
      pressureEnabled: false,
    });

    return { id };
  });

  // Upload auto-sizes the boundary box to the image and centers the camera on
  // it at zoom 1, so canvas-center == document/layer-local center (200, 150).
  const canvasLocator = page.locator("#upaint-root canvas");
  const bounds = await canvasLocator.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.mouse.move(centerX - 80, centerY - 50);
  await page.mouse.down();
  await page.mouse.move(centerX + 80, centerY - 50, { steps: 8 });
  await page.mouse.up();

  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  await page.mouse.move(centerX - 80, centerY + 50);
  await page.mouse.down();
  await page.mouse.move(centerX + 80, centerY + 50, { steps: 8 });
  await page.mouse.up();

  const result = await page.evaluate((id) => {
    const app = (window as TestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!;
    const afterStrokesUrl = app.layerSourceDataURL(id)!;
    app.undo(); // undo eraser
    const afterEraserUndoUrl = app.layerSourceDataURL(id)!;
    app.redo(); // redo eraser
    const afterEraserRedoUrl = app.layerSourceDataURL(id)!;
    app.undo(); // undo eraser again
    app.undo(); // undo brush
    const afterBrushUndoUrl = app.layerSourceDataURL(id)!;
    app.redo(); // redo brush (eraser stays undone)
    const afterBrushRedoUrl = app.layerSourceDataURL(id)!;
    return {
      afterStrokesUrl,
      afterEraserUndoUrl,
      afterEraserRedoUrl,
      afterBrushUndoUrl,
      afterBrushRedoUrl,
    };
  }, setup.id);

  const brushPoint: Array<[number, number]> = [[200, 100]];
  const eraserPoint: Array<[number, number]> = [[200, 200]];
  const white = [255, 255, 255, 255];
  const gray = [32, 32, 32, 255];

  expect(await samplePixels(page, result.afterStrokesUrl, brushPoint)).toEqual([white]);
  const erased = await samplePixels(page, result.afterStrokesUrl, eraserPoint);
  expect(erased[0]![3]).toBe(0);

  expect(await samplePixels(page, result.afterEraserUndoUrl, eraserPoint)).toEqual([gray]);
  const erasedAgain = await samplePixels(page, result.afterEraserRedoUrl, eraserPoint);
  expect(erasedAgain[0]![3]).toBe(0);

  expect(await samplePixels(page, result.afterBrushUndoUrl, brushPoint)).toEqual([gray]);
  expect(await samplePixels(page, result.afterBrushRedoUrl, brushPoint)).toEqual([white]);
});

test("blank layers and generated-Apply images ingest through the tiled surface", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // Sizes the very first layer (adding it re-origins an empty document's
    // boundary box to (0, 0), same as the existing monolithic path).
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 500, height: 400 });

    const blankId = await app.addBlankLayer();
    const blankSurface = hook.layerStore.getTiledSurface(blankId);
    const blankLayer = hook.layerStore.document.layers.find((l) => l.id === blankId);
    const blankTileCountBeforeFill = blankSurface?.tileCount;

    // A blank tiled layer must still be paintable: Fill should allocate tiles.
    hook.layerStore.setSelectedLayerId(blankId);
    app.fillSelectedLayer();
    const tileCountAfterFill = hook.layerStore.getTiledSurface(blankId)?.tileCount;

    // Reposition away from the origin now that the document is no longer
    // empty, so a missing setTransform after generated-Apply ingestion
    // (which must NOT re-origin the box the way first-layer creation does)
    // would show up as a bug.
    hook.layerStore.setBoundaryBox({ x: 300, y: 200, width: 120, height: 90 });

    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(0, 0, 120, 90);
    const dataUrl = canvas.toDataURL("image/png");

    const generatedId = await app.addImageFromDataURL(dataUrl, "Generated", "generated");
    const generatedLayer = hook.layerStore.document.layers.find((l) => l.id === generatedId);

    return {
      blankDims: { width: blankLayer?.image.width, height: blankLayer?.image.height },
      blankTileCountBeforeFill,
      tileCountAfterFill,
      generatedTransform: generatedLayer ? { ...generatedLayer.transform } : undefined,
      generatedDims: { width: generatedLayer?.image.width, height: generatedLayer?.image.height },
    };
  });

  expect(result.blankDims).toEqual({ width: 500, height: 400 });
  expect(result.blankTileCountBeforeFill).toBe(0);
  expect(result.tileCountAfterFill).toBeGreaterThan(0);

  expect(result.generatedDims).toEqual({ width: 120, height: 90 });
  expect(result.generatedTransform).toEqual({ x: 300, y: 200, scaleX: 1, scaleY: 1, rotation: 0 });
});

test("generated tiled rasters stay below their Mask and ControlNet sections", async ({ page }) => {
  const order = await page.evaluate(async () => {
    type AppWithTree = NonNullable<
      ReturnType<NonNullable<TestWindow["__ultraPaintTest"]>["getActiveUltraPaintApp"]>
    > & {
      tree?: {
        root: { children: unknown[] };
        getNode(id: string): { container: unknown } | undefined;
      };
    };
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp() as AppWithTree | null;
    if (!app?.tree) throw new Error("Ultra Paint scene tree is unavailable");
    await app.ready;

    const rasterId = await app.addBlankLayer();
    const controlId = app.convertLayerToControl(rasterId);
    const maskId = app.convertLayerToMask(rasterId);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const generatedId = await app.addImageFromDataURL(canvas.toDataURL("image/png"));

    const indexOf = (id: string) => {
      const node = app.tree?.getNode(id);
      if (!node) throw new Error(`Layer node "${id}" is unavailable`);
      return app.tree.root.children.indexOf(node.container);
    };
    return {
      mask: indexOf(maskId),
      control: indexOf(controlId),
      generated: indexOf(generatedId),
    };
  });

  // Pixi draws later children on top: Mask -> ControlNet -> Raster.
  expect(order.mask).toBeGreaterThan(order.control);
  expect(order.control).toBeGreaterThan(order.generated);
});

/** Whether `url`'s decoded PNG contains any opaque pixel matching `rgb` exactly. */
async function hasExactColor(
  page: import("@playwright/test").Page,
  url: string,
  rgb: [number, number, number],
): Promise<boolean> {
  return page.evaluate(
    ({ url: src, rgb: target }) =>
      new Promise<boolean>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(image, 0, 0);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 0; i < data.length; i += 4) {
            if (
              data[i] === target[0] &&
              data[i + 1] === target[1] &&
              data[i + 2] === target[2] &&
              (data[i + 3] ?? 0) > 0
            ) {
              resolve(true);
              return;
            }
          }
          resolve(false);
        };
        image.onerror = () => reject(new Error("failed to decode sampled PNG"));
        image.src = src;
      }),
    { url, rgb },
  );
}

test("merging visible layers composites chunk-by-chunk into a tiled surface, without leaking debug tile borders", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    type Hook = NonNullable<TestWindow["__ultraPaintTest"]> & {
      paintToolStore: { setBrushSettings(settings: { color?: string; opacity?: number }): void };
      getActiveUltraPaintApp(): ReturnType<
        NonNullable<TestWindow["__ultraPaintTest"]>["getActiveUltraPaintApp"]
      > & {
        mergeVisibleLayersToNewLayer(): string;
        setTileDebugBorders(visible: boolean): void;
      };
    };
    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook!.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // 1200x1200 spans a 2x2 grid at the default 1024 tile size.
    hook!.layerStore.setBoundaryBox({ x: 0, y: 0, width: 1200, height: 1200 });

    const redId = await app.addBlankLayer();
    hook!.layerStore.setSelectedLayerId(redId);
    hook!.paintToolStore.setBrushSettings({ color: "#ff0000", opacity: 1 });
    app.fillSelectedLayer();

    // Opaque blue on top fully occludes the red layer, so a correct
    // chunk-by-chunk merge reads as pure solid blue everywhere -- including
    // exactly at the tile seams -- with no need to reason about blending.
    const blueId = await app.addBlankLayer();
    hook!.layerStore.setSelectedLayerId(blueId);
    hook!.paintToolStore.setBrushSettings({ color: "#0000ff", opacity: 1 });
    app.fillSelectedLayer();

    const mergedId = app.mergeVisibleLayersToNewLayer();
    const mergedTileCount = hook!.layerStore.getTiledSurface(mergedId)?.tileCount;
    const mergedUrl = app.layerSourceDataURL(mergedId)!;

    app.setTileDebugBorders(true);
    const flattenedWithBordersOn = app.flattenToDataURL();
    const remergedId = app.mergeVisibleLayersToNewLayer();
    const remergedWithBordersOnUrl = app.layerSourceDataURL(remergedId)!;
    app.setTileDebugBorders(false);

    return {
      mergedTileCount,
      mergedUrl,
      flattenedWithBordersOn,
      remergedWithBordersOnUrl,
    };
  });

  expect(result.mergedTileCount).toBe(4);

  const seamAdjacentPoints: Array<[number, number]> = [
    [10, 10],
    [1190, 10],
    [10, 1190],
    [1190, 1190],
    [1020, 600],
    [1028, 600],
    [600, 1020],
    [600, 1028],
  ];
  const blue = [0, 0, 255, 255];
  expect(await samplePixels(page, result.mergedUrl, seamAdjacentPoints)).toEqual(
    seamAdjacentPoints.map(() => blue),
  );

  for (const url of [result.flattenedWithBordersOn, result.remergedWithBordersOnUrl]) {
    expect(await samplePixels(page, url, seamAdjacentPoints)).toEqual(
      seamAdjacentPoints.map(() => blue),
    );
    expect(await hasExactColor(page, url, [0, 255, 0])).toBe(false);
  }
});

test("merging layers keeps every layer's content even when the boundary box sits elsewhere", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    type Hook = NonNullable<TestWindow["__ultraPaintTest"]> & {
      paintToolStore: { setBrushSettings(settings: { color?: string; opacity?: number }): void };
      getActiveUltraPaintApp(): ReturnType<
        NonNullable<TestWindow["__ultraPaintTest"]>["getActiveUltraPaintApp"]
      > & {
        mergeVisibleLayersToNewLayer(): string;
      };
    };
    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook!.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // Three 100x100 boxes stacked 150px apart, each painted onto its own
    // layer by moving the boundary box to that box's slot before filling.
    const slots: Array<{ y: number; color: string }> = [
      { y: 0, color: "#ff0000" },
      { y: 150, color: "#00ff00" },
      { y: 300, color: "#0000ff" },
    ];
    for (const slot of slots) {
      hook!.layerStore.setBoundaryBox({ x: 0, y: slot.y, width: 100, height: 100 });
      const id = await app.addBlankLayer();
      hook!.layerStore.setSelectedLayerId(id);
      hook!.paintToolStore.setBrushSettings({ color: slot.color, opacity: 1 });
      app.fillSelectedLayer();
    }

    // Move the boundary box completely off of the painted content before merging.
    hook!.layerStore.setBoundaryBox({ x: 5000, y: 5000, width: 50, height: 50 });

    const mergedId = app.mergeVisibleLayersToNewLayer();
    const mergedLayer = hook!.layerStore.document.layers.find((l) => l.id === mergedId);
    const mergedUrl = app.layerSourceDataURL(mergedId)!;

    return { transform: mergedLayer?.transform, mergedUrl };
  });

  // Content starts at document (0,0) (box 1's top-left), so merged-layer-local
  // coordinates line up with document coordinates.
  expect(result.transform?.x).toBe(0);
  expect(result.transform?.y).toBe(0);

  const points: Array<[number, number]> = [
    [50, 50], // inside box 1
    [50, 200], // inside box 2
    [50, 350], // inside box 3
    [50, 125], // gap between box 1 and box 2 -- should stay transparent
  ];
  const [red, green, blue, gap] = await samplePixels(page, result.mergedUrl, points);
  expect(red).toEqual([255, 0, 0, 255]);
  expect(green).toEqual([0, 255, 0, 255]);
  expect(blue).toEqual([0, 0, 255, 255]);
  expect(gap?.[3]).toBe(0);
});

test("merging layers scans actual painted pixels for bounds instead of the tile-quantized sprite footprint", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    type Hook = NonNullable<TestWindow["__ultraPaintTest"]> & {
      paintToolStore: { setBrushSettings(settings: { color?: string; opacity?: number }): void };
      getActiveUltraPaintApp(): ReturnType<
        NonNullable<TestWindow["__ultraPaintTest"]>["getActiveUltraPaintApp"]
      > & {
        mergeLayersToNewLayer(ids: string[]): string;
      };
    };
    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook!.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // A throwaway first layer at the default box -- adding the very first
    // layer of a document snaps the boundary box to (0, 0), so this dodges
    // that reset before positioning the boundary box off-origin below. It's
    // excluded from the merge by id, not by visibility.
    await app.addBlankLayer();

    // A small paint region well inside a single default-sized (1024) tile,
    // nowhere near a tile boundary. The old sprite-bounds approach reported
    // the *whole* allocated tile as content; a correct merge hugs the 40x25
    // painted rectangle instead.
    hook!.layerStore.setBoundaryBox({ x: 300, y: 300, width: 40, height: 25 });

    const ids: string[] = [];
    for (const color of ["#ff0000", "#00ff00"]) {
      const id = await app.addBlankLayer();
      hook!.layerStore.setSelectedLayerId(id);
      hook!.paintToolStore.setBrushSettings({ color, opacity: 1 });
      app.fillSelectedLayer();
      ids.push(id);
    }

    const mergedId = app.mergeLayersToNewLayer(ids);
    const mergedLayer = hook!.layerStore.document.layers.find((l) => l.id === mergedId);
    return { transform: mergedLayer?.transform, image: mergedLayer?.image };
  });

  expect(result.transform?.x).toBe(300);
  expect(result.transform?.y).toBe(300);
  expect(result.image?.width).toBe(40);
  expect(result.image?.height).toBe(25);
});

test("merging visible masks composites chunk-by-chunk into a tiled mask surface", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    type Hook = NonNullable<TestWindow["__ultraPaintTest"]> & {
      paintToolStore: { setBrushSettings(settings: { color?: string; opacity?: number }): void };
      getActiveUltraPaintApp(): ReturnType<
        NonNullable<TestWindow["__ultraPaintTest"]>["getActiveUltraPaintApp"]
      > & {
        mergeVisibleMasksToNewMask(): string;
      };
    };
    const hook = (window as TestWindow).__ultraPaintTest as unknown as Hook;
    const app = hook!.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.ready;

    // 1200x1200 spans a 2x2 grid at the default 1024 tile size, same as the
    // raster-merge test above.
    hook!.layerStore.setBoundaryBox({ x: 0, y: 0, width: 1200, height: 1200 });

    // Full-coverage (white -> alpha 255) mask, occluded underneath.
    const redId = await app.addBlankLayer();
    hook!.layerStore.setSelectedLayerId(redId);
    hook!.paintToolStore.setBrushSettings({ color: "#ff0000", opacity: 1 });
    app.fillSelectedLayer();
    const bottomMaskId = app.convertLayerToMask(redId);

    // Fully opaque (white -> alpha 255) mask on top fully occludes the one
    // below, so a correct chunk-by-chunk merge reads as solid opaque white
    // everywhere -- including exactly at the tile seams.
    const whiteId = await app.addBlankLayer();
    hook!.layerStore.setSelectedLayerId(whiteId);
    hook!.paintToolStore.setBrushSettings({ color: "#ffffff", opacity: 1 });
    app.fillSelectedLayer();
    const topMaskId = app.convertLayerToMask(whiteId);
    hook!.layerStore.setSelectedLayerId(null);

    const mergedId = app.mergeVisibleMasksToNewMask();
    const mergedLayer = hook!.layerStore.document.layers.find((l) => l.id === mergedId);
    const mergedTileCount = hook!.layerStore.getTiledSurface(mergedId)?.tileCount;
    // Read the merged layer's own pixels directly -- the pre-merge source
    // masks are still visible/present, so a full flattenMask() export would
    // double-count them.
    const mergedUrl = app.layerSourceDataURL(mergedId)!;

    return {
      topMaskId,
      bottomMaskId,
      transform: mergedLayer?.transform,
      mergedTileCount,
      mergedUrl,
    };
  });

  expect(result.topMaskId).not.toBe(result.bottomMaskId);
  expect(result.transform).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  expect(result.mergedTileCount).toBe(4);

  const seamAdjacentPoints: Array<[number, number]> = [
    [10, 10],
    [1190, 10],
    [10, 1190],
    [1190, 1190],
    [1020, 600],
    [1028, 600],
    [600, 1020],
    [600, 1028],
  ];
  const white = [255, 255, 255, 255];
  expect(await samplePixels(page, result.mergedUrl, seamAdjacentPoints)).toEqual(
    seamAdjacentPoints.map(() => white),
  );
});
