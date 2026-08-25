import { expect, test, type Page } from "@playwright/test";

import generateFixture from "../fixtures/generate.json" with { type: "json" };
import optionsFixture from "../fixtures/options.json" with { type: "json" };
import { calculateAutoResolution } from "../../src/util/autoResolution";

interface BoundaryBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TestLayer {
  id?: string;
  name: string;
  kind?: "raster" | "group" | "mask";
  color?: string;
  visible?: boolean;
  image?: { source: string };
  transform: { x: number; y: number };
}

interface UltraPaintTestHook {
  getActiveUltraPaintApp(): {
    ready: Promise<void>;
    flattenToDataURL(): string;
    flattenMaskToDataURL(): string | null;
    addBlankLayer(): Promise<string>;
    resizeBoundaryBox(width: number, height: number): void;
    getZoom(): number;
    isGridVisible(): boolean;
  } | null;
  layerStore: {
    document: {
      boundaryBox: BoundaryBox;
      layers: TestLayer[];
    };
    setBoundaryBox(box: BoundaryBox): void;
    setSelectedLayerId(id: string | null): void;
    setVisible(id: string, visible: boolean): void;
    setTransform(id: string, transform: Partial<TestLayer["transform"]>): void;
  };
  paintToolStore: {
    readonly activeTool: "brush" | "eraser" | "boundary-box";
    readonly brush: {
      radius: number;
      hardness: number;
      opacity: number;
    };
    setBrushSettings(settings: {
      color?: string;
      radius?: number;
      hardness?: number;
      opacity?: number;
    }): void;
  };
}

type TestWindow = Window & { __ultraPaintTest?: UltraPaintTestHook };

async function routeOptions(page: Page): Promise<void> {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
}

async function openApp(page: Page): Promise<void> {
  await page.goto("./");
  await page.waitForFunction(
    () =>
      Boolean(
        (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp(),
      ),
  );
  await page.evaluate(async () => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    await app.ready;
  });
}

async function addBlankLayer(page: Page): Promise<void> {
  const before = await page.locator("[data-layer-id]").count();
  await page.getByRole("button", { name: "Add a layer" }).click();
  await page.getByRole("menuitem", { name: "Raster Layer", exact: true }).click();
  await expect(page.locator("[data-layer-id]")).toHaveCount(before + 1);
}

async function addMaskLayer(page: Page): Promise<void> {
  const masks = page.locator('[data-layer-section="masks"] [data-layer-id]');
  const before = await masks.count();
  await page.getByRole("button", { name: "Add a layer" }).click();
  await page.getByRole("menuitem", { name: "Mask Layer", exact: true }).click();
  await expect(masks).toHaveCount(before + 1);
}

async function paintCenteredStroke(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX - 32, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 32, centerY, { steps: 8 });
  await page.mouse.up();
}

async function readMaskPixel(
  page: Page,
  x: number,
  y: number,
): Promise<number[] | null> {
  return page.evaluate(
    async ({ sampleX, sampleY }) => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      const maskUrl = app.flattenMaskToDataURL();
      if (!maskUrl) return null;
      const image = new Image();
      image.src = maskUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas context is unavailable");
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(sampleX, sampleY, 1, 1).data);
    },
    { sampleX: x, sampleY: y },
  );
}

test("auto resolution preserves the selected square-equivalent area", () => {
  expect(calculateAutoResolution(300, 400, 1024, 64)).toEqual({
    width: 896,
    height: 1152,
  });
  expect(calculateAutoResolution(640, 640, 1024, 64)).toEqual({
    width: 1024,
    height: 1024,
  });
  expect(calculateAutoResolution(2048, 1024, 1024, 64)).toEqual({
    width: 1408,
    height: 704,
  });
  expect(calculateAutoResolution(1024, 2048, 1024, 128)).toEqual({
    width: 768,
    height: 1408,
  });
});

test("smoke: app loads, mounts its canvas, and logs no errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await routeOptions(page);

  await openApp(page);

  await expect(page.locator("#upaint-root canvas")).toBeVisible();
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});

