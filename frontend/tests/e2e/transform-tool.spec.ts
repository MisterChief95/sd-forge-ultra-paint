import { expect, test, type Page } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type TestWindow = Window & {
  __transformSurface?: unknown;
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): TestApp | null;
    layerStore: TestStore;
  };
};

interface TestStore {
  setBoundaryBox(box: object): void;
  setSelectedLayerId(id: string): void;
  getLayer(id: string): { transform: Transform } | undefined;
  getTiledSurface(
    id: string,
  ): { diagnosticTileCoords(): Array<{ x: number; y: number }> } | undefined;
}

interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

interface TestContainer {
  toGlobal(point: { x: number; y: number }): { x: number; y: number };
  getChildByLabel(label: string): TestContainer | null;
}

interface TestApp {
  ready: Promise<void>;
  app: { renderer: { width: number; height: number } };
  tree: {
    root: TestContainer;
    getNode(id: string): { container: TestContainer } | undefined;
  };
  transformOverlay: { container: TestContainer };
  addBlankLayer(): Promise<string>;
  fillSelectedLayer(): void;
  fitToBoundaryBox(padding?: number): void;
  undo(): void;
}

async function openApp(page: Page): Promise<void> {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await page.goto("./");
  await page.waitForFunction(() => Boolean((window as TestWindow).__ultraPaintTest));
  await page.evaluate(async () => {
    await (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.ready;
  });
}

test("transform gizmo moves, rotates, scales, and mirrors a tiled layer", async ({ page }) => {
  await openApp(page);
  const id = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 256, height: 256 });
    const layerId = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(layerId);
    app.fillSelectedLayer();
    app.fitToBoundaryBox(16);
    (window as TestWindow).__transformSurface = hook.layerStore.getTiledSurface(layerId);
    return layerId;
  });

  await page.getByRole("button", { name: "Transform Layer" }).click();

  const move = await page.evaluate((layerId) => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp()!;
    const node = app.tree.getNode(layerId)!;
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas")!;
    const rect = canvas.getBoundingClientRect();
    const client = (point: { x: number; y: number }) => ({
      x: rect.x + (point.x * rect.width) / app.app.renderer.width,
      y: rect.y + (point.y * rect.height) / app.app.renderer.height,
    });
    return {
      from: client(node.container.toGlobal({ x: 128, y: 128 })),
      to: client(node.container.toGlobal({ x: 145, y: 145 })),
    };
  }, id);
  await page.mouse.move(move.from.x, move.from.y);
  await page.mouse.down();
  await page.mouse.move(move.to.x, move.to.y, { steps: 4 });
  await page.mouse.up();

  let transform = await page.evaluate(
    (layerId) => ({
      ...(window as TestWindow).__ultraPaintTest!.layerStore.getLayer(layerId)!.transform,
    }),
    id,
  );
  expect(transform.x).toBeCloseTo(32, 3);
  expect(transform.y).toBeCloseTo(32, 3);

  const fineMove = await page.evaluate((layerId) => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp()!;
    const node = app.tree.getNode(layerId)!;
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas")!;
    const rect = canvas.getBoundingClientRect();
    const client = (point: { x: number; y: number }) => ({
      x: rect.x + (point.x * rect.width) / app.app.renderer.width,
      y: rect.y + (point.y * rect.height) / app.app.renderer.height,
    });
    return {
      from: client(node.container.toGlobal({ x: 128, y: 128 })),
      to: client(node.container.toGlobal({ x: 109, y: 109 })),
    };
  }, id);
  await page.keyboard.down("Control");
  await page.mouse.move(fineMove.from.x, fineMove.from.y);
  await page.mouse.down();
  await page.mouse.move(fineMove.to.x, fineMove.to.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Control");

  transform = await page.evaluate(
    (layerId) => ({
      ...(window as TestWindow).__ultraPaintTest!.layerStore.getLayer(layerId)!.transform,
    }),
    id,
  );
  expect(transform.x).toBeCloseTo(16, 3);
  expect(transform.y).toBeCloseTo(16, 3);

  const freeScale = await page.evaluate((layerId) => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp()!;
    const node = app.tree.getNode(layerId)!;
    const handle = app.transformOverlay.container.getChildByLabel(
      "ultra-paint:transform-handle:scale-nw",
    )!;
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas")!;
    const rect = canvas.getBoundingClientRect();
    const client = (point: { x: number; y: number }) => ({
      x: rect.x + (point.x * rect.width) / app.app.renderer.width,
      y: rect.y + (point.y * rect.height) / app.app.renderer.height,
    });
    return {
      start: client(handle.toGlobal({ x: 0, y: 0 })),
      end: client(app.tree.root.toGlobal({ x: 64, y: 96 })),
      anchor: node.container.toGlobal({ x: 256, y: 256 }),
    };
  }, id);
  await page.mouse.move(freeScale.start.x, freeScale.start.y);
  await page.mouse.down();
  await page.mouse.move(freeScale.end.x, freeScale.end.y, { steps: 6 });
  await page.mouse.up();

  transform = await page.evaluate(
    (layerId) => ({
      ...(window as TestWindow).__ultraPaintTest!.layerStore.getLayer(layerId)!.transform,
    }),
    id,
  );
  expect(transform.scaleX).toBeCloseTo(0.8125, 4);
  expect(transform.scaleY).toBeCloseTo(0.6875, 4);
  const freeAspectRatio = transform.scaleX / transform.scaleY;

  const constrainedScale = await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp()!;
    const handle = app.transformOverlay.container.getChildByLabel(
      "ultra-paint:transform-handle:scale-nw",
    )!;
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas")!;
    const rect = canvas.getBoundingClientRect();
    const client = (point: { x: number; y: number }) => ({
      x: rect.x + (point.x * rect.width) / app.app.renderer.width,
      y: rect.y + (point.y * rect.height) / app.app.renderer.height,
    });
    return {
      start: client(handle.toGlobal({ x: 0, y: 0 })),
      end: client(app.tree.root.toGlobal({ x: 96, y: 128 })),
    };
  });
  await page.keyboard.down("Shift");
  await page.mouse.move(constrainedScale.start.x, constrainedScale.start.y);
  await page.mouse.down();
  await page.mouse.move(constrainedScale.end.x, constrainedScale.end.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  transform = await page.evaluate(
    (layerId) => ({
      ...(window as TestWindow).__ultraPaintTest!.layerStore.getLayer(layerId)!.transform,
    }),
    id,
  );
  expect(transform.scaleX / transform.scaleY).toBeCloseTo(freeAspectRatio, 5);
  const anchored = await page.evaluate((layerId) => {
    const app = (window as TestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!;
    return app.tree.getNode(layerId)!.container.toGlobal({ x: 256, y: 256 });
  }, id);
  expect(anchored.x).toBeCloseTo(freeScale.anchor.x, 4);
  expect(anchored.y).toBeCloseTo(freeScale.anchor.y, 4);
  const scaleBeforeMirror = { scaleX: transform.scaleX, scaleY: transform.scaleY };

  const rotation = await page.evaluate((layerId) => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp()!;
    const node = app.tree.getNode(layerId)!;
    const handle = app.transformOverlay.container.getChildByLabel(
      "ultra-paint:transform-handle:rotate",
    )!;
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas")!;
    const rect = canvas.getBoundingClientRect();
    const client = (point: { x: number; y: number }) => ({
      x: rect.x + (point.x * rect.width) / app.app.renderer.width,
      y: rect.y + (point.y * rect.height) / app.app.renderer.height,
    });
    const center = node.container.toGlobal({ x: 128, y: 128 });
    const start = handle.toGlobal({ x: 0, y: 0 });
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    return { start: client(start), end: client({ x: center.x + radius, y: center.y }) };
  }, id);
  await page.mouse.move(rotation.start.x, rotation.start.y);
  await page.mouse.down();
  await page.mouse.move(rotation.end.x, rotation.end.y, { steps: 6 });
  await page.mouse.up();

  transform = await page.evaluate(
    (layerId) => ({
      ...(window as TestWindow).__ultraPaintTest!.layerStore.getLayer(layerId)!.transform,
    }),
    id,
  );
  expect(transform.rotation).toBeCloseTo(Math.PI / 2, 2);

  await page.getByRole("button", { name: "Mirror selected layer horizontally" }).click();

  const result = await page.evaluate((layerId) => {
    const hook = (window as TestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp()!;
    const node = app.tree.getNode(layerId)!;
    const center = node.container.toGlobal({ x: 128, y: 128 });
    const surface = hook.layerStore.getTiledSurface(layerId);
    const current = { ...hook.layerStore.getLayer(layerId)!.transform };
    app.undo();
    return {
      current,
      afterUndo: { ...hook.layerStore.getLayer(layerId)!.transform },
      sameSurface: surface === (window as TestWindow).__transformSurface,
      tiles: surface?.diagnosticTileCoords(),
      center,
      centerAfterUndo: node.container.toGlobal({ x: 128, y: 128 }),
    };
  }, id);

  expect(result.current.scaleX).toBeCloseTo(-scaleBeforeMirror.scaleX, 4);
  expect(result.current.scaleY).toBeCloseTo(scaleBeforeMirror.scaleY, 4);
  expect(result.afterUndo.scaleX).toBeCloseTo(scaleBeforeMirror.scaleX, 4);
  expect(result.afterUndo.scaleY).toBeCloseTo(scaleBeforeMirror.scaleY, 4);
  expect(result.sameSurface).toBe(true);
  expect(result.tiles).toEqual([{ x: 0, y: 0 }]);
  expect(result.centerAfterUndo.x).toBeCloseTo(result.center.x, 4);
  expect(result.centerAfterUndo.y).toBeCloseTo(result.center.y, 4);
});
