import { expect, test } from "@playwright/test";

test("side panels collapse, give the canvas their space, and stay collapsed after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("./");
  await page.evaluate(() => localStorage.removeItem("ultra-paint:ui-layout"));
  await page.reload();

  const settings = page.locator("#upaint-settings-panel");
  const layers = page.locator("#upaint-root-panel");
  const canvas = page.locator("#upaint-root canvas");
  await expect(settings).toBeVisible();
  await expect(layers).toBeVisible();
  const openWidth = (await canvas.boundingBox())!.width;

  // The top bar fits at this width with both panels open.
  const options = page.getByRole("group", { name: "Brush options" });
  expect(await options.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  const hideSettings = page.getByRole("button", { name: "Hide generation settings" });
  await expect(hideSettings).toHaveAttribute("aria-expanded", "true");
  await hideSettings.click();
  await page.getByRole("button", { name: "Hide layers panel" }).click();
  await expect(settings).toBeHidden();
  await expect(layers).toBeHidden();
  await expect(page.getByRole("separator")).toHaveCount(0);
  await expect
    .poll(async () => (await canvas.boundingBox())!.width)
    .toBeGreaterThan(openWidth + 600);

  await page.reload();
  await expect(settings).toBeHidden();
  await expect(layers).toBeHidden();
  const showSettings = page.getByRole("button", { name: "Show generation settings" });
  await expect(showSettings).toHaveAttribute("aria-expanded", "false");
  await showSettings.click();
  await page.getByRole("button", { name: "Show layers panel" }).click();
  await expect(settings).toBeVisible();
  await expect(layers).toBeVisible();
  // Generation state survives collapsing because the panel stays mounted.
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
});

test("top bar options follow the active tool", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("slider", { name: "Brush size" })).toBeVisible();

  await page.getByRole("button", { name: "Boundary Box", exact: true }).click();
  await expect(page.getByRole("group", { name: "Boundary Box options" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Brush size" })).toHaveCount(0);

  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Brush size" })).toBeVisible();
});