test("pasting an image into the focused canvas adds a layer without consuming prompt pastes", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);

  const result = await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
    const imagePaste = () => {
      const data = new DataTransfer();
      data.items.add(new File([png], "Pasted image.png", { type: "image/png" }));
      return new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
    };
    const prompt = document.querySelector<HTMLTextAreaElement>("textarea");
    const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas");
    if (!prompt || !canvas) throw new Error("Paste targets are unavailable");

    const promptPaste = imagePaste();
    prompt.dispatchEvent(promptPaste);
    canvas.focus();
    const canvasPaste = imagePaste();
    canvas.dispatchEvent(canvasPaste);
    return {
      promptPrevented: promptPaste.defaultPrevented,
      canvasPrevented: canvasPaste.defaultPrevented,
    };
  });

  expect(result).toEqual({ promptPrevented: false, canvasPrevented: true });
  await expect(page.locator("[data-layer-id]")).toHaveCount(1);
  await expect(page.locator("[data-layer-id]")).toContainText("Pasted image.png");
});

test("viewport zoom control reflects wheel zoom and resets to 100%", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);

  const canvas = page.locator("#upaint-root canvas");
  await canvas.hover();
  await page.mouse.wheel(0, -120);

  const zoomButton = page.getByRole("button", { name: /^Zoom:/ });
  await expect.poll(() =>
    page.evaluate(() => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      return Math.round(app.getZoom() * 100);
    }),
  ).toBeGreaterThan(100);
  await expect(zoomButton).toHaveText(
    await page.evaluate(() => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      return `${Math.round(app.getZoom() * 100)}%`;
    }),
  );

  await zoomButton.click();
  await expect.poll(() =>
    page.evaluate(() => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      return app.getZoom();
    }),
  ).toBe(1);
  await expect(zoomButton).toHaveText("100%");
});

test("fit-to-boundary-box uses the viewport with 8px padding", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 64, y: 80, width: 160, height: 96 });
  });

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const expectedZoom = Math.min(
    (bounds.width - 16) / 160,
    (bounds.height - 16) / 96,
  );

  await page.getByRole("button", { name: "Fit boundary box to viewport" }).click();
  await expect.poll(() =>
    page.evaluate(() => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      return app.getZoom();
    }),
  ).toBeCloseTo(expectedZoom, 5);
});

test("grid control hides and shows the rendered pixel grid", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);

  const canvas = page.locator("#upaint-root canvas");
  const visibleGrid = await canvas.screenshot();
  const gridButton = page.getByRole("button", { name: "Hide pixel grid" });
  await gridButton.click();
  await expect.poll(() =>
    page.evaluate(() => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      return app.isGridVisible();
    }),
  ).toBe(false);
  const hiddenGrid = await canvas.screenshot();
  expect(hiddenGrid.equals(visibleGrid)).toBe(false);

  await page.getByRole("button", { name: "Show pixel grid" }).click();
  await expect.poll(() =>
    page.evaluate(() => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      return app.isGridVisible();
    }),
  ).toBe(true);
  const shownGrid = await canvas.screenshot();
  expect(shownGrid.equals(hiddenGrid)).toBe(false);
});

test("paint round-trip persists a pointer stroke in flattenToDataURL", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
  });
  await addBlankLayer(page);
  await page.getByRole("button", { name: "Brush", exact: true }).click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX - 32, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 32, centerY, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
        if (!app) throw new Error("Ultra Paint test hook is unavailable");
        const image = new Image();
        image.src = app.flattenToDataURL();
        await image.decode();
        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = image.naturalWidth;
        sampleCanvas.height = image.naturalHeight;
        const context = sampleCanvas.getContext("2d");
        if (!context) throw new Error("2D canvas context is unavailable");
        context.drawImage(image, 0, 0);
        const x = Math.floor(image.naturalWidth / 2);
        const y = Math.floor(image.naturalHeight / 2);
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          alpha: context.getImageData(x, y, 1, 1).data[3] ?? 0,
        };
      }),
    )
    .toEqual({ width: 256, height: 256, alpha: 255 });
});

