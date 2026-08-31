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
  kind?: "raster" | "group" | "mask" | "control";
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
    layerSourceDataURL(id: string): string | null;
    addBlankLayer(): Promise<string>;
    convertLayerToControl(id: string): string;
    acceptFilterResult(id: string, dataUrl: string): Promise<void>;
    clearSelectedMask(): boolean;
    invertSelectedMask(): boolean;
    clipLayerToBoundaryBox(id: string): boolean;
    fillSelectedLayer(): void;
    resizeBoundaryBox(width: number, height: number): void;
    undo(): void;
    getZoom(): number;
    isGridVisible(): boolean;
  } | null;
  filterStore: {
    readonly active: boolean;
    readonly targetLayerId: string | null;
  };
  layerStore: {
    document: {
      boundaryBox: BoundaryBox;
      layers: TestLayer[];
    };
    setBoundaryBox(box: BoundaryBox): void;
    setSelectedLayerId(id: string | null): void;
    setLocked(id: string, locked: boolean): void;
    setPreserveAlpha(id: string, preserveAlpha: boolean): void;
    setVisible(id: string, visible: boolean): void;
    setTransform(id: string, transform: Partial<TestLayer["transform"]>): void;
  };
  paintToolStore: {
    readonly activeTool: "brush" | "eraser" | "eyedropper" | "boundary-box";
    readonly brush: {
      color: string;
      radius: number;
      hardness: number;
      opacity: number;
      pressureEnabled: boolean;
      sizePressure: boolean;
      opacityPressure: boolean;
    };
    readonly secondaryColor: string;
    setBrushSettings(settings: {
      color?: string;
      radius?: number;
      hardness?: number;
      opacity?: number;
      pressureEnabled?: boolean;
      sizePressure?: boolean;
      opacityPressure?: boolean;
    }): void;
    setSecondaryColor(color: string): void;
    swapColors(): void;
  };
}

type TestWindow = Window & { __ultraPaintTest?: UltraPaintTestHook };

interface PersistedSettingsFixture {
  value: Record<string, unknown>;
  writes: number;
}

async function routeOptions(page: Page): Promise<PersistedSettingsFixture> {
  const persisted: PersistedSettingsFixture = { value: {}, writes: 0 };
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      persisted.value = route.request().postDataJSON() as Record<string, unknown>;
      persisted.writes += 1;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ json: persisted.value });
  });
  return persisted;
}

async function openApp(page: Page): Promise<void> {
  await page.goto("./");
  await page.waitForFunction(() =>
    Boolean((window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
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

async function readMaskPixel(page: Page, x: number, y: number): Promise<number[] | null> {
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

/**
 * Alpha of a mask layer's own raw texture at a document-space coordinate
 * (the mask's transform is (0, 0) unless moved) -- unlike
 * {@link readMaskPixel}, this is independent of the current boundary box, so
 * it stays valid across boundary-box resizes that would otherwise shift or
 * clip {@link flattenMaskToDataURL}'s box-relative export.
 */
async function readLayerAlpha(
  page: Page,
  layerId: string,
  x: number,
  y: number,
): Promise<number | null> {
  return page.evaluate(
    async ({ id, sampleX, sampleY }) => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      const url = app.layerSourceDataURL(id);
      if (!url) return null;
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas context is unavailable");
      context.drawImage(image, 0, 0);
      return context.getImageData(sampleX, sampleY, 1, 1).data[3] ?? null;
    },
    { id: layerId, sampleX: x, sampleY: y },
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

test("smoke: app loads, mounts its canvas, and logs no errors", async ({ page }) => {
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
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (char) => char.charCodeAt(0),
    );
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
  await page.getByRole("menuitem", { name: "Raster Layer", exact: true }).click();
  await expect(page.locator("[data-layer-id]")).toHaveCount(1);
  await expect(page.locator("[data-layer-id]")).toContainText("Pasted image.png");
});

test("viewport zoom control reflects wheel zoom and resets to 100%", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);

  const canvas = page.locator("#upaint-root canvas");
  await canvas.hover();
  await page.mouse.wheel(0, -120);

  const zoomButton = page.getByRole("button", { name: /^Zoom:/ });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
        if (!app) throw new Error("Ultra Paint test hook is unavailable");
        return Math.round(app.getZoom() * 100);
      }),
    )
    .toBeGreaterThan(100);
  await expect(zoomButton).toHaveText(
    await page.evaluate(() => {
      const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
      if (!app) throw new Error("Ultra Paint test hook is unavailable");
      return `${Math.round(app.getZoom() * 100)}%`;
    }),
  );

  await zoomButton.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
        if (!app) throw new Error("Ultra Paint test hook is unavailable");
        return app.getZoom();
      }),
    )
    .toBe(1);
  await expect(zoomButton).toHaveText("100%");
});

