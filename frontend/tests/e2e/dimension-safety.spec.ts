import { expect, test, type Page } from "@playwright/test";

import { fitDimensions } from "../../src/util/dimensions";

interface BoundaryBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TestApp = {
  ready: Promise<void>;
  resizeBoundaryBox(width: number, height: number): void;
  addImageFromFile(file: File): Promise<string>;
  addImageFromDataURL(url: string): Promise<string>;
};

type TestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): TestApp | null;
    layerStore: {
      document: {
        boundaryBox: BoundaryBox;
        layers: Array<{ image?: { width: number; height: number } }>;
      };
      setBoundaryBox(box: BoundaryBox): void;
    };
  };
};

async function openApp(page: Page): Promise<void> {
  await test.step("open the app", async () => {
    await page.goto("./");
    await page.waitForFunction(() =>
      Boolean((window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
    );
    await page.evaluate(async () => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      await app.ready;
    });
  });
}

test("boundary-box mutations stay finite, integral, and within 8192px", async ({ page }) => {
  await openApp(page);
  const box = await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({
      x: 12.6,
      y: Number.POSITIVE_INFINITY,
      width: 99_999,
      height: -3,
    });
    hook.getActiveUltraPaintApp()?.resizeBoundaryBox(Number.NaN, Number.POSITIVE_INFINITY);
    return { ...hook.layerStore.document.boundaryBox };
  });

  expect(box).toEqual({ x: 13, y: 0, width: 8192, height: 1 });
});

test("oversized image dimensions are reduced before render-texture allocation", () => {
  expect(fitDimensions(9000, 4500)).toEqual({ width: 8192, height: 4096 });
});

test("uploaded and generated images use a bounded paintable pixel backing", async ({ page }) => {
  await openApp(page);
  const dimensions = await page.evaluate(async () => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!app || !hook) throw new Error("Ultra Paint test hook is unavailable");

    const encoded =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(encoded.split(",")[1]!), (char) => char.charCodeAt(0));
    await app.addImageFromFile(new File([bytes], "generated.png", { type: "image/png" }));
    await app.addImageFromDataURL(encoded);
    return hook.layerStore.document.layers.map((layer) => layer.image).filter(Boolean);
  });

  expect(dimensions).toEqual([
    { source: "upload", width: 1, height: 1, storage: "tiled" },
    { source: "generated", width: 1, height: 1 },
  ]);
});