test("contextual shortcuts switch tools and modifier drags adjust without painting", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setSelectedLayerId(await app.addBlankLayer());
  });
  await page.evaluate(() => {
    const tools = (window as TestWindow).__ultraPaintTest?.paintToolStore;
    if (!tools) throw new Error("Ultra Paint test hook is unavailable");
    tools.setBrushSettings({ radius: 20, hardness: 0.5, opacity: 1 });
  });

  await page.keyboard.press("E");
  expect(
    await page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.activeTool),
  ).toBe("eraser");
  await page.keyboard.press("B");

  const prompt = page.getByPlaceholder("Describe what to generate");
  await prompt.focus();
  await page.keyboard.press("E");
  await expect(prompt).toHaveValue("E");
  expect(
    await page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.activeTool),
  ).toBe("brush");

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;

  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y - 40, { steps: 4 });
  await expect(page.locator('[role="status"]').filter({ hasText: "Size 60px" })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");

  await expect.poll(() =>
    page.evaluate(() => {
      const brush = (window as TestWindow).__ultraPaintTest?.paintToolStore.brush;
      return brush ? { radius: brush.radius, hardness: brush.hardness } : null;
    }),
  ).toEqual({ radius: 60, hardness: 0.7 });

  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
  expect(
    await page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.brush.opacity),
  ).toBe(0.5);

  const centerAlpha = await page.evaluate(async () => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    const image = new Image();
    image.src = app.flattenToDataURL();
    await image.decode();
    const sample = document.createElement("canvas");
    sample.width = image.naturalWidth;
    sample.height = image.naturalHeight;
    const context = sample.getContext("2d");
    if (!context) throw new Error("2D canvas context is unavailable");
    context.drawImage(image, 0, 0);
    return context.getImageData(
      Math.floor(image.naturalWidth / 2),
      Math.floor(image.naturalHeight / 2),
      1,
      1,
    ).data[3];
  });
  expect(centerAlpha).toBe(0);
});

test("mask shortcuts clear undoably and fit the boundary box to painted alpha", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
    hook.paintToolStore.setBrushSettings({ radius: 12, hardness: 1, opacity: 1 });
  });
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator('[data-layer-section="masks"] [data-layer-id]')).toHaveCount(1);
  await paintCenteredStroke(page);
  await expect.poll(() => readMaskPixel(page, 128, 128)).toEqual([255, 255, 255, 255]);

  await page.keyboard.press("Alt+C");
  await expect.poll(() => readMaskPixel(page, 128, 128)).toEqual([0, 0, 0, 255]);
  await expect(page.locator('[data-layer-section="masks"] [data-layer-id]')).toHaveCount(1);

  await page.keyboard.press("Control+Z");
  await expect.poll(() => readMaskPixel(page, 128, 128)).toEqual([255, 255, 255, 255]);

  await page.keyboard.press("Control+Shift+B");
  const box = await page.evaluate(() => {
    const boundaryBox = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!boundaryBox) throw new Error("Ultra Paint test hook is unavailable");
    return { ...boundaryBox };
  });
  expect(box.x).toBeGreaterThan(0);
  expect(box.y).toBeGreaterThan(0);
  expect(box.width).toBeGreaterThan(0);
  expect(box.width).toBeLessThan(128);
  expect(box.height).toBeGreaterThan(0);
  expect(box.height).toBeLessThan(64);
});

