import { expect, test } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

test("VAE / Text Encoder picker adds and removes selection chips", async ({ page }) => {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) =>
    route.fulfill(route.request().method() === "PUT" ? { status: 204, body: "" } : { json: {} }),
  );
  await page.goto("./");
  await page.waitForSelector("#upaint-root canvas");

  const selection = page.getByRole("combobox", { name: "VAE / Text Encoder" });
  await expect(selection).toContainText("fixture-vae.safetensors");

  await selection.click();
  const picker = page.getByRole("listbox", { name: "VAE / Text Encoder options" });
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: "fixture-clip.safetensors Add" }).click();
  await expect(selection).toContainText("fixture-clip.safetensors");
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("option", { name: "fixture-clip.safetensors Added" }),
  ).toBeDisabled();

  await selection.getByRole("button", { name: "Remove fixture-vae.safetensors" }).click();
  await expect(selection).not.toContainText("fixture-vae.safetensors");
  await expect(picker.getByRole("option", { name: "fixture-vae.safetensors Add" })).toBeEnabled();
});
