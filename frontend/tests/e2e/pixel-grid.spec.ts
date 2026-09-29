import { expect, test } from "@playwright/test";

test("grid spacing stays in a bounded on-screen band on whole-pixel powers of two", async ({
  page,
}) => {
  await page.goto("./");
  const results = await page.evaluate(async () => {
    // Vite serves source modules under the app base during e2e runs.
    const url = "/ultra_paint/app/src/scene/PixelGrid.ts";
    const { gridSpacingForZoom } = (await import(/* @vite-ignore */ url)) as {
      gridSpacingForZoom(zoom: number): number;
    };
    return [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 8, 16, 32, 64].map((zoom) => ({
      zoom,
      spacing: gridSpacingForZoom(zoom),
    }));
  });

  for (const { zoom, spacing } of results) {
    expect(Number.isInteger(Math.log2(spacing))).toBe(true);
    expect(spacing).toBeGreaterThanOrEqual(1);
    const onScreen = spacing * zoom;
    // At or above 16 screen px, and within one doubling of it (unless the
    // one-document-pixel floor applies at extreme zoom).
    expect(onScreen).toBeGreaterThanOrEqual(16);
    if (spacing > 1) expect(onScreen).toBeLessThan(32);
  }
});
