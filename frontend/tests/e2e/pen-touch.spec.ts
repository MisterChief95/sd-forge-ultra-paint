import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { mapPenPressure } from "../../src/util/pressure";

type TestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addBlankLayer(): Promise<string>;
      layerSourceDataURL(id: string): string | null;
    } | null;
    layerStore: { setSelectedLayerIds(ids: readonly string[]): void };
    paintToolStore: {
      activeTool: string;
      brush: { color: string };
      setBrushSettings(settings: { color?: string; opacity?: number; radius?: number }): void;
    };
  };
};

type Finger = { x: number; y: number; id: number };

test.use({ hasTouch: true });

// Trusted input through CDP: the gesture handler ignores synthetic DOM events.
const touch = (cdp: CDPSession, type: string, fingers: Finger[]) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: fingers });

const pen = (
  cdp: CDPSession,
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  x: number,
  y: number,
  button: "none" | "left" | "right" = "left",
  buttons = type === "mouseReleased" ? 0 : 1,
) =>
  cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    buttons,
    clickCount: type === "mouseMoved" ? 0 : 1,
    pointerType: "pen",
    force: type === "mouseReleased" ? 0 : 0.8,
  });

async function setup(page: Page) {
  await page.goto("./");
  const id = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    await app.ready;
    const id = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerIds([id]);
    hook.paintToolStore.setBrushSettings({ color: "#ff0000", opacity: 1, radius: 20 });
    return id;
  });
  const box = (await page.locator("#upaint-root canvas").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const pixels = () =>
    page.evaluate(
      (layerId) =>
        (window as TestWindow)
          .__ultraPaintTest!.getActiveUltraPaintApp()!
          .layerSourceDataURL(layerId),
      id,
    );
  const worldX = () =>
    page.evaluate(
      () =>
        (
          (window as TestWindow).__ultraPaintTest!.getActiveUltraPaintApp() as unknown as {
            world: { x: number };
          }
        ).world.x,
    );
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, cdp, pixels, worldX };
}

async function fingerStroke(cdp: CDPSession, x: number, y: number, id = 1): Promise<void> {
  await touch(cdp, "touchStart", [{ id, x, y }]);
  await touch(cdp, "touchMove", [{ id, x: x + 30, y: y + 10 }]);
  await touch(cdp, "touchMove", [{ id, x: x + 60, y: y + 20 }]);
  await touch(cdp, "touchEnd", []);
}

test("pen pressure curve maps through sensitivity and floor", () => {
  expect(mapPenPressure(0.5, 0, 0)).toBeCloseTo(0.5);
  expect(mapPenPressure(1, 100, 0.3)).toBeCloseTo(1);
  expect(mapPenPressure(0, -100, 0.2)).toBeCloseTo(0.2);
  expect(mapPenPressure(0.25, 100, 0)).toBeGreaterThan(0.5); // light touch reads high
  expect(mapPenPressure(0.25, -100, 0)).toBeLessThan(0.1); // firm curve reads low
  expect(mapPenPressure(2, 0, 0)).toBe(1);
});

test("the flipped pen's eraser end erases while the brush stays selected", async ({ page }) => {
  const { cx, cy, cdp, pixels } = await setup(page);
  const blank = await pixels();

  await pen(cdp, "mousePressed", cx, cy);
  await pen(cdp, "mouseMoved", cx + 60, cy);
  await pen(cdp, "mouseReleased", cx + 60, cy);
  const painted = await pixels();
  expect(painted).not.toBe(blank);

  // CDP can't emulate the eraser end (button 5 / buttons bit 32), so dispatch
  // it on the canvas directly with pointer capture stubbed out.
  await page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelector<HTMLCanvasElement>("#upaint-root canvas")!;
      canvas.setPointerCapture = () => {};
      canvas.hasPointerCapture = () => false;
      (window as TestWindow).__ultraPaintTest!.paintToolStore.setBrushSettings({ radius: 80 });
      const send = (type: string, clientX: number, button: number, buttons: number) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 77,
            pointerType: "pen",
            button,
            buttons,
            clientX,
            clientY: y,
            pressure: buttons ? 0.8 : 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      send("pointerdown", x! - 20, 5, 32);
      send("pointermove", x! + 30, -1, 32);
      send("pointermove", x! + 80, -1, 32);
      send("pointerup", x! + 80, 5, 0);
    },
    [cx, cy],
  );

  expect(await pixels()).toBe(blank);
  expect(
    await page.evaluate(() => (window as TestWindow).__ultraPaintTest!.paintToolStore.activeTool),
  ).toBe("brush");
});