test("fit-to-boundary-box uses the viewport with 8px padding", async ({ page }) => {
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
  const expectedZoom = Math.min((bounds.width - 16) / 160, (bounds.height - 16) / 96);

  await page.getByRole("button", { name: "Fit boundary box to viewport" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
        if (!app) throw new Error("Ultra Paint test hook is unavailable");
        return app.getZoom();
      }),
    )
    .toBeCloseTo(expectedZoom, 5);
});

test("grid control hides and shows the rendered pixel grid", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);

  const canvas = page.locator("#upaint-root canvas");
  const visibleGrid = await canvas.screenshot();
  const gridButton = page.getByRole("button", { name: "Hide pixel grid" });
  await gridButton.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
        if (!app) throw new Error("Ultra Paint test hook is unavailable");
        return app.isGridVisible();
      }),
    )
    .toBe(false);
  const hiddenGrid = await canvas.screenshot();
  expect(hiddenGrid.equals(visibleGrid)).toBe(false);

  await page.getByRole("button", { name: "Show pixel grid" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
        if (!app) throw new Error("Ultra Paint test hook is unavailable");
        return app.isGridVisible();
      }),
    )
    .toBe(true);
  const shownGrid = await canvas.screenshot();
  expect(shownGrid.equals(hiddenGrid)).toBe(false);
});

test("paint round-trip persists a pointer stroke in flattenToDataURL", async ({ page }) => {
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

test("preserve alpha clips the brush while the pointer is still down", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
  });
  await addBlankLayer(page);
  await paintCenteredStroke(page);

  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const layerId = hook?.layerStore.document.layers.find(
      (candidate) => candidate.kind === "raster",
    )?.id;
    if (!hook || !layerId) throw new Error("Raster test layer is unavailable");
    hook.layerStore.setPreserveAlpha(layerId, true);
    hook.paintToolStore.setBrushSettings({ radius: 80 });
  });

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const outsideOriginalAlpha = { x: centerX - 2, y: centerY + 58, width: 4, height: 4 };
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.waitForTimeout(50);
  const held = await page.screenshot({ clip: outsideOriginalAlpha });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const committed = await page.screenshot({ clip: outsideOriginalAlpha });

  expect(held.equals(committed)).toBe(true);
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

  await expect
    .poll(() =>
      page.evaluate(() => {
        const brush = (window as TestWindow).__ultraPaintTest?.paintToolStore.brush;
        return brush ? { radius: brush.radius, hardness: brush.hardness } : null;
      }),
    )
    .toEqual({ radius: 60, hardness: 0.7 });

  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
  expect(
    await page.evaluate(
      () => (window as TestWindow).__ultraPaintTest?.paintToolStore.brush.opacity,
    ),
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

test("X swaps primary/secondary brush colors, scoped to the brush tool and non-editable targets", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);

  await page.evaluate(() => {
    const tools = (window as TestWindow).__ultraPaintTest?.paintToolStore;
    if (!tools) throw new Error("Ultra Paint test hook is unavailable");
    tools.setBrushSettings({ color: "#ff0000" });
    tools.setSecondaryColor("#00ff00");
  });

  const primaryInput = page.getByLabel("Primary brush color");
  const secondaryInput = page.getByLabel("Secondary brush color");
  await expect(primaryInput).toHaveValue("#ff0000");
  await expect(secondaryInput).toHaveValue("#00ff00");

  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.keyboard.press("X");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const tools = (window as TestWindow).__ultraPaintTest?.paintToolStore;
        return tools ? { color: tools.brush.color, secondaryColor: tools.secondaryColor } : null;
      }),
    )
    .toEqual({ color: "#00ff00", secondaryColor: "#ff0000" });
  await expect(primaryInput).toHaveValue("#00ff00");
  await expect(secondaryInput).toHaveValue("#ff0000");

  const prompt = page.getByPlaceholder("Describe what to generate");
  await prompt.focus();
  await page.keyboard.press("X");
  await expect(prompt).toHaveValue("X");
  expect(
    await page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.brush.color),
  ).toBe("#00ff00");

  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  await page.keyboard.press("X");
  expect(
    await page.evaluate(() => {
      const tools = (window as TestWindow).__ultraPaintTest?.paintToolStore;
      return tools ? { color: tools.brush.color, secondaryColor: tools.secondaryColor } : null;
    }),
  ).toEqual({ color: "#00ff00", secondaryColor: "#ff0000" });
});

test("holding Alt switches to the eyedropper, click samples a color, and releasing Alt restores the previous tool", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await addBlankLayer(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.paintToolStore.setBrushSettings({
      color: "#336699",
      radius: 40,
      hardness: 1,
      opacity: 1,
    });
  });
  await paintCenteredStroke(page);
  await page.evaluate(() => {
    const tools = (window as TestWindow).__ultraPaintTest?.paintToolStore;
    if (!tools) throw new Error("Ultra Paint test hook is unavailable");
    tools.setBrushSettings({ color: "#ff0000" });
  });
  await expect(page.getByLabel("Primary brush color")).toHaveValue("#ff0000");

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  await page.keyboard.down("Alt");
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.activeTool),
    )
    .toBe("eyedropper");

  await page.mouse.move(centerX, centerY);
  await expect(page.locator('[data-testid="eyedropper-magnifier"]')).toBeVisible();
  // A hover alone must not commit a color -- only the click below does.
  await expect(page.getByLabel("Primary brush color")).toHaveValue("#ff0000");

  await page.mouse.click(centerX, centerY);
  await expect(page.getByLabel("Primary brush color")).toHaveValue("#336699");

  await page.keyboard.up("Alt");
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.activeTool),
    )
    .toBe("brush");
  await expect(page.locator('[data-testid="eyedropper-magnifier"]')).not.toBeVisible();
});

