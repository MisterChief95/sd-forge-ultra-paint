import { expect, test, type Page } from "@playwright/test";

import generateFixture from "../fixtures/generate.json" with { type: "json" };
import optionsFixture from "../fixtures/options.json" with { type: "json" };

interface TestWindow extends Window {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addBlankLayer(): Promise<string>;
      convertLayerToControl(id: string): string;
      flattenToDataURL(): string;
    } | null;
    layerStore: {
      document: { layers: Array<{ id: string; kind: string }> };
      removeLayer(id: string): void;
    };
    filterStore: { active: boolean };
    previewStore: { selected: unknown | null };
  };
}

async function openApp(page: Page): Promise<void> {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await page.goto("./");
  await page.waitForFunction(() => Boolean((window as TestWindow).__ultraPaintTest));
  await page.evaluate(async () => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    await app.ready;
  });
}

async function addBlankLayer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint app is unavailable");
    await app.addBlankLayer();
  });
}

async function paintCenteredStroke(page: Page): Promise<void> {
  const canvas = page.locator("#upaint-root canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
}

test("pending generation preview freezes canvas mutations and shows the disabled cursor", async ({
  page,
}) => {
  await openApp(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({ json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 } }),
  );
  await page.route("**/ultra_paint/api/generate", (route) =>
    route.fulfill({ json: generateFixture }),
  );
  await addBlankLayer(page);
  await page.locator("[data-layer-id]").first().click();

  const before = await page.evaluate(() =>
    (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.flattenToDataURL(),
  );
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "Generation previews" })).toBeVisible();
  const canvas = page.locator("#upaint-root canvas");
  await expect(canvas).toHaveCSS("cursor", "not-allowed");
  await expect(page.getByRole("button", { name: "Add a layer" })).toBeDisabled();
  await paintCenteredStroke(page);
  await page.keyboard.press("Shift+F");
  const after = await page.evaluate(() =>
    (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.flattenToDataURL(),
  );
  expect(after).toBe(before);

  await page.getByRole("button", { name: "Discard all previews" }).click();
  await expect(canvas).toHaveCSS("cursor", "none");
  await paintCenteredStroke(page);
  const painted = await page.evaluate(() =>
    (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.flattenToDataURL(),
  );
  expect(painted).not.toBe(before);
});

test("filter lock uses the disabled cursor and target removal cancels cleanly", async ({
  page,
}) => {
  await openApp(page);
  await page.route("**/ultra_paint/api/controlnet/module_list", (route) =>
    route.fulfill({ json: { module_list: ["lineart"] } }),
  );
  await addBlankLayer(page);
  const controlId = await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    const raster = hook?.layerStore.document.layers.find((layer) => layer.kind === "raster");
    if (!app || !raster) throw new Error("Control layer setup failed");
    return app.convertLayerToControl(raster.id);
  });

  await page.locator(`[data-layer-id="${controlId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Filter...", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: /Filter/ })).toBeVisible();
  await expect(page.locator("#upaint-root canvas")).toHaveCSS("cursor", "not-allowed");
  await page.evaluate(
    (id) => (window as TestWindow).__ultraPaintTest?.layerStore.removeLayer(id),
    controlId,
  );
  await expect
    .poll(() => page.evaluate(() => (window as TestWindow).__ultraPaintTest?.filterStore.active))
    .toBe(false);
  await expect(page.getByRole("toolbar", { name: /Filter/ })).toHaveCount(0);
});
