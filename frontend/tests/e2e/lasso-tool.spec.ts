import { expect, test, type Page } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type TestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      flattenMaskToDataURL(): string | null;
      resizeBoundaryBox(width: number, height: number): void;
    } | null;
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
  await page.goto("./");
  await page.waitForFunction(() =>
    Boolean((window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );
  await page.evaluate(async () => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    await app.ready;
    app.resizeBoundaryBox(256, 256);
  });
});

async function addMask(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add a layer" }).click();
  await page.getByRole("menuitem", { name: "Mask Layer", exact: true }).click();
  await expect(page.locator('[data-layer-section="masks"] [data-layer-id]')).toHaveCount(1);
}

async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const bounds = await page.locator("#upaint-root canvas").boundingBox();
  if (!bounds) throw new Error("Canvas is unavailable");
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

async function polygon(
  page: Page,
  points: ReadonlyArray<readonly [number, number]>,
  modifiers: { altKey?: boolean; shiftKey?: boolean } = {},
): Promise<void> {
  const canvas = page.locator("#upaint-root canvas");
  for (const [x, y] of [...points, points[0]!]) {
    await canvas.dispatchEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientX: x,
      clientY: y,
      ...modifiers,
    });
    await canvas.dispatchEvent("pointerup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
      ...modifiers,
    });
  }
}

async function maskPixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ({ x, y }) => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      const url = app?.flattenMaskToDataURL();
      if (!url) return [0, 0, 0, 0];
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas context is unavailable");
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(x, y, 1, 1).data);
    },
    { x, y },
  );
}

test("lasso replaces, adds, subtracts, rejects crossings, and undoes atomically", async ({
  page,
}) => {
  const lasso = page.getByRole("button", { name: "Lasso mask coverage" });
  await expect(lasso).toBeDisabled();
  await addMask(page);
  await expect(lasso).toBeEnabled();
  await lasso.click();
  // Freehand is the default mode; this first shape is click-by-click.
  await page.getByRole("button", { name: "Polygon" }).click();

  const center = await canvasCenter(page);
  await polygon(page, [
    [center.x - 40, center.y - 40],
    [center.x + 40, center.y - 40],
    [center.x + 40, center.y + 40],
    [center.x - 40, center.y + 40],
  ]);
  await expect.poll(() => maskPixel(page, 128, 128)).toEqual([255, 255, 255, 255]);

  await page.keyboard.press("Control+Z");
  await expect.poll(() => maskPixel(page, 128, 128)).toEqual([0, 0, 0, 255]);
  await page.keyboard.press("Control+Shift+Z");

  await page.keyboard.down("Shift");
  await page.getByRole("button", { name: "Freehand" }).click();
  await page.mouse.move(center.x + 60, center.y - 25);
  await page.mouse.down();
  await page.mouse.move(center.x + 110, center.y - 25, { steps: 6 });
  await page.mouse.move(center.x + 110, center.y + 25, { steps: 6 });
  await page.mouse.move(center.x + 60, center.y + 25, { steps: 6 });
  await page.mouse.move(center.x + 60, center.y - 25, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(() => maskPixel(page, 208, 128)).toEqual([255, 255, 255, 255]);

  await page.getByRole("button", { name: "Polygon" }).click();
  await polygon(
    page,
    [
      [center.x - 20, center.y - 20],
      [center.x + 20, center.y - 20],
      [center.x + 20, center.y + 20],
      [center.x - 20, center.y + 20],
    ],
    { altKey: true },
  );
  await expect.poll(() => maskPixel(page, 128, 128)).toEqual([0, 0, 0, 255]);
  await expect.poll(() => maskPixel(page, 100, 128)).toEqual([255, 255, 255, 255]);

  await polygon(page, [
    [center.x - 35, center.y - 35],
    [center.x + 35, center.y + 35],
    [center.x + 35, center.y - 35],
    [center.x - 35, center.y + 35],
  ]);
  await expect.poll(() => maskPixel(page, 128, 128)).toEqual([0, 0, 0, 255]);
  await expect.poll(() => maskPixel(page, 100, 128)).toEqual([255, 255, 255, 255]);
  await page.keyboard.press("Escape");
});
