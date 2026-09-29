import { expect, test, type Frame, type Page } from "@playwright/test";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type PopOutTestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): { ready: Promise<void>; addBlankLayer(): Promise<string> } | null;
  };
};

async function appReady(target: Page | Frame): Promise<void> {
  await target.waitForFunction(() =>
    Boolean((window as PopOutTestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );
  await target.evaluate(
    () => (window as PopOutTestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!.ready,
  );
}

function addLayer(target: Page | Frame): Promise<string> {
  return target.evaluate(() =>
    (window as PopOutTestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!.addBlankLayer(),
  );
}

test("pop out hands the document to a new tab and bring back returns it", async ({
  page,
  context,
}) => {
  let uploads = 0;
  // Context-level routes so the popped-out tab is stubbed too.
  await context.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await context.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await context.route("**/ultra_paint/api/controlnet/model_list", (route) =>
    route.fulfill({ json: { model_list: [] } }),
  );
  await context.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/ultra_paint/api/autosave", (route) => {
    uploads += 1;
    return route.fulfill({ json: {} });
  });

  // Stand in for Forge: a host page embedding the app in an iframe.
  await page.goto("./");
  await page.evaluate(() => {
    document.body.innerHTML = '<iframe id="host" src="./?embedded=1"></iframe>';
  });
  const embedded = page.frameLocator("#host");
  const frame = () => page.frames().find((f) => f.url().includes("embedded=1"))!;
  await expect.poll(() => Boolean(frame())).toBe(true);
  await appReady(frame());

  await addLayer(frame());
  const popupPromise = context.waitForEvent("page");
  await embedded.getByRole("button", { name: "Open in a full-window tab" }).click();
  const popup = await popupPromise;
  // The unsaved edit reached the server before the new tab took over.
  expect(uploads).toBe(1);
  await expect(embedded.getByRole("alertdialog", { name: "Open in another tab" })).toBeVisible();
  await appReady(popup);
  await expect(popup.getByRole("button", { name: "Open in a full-window tab" })).toHaveCount(0);

  await addLayer(popup);
  const closed = popup.waitForEvent("close");
  await embedded.getByRole("button", { name: "Bring Back Here" }).click();
  await closed;
  expect(uploads).toBe(2);
  // The iframe reloads unfrozen to pick up the popped-out tab's autosave.
  await expect(embedded.getByRole("alertdialog")).toHaveCount(0);
  await appReady(frame());
});