test("clicking the Eyedropper toolbar button selects it as a persistent tool", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);

  const button = page.getByRole("button", {
    name: "Eyedropper (hold Alt to switch temporarily)",
  });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.activeTool),
    )
    .toBe("eyedropper");
});

test("pen pressure split control toggles independently and dismisses above-canvas popover", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);

  await page.getByRole("button", { name: "Enable pen pressure" }).click();
  await expect(page.getByRole("button", { name: "Disable pen pressure" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.brush),
  ).toMatchObject({ pressureEnabled: true, sizePressure: true, opacityPressure: false });

  const button = page.getByRole("button", { name: "Configure pen pressure" });
  const popover = page.locator("#upaint-pressure-popover");
  await button.click();

  await expect(popover).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  expect(
    await popover.evaluate((element) => {
      const popoverBounds = element.getBoundingClientRect();
      const canvasBounds = document.querySelector("#upaint-root canvas")?.getBoundingClientRect();
      if (!canvasBounds) return false;
      const x = popoverBounds.left + popoverBounds.width / 2;
      const y = Math.max(popoverBounds.top, canvasBounds.top) + 1;
      return element.contains(document.elementFromPoint(x, y));
    }),
  ).toBe(true);

  await popover.getByRole("checkbox", { name: "Opacity pressure" }).check();
  expect(
    await page.evaluate(() => (window as TestWindow).__ultraPaintTest?.paintToolStore.brush),
  ).toMatchObject({ pressureEnabled: true, sizePressure: true, opacityPressure: true });

  await page.locator("#upaint-settings-panel").click({ position: { x: 8, y: 8 } });
  await expect(popover).not.toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Disable pen pressure" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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

  await page.keyboard.press("Shift+C");
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

test("Shift+V inverts mask coverage inside the boundary box and clears outside it", async ({
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
  await paintCenteredStroke(page);
  const maskLayerId = await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const layer = hook?.layerStore.document.layers.find((candidate) => candidate.kind === "mask");
    if (!layer?.id) throw new Error("Mask test layer is unavailable");
    return layer.id;
  });

  // Center (inside the boundary box shrunk below) is painted; a far corner
  // (outside it) is left untouched -- a discriminating pair: a buggy
  // unclipped invert would flip the corner too, and a clip-but-no-invert bug
  // would leave the center unchanged. Sampled via the mask's own raw texture
  // (boundary-box-independent) rather than the box-relative flattened
  // export, since the box gets resized below.
  await expect.poll(() => readLayerAlpha(page, maskLayerId, 128, 128)).toBe(255);
  await expect.poll(() => readLayerAlpha(page, maskLayerId, 10, 10)).toBe(0);

  // setBoundaryBox never touches an existing mask's own texture/transform,
  // so this leaves the mask's full 256x256 painted texture in place while
  // shrinking the box to an inner region that excludes (10, 10).
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 64, y: 64, width: 128, height: 128 });
  });
  await page.keyboard.press("Shift+V");
  await expect.poll(() => readLayerAlpha(page, maskLayerId, 128, 128)).toBe(0);
  await expect.poll(() => readLayerAlpha(page, maskLayerId, 10, 10)).toBe(0);

  await page.keyboard.press("Control+Z");
  await expect.poll(() => readLayerAlpha(page, maskLayerId, 128, 128)).toBe(255);
  await expect.poll(() => readLayerAlpha(page, maskLayerId, 10, 10)).toBe(0);
});