test("mask accordion keeps mask rows separate and its controls working", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await addMaskLayer(page);
  await addMaskLayer(page);

  const layersSection = page.locator('[data-layer-section="layers"]');
  const masksSection = page.locator('[data-layer-section="masks"]');
  await expect(layersSection.locator("[data-layer-id]")).toHaveCount(0);
  await expect(masksSection.locator("[data-layer-id]")).toHaveCount(2);

  const topMask = masksSection.locator("[data-layer-id]").first();
  await topMask.getByTitle(/click to rename/).click();
  await topMask.getByRole("textbox", { name: /Rename/ }).fill("Detail Mask");
  await topMask.getByRole("textbox", { name: /Rename/ }).press("Enter");
  await expect(topMask.getByText("Detail Mask", { exact: true })).toBeVisible();

  const color = topMask.getByLabel('Display color of "Detail Mask"');
  await color.fill("#00cc88");
  await expect(color).toHaveValue("#00cc88");

  const visibility = topMask.getByLabel('Toggle "Detail Mask" visible');
  await visibility.uncheck();
  await expect(visibility).not.toBeChecked();
  await visibility.check();
  await expect(visibility).toBeChecked();

  await topMask.getByRole("button", { name: "Move Detail Mask down" }).click();
  await expect(masksSection.locator("[data-layer-id]").last()).toContainText(
    "Detail Mask",
  );
  await masksSection
    .getByRole("button", { name: "Delete Detail Mask", exact: true })
    .click();
  await expect(masksSection.locator("[data-layer-id]")).toHaveCount(1);

  const masksAccordion = masksSection.getByRole("button", {
    name: /^Masks/,
  });
  await masksAccordion.click();
  await expect(masksAccordion).toHaveAttribute("aria-expanded", "false");
  await expect(masksSection.locator("[data-layer-id]")).toHaveCount(0);
  await masksAccordion.click();
  await expect(masksAccordion).toHaveAttribute("aria-expanded", "true");
  await expect(masksSection.locator("[data-layer-id]")).toHaveCount(1);

  const layersAccordion = layersSection.getByRole("button", {
    name: /^Layers/,
  });
  await layersAccordion.click();
  await expect(layersAccordion).toHaveAttribute("aria-expanded", "false");
});

test("mask paint exports white coverage on black without entering the composite", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
    hook.paintToolStore.setBrushSettings({ color: "#1256c4" });
  });
  await addMaskLayer(page);
  await paintCenteredStroke(page);

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
        if (!app) throw new Error("Ultra Paint test hook is unavailable");
        const maskUrl = app.flattenMaskToDataURL();
        if (!maskUrl) return null;

        async function pixels(url: string): Promise<{
          center: number[];
          corner: number[];
          width: number;
          height: number;
        }> {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("2D canvas context is unavailable");
          context.drawImage(image, 0, 0);
          const center = Array.from(
            context.getImageData(
              Math.floor(image.naturalWidth / 2),
              Math.floor(image.naturalHeight / 2),
              1,
              1,
            ).data,
          );
          const corner = Array.from(context.getImageData(0, 0, 1, 1).data);
          return {
            center,
            corner,
            width: image.naturalWidth,
            height: image.naturalHeight,
          };
        }

        const mask = await pixels(maskUrl);
        const composite = await pixels(app.flattenToDataURL());
        return {
          mask,
          compositeCenterAlpha: composite.center[3],
        };
      }),
    )
    .toEqual({
      mask: {
        center: [255, 255, 255, 255],
        corner: [0, 0, 0, 255],
        width: 256,
        height: 256,
      },
      compositeCenterAlpha: 0,
    });
});

test("eraser removes exported coverage from a mask layer", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
    hook.paintToolStore.setBrushSettings({
      color: "#2468cc",
      radius: 24,
      hardness: 1,
      opacity: 1,
    });
  });
  await addMaskLayer(page);
  await paintCenteredStroke(page);
  await expect.poll(() => readMaskPixel(page, 128, 128)).toEqual([
    255, 255, 255, 255,
  ]);

  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.paintToolStore.setBrushSettings({ radius: 16, hardness: 1, opacity: 1 });
  });
  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX - 8, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 8, centerY, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => readMaskPixel(page, 128, 128)).toEqual([0, 0, 0, 255]);
  expect(await readMaskPixel(page, 96, 128)).toEqual([255, 255, 255, 255]);
});

