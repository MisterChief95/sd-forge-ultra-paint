import { expect, test, type CDPSession, type Page } from "@playwright/test";

type TestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addBlankLayer(): Promise<string>;
      layerSourceDataURL(id: string): string | null;
      getZoom(): number;
    } | null;
    layerStore: { setSelectedLayerIds(ids: readonly string[]): void };
    paintToolStore: { setBrushSettings(settings: { color?: string; opacity?: number }): void };
  };
};

type Finger = { x: number; y: number; id: number };

test.use({ hasTouch: true });

// Real (trusted) touch input through CDP; synthetic DOM events are ignored by
// the gesture handler on purpose.
async function touch(cdp: CDPSession, type: string, fingers: Finger[]): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: fingers });
}

async function setupLayer(page: Page): Promise<string> {
  await page.goto("./");
  return page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    await app.ready;
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerIds([id]);
    hook.paintToolStore.setBrushSettings({ color: "#ff0000", opacity: 1 });
    return id;
  });
}

const layerState = (page: Page, id: string) =>
  page.evaluate((layerId) => {
    const app = (window as TestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!;
    return { pixels: app.layerSourceDataURL(layerId), zoom: app.getZoom() };
  }, id);

test("one finger paints; a second finger pinch-zooms and cancels the stroke", async ({ page }) => {
  const id = await setupLayer(page);
  const box = (await page.locator("#upaint-root canvas").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const blank = await layerState(page, id);

  // Finger starts painting, then a second finger lands and both spread apart.
  await touch(cdp, "touchStart", [{ id: 1, x: cx - 20, y: cy }]);
  await touch(cdp, "touchMove", [{ id: 1, x: cx - 40, y: cy }]);
  await touch(cdp, "touchStart", [
    { id: 1, x: cx - 40, y: cy },
    { id: 2, x: cx + 40, y: cy },
  ]);
  await touch(cdp, "touchMove", [
    { id: 1, x: cx - 120, y: cy },
    { id: 2, x: cx + 120, y: cy },
  ]);
  await touch(cdp, "touchEnd", []);

  const pinched = await layerState(page, id);
  expect(pinched.zoom).toBeGreaterThan(blank.zoom * 2);
  expect(pinched.pixels).toBe(blank.pixels);

  // A lone finger still paints afterwards.
  await touch(cdp, "touchStart", [{ id: 3, x: cx, y: cy }]);
  await touch(cdp, "touchMove", [{ id: 3, x: cx + 30, y: cy + 10 }]);
  await touch(cdp, "touchEnd", []);
  await expect.poll(async () => (await layerState(page, id)).pixels).not.toBe(blank.pixels);
});

test("long-pressing a layer row opens its menu and it stays open on release", async ({ page }) => {
  await setupLayer(page);
  const row = page.locator("[data-layer-kind='raster']").first();
  const box = (await row.boundingBox())!;
  const finger = { id: 1, x: box.x + box.width * 0.4, y: box.y + 10 };
  const cdp = await page.context().newCDPSession(page);

  await touch(cdp, "touchStart", [finger]);
  await page.waitForTimeout(700);
  await touch(cdp, "touchEnd", []);

  const menu = page.getByRole("menu", { name: "Context menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Move up" })).toBeVisible();
  // The release click was swallowed, so the name button didn't start a rename.
  await expect(page.getByRole("textbox", { name: /^Rename/ })).toHaveCount(0);
});

test("the Pan tool pans with one finger and the zoom buttons zoom", async ({ page }) => {
  const id = await setupLayer(page);
  const box = (await page.locator("#upaint-root canvas").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const worldX = () =>
    page.evaluate(
      () =>
        (
          (window as TestWindow).__ultraPaintTest!.getActiveUltraPaintApp() as unknown as {
            world: { x: number };
          }
        ).world.x,
    );
  const blank = await layerState(page, id);
  const startX = await worldX();

  await page.getByRole("button", { name: "Pan", exact: true }).click();
  await touch(cdp, "touchStart", [{ id: 1, x: cx, y: cy }]);
  await touch(cdp, "touchMove", [{ id: 1, x: cx + 80, y: cy }]);
  await touch(cdp, "touchEnd", []);
  expect(await worldX()).toBeGreaterThan(startX + 40);
  expect((await layerState(page, id)).pixels).toBe(blank.pixels);

  await page.getByRole("button", { name: "Zoom in" }).click();
  expect((await layerState(page, id)).zoom).toBeCloseTo(blank.zoom * 1.25);
  await page.getByRole("button", { name: "Zoom out" }).click();
  expect((await layerState(page, id)).zoom).toBeCloseTo(blank.zoom);
});