test("locked layers reject destructive pixel actions", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
    hook.paintToolStore.setBrushSettings({ radius: 12, hardness: 1, opacity: 1 });
  });

  await addMaskLayer(page);
  await paintCenteredStroke(page);
  const maskId = await page.evaluate(() => {
    const layer = (window as TestWindow).__ultraPaintTest?.layerStore.document.layers.find(
      (candidate) => candidate.kind === "mask",
    );
    if (!layer?.id) throw new Error("Mask test layer is unavailable");
    return layer.id;
  });
  const maskBefore = await page.evaluate(
    (id) =>
      (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id),
    maskId,
  );
  const maskResults = await page.evaluate((id) => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setLocked(id, true);
    return [app.clearSelectedMask(), app.invertSelectedMask()];
  }, maskId);
  expect(maskResults).toEqual([false, false]);
  expect(
    await page.evaluate(
      (id) =>
        (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id),
      maskId,
    ),
  ).toBe(maskBefore);

  await addBlankLayer(page);
  await paintCenteredStroke(page);
  const rasterId = await page.evaluate(() => {
    const layer = (window as TestWindow).__ultraPaintTest?.layerStore.document.layers.find(
      (candidate) => candidate.kind === "raster",
    );
    if (!layer?.id) throw new Error("Raster test layer is unavailable");
    return layer.id;
  });
  const rasterBefore = await page.evaluate(
    (id) =>
      (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id),
    rasterId,
  );
  const clipResult = await page.evaluate((id) => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 64, y: 64, width: 128, height: 128 });
    hook.layerStore.setLocked(id, true);
    app.fillSelectedLayer();
    return app.clipLayerToBoundaryBox(id);
  }, rasterId);
  expect(clipResult).toBe(false);
  await expect(page.getByRole("button", { name: "Fill the selected layer" })).toBeDisabled();
  expect(
    await page.evaluate(
      (id) =>
        (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id),
      rasterId,
    ),
  ).toBe(rasterBefore);
});

test("preserve alpha clips Fill to existing pixels", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(256, 256);
    hook.paintToolStore.setBrushSettings({ radius: 12, hardness: 1, opacity: 1 });
  });
  await addBlankLayer(page);
  await paintCenteredStroke(page);
  const rasterId = await page.evaluate(() => {
    const layer = (window as TestWindow).__ultraPaintTest?.layerStore.document.layers.find(
      (candidate) => candidate.kind === "raster",
    );
    if (!layer?.id) throw new Error("Raster test layer is unavailable");
    return layer.id;
  });
  await expect.poll(() => readLayerAlpha(page, rasterId, 128, 128)).toBe(255);
  expect(await readLayerAlpha(page, rasterId, 10, 10)).toBe(0);
  const beforeFill = await page.evaluate(
    (id) =>
      (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id),
    rasterId,
  );

  await page.evaluate((id) => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setPreserveAlpha(id, true);
    hook.paintToolStore.setBrushSettings({ color: "#ff0000" });
    app.fillSelectedLayer();
  }, rasterId);

  await expect.poll(() => readLayerAlpha(page, rasterId, 128, 128)).toBe(255);
  await expect.poll(() => readLayerAlpha(page, rasterId, 10, 10)).toBe(0);
  expect(
    await page.evaluate(
      (id) =>
        (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id),
      rasterId,
    ),
  ).not.toBe(beforeFill);
});

test("mask accordion keeps mask rows separate and its controls working", async ({ page }) => {
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
  const thumbnail = topMask.getByAltText("Detail Mask preview");
  await expect(thumbnail).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(thumbnail).toHaveCSS("border-color", "rgb(0, 204, 136)");

  const visibility = topMask.getByLabel('Toggle "Detail Mask" visible');
  await visibility.uncheck();
  await expect(visibility).not.toBeChecked();
  await visibility.check();
  await expect(visibility).toBeChecked();

  const bottomMask = masksSection.locator("[data-layer-id]").last();
  const bottomBounds = await bottomMask.boundingBox();
  expect(bottomBounds).not.toBeNull();
  if (!bottomBounds) return;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await topMask.dispatchEvent("pointerdown", { bubbles: true, button: 0 });
  await topMask.dispatchEvent("dragstart", { dataTransfer });
  await bottomMask.dispatchEvent("dragover", {
    clientY: bottomBounds.y + bottomBounds.height - 1,
    dataTransfer,
  });
  await bottomMask.dispatchEvent("drop", {
    clientY: bottomBounds.y + bottomBounds.height - 1,
    dataTransfer,
  });
  await topMask.dispatchEvent("dragend", { dataTransfer });
  await expect(masksSection.locator("[data-layer-id]").last()).toContainText("Detail Mask");
  await masksSection.getByRole("button", { name: "Delete Detail Mask", exact: true }).click();
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
  await expect.poll(() => readMaskPixel(page, 128, 128)).toEqual([255, 255, 255, 255]);

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

test("live mask brush preview is tinted and hatched before commit", async ({ page }) => {
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

test("boundary-box corner drag updates the store and snaps to the 32px grid", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(160, 160);
  });
  await page.getByRole("button", { name: "Boundary Box", exact: true }).click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const southeastX = bounds.x + bounds.width / 2 + 80;
  const southeastY = bounds.y + bounds.height / 2 + 80;
  await page.mouse.move(southeastX, southeastY);
  await page.mouse.down();
  await page.mouse.move(southeastX + 20, southeastY + 44, { steps: 4 });
  await page.mouse.up();

  const boundaryBox = await page.evaluate(() => {
    const box = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!box) throw new Error("Ultra Paint test hook is unavailable");
    return { ...box };
  });
  expect(boundaryBox).toEqual({ x: 0, y: 0, width: 192, height: 192 });
  expect(Object.values(boundaryBox).every((value) => value % 32 === 0)).toBe(true);
});

