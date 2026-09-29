import { expect, test, type Page } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type HardeningTestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): { ready: Promise<void>; addBlankLayer(): Promise<string> } | null;
    layerStore: { setName(id: string, name: string): void };
  };
};

async function openApp(page: Page, autosaveStatus: number): Promise<{ uploads: number }> {
  const counter = { uploads: 0 };
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await page.route("**/ultra_paint/api/controlnet/model_list", (route) =>
    route.fulfill({ json: { model_list: [] } }),
  );
  await page.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route("**/ultra_paint/api/autosave", (route) => {
    counter.uploads += 1;
    return route.fulfill({ status: autosaveStatus, json: {} });
  });
  await page.goto("./");
  await page.waitForFunction(() =>
    Boolean((window as HardeningTestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );
  await page.evaluate(
    () => (window as HardeningTestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!.ready,
  );
  return counter;
}

function addLayer(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as HardeningTestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!.addBlankLayer(),
  );
}

/** Commit a document revision, then hide the tab. */
async function editAndHide(page: Page, id: string, name: string): Promise<void> {
  await page.evaluate(
    ({ id, name }) => {
      (window as HardeningTestWindow).__ultraPaintTest!.layerStore.setName(id, name);
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    },
    { id, name },
  );
}

test("hiding the tab saves immediately instead of waiting for the quiet interval", async ({
  page,
}) => {
  const counter = await openApp(page, 200);
  await editAndHide(page, await addLayer(page), "hidden save");
  // The quiet interval is 25s; a flush on hide lands well inside this window.
  await expect.poll(() => counter.uploads, { timeout: 5_000 }).toBe(1);
});

test("repeated autosave failures warn the user", async ({ page }) => {
  const counter = await openApp(page, 500);
  const id = await addLayer(page);
  await editAndHide(page, id, "first");
  await expect.poll(() => counter.uploads, { timeout: 5_000 }).toBe(1);
  await expect(page.getByText("Autosave is failing")).toHaveCount(0);
  await editAndHide(page, id, "second");
  await expect.poll(() => counter.uploads, { timeout: 5_000 }).toBe(2);
  await expect(page.getByText("Autosave is failing")).toBeVisible();
});

test("a lost graphics context freezes editing and never autosaves", async ({ page }) => {
  const counter = await openApp(page, 200);
  const id = await addLayer(page);
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas")!;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    gl!.getExtension("WEBGL_lose_context")!.loseContext();
  });
  await expect(page.getByRole("alertdialog", { name: "Canvas lost" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeFocused();

  await expect(addLayer(page)).rejects.toThrow("Document is locked");
  await editAndHide(page, id, "after loss");
  await page.waitForTimeout(1_000);
  expect(counter.uploads).toBe(0);
});
