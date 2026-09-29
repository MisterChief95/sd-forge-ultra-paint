import { expect, test, type Page } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

const TAGS_CSV = '1girl,0,100,"one_girl"\nsolo,0,90,""\nsmile,0,80,""\n';

async function openApp(page: Page): Promise<void> {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/extensions", (route) => route.fulfill({ json: [] }));
  await page.route("**/ultra_paint/api/controlnet/model_list", (route) =>
    route.fulfill({ json: { model_list: [] } }),
  );
  await page.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/ultra_paint/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 204, body: "" })
      : route.fulfill({ json: {} }),
  );
  await page.route("**/ultra_paint/data/tags.csv", (route) => route.fulfill({ body: TAGS_CSV }));
  await page.goto("./");
  await page.waitForSelector("#upaint-root canvas");
}

test("dropdown only opens when tags match", async ({ page }) => {
  await openApp(page);
  const prompt = page.getByPlaceholder("Describe what to generate");

  await prompt.fill("zzzz");
  await page.waitForTimeout(500);
  await expect(page.getByRole("listbox")).toHaveCount(0);

  await prompt.fill("smi");
  await expect(page.getByRole("option", { name: /smile/ })).toBeVisible();
  await prompt.press("Enter");
  await expect(prompt).toHaveValue("smile, ");
});

test("settings modal toggles tag autocompletion and persists it", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const toggle = dialog.getByLabel("Tag autocompletion");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await page.waitForSelector("#upaint-root canvas");
  const prompt = page.getByPlaceholder("Describe what to generate");
  await prompt.fill("smi");
  await page.waitForTimeout(500);
  await expect(page.getByRole("listbox")).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Tag autocompletion")).not.toBeChecked();
});