test("boundary-box corner drag snaps to the 8px grid while Control is held", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(160, 160);
  });
  await page.getByRole("button", { name: "Boundary Box", exact: true }).click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const southeastX = bounds.x + bounds.width / 2 + 80;
  const southeastY = bounds.y + bounds.height / 2 + 80;
  await page.mouse.move(southeastX, southeastY);
  await page.mouse.down();
  await page.keyboard.down("Control");
  await page.mouse.move(southeastX + 13, southeastY + 19, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Control");

  const boundaryBox = await page.evaluate(() => {
    const box = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!box) throw new Error("Ultra Paint test hook is unavailable");
    return { ...box };
  });
  expect(boundaryBox).toEqual({ x: 0, y: 0, width: 176, height: 176 });
  expect(Object.values(boundaryBox).every((value) => value % 8 === 0)).toBe(true);
});

test("boundary-box body drag commits one undoable mutation", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(160, 160);
  });
  await page.getByRole("button", { name: "Boundary Box", exact: true }).click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 27, centerY + 19, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => ({
        ...(window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox,
      })),
    )
    .toEqual({ x: 32, y: 32, width: 160, height: 160 });

  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.undo();
  });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        ...(window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox,
      })),
    )
    .toEqual({ x: 0, y: 0, width: 160, height: 160 });
});

test("boundary-box drag survives leaving the canvas and native pointer cancellation", async ({
  page,
}) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
    if (!app) throw new Error("Ultra Paint test hook is unavailable");
    app.resizeBoundaryBox(160, 160);
  });
  await page.getByRole("button", { name: "Boundary Box", exact: true }).click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width + 24, centerY, { steps: 8 });
  await page.mouse.up();
  const outsideDragBox = await page.evaluate(() => ({
    ...(window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox,
  }));
  expect(outsideDragBox.x).toBeGreaterThan(0);
  expect(outsideDragBox.x % 32).toBe(0);

  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 160, height: 160 });
  });
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 25, centerY, { steps: 4 });
  await canvas.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent("pointercancel", {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
  });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => ({
        ...(window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox,
      })),
    )
    .toEqual({ x: 32, y: 0, width: 160, height: 160 });

  await page.mouse.move(centerX + 32, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 64, centerY, { steps: 3 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        ...(window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox,
      })),
    )
    .toEqual({ x: 64, y: 0, width: 160, height: 160 });
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

  await page.getByRole("button", { name: "Bounding Box", exact: true }).click();
  const lock = page.getByRole("button", {
    name: "Lock boundary-box aspect ratio",
  });
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Boundary box width").fill("320");
  await expect(page.getByLabel("Boundary box height")).toHaveValue("192");
  await page.getByRole("button", { name: "Resize", exact: true }).click();
  await page.getByRole("button", { name: "Boundary Box", exact: true }).click();

  const canvas = page.locator("#upaint-root canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  const southeastX = bounds.x + bounds.width / 2 + 160;
  const southeastY = bounds.y + bounds.height / 2 + 96;
  await page.mouse.move(southeastX, southeastY);
  await page.mouse.down();
  await page.keyboard.down("Control");
  await page.mouse.move(southeastX + 77, southeastY + 5, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Control");

  const box = await page.evaluate(() => {
    const boundaryBox = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!boundaryBox) throw new Error("Ultra Paint test hook is unavailable");
    return { ...boundaryBox };
  });
  expect(box.width % 8).toBe(0);
  expect(box.height % 8).toBe(0);
  expect(Math.abs(box.width / box.height - 160 / 96)).toBeLessThan(0.04);
});

test("boundary dimension swap keeps the top-left position fixed", async ({ page }) => {
  await routeOptions(page);
  await openApp(page);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 64, y: 80, width: 160, height: 96 });
  });

  await page.getByRole("button", { name: "Bounding Box", exact: true }).click();
  await page.getByRole("button", { name: "Swap boundary-box width and height" }).click();
  const box = await page.evaluate(() => {
    const boundaryBox = (window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox;
    if (!boundaryBox) throw new Error("Ultra Paint test hook is unavailable");
    return { ...boundaryBox };
  });
  expect(box).toEqual({ x: 64, y: 80, width: 96, height: 160 });
});

test("generate flow adds a fixture image at the boundary-box position", async ({ page }) => {
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
  await page.getByRole("button", { name: "Apply selected preview" }).click();
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

test("preview gallery saves the selected generated PNG directly", async ({ page }) => {
  let savedImage: string | null = null;
  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({ json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 } }),
  );
  await page.route("**/ultra_paint/api/generate", (route) =>
    route.fulfill({ json: generateFixture }),
  );
  await page.route("**/ultra_paint/api/save", async (route) => {
    savedImage = (route.request().postDataJSON() as { image?: string }).image ?? null;
    await route.fulfill({ json: { path: "outputs/selected-preview.png" } });
  });
  await openApp(page);

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByRole("button", { name: "Save selected preview" }).click();

  await expect.poll(() => savedImage).toBe(generateFixture.images[0]);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved to outputs/selected-preview.png" }),
  ).toBeVisible();
});