test("the pen barrel button samples the canvas color", async ({ page }) => {
  const { cx, cy, cdp } = await setup(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 10, cy);
  await page.mouse.up();
  await page.evaluate(() =>
    (window as TestWindow).__ultraPaintTest!.paintToolStore.setBrushSettings({
      color: "#00ff00",
    }),
  );

  await pen(cdp, "mousePressed", cx + 5, cy, "right", 2);
  await pen(cdp, "mouseReleased", cx + 5, cy, "right", 0);

  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__ultraPaintTest!.paintToolStore.brush.color),
    )
    .toBe("#ff0000");
});

test("touches beside a hovering pen are rejected; afterwards one finger pans", async ({ page }) => {
  const { cx, cy, cdp, pixels, worldX } = await setup(page);
  const blank = await pixels();
  const startX = await worldX();

  // Pen hovering (no contact) while the palm lands and drags.
  await pen(cdp, "mouseMoved", cx + 200, cy, "none", 0);
  await fingerStroke(cdp, cx, cy);
  expect(await pixels()).toBe(blank);
  expect(await worldX()).toBe(startX);

  // Pen out of range: in "auto" touch mode a finger now pans instead of painting.
  await page.waitForTimeout(600);
  await fingerStroke(cdp, cx, cy, 2);
  expect(await pixels()).toBe(blank);
  expect(await worldX()).toBeGreaterThan(startX + 30);
});

test("two-finger tap undoes and three-finger tap redoes", async ({ page }) => {
  const { cx, cy, cdp, pixels, worldX } = await setup(page);
  const blank = await pixels();
  await fingerStroke(cdp, cx, cy);
  const painted = await pixels();
  expect(painted).not.toBe(blank);
  const startX = await worldX();

  await touch(cdp, "touchStart", [{ id: 1, x: cx, y: cy }]);
  await touch(cdp, "touchStart", [
    { id: 1, x: cx, y: cy },
    { id: 2, x: cx + 80, y: cy },
  ]);
  await touch(cdp, "touchMove", [
    { id: 1, x: cx + 3, y: cy },
    { id: 2, x: cx + 80, y: cy + 2 },
  ]);
  await touch(cdp, "touchEnd", []);
  await expect.poll(pixels).toBe(blank);
  expect(await worldX()).toBe(startX);

  const three = [
    { id: 1, x: cx, y: cy },
    { id: 2, x: cx + 60, y: cy },
    { id: 3, x: cx + 120, y: cy },
  ];
  await touch(cdp, "touchStart", three.slice(0, 1));
  await touch(cdp, "touchStart", three.slice(0, 2));
  await touch(cdp, "touchStart", three);
  await touch(cdp, "touchEnd", []);
  await expect.poll(pixels).toBe(painted);

  // A real pinch is not a tap: history is untouched.
  await touch(cdp, "touchStart", [{ id: 1, x: cx - 40, y: cy }]);
  await touch(cdp, "touchStart", [
    { id: 1, x: cx - 40, y: cy },
    { id: 2, x: cx + 40, y: cy },
  ]);
  await touch(cdp, "touchMove", [
    { id: 1, x: cx - 120, y: cy },
    { id: 2, x: cx + 120, y: cy },
  ]);
  await touch(cdp, "touchEnd", []);
  expect(await pixels()).toBe(painted);
});
