import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import optionsFixture from "../fixtures/options.json" with { type: "json" };

type HardeningTestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addBlankLayer(): Promise<string>;
      fillSelectedLayer(): void;
      layerSourceDataURL(id: string): string | null;
    } | null;
    layerStore: {
      document: { layers: { id: string }[] };
      setSelectedLayerId(id: string): void;
      setBoundaryBox(box: { x: number; y: number; width: number; height: number }): void;
    };
  };
};

async function stubBackend(page: Page): Promise<void> {
  await page.route("**/ultra_paint/api/options", (route) =>
    route.fulfill({ json: optionsFixture }),
  );
  await page.route("**/ultra_paint/api/settings", (route) => route.fulfill({ json: {} }));
  await page.route("**/ultra_paint/api/controlnet/model_list", (route) =>
    route.fulfill({ json: { model_list: [] } }),
  );
  await page.route("**/ultra_paint/api/autosave", (route) => route.fulfill({ json: {} }));
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as HardeningTestWindow).__ultraPaintTest?.getActiveUltraPaintApp()),
  );
  await page.evaluate(
    () => (window as HardeningTestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!.ready,
  );
}

/** Save a filled layer spanning several tiles and return the archive entries plus its pixels. */
async function saveProject(
  page: Page,
): Promise<{ entries: Record<string, Uint8Array>; id: string; png: string | null }> {
  await page.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto("./");
  await waitForApp(page);
  const { id, png } = await page.evaluate(async () => {
    const hook = (window as HardeningTestWindow).__ultraPaintTest!;
    const app = hook.getActiveUltraPaintApp()!;
    hook.layerStore.setBoundaryBox({ x: 0, y: 0, width: 2048, height: 1100 });
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerId(id);
    app.fillSelectedLayer();
    return { id, png: app.layerSourceDataURL(id) };
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save Project" }).click();
  const path = await (await downloadPromise).path();
  return { entries: unzipSync(readFileSync(path!)), id, png };
}

async function openArchive(page: Page, entries: Record<string, Uint8Array>): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open Project" }).click();
  await (
    await chooserPromise
  ).setFiles({
    name: "tampered.uproj",
    mimeType: "application/zip",
    buffer: Buffer.from(zipSync(entries)),
  });
}

test.beforeEach(({ page }) => stubBackend(page));

test("rejects a project whose boundary box exceeds the size limit", async ({ page }) => {
  const { entries } = await saveProject(page);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
  manifest.document.boundaryBox.width = 8193;
  await openArchive(page, { ...entries, "manifest.json": strToU8(JSON.stringify(manifest)) });
  await expect(page.getByText("Document boundary box exceeds 8192px.")).toBeVisible();
});

test("skips oversized archive entries instead of inflating them", async ({ page }) => {
  const { entries } = await saveProject(page);
  const pixelPath = Object.keys(entries).find((path) => path.startsWith("pixels/"))!;
  await openArchive(page, { ...entries, [pixelPath]: new Uint8Array(65 * 1024 * 1024) });
  await expect(page.getByText(`Project is missing "${pixelPath}".`)).toBeVisible();
});

test("restores a multi-tile autosave with concurrent tile requests", async ({ page }) => {
  const { entries, id, png } = await saveProject(page);
  const pixelPaths = Object.keys(entries).filter((path) => path.startsWith("pixels/"));
  expect(pixelPaths.length).toBeGreaterThan(1);

  const checkpointId = "0".repeat(32);
  await page.unroute("**/ultra_paint/api/autosave/current");
  await page.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ json: { checkpointId } }),
  );
  let inFlight = 0;
  let peak = 0;
  await page.route(`**/ultra_paint/api/autosave/checkpoints/${checkpointId}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.split(`${checkpointId}/`)[1]!;
    if (path === "manifest") {
      return route.fulfill({ body: Buffer.from(entries["manifest.json"]!) });
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 50));
    inFlight -= 1;
    return route.fulfill({ body: Buffer.from(entries[path]!), contentType: "image/png" });
  });

  await page.reload();
  await waitForApp(page);
  const restored = await page.evaluate(
    (layerId) =>
      (window as HardeningTestWindow)
        .__ultraPaintTest!.getActiveUltraPaintApp()!
        .layerSourceDataURL(layerId),
    id,
  );
  expect(restored).toBe(png);
  expect(peak).toBeGreaterThan(1);
});

test("a failed layer action tells the user", async ({ page }) => {
  await page.route("**/ultra_paint/api/autosave/current", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto("./");
  await waitForApp(page);
  await page.evaluate(() => {
    const app = (window as HardeningTestWindow).__ultraPaintTest!.getActiveUltraPaintApp()!;
    app.addBlankLayer = () => Promise.reject(new Error("boom"));
  });
  await page.getByRole("button", { name: "Add a layer" }).click();
  await page.getByRole("menuitem", { name: "Raster Layer", exact: true }).click();
  await expect(page.getByText("Could not add a layer.")).toBeVisible();
});