test("a second generation after Apply does not freeze the viewport", async ({ page }) => {
  // Regression test: Apply calls previewStore.discardAll(), which evicted
  // the just-shown preview's cached Texture even though the (now hidden)
  // sprite still pointed at it. The next generate() made the sprite visible
  // again with that dangling destroyed Texture before the new one loaded,
  // throwing mid-render and permanently stalling PixiJS's ticker.
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({ json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 1 } }),
  );
  await page.route("**/ultra_paint/api/generate", (route) =>
    route.fulfill({ json: generateFixture }),
  );
  await openApp(page);

  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await page.getByPlaceholder("Describe what to generate").fill("first pass");
  await generate.click();
  await page.getByRole("button", { name: "Apply selected preview" }).click();

  await page.getByPlaceholder("Describe what to generate").fill("second pass");
  await generate.click();
  await expect(page.getByRole("button", { name: "Apply selected preview" })).toBeVisible();

  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});

test("generation panel settings survive a page reload", async ({ page }) => {
  const persisted = await routeOptions(page);
  await openApp(page);

  await page.getByPlaceholder("Describe what to generate").fill("persistent prompt");
  await page.getByPlaceholder("What to avoid").fill("persistent negative prompt");
  await page.getByLabel("Sampler").selectOption("DPM++ 2M");
  await page.getByLabel("Scheduler").selectOption("Karras");
  await page.getByLabel("Steps").first().fill("42");
  await page.getByLabel("CFG scale").first().fill("9.5");
  await page.getByRole("combobox", { name: "VAE / Text Encoder" }).click();
  await page.getByRole("option", { name: /fixture-clip\.safetensors/ }).click();
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 64, y: 80, width: 320, height: 192 });
  });
  await expect.poll(() => persisted.value.prompt).toBe("persistent prompt");

  await page.reload();
  await page.waitForFunction(() =>
    Boolean((window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );

  await expect(page.getByPlaceholder("Describe what to generate")).toHaveValue("persistent prompt");
  await expect(page.getByPlaceholder("What to avoid")).toHaveValue("persistent negative prompt");
  await expect(page.getByLabel("Sampler")).toHaveValue("DPM++ 2M");
  await expect(page.getByLabel("Scheduler")).toHaveValue("Karras");
  await expect(page.getByLabel("Steps").first()).toHaveValue("42");
  await expect(page.getByLabel("CFG scale").first()).toHaveValue("9.5");
  await expect(page.getByRole("combobox", { name: "VAE / Text Encoder" })).toContainText(
    "fixture-clip.safetensors",
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({
        ...(window as TestWindow).__ultraPaintTest?.layerStore.document.boundaryBox,
      })),
    )
    .toEqual({ x: 64, y: 80, width: 320, height: 192 });
});

test("generation settings writes are debounced", async ({ page }) => {
  const persisted = await routeOptions(page);
  await openApp(page);
  await expect.poll(() => persisted.writes).toBe(1);
  persisted.writes = 0;

  const prompt = page.getByPlaceholder("Describe what to generate");
  await prompt.fill("one");
  await prompt.fill("two");
  await prompt.fill("three");

  await page.waitForTimeout(500);
  expect(persisted.writes).toBe(0);
  await expect.poll(() => persisted.writes).toBe(1);
  expect(persisted.value.prompt).toBe("three");
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
  await page.getByRole("button", { name: "Add activation words for Portrait Detail" }).click();
  await expect(prompt).toHaveValue("portrait, cinematic lighting");

  await page.getByRole("button", { name: "Disable Painterly Style" }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => generatedPrompt).not.toBeNull();
  expect(generatedPrompt).toBe("portrait, cinematic lighting\n<lora:portrait-detail:3.5>");
  await expect(prompt).toHaveValue("portrait, cinematic lighting");
  await page.getByRole("button", { name: "Remove Painterly Style" }).click();
  await expect(selected).not.toContainText("Painterly Style");
});

test("generation mode follows effective raster overlap with the boundary box", async ({ page }) => {
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

  expect(generationModes).toEqual(["txt2img", "img2img", "txt2img", "img2img", "txt2img"]);
});

test("resolution modes update targets and control generate request fields", async ({ page }) => {
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
  await expect(page.getByLabel("Auto target size")).toHaveText(/Width:\s*896\s*Height:\s*1152/);
  await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    if (!hook) throw new Error("Ultra Paint test hook is unavailable");
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 400, height: 200 });
  });
  await expect(page.getByLabel("Auto target size")).toHaveText(/Width:\s*1408\s*Height:\s*768/);
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

