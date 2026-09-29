import { expect, test } from "@playwright/test";

import generateFixture from "../fixtures/generate.json" with { type: "json" };
import optionsFixture from "../fixtures/options.json" with { type: "json" };

test("applies and saves Forge prompt styles", async ({ page }) => {
  let styles = [
    { name: "moody", prompt: "dark {prompt}, moody", negative_prompt: "bright" },
    { name: "sharp", prompt: "sharp focus", negative_prompt: "" },
  ];
  let lastPut: unknown = null;
  let lastDelete: string | null = null;
  let lastGenerate: { gen_params?: Record<string, unknown> } | null = null;
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
  await page.route("**/ultra_paint/data/tags.csv", (route) => route.fulfill({ body: "" }));
  await page.route("**/ultra_paint/api/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 204, body: "" })
      : route.fulfill({ json: {} }),
  );
  await page.route("**/ultra_paint/api/generate", (route) => {
    lastGenerate = route.request().postDataJSON() as typeof lastGenerate;
    return route.fulfill({ json: generateFixture });
  });
  await page.route("**/ultra_paint/api/styles**", (route) => {
    if (route.request().method() === "PUT") {
      lastPut = route.request().postDataJSON();
      const { name, prompt, negative_prompt, original_name } =
        lastPut as (typeof styles)[number] & {
          original_name: string | null;
        };
      styles = [
        ...styles.filter((style) => style.name !== (original_name ?? name)),
        { name, prompt, negative_prompt },
      ];
    }
    if (route.request().method() === "DELETE") {
      lastDelete = new URL(route.request().url()).searchParams.get("name");
      styles = styles.filter((style) => style.name !== lastDelete);
    }
    return route.fulfill({ json: styles });
  });
  await page.goto("./");
  await page.waitForSelector("#upaint-root canvas");

  const prompt = page.getByPlaceholder("Describe what to generate");
  const negative = page.getByPlaceholder("What to avoid");
  await prompt.fill("a cat");
  await negative.fill("blurry");

  const dialog = page.getByRole("dialog", { name: "Styles" });
  const select = dialog.getByLabel("Edit style", { exact: true });
  const menu = page.getByRole("menu", { name: "Styles" });
  const chips = page.getByRole("list", { name: "Applied styles" });
  const openMenu = () => page.getByRole("button", { name: "Styles", exact: true }).click();

  // Pick two styles from the menu; each becomes a chip and the menu stays open.
  await openMenu();
  await menu.getByRole("menuitemcheckbox", { name: "moody" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "sharp" }).click();
  await expect(chips.getByRole("button")).toHaveText(["moody", "sharp"]);
  await page.keyboard.press("Escape");

  // Text is untouched; styles are applied to what is sent.
  await expect(prompt).toHaveValue("a cat");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect
    .poll(() => lastGenerate?.gen_params)
    .toMatchObject({
      prompt: "dark a cat, moody, sharp focus",
      negative_prompt: "blurry, bright",
    });

  // Removing a chip drops that style.
  await chips.getByRole("button", { name: "Remove moody" }).click();
  await expect(chips.getByRole("button")).toHaveText(["sharp"]);

  // Edit opens the modal.
  await openMenu();
  await menu.getByRole("menuitem", { name: "Edit" }).click();
  await expect(dialog).toBeVisible();
  await expect(select.locator("option")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // Create from the modal.
  await openMenu();
  await menu.getByRole("menuitem", { name: "Edit" }).click();
  await select.selectOption("");
  await dialog.getByLabel("Style name").fill("mine");
  await dialog.getByLabel("Style prompt").fill("cozy");
  await dialog.getByRole("button", { name: "Create style" }).click();
  await expect(select.locator("option")).toHaveCount(4);
  expect(lastPut).toMatchObject({ name: "mine", prompt: "cozy", original_name: null });

  // Edit it (now selected in the modal), then delete.
  await dialog.getByLabel("Style prompt").fill("cozier");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  expect(lastPut).toMatchObject({ name: "mine", prompt: "cozier", original_name: "mine" });
  page.once("dialog", (confirm) => confirm.accept());
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => lastDelete).toBe("mine");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("negative prompt toggle sends a blank negative prompt when off", async ({ page }) => {
  let body: { gen_params?: { negative_prompt?: string } } | null = null;
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/extensions", (route) => route.fulfill({ json: [] }));
  await page.route("**/ultra_paint/api/styles", (route) => route.fulfill({ json: [] }));
  await page.route("**/ultra_paint/api/controlnet/model_list", (route) =>
    route.fulfill({ json: { model_list: [] } }),
  );
  await page.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/ultra_paint/data/tags.csv", (route) => route.fulfill({ body: "" }));
  let saved: Record<string, unknown> = {};
  await page.route("**/ultra_paint/api/settings", (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ json: saved });
  });
  await page.route("**/ultra_paint/api/generate", (route) => {
    body = route.request().postDataJSON() as typeof body;
    return route.fulfill({ json: generateFixture });
  });
  await page.goto("./");
  await page.waitForSelector("#upaint-root canvas");

  const negative = page.getByPlaceholder("What to avoid");
  await negative.fill("blurry");
  await page.getByRole("button", { name: "Negative prompt" }).click();
  await expect(page.getByPlaceholder("What to avoid")).toHaveCount(0);

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => body?.gen_params?.negative_prompt).toBe("");
  await expect.poll(() => saved.negativeEnabled).toBe(false);

  await page.reload();
  await page.waitForSelector("#upaint-root canvas");
  await expect(page.getByPlaceholder("What to avoid")).toHaveCount(0);
  await page.getByRole("button", { name: "Negative prompt" }).click();
  await expect(page.getByPlaceholder("What to avoid")).toHaveValue("blurry");
});