test("live mask brush preview is tinted and hatched before commit", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
    hook.paintToolStore.setBrushSettings({
      color: "#0000ff",
      radius: 32,
      hardness: 1,
      opacity: 1,
    });
  });
  await addMaskLayer(page);
  await page.getByLabel(/Display color of/).fill("#ff0000");
  await page.getByRole("button", { name: "Brush", exact: true }).click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.waitForTimeout(100);
  const screenshot = await page.screenshot({ clip: bounds });
  const samples = await page.evaluate(
    async ({ dataUrl, centerX: sampleCenterX, centerY: sampleCenterY }) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas context is unavailable");
      context.drawImage(image, 0, 0);
      const pixels: number[][] = [];
      for (let offset = -12; offset <= 12; offset += 1) {
        pixels.push(
          Array.from(
            context.getImageData(
              Math.round(sampleCenterX + offset),
              Math.round(sampleCenterY),
              1,
              1,
            ).data,
          ),
        );
      }
      return pixels;
    },
    {
      dataUrl: `data:image/png;base64,${screenshot.toString("base64")}`,
      centerX: bounds.width / 2,
      centerY: bounds.height / 2,
    },
  );
  await page.mouse.up();

  const red = samples.map((sample) => sample[0] ?? 0);
  const blue = samples.map((sample) => sample[2] ?? 0);
  expect(Math.max(...red)).toBeGreaterThan(120);
  expect(Math.max(...red)).toBeGreaterThan(Math.max(...blue) * 2);
  expect(Math.max(...red) - Math.min(...red)).toBeGreaterThan(40);
});

test("boundary-box corner drag updates the store and snaps to the 8px grid", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(160, 160);
  });
  await page
    .getByRole("button", { name: "Boundary Box", exact: true })
    .click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const southeastX = bounds.x + bounds.width / 2 + 80;
  const southeastY = bounds.y + bounds.height / 2 + 80;
  await page.mouse.move(southeastX, southeastY);
  await page.mouse.down();
  await page.mouse.move(southeastX + 13, southeastY + 19, { steps: 4 });
  await page.mouse.up();

  const boundaryBox = await page.evaluate(() => {
    const box = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!box) throw new Error("Ultra Paint test hook is unavailable");
    return { ...box };
  });
  expect(boundaryBox).toEqual({ x: 0, y: 0, width: 176, height: 176 });
  expect(Object.values(boundaryBox).every((value) => value % 8 === 0)).toBe(
    true,
  );
});

test("locked boundary resize preserves its captured ratio for inputs and corner drag", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(160, 96);
  });

  const lock = page.getByRole("button", {
    name: "Lock boundary-box aspect ratio",
  });
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Boundary box width").fill("320");
  await expect(page.getByLabel("Boundary box height")).toHaveValue("192");
  await page.getByRole("button", { name: "Resize", exact: true }).click();
  await page
    .getByRole("button", { name: "Boundary Box", exact: true })
    .click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const southeastX = bounds.x + bounds.width / 2 + 160;
  const southeastY = bounds.y + bounds.height / 2 + 96;
  await page.mouse.move(southeastX, southeastY);
  await page.mouse.down();
  await page.mouse.move(southeastX + 77, southeastY + 5, { steps: 6 });
  await page.mouse.up();

  const box = await page.evaluate(() => {
    const boundaryBox = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!boundaryBox) throw new Error("Ultra Paint test hook is unavailable");
    return { ...boundaryBox };
  });
  expect(box.width % 8).toBe(0);
  expect(box.height % 8).toBe(0);
  expect(Math.abs(box.width / box.height - 160 / 96)).toBeLessThan(0.04);
});

test("boundary dimension swap keeps the top-left position fixed", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 64, y: 80, width: 160, height: 96 });
  });

  await page
    .getByRole("button", { name: "Swap boundary-box width and height" })
    .click();
  const box = await page.evaluate(() => {
    const boundaryBox = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!boundaryBox) throw new Error("Ultra Paint test hook is unavailable");
    return { ...boundaryBox };
  });
  expect(box).toEqual({ x: 64, y: 80, width: 96, height: 160 });
});

