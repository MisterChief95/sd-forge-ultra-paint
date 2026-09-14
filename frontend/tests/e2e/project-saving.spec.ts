import { expect, test } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type ProjectLayer = {
  id: string;
  name: string;
  kind: string;
  opacity: number;
  blendMode: string;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
};

type ProjectTestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addBlankLayer(): Promise<string>;
      fillSelectedLayer(): void;
      layerSourceDataURL(id: string): string | null;
    } | null;
    layerStore: {
      document: { layers: ProjectLayer[] };
      setSelectedLayerId(id: string): void;
      setName(id: string, name: string): void;
      setOpacity(id: string, opacity: number): void;
      setBlendMode(id: string, mode: "multiply"): void;
      setTransform(id: string, transform: ProjectLayer["transform"]): void;
      setBoundaryBox(box: { x: number; y: number; width: number; height: number }): void;
    };
  };
};

test("saves and atomically reopens a tiled project", async ({ page }) => {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await page.route("**/ultra_paint/api/controlnet/model_list", (route) =>
    route.fulfill({ json: { model_list: [] } }),
  );
  await page.goto("./");
  await page.waitForFunction(() =>
    Boolean((window as ProjectTestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );

  const saved = await page.evaluate(async () => {
    const hook = (window as ProjectTestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    await app.ready;
    hook.layerStore.setBoundaryBox({ x: -32, y: 16, width: 64, height: 64 });
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    app.fillSelectedLayer();
    hook.layerStore.setName(id, "Portable layer");
    hook.layerStore.setOpacity(id, 0.625);
    hook.layerStore.setBlendMode(id, "multiply");
    hook.layerStore.setTransform(id, {
      x: -20,
      y: 30,
      scaleX: -1,
      scaleY: 1.25,
      rotation: 0.25,
    });
    return { id, png: app.layerSourceDataURL(id) };
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Project" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.uproj$/);
  const path = await download.path();
  expect(path).not.toBeNull();

  await page.evaluate(({ id }) => {
    const store = (window as ProjectTestWindow).__ultraPaintTest?.layerStore;
    store?.setName(id, "Changed after save");
    store?.setOpacity(id, 1);
  }, saved);

  page.once("dialog", (dialog) => dialog.accept());
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open Project" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path!);
  await expect(page.getByText("Project opened.")).toBeVisible();

  const reopened = await page.evaluate(({ id }) => {
    const hook = (window as ProjectTestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    const layer = hook?.layerStore.document.layers.find((candidate) => candidate.id === id);
    return { layer, png: app?.layerSourceDataURL(id) };
  }, saved);
  expect(reopened.layer).toMatchObject({
    name: "Portable layer",
    opacity: 0.625,
    blendMode: "multiply",
    transform: { x: -20, y: 30, scaleX: -1, scaleY: 1.25, rotation: 0.25 },
  });
  expect(reopened.png).toBe(saved.png);
});