test("generation progress fills the active button and Save lives in the toolbar", async ({
  page,
}) => {
  let releaseGenerate: (() => void) | null = null;
  let savedImage: string | null = null;

  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({
      json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 4 },
    }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    await new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    await route.fulfill({ json: { images: [] } });
  });
  await page.route("**/ultra_paint/api/interrupt", async (route) => {
    releaseGenerate?.();
    await route.fulfill({ json: { interrupted: true } });
  });
  await page.route("**/ultra_paint/api/save", async (route) => {
    savedImage = (route.request().postDataJSON() as { image?: string }).image ?? null;
    await route.fulfill({ json: { path: "outputs/ultra-paint-test.png" } });
  });
  await openApp(page);

  const generateButton = page.getByRole("button", { name: "Generate", exact: true });
  const idleBox = await generateButton.boundingBox();
  expect(idleBox).not.toBeNull();
  await generateButton.click();

  const activeButton = page.getByRole("button", { name: /Generating 1 of 1, 25% complete/ });
  await expect(activeButton).toBeVisible();
  await expect(activeButton).toContainText("Generating… (1/1)");
  await expect(activeButton.locator('span[aria-hidden="true"]')).toHaveCSS("width", /[1-9]/);
  await expect(page.getByRole("button", { name: "Generation queue actions" })).toBeVisible();
  expect((await activeButton.boundingBox())?.width).toBeLessThan(idleBox?.width ?? 0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);

  await page.getByRole("button", { name: "Generation queue actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Cancel Current" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Cancel Remaining" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Cancel All" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Cancel Current" }).click();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();

  const toolbar = page.getByRole("toolbar", { name: "Painting tools" });
  const saveButton = toolbar.getByRole("button", { name: "Save canvas" });
  await expect(saveButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Save canvas" })).toHaveCount(1);
  await saveButton.click();
  await expect.poll(() => savedImage).toMatch(/^data:image\/png;base64,/);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved to outputs/ultra-paint-test.png" }),
  ).toBeVisible();
});

test("live preview ignores a foreign job and blocks painting while generating", async ({
  page,
}) => {
  const foreignImg =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const oursImg =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwAAAAASUVORK5CYII=";
  let releaseGenerate: (() => void) | null = null;
  let pollCount = 0;
  let releaseSecondPoll: (() => void) | null = null;
  const secondPollGate = new Promise<void>((resolve) => {
    releaseSecondPoll = resolve;
  });

  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", async (route) => {
    pollCount += 1;
    if (pollCount > 1) await secondPollGate;
    // First poll lands before our own `state.begin("ultra_paint")` has run
    // server-side -- Forge's shared.state still reports whatever job is
    // active elsewhere. The live-preview image from that foreign job must
    // never reach our overlay/img (see generationController.svelte.ts).
    const [job, image] =
      pollCount === 1 ? ["some_other_tab", foreignImg] : ["ultra_paint", oursImg];
    return route.fulfill({
      json: { job, sampling_step: 1, sampling_steps: 4, current_image: image },
    });
  });
  await page.route("**/ultra_paint/api/generate", async (route) => {
    await new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    await route.fulfill({ json: generateFixture });
  });
  await openApp(page);
  await addBlankLayer(page);

  const before = await page.evaluate(() =>
    (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.flattenToDataURL(),
  );

  await page.getByRole("button", { name: "Generate", exact: true }).click();

  const livePreview = page.getByRole("img", { name: "Live generation preview" });
  await expect.poll(() => pollCount).toBeGreaterThanOrEqual(1);
  // The foreign job's image must never reach the live-preview <img>.
  await expect(livePreview).not.toBeVisible();

  const canvas = page.locator("#upaint-root canvas");
  await expect(canvas).toHaveCSS("cursor", "wait");

  releaseSecondPoll?.();
  await expect(livePreview).toBeVisible();
  await expect(livePreview).toHaveAttribute("src", oursImg);

  await paintCenteredStroke(page);
  const afterAttemptedPaint = await page.evaluate(() =>
    (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.flattenToDataURL(),
  );
  expect(afterAttemptedPaint).toBe(before);

  releaseGenerate?.();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
});

test("queued generations capture prompts sequentially and Cancel Current continues", async ({
  page,
}) => {
  const prompts: string[] = [];
  const releases: Array<() => void> = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let interrupts = 0;

  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({ json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 4 } }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    const body = route.request().postDataJSON() as { gen_params?: { prompt?: string } };
    prompts.push(body.gen_params?.prompt ?? "");
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise<void>((resolve) => releases.push(resolve));
    activeRequests -= 1;
    await route.fulfill({ json: { images: [] } });
  });
  await page.route("**/ultra_paint/api/interrupt", async (route) => {
    interrupts += 1;
    releases.shift()?.();
    await route.fulfill({ json: { interrupted: true } });
  });
  await openApp(page);

  const prompt = page.getByPlaceholder("Describe what to generate");
  await prompt.fill("first queued prompt");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => prompts).toEqual(["first queued prompt"]);

  await prompt.fill("second queued prompt");
  await page.getByRole("button", { name: /^Generating/ }).click();
  await expect(page.getByRole("button", { name: /Generating 1 of 2/ })).toBeVisible();
  await page.getByRole("button", { name: "Generation queue actions" }).click();
  await page.getByRole("menuitem", { name: "Cancel Current" }).click();

  await expect.poll(() => prompts).toEqual(["first queued prompt", "second queued prompt"]);
  await expect(page.getByRole("button", { name: /Generating 2 of 2/ })).toBeVisible();
  expect(interrupts).toBe(1);
  expect(maxActiveRequests).toBe(1);
  releases.shift()?.();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
});