test("generate flow adds a fixture image at the boundary-box position", async ({
  page,
}) => {
  let requestBody: {
    composite_image: string;
    generation_mode: "txt2img" | "img2img";
    mask_image?: string;
    gen_params: {
      prompt: string;
      sampler_name: string | null;
      target_width?: number;
      target_height?: number;
    };
  } | null = null;
  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({
      json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 },
    }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody;
    await route.fulfill({ json: generateFixture });
  });
  await openApp(page);
  await addBlankLayer(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 64, y: 80, width: 128, height: 128 });
  });

  await page.getByPlaceholder("Describe what to generate").fill("fixture prompt");
  await page.getByLabel("Sampler").selectOption("Euler a");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator("[data-layer-id]")).toHaveCount(2);

  const generated = await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    const layer = hook.layerStore.document.layers.find(
      (candidate) => candidate.image?.source === "generated",
    );
    return layer
      ? {
          name: layer.name,
          source: layer.image?.source,
          x: layer.transform.x,
          y: layer.transform.y,
        }
      : null;
  });
  expect(generated).toEqual({
    name: "Generated",
    source: "generated",
    x: 64,
    y: 80,
  });
  expect(requestBody).toMatchObject({
    gen_params: { prompt: "fixture prompt", sampler_name: "Euler a" },
  });
  expect(requestBody?.composite_image).toMatch(/^data:image\/png;base64,/);
  expect(requestBody?.generation_mode).toBe("img2img");
  expect(requestBody).not.toHaveProperty("mask_image");
  expect(requestBody?.gen_params).not.toHaveProperty("target_width");
  expect(requestBody?.gen_params).not.toHaveProperty("target_height");
});

test("LoRAs add activation words and only inject enabled tags into generation", async ({
  page,
}) => {
  let generatedPrompt: string | null = null;
  await routeOptions(page);
  await page.route("**/ultra_paint/api/loras", (route) =>
    route.fulfill({
      json: [
        {
          name: "Portrait Detail",
          prompt_name: "portrait-detail",
          activation_text: "cinematic lighting",
          preferred_weight: 0.8,
        },
        {
          name: "Painterly Style",
          prompt_name: "painterly-style",
          activation_text: "",
          preferred_weight: 1,
        },
      ],
    }),
  );
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({
      json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 },
    }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    const body = route.request().postDataJSON() as {
      gen_params?: { prompt?: string };
    };
    generatedPrompt = body.gen_params?.prompt ?? null;
    await route.fulfill({ json: { images: [] } });
  });
  await openApp(page);

  const prompt = page.getByPlaceholder("Describe what to generate");
  await prompt.fill("portrait");
  await page.getByRole("button", { name: /^LoRAs/ }).click();
  await page.getByRole("button", { name: "Add +", exact: true }).click();

  const picker = page.getByRole("dialog", { name: "Add LoRA" });
  const search = picker.getByRole("searchbox", { name: "Search LoRAs" });
  await search.fill("Portrait");
  await picker.getByRole("button", { name: "Add Portrait Detail" }).click();
  await search.fill("");
  await picker.getByRole("button", { name: "Add Painterly Style" }).click();
  await picker.getByRole("button", { name: "Close LoRA picker" }).click();

  const selected = page.getByLabel("Selected LoRAs");
  await expect(selected).toContainText("Portrait Detail");
  await expect(selected).toContainText("Painterly Style");
  await page.getByLabel("Strength value for Portrait Detail").fill("3.5");
  await page
    .getByRole("button", { name: "Add activation words for Portrait Detail" })
    .click();
  await expect(prompt).toHaveValue("portrait, cinematic lighting");

  await page.getByRole("button", { name: "Disable Painterly Style" }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => generatedPrompt).not.toBeNull();
  expect(generatedPrompt).toBe(
    "portrait, cinematic lighting\n<lora:portrait-detail:3.5>",
  );
  await expect(prompt).toHaveValue("portrait, cinematic lighting");
  await page.getByRole("button", { name: "Remove Painterly Style" }).click();
  await expect(selected).not.toContainText("Painterly Style");
});

