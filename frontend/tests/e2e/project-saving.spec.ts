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
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save Project" }).click();
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
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open Project" }).click();
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

test("project round-trip keeps soft alpha edge colours", async ({ page }) => {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await page.route("**/ultra_paint/api/controlnet/model_list", (route) =>
    route.fulfill({ json: { model_list: [] } }),
  );
  await page.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.goto("./");
  await page.waitForFunction(() =>
    Boolean((window as ProjectTestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );

  // A flat-colour disc with a soft alpha falloff: premultiplied-vs-straight
  // mistakes show up as darker RGB where alpha is partial.
  const softDisc = await page.evaluate(async () => {
    const hook = (window as ProjectTestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp() as unknown as {
      ready: Promise<void>;
      addImageFromDataURL(url: string): Promise<string>;
    };
    await app.ready;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    gradient.addColorStop(0, "rgba(220, 180, 120, 1)");
    gradient.addColorStop(1, "rgba(220, 180, 120, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const id = await app.addImageFromDataURL(canvas.toDataURL("image/png"));
    return { id };
  });

  const readEdge = (id: string) =>
    page.evaluate(async (layerId) => {
      const app = (window as ProjectTestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      const url = app?.layerSourceDataURL(layerId);
      if (!url) throw new Error("no pixels");
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Partial-alpha pixels only, as [r, g, b, a] rows.
      const edge: number[][] = [];
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]!;
        if (a > 40 && a < 220) edge.push([data[i]!, data[i + 1]!, data[i + 2]!, a]);
      }
      return edge;
    }, id);

  const before = await readEdge(softDisc.id);
  expect(before.length).toBeGreaterThan(50);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save Project" }).click();
  const path = await (await downloadPromise).path();

  page.once("dialog", (dialog) => dialog.accept());
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open Project" }).click();
  await (await chooserPromise).setFiles(path!);
  await expect(page.getByText("Project opened.")).toBeVisible();

  const after = await readEdge(softDisc.id);
  expect(after.length).toBe(before.length);
  for (const [index, pixel] of before.entries()) {
    for (let channel = 0; channel < 4; channel += 1) {
      expect(Math.abs(pixel[channel]! - after[index]![channel]!)).toBeLessThanOrEqual(3);
    }
  }
  // Colours must stay near the source colour, not premultiplied-dark.
  const avgRed = before.reduce((sum, pixel) => sum + pixel[0]!, 0) / before.length;
  expect(avgRed).toBeGreaterThan(200);
});
