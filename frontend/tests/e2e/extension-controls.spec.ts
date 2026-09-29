import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import extensionsFixture from "../fixtures/extensions.json" with { type: "json" };
import generateFixture from "../fixtures/generate.json" with { type: "json" };
import optionsFixture from "../fixtures/options.json" with { type: "json" };

/** Header row for one Accordion, scoped so `getByRole` calls inside it never
 * collide with an identically-labelled control (e.g. every canEnable
 * Accordion's checkbox is named "Enabled") belonging to a different section. */
function accordionHeader(page: Page, title: string) {
  return page.locator("[data-accordion-header]").filter({ hasText: title });
}

async function mockBackend(page: Page): Promise<{ lastGenerateBody: () => unknown }> {
  let lastSettings: unknown = {};
  let lastGenerateBody: unknown = null;

  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/extensions", (route) =>
    route.fulfill({ json: extensionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route: Route) => {
    if (route.request().method() === "PUT") {
      lastSettings = route.request().postDataJSON();
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ json: lastSettings });
  });
  await page.route("**/ultra_paint/api/generate", (route: Route) => {
    lastGenerateBody = route.request().postDataJSON();
    return route.fulfill({ json: generateFixture });
  });

  return { lastGenerateBody: () => lastGenerateBody };
}

async function openApp(page: Page): Promise<void> {
  await page.goto("./");
  await page.waitForSelector("#upaint-root canvas");
}

/** Accordion open/closed state persists to real browser localStorage
 * (`uiLayoutStore`) independently of anything mocked in this test, so a
 * blind click can toggle an already-open section closed after a reload --
 * only click when collapsed. */
async function ensureOpen(toggleButton: Locator): Promise<void> {
  if ((await toggleButton.getAttribute("aria-expanded")) !== "true") {
    await toggleButton.click();
  }
}

async function openNagControls(page: Page): Promise<void> {
  await ensureOpen(
    accordionHeader(page, "Extensions").getByRole("button", { name: "Extensions", exact: true }),
  );
  await ensureOpen(
    accordionHeader(page, "Normalized Attention Guidance").getByRole("button", {
      name: "Normalized Attention Guidance",
      exact: true,
    }),
  );
}

test("extension manifest renders a section and its values reach the generate request", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await openApp(page);

  await expect(accordionHeader(page, "Extensions")).toBeVisible();
  await openNagControls(page);

  const enabledCheckbox = accordionHeader(page, "Normalized Attention Guidance").getByRole(
    "checkbox",
    { name: "Enabled" },
  );
  await expect(enabledCheckbox).not.toBeChecked();
  await enabledCheckbox.check();
  await expect(enabledCheckbox).toBeChecked();

  const scaleInput = page.getByRole("spinbutton", { name: "Scale", exact: true });
  await expect(scaleInput).toHaveValue("5");
  await scaleInput.fill("9");
  await scaleInput.blur();

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect
    .poll(() => backend.lastGenerateBody())
    .toMatchObject({
      extensions: {
        "sd-forge-nag": {
          enabled: true,
          scale: 9,
          tau: 2.5,
          alpha: 0.25,
          sigma_end: 0,
        },
      },
    });
});

test("extension enabled state and edited values survive a reload", async ({ page }) => {
  await mockBackend(page);
  await openApp(page);
  await openNagControls(page);

  await accordionHeader(page, "Normalized Attention Guidance")
    .getByRole("checkbox", { name: "Enabled" })
    .check();
  const scaleInput = page.getByRole("spinbutton", { name: "Scale", exact: true });
  await scaleInput.fill("12");
  await scaleInput.blur();

  // Settings persistence is debounced (SETTINGS_DEBOUNCE_MS); wait for the
  // save to actually reach the (stateful) mocked settings route before
  // reloading, or the reload would race the debounce timer.
  await page.waitForRequest(
    (request) => request.url().includes("/ultra_paint/api/settings") && request.method() === "PUT",
  );

  await openApp(page);
  await openNagControls(page);

  const restoredEnabled = accordionHeader(page, "Normalized Attention Guidance").getByRole(
    "checkbox",
    { name: "Enabled" },
  );
  await expect(restoredEnabled).toBeChecked();
  await expect(page.getByRole("spinbutton", { name: "Scale", exact: true })).toHaveValue("12");
});