test("generation mode follows effective raster overlap with the boundary box", async ({
  page,
}) => {
  const generationModes: string[] = [];
  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({ json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 } }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    const body = route.request().postDataJSON() as { generation_mode?: string };
    generationModes.push(body.generation_mode ?? "missing");
    await route.fulfill({ json: { images: [] } });
  });
  await openApp(page);

  const generate = page.getByRole("button", { name: "Generate", exact: true });
  const denoising = page.getByLabel("Denoising strength");
  const modeStatus = page.getByRole("status").filter({ hasText: "Generation mode:" });
  await expect(denoising).toHaveCount(2);
  await expect(denoising.first()).toBeDisabled();
  await expect(modeStatus).toContainText("Text to image");
  await generate.click();
  await expect.poll(() => generationModes.length).toBe(1);

  await addBlankLayer(page);
  const layerId = await page.evaluate(() => {
    const layer = (window as TestWindow).__ultraPaintTest?.layerStore.document.layers.find(
      (candidate) => candidate.kind === "raster",
    );
    if (!layer?.id) throw new Error("Raster test layer is unavailable");
    return layer.id;
  });
  await expect(denoising.first()).toBeEnabled();
  await expect(modeStatus).toContainText("Image to image");
  await generate.click();
  await expect.poll(() => generationModes.length).toBe(2);

  await page.evaluate((id) => {
    const store = (window as TestWindow).__ultraPaintTest?.layerStore;
    if (!store) throw new Error("Ultra Paint test hook is unavailable");
    const box = store.document.boundaryBox;
    store.setTransform(id, { x: box.x + box.width, y: box.y });
  }, layerId);
  await expect(denoising.first()).toBeDisabled();
  await generate.click();
  await expect.poll(() => generationModes.length).toBe(3);

  await page.evaluate((id) => {
    const store = (window as TestWindow).__ultraPaintTest?.layerStore;
    if (!store) throw new Error("Ultra Paint test hook is unavailable");
    const box = store.document.boundaryBox;
    store.setTransform(id, { x: box.x + box.width - 1, y: box.y });
  }, layerId);
  await expect(denoising.first()).toBeEnabled();
  await generate.click();
  await expect.poll(() => generationModes.length).toBe(4);

  await page.evaluate((id) => {
    const store = (window as TestWindow).__ultraPaintTest?.layerStore;
    if (!store) throw new Error("Ultra Paint test hook is unavailable");
    store.setVisible(id, false);
  }, layerId);
  await expect(denoising.first()).toBeDisabled();
  await generate.click();
  await expect.poll(() => generationModes.length).toBe(5);

  expect(generationModes).toEqual([
    "txt2img",
    "img2img",
    "txt2img",
    "img2img",
    "txt2img",
  ]);
});

test("resolution modes update targets and control generate request fields", async ({
  page,
}) => {
  const requestBodies: Array<{
    gen_params: { target_width?: number; target_height?: number };
  }> = [];
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({
      json: { ...optionsFixture, resolution_step: 128 },
    }),
  );
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({
      json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 },
    }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    requestBodies.push(route.request().postDataJSON() as (typeof requestBodies)[number]);
    await route.fulfill({ json: { images: [] } });
  });
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 300, height: 400 });
  });

  await page.getByRole("button", { name: "Bounding Box", exact: true }).click();
  const mode = page.getByLabel("Resolution scale mode");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await mode.selectOption("auto");
  await expect(page.getByLabel("Auto target size")).toHaveText("896 × 1152");
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 400, height: 200 });
  });
  await expect(page.getByLabel("Auto target size")).toHaveText("1408 × 768");
  await generate.click();
  await expect.poll(() => requestBodies.length).toBe(1);
  expect(requestBodies[0]?.gen_params).toMatchObject({
    target_width: 1408,
    target_height: 768,
  });

  await mode.selectOption("manual");
  await page.getByLabel("Target width").fill("640");
  await page.getByLabel("Target height").fill("768");
  await generate.click();
  await expect.poll(() => requestBodies.length).toBe(2);
  expect(requestBodies[1]?.gen_params).toMatchObject({
    target_width: 640,
    target_height: 768,
  });

  await mode.selectOption("none");
  await generate.click();
  await expect.poll(() => requestBodies.length).toBe(3);
  expect(requestBodies[2]?.gen_params).not.toHaveProperty("target_width");
  expect(requestBodies[2]?.gen_params).not.toHaveProperty("target_height");
});

