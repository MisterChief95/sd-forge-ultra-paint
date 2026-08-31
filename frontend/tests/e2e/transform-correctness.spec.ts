import { expect, test, type Page } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type TestWindow = Window & { __ultraPaintTest?: Record<string, unknown> };

interface TestNode {
  container: { toGlobal(point: object): { x: number; y: number } };
}

interface PrivateApp {
  tree: {
    root: { toLocal(point: object): { x: number; y: number } };
    getNode(id: string): TestNode;
  };
  app: { renderer: { width: number; height: number } };
}

async function openApp(page: Page): Promise<void> {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await page.goto("./");
  await page.waitForFunction(() => Boolean((window as TestWindow).__ultraPaintTest));
  await page.evaluate(async () => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp as
      (() => { ready: Promise<void> } | null) | undefined;
    await app?.()?.ready;
  });
}

async function layerAlpha(page: Page, id: string, x: number, y: number): Promise<number> {
  return page.evaluate(
    async ({ id: layerId, x: sampleX, y: sampleY }) => {
      const hook = (window as TestWindow).__ultraPaintTest as {
        getActiveUltraPaintApp(): { layerSourceDataURL(id: string): string | null } | null;
      };
      const url = hook.getActiveUltraPaintApp()?.layerSourceDataURL(layerId);
      if (!url) throw new Error("Layer texture is unavailable");
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas context is unavailable");
      context.drawImage(image, 0, 0);
      return context.getImageData(sampleX, sampleY, 1, 1).data[3] ?? 0;
    },
    { id, x, y },
  );
}

test("texture growth preserves painted pixels on a rotated flipped layer", async ({ page }) => {
  await openApp(page);
  const setup = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest as {
      getActiveUltraPaintApp(): { addBlankLayer(): Promise<string> } | null;
      layerStore: {
        setBoundaryBox(value: object): void;
        setSelectedLayerId(id: string): void;
        setTransform(id: string, value: object): void;
      };
      paintToolStore: { setBrushSettings(value: object): void };
    };
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 256, height: 256 });
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    hook.layerStore.setTransform(id, {
      x: 280,
      y: 170,
      scaleX: -1.1,
      scaleY: 0.8,
      rotation: 0.45,
    });
    hook.paintToolStore.setBrushSettings({ radius: 20, hardness: 1, opacity: 1 });

    const privateApp = app as unknown as PrivateApp;
    const node = privateApp.tree.getNode(id);
    const toClient = (point: { x: number; y: number }) => {
      const global = node.container.toGlobal(point);
      const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas");
      if (!canvas) throw new Error("Canvas is unavailable");
      const bounds = canvas.getBoundingClientRect();
      return {
        x: bounds.x + (global.x * bounds.width) / privateApp.app.renderer.width,
        y: bounds.y + (global.y * bounds.height) / privateApp.app.renderer.height,
      };
    };
    return {
      id,
      inside: toClient({ x: 100, y: 100 }),
      outside: toClient({ x: -10, y: -10 }),
      oldPixelGlobal: node.container.toGlobal({ x: 100, y: 100 }),
    };
  });

  await page.mouse.click(setup.inside.x, setup.inside.y);
  await page.mouse.click(setup.outside.x, setup.outside.y);

  const result = await page.evaluate((id) => {
    const hook = (window as TestWindow).__ultraPaintTest as {
      getActiveUltraPaintApp(): {
        getStore(): {
          getLayer(id: string): { image: { width: number; height: number } } | undefined;
        } | null;
      } | null;
    };
    const app = hook.getActiveUltraPaintApp();
    const privateApp = app as unknown as PrivateApp;
    const layer = app?.getStore().getLayer(id);
    if (!layer) throw new Error("Grown layer is unavailable");
    const node = privateApp.tree.getNode(id);
    return {
      width: layer.image.width,
      height: layer.image.height,
      oldPixelGlobal: node.container.toGlobal({
        x: layer.image.width - 256 + 100,
        y: layer.image.height - 256 + 100,
      }),
    };
  }, setup.id);

  expect(result.width).toBeGreaterThan(256);
  expect(result.height).toBeGreaterThan(256);
  expect(result.oldPixelGlobal.x).toBeCloseTo(setup.oldPixelGlobal.x, 5);
  expect(result.oldPixelGlobal.y).toBeCloseTo(setup.oldPixelGlobal.y, 5);
  expect(await layerAlpha(page, setup.id, result.width - 156, result.height - 156)).toBeGreaterThan(
    0,
  );
});

test("Clip to BBox clips through rotated flipped group transforms", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest as {
      getActiveUltraPaintApp(): {
        addBlankLayer(): Promise<string>;
        fillSelectedLayer(): void;
        clipLayerToBoundaryBox(id: string): boolean;
      } | null;
      layerStore: {
        document: {
          layers: Array<{ id: string; kind: string; parentId: string | null; children?: string[] }>;
          layerOrder: string[];
        };
        addGroupLayer(): string;
        setBoundaryBox(box: object): void;
        setSelectedLayerId(id: string): void;
        setTransform(id: string, value: object): void;
      };
    };
    const app = hook.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    app.fillSelectedLayer();
    const groupId = hook.layerStore.addGroupLayer();
    const layer = hook.layerStore.document.layers.find((candidate) => candidate.id === id);
    const group = hook.layerStore.document.layers.find((candidate) => candidate.id === groupId);
    if (!layer || !group?.children) throw new Error("Test group is unavailable");
    layer.parentId = groupId;
    group.children.push(id);
    hook.layerStore.document.layerOrder.splice(hook.layerStore.document.layerOrder.indexOf(id), 1);
    hook.layerStore.setTransform(groupId, {
      x: 150,
      y: 120,
      scaleX: -1.1,
      scaleY: 0.9,
      rotation: 0.4,
    });
    hook.layerStore.setTransform(id, {
      x: 120,
      y: 150,
      scaleX: 0.8,
      scaleY: -1.2,
      rotation: -0.25,
    });
    hook.layerStore.setBoundaryBox({ x: 64, y: 64, width: 128, height: 128 });
    if (!app.clipLayerToBoundaryBox(id)) throw new Error("Clip unexpectedly found no overlap");

    return { id };
  });

  // The layer source is sampled below through its live Pixi transform: every
  // opaque sample must remain inside the document boundary box after clipping.
  const coverage = await page.evaluate(async (id) => {
    const hook = (window as TestWindow).__ultraPaintTest as {
      getActiveUltraPaintApp(): { layerSourceDataURL(id: string): string | null } | null;
    };
    const app = hook.getActiveUltraPaintApp() as unknown as PrivateApp;
    const url = hook.getActiveUltraPaintApp()?.layerSourceDataURL(id);
    if (!url) throw new Error("Clipped layer texture is unavailable");
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context is unavailable");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const node = app.tree.getNode(id);
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < canvas.height; y += 4)
      for (let x = 0; x < canvas.width; x += 4) {
        if ((pixels[(y * canvas.width + x) * 4 + 3] ?? 0) < 128) continue;
        const point = app.tree.root.toLocal(node.container.toGlobal({ x, y }));
        if (point.x >= 63 && point.x <= 193 && point.y >= 63 && point.y <= 193) inside += 1;
        else outside += 1;
      }
    return { inside, outside };
  }, result.id);
  expect(coverage.inside).toBeGreaterThan(0);
  expect(coverage.outside).toBe(0);
});