test("Cancel Remaining preserves the active job and Cancel All clears and interrupts", async ({
  page,
}) => {
  let requests = 0;
  let interrupts = 0;
  let releaseCurrent: (() => void) | null = null;

  await routeOptions(page);
  await page.route("**/ultra_paint/api/progress", (route) =>
    route.fulfill({ json: { job: "ultra_paint", sampling_step: 1, sampling_steps: 4 } }),
  );
  await page.route("**/ultra_paint/api/generate", async (route) => {
    requests += 1;
    await new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await route.fulfill({ json: { images: [] } });
  });
  await page.route("**/ultra_paint/api/interrupt", async (route) => {
    interrupts += 1;
    releaseCurrent?.();
    await route.fulfill({ json: { interrupted: true } });
  });
  await openApp(page);

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("button", { name: /^Generating/ }).click();
  await page.getByRole("button", { name: /^Generating/ }).click();
  await expect(page.getByRole("button", { name: /Generating 1 of 3/ })).toBeVisible();
  await page.getByRole("button", { name: "Generation queue actions" }).click();
  await page.getByRole("menuitem", { name: "Cancel Remaining" }).click();
  await expect(page.getByRole("button", { name: /Generating 1 of 1/ })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Removed 2 queued generations." }),
  ).toBeVisible();
  expect(interrupts).toBe(0);
  releaseCurrent?.();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  expect(requests).toBe(1);

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await page.getByRole("button", { name: /^Generating/ }).click();
  await page.getByRole("button", { name: /^Generating/ }).click();
  await page.getByRole("button", { name: "Generation queue actions" }).click();
  await page.getByRole("menuitem", { name: "Cancel All" }).click();
  await expect.poll(() => interrupts).toBe(1);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Removed 2 queued generations; cancelling the current generation." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  expect(requests).toBe(2);
});

test("generate includes mask_image when a visible mask is present", async ({ page }) => {
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

/** Fully opaque 1x1 black PNG, distinct from a freshly-created blank layer's
 * transparent pixels -- stands in for a ControlNet preprocessor's output. */
const FILTER_RESULT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("Filter mode bakes a preprocessor result into a control layer, undoably, and Cancel leaves it untouched", async ({
  page,
}) => {
  await routeOptions(page);
  await page.route("**/ultra_paint/api/controlnet/module_list", (route) =>
    route.fulfill({ json: { module_list: ["lineart"] } }),
  );
  await page.route("**/ultra_paint/api/controlnet/detect", (route) =>
    route.fulfill({ json: { image: FILTER_RESULT_PNG } }),
  );
  await openApp(page);
  await addBlankLayer(page);

  const controlLayerId = await page.evaluate(() => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    const layer = hook?.layerStore.document.layers.find((candidate) => candidate.kind === "raster");
    if (!app || !layer?.id) throw new Error("Blank raster layer is unavailable");
    return app.convertLayerToControl(layer.id);
  });

  const originalDataUrl = await page.evaluate(
    (id) =>
      (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id) ??
      null,
    controlLayerId,
  );
  expect(originalDataUrl).not.toBeNull();

  await page.locator(`[data-layer-id="${controlLayerId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Filter...", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as TestWindow).__ultraPaintTest?.filterStore.active))
    .toBe(true);

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Accept", exact: true }).click();

  await expect
    .poll(() => page.evaluate(() => (window as TestWindow).__ultraPaintTest?.filterStore.active))
    .toBe(false);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as TestWindow).__ultraPaintTest
            ?.getActiveUltraPaintApp()
            ?.layerSourceDataURL(id) ?? null,
        controlLayerId,
      ),
    )
    .not.toBe(originalDataUrl);

  await page.keyboard.press("Control+Z");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as TestWindow).__ultraPaintTest
            ?.getActiveUltraPaintApp()
            ?.layerSourceDataURL(id) ?? null,
        controlLayerId,
      ),
    )
    .toBe(originalDataUrl);

  // A second Preview -> Cancel round trip must leave the layer's pixels
  // byte-for-byte unchanged (Cancel never touches the real layer).
  await page.locator(`[data-layer-id="${controlLayerId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Filter...", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect
    .poll(() => page.evaluate(() => (window as TestWindow).__ultraPaintTest?.filterStore.active))
    .toBe(false);
  const afterCancel = await page.evaluate(
    (id) =>
      (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp()?.layerSourceDataURL(id) ??
      null,
    controlLayerId,
  );
  expect(afterCancel).toBe(originalDataUrl);
});
