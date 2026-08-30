import { expect, test, type Page } from "@playwright/test";

import generateFixture from "../fixtures/generate.json" with { type: "json" };
import optionsFixture from "../fixtures/options.json" with { type: "json" };

interface TestWindow extends Window {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addImageFromDataURL(url: string): Promise<string>;
    } | null;
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
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context is unavailable");
    context.fillStyle = "#ff00ff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await app.addImageFromDataURL(canvas.toDataURL());
  });
}

async function hasPaintedPixels(dataUrl: string): Promise<boolean> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context is unavailable");
  context.drawImage(image, 0, 0);
  return context
    .getImageData(0, 0, canvas.width, canvas.height)
    .data.some((value, index) => index % 4 === 3 && value > 0);
}

test("Hide Layers remains display-only for Save and Generate exports", async ({ page }) => {
  let savedImage: string | null = null;
  let generatedImage: string | null = null;
  await openApp(page);
  await page.route("**/ultra_paint/api/save", async (route) => {
    savedImage = (route.request().postDataJSON() as { image: string }).image;
    await route.fulfill({ json: { path: "outputs/canvas.png" } });
  });
  await page.route("**/ultra_paint/api/generate", async (route) => {
    generatedImage = (route.request().postDataJSON() as { composite_image: string })
      .composite_image;
    await route.fulfill({ json: generateFixture });
  });

  await page.getByRole("button", { name: "Hide layers from canvas" }).click();
  await expect(page.getByRole("button", { name: "Show layers on canvas" })).toBeVisible();

  await page.getByRole("button", { name: "Save canvas" }).click();
  await expect.poll(() => savedImage).not.toBeNull();
  expect(await page.evaluate(hasPaintedPixels, savedImage)).toBe(true);

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => generatedImage).not.toBeNull();
  expect(await page.evaluate(hasPaintedPixels, generatedImage)).toBe(true);

  // Export must leave the comparison state exactly as it was.
  await expect(page.getByRole("button", { name: "Show layers on canvas" })).toBeVisible();
});