test("video-model options show an inline generation warning", async ({ page }) => {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({
      json: { ...optionsFixture, is_video_model: true },
    }),
  );
  await openApp(page);
  await expect(page.getByRole("alert")).toContainText(
    "Wan/video model is loaded. Generate will be rejected",
  );
});

test("cancel button interrupts generation without resizing the Generate button", async ({
  page,
}) => {
  let interrupted = false;
  let releaseGenerate: (() => void) | null = null;
  const generateGate = new Promise<void>((resolve) => {
    releaseGenerate = resolve;
  });

  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({
      json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 4 },
    }),
  );
  await page.route("**/ultra_paint/api/interrupt", async (route) => {
    interrupted = true;
    await route.fulfill({ json: { interrupted: true } });
    releaseGenerate?.();
  });
  await page.route("**/ultra_paint/api/generate", async (route) => {
    await generateGate;
    await route.fulfill({ json: { images: [] } });
  });
  await openApp(page);

  // Matches both "Generate" (idle) and "Generating…" (active) -- the
  // button's own accessible name/text changes while a request is in
  // flight, so an exact "Generate" match would stop resolving mid-test.
  const generateButton = page.getByRole("button", { name: /^Generat/ });
  const idleBox = await generateButton.boundingBox();
  expect(idleBox).not.toBeNull();

  await generateButton.click();
  const cancelButton = page.getByRole("button", { name: "Cancel generation" });
  await expect(cancelButton).toBeVisible();

  const generatingBox = await generateButton.boundingBox();
  expect(generatingBox).not.toBeNull();
  // The X button appearing must not resize Generate -- it always occupies
  // its row slot (toggled via visibility, not conditional rendering).
  expect(generatingBox?.width).toBeCloseTo(idleBox?.width ?? -1, 0);

  await cancelButton.click();
  await expect.poll(() => interrupted).toBe(true);
  await expect(cancelButton).not.toBeVisible();
  await expect(generateButton).toBeEnabled();

  const settledBox = await generateButton.boundingBox();
  expect(settledBox?.width).toBeCloseTo(idleBox?.width ?? -1, 0);
});

test("generate includes mask_image when a visible mask is present", async ({
  page,
}) => {
  let requestBody: { mask_image?: string } | null = null;
  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({
      json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 },
    }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody;
    await route.fulfill({ json: generateFixture });
  });
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
  });
  await addBlankLayer(page);
  await addMaskLayer(page);
  await paintCenteredStroke(page);

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requestBody).not.toBeNull();
  expect(requestBody?.mask_image).toMatch(/^data:image\/png;base64,/);
});

test("mask-only canvas uses txt2img and omits the mask", async ({ page }) => {
  let requestBody: { generation_mode?: string; mask_image?: string } | null = null;
  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({ json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 } }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody;
    await route.fulfill({ json: { images: [] } });
  });
  await openApp(page);
  await addMaskLayer(page);
  await paintCenteredStroke(page);

  await expect(page.getByLabel("Denoising strength").first()).toBeDisabled();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requestBody).not.toBeNull();
  expect(requestBody?.generation_mode).toBe("txt2img");
  expect(requestBody).not.toHaveProperty("mask_image");
});
