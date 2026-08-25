# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ultra-paint.spec.ts >> video-model options show an inline generation warning
- Location: tests\e2e\ultra-paint.spec.ts:1105:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/ultra_paint/app/
Call log:
  - navigating to "http://localhost:5173/ultra_paint/app/", waiting until "load"

```

# Test source

```ts
  1   | import { expect, test, type Page } from "@playwright/test";
  2   | 
  3   | import generateFixture from "../fixtures/generate.json" with { type: "json" };
  4   | import optionsFixture from "../fixtures/options.json" with { type: "json" };
  5   | import { calculateAutoResolution } from "../../src/util/autoResolution";
  6   | 
  7   | interface BoundaryBox {
  8   |   x: number;
  9   |   y: number;
  10  |   width: number;
  11  |   height: number;
  12  | }
  13  | 
  14  | interface TestLayer {
  15  |   id?: string;
  16  |   name: string;
  17  |   kind?: "raster" | "group" | "mask";
  18  |   color?: string;
  19  |   visible?: boolean;
  20  |   image?: { source: string };
  21  |   transform: { x: number; y: number };
  22  | }
  23  | 
  24  | interface UltraPaintTestHook {
  25  |   getActiveUltraPaintApp(): {
  26  |     ready: Promise<void>;
  27  |     flattenToDataURL(): string;
  28  |     flattenMaskToDataURL(): string | null;
  29  |     addBlankLayer(): Promise<string>;
  30  |     resizeBoundaryBox(width: number, height: number): void;
  31  |     getZoom(): number;
  32  |     isGridVisible(): boolean;
  33  |   } | null;
  34  |   layerStore: {
  35  |     document: {
  36  |       boundaryBox: BoundaryBox;
  37  |       layers: TestLayer[];
  38  |     };
  39  |     setBoundaryBox(box: BoundaryBox): void;
  40  |     setSelectedLayerId(id: string | null): void;
  41  |     setVisible(id: string, visible: boolean): void;
  42  |     setTransform(id: string, transform: Partial<TestLayer["transform"]>): void;
  43  |   };
  44  |   paintToolStore: {
  45  |     readonly activeTool: "brush" | "eraser" | "boundary-box";
  46  |     readonly brush: {
  47  |       radius: number;
  48  |       hardness: number;
  49  |       opacity: number;
  50  |     };
  51  |     setBrushSettings(settings: {
  52  |       color?: string;
  53  |       radius?: number;
  54  |       hardness?: number;
  55  |       opacity?: number;
  56  |     }): void;
  57  |   };
  58  | }
  59  | 
  60  | type TestWindow = Window & { __ultraPaintTest?: UltraPaintTestHook };
  61  | 
  62  | async function routeOptions(page: Page): Promise<void> {
  63  |   await page.route("**/ultra_paint/api/options", (route) =>
  64  |     route.fulfill({ json: optionsFixture }),
  65  |   );
  66  | }
  67  | 
  68  | async function openApp(page: Page): Promise<void> {
> 69  |   await page.goto("./");
      |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/ultra_paint/app/
  70  |   await page.waitForFunction(
  71  |     () =>
  72  |       Boolean(
  73  |         (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp(),
  74  |       ),
  75  |   );
  76  |   await page.evaluate(async () => {
  77  |     const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
  78  |     if (!app) throw new Error("Ultra Paint test hook is unavailable");
  79  |     await app.ready;
  80  |   });
  81  | }
  82  | 
  83  | async function addBlankLayer(page: Page): Promise<void> {
  84  |   const before = await page.locator("[data-layer-id]").count();
  85  |   await page.getByRole("button", { name: "Add a layer" }).click();
  86  |   await page.getByRole("menuitem", { name: "Raster Layer", exact: true }).click();
  87  |   await expect(page.locator("[data-layer-id]")).toHaveCount(before + 1);
  88  | }
  89  | 
  90  | async function addMaskLayer(page: Page): Promise<void> {
  91  |   const masks = page.locator('[data-layer-section="masks"] [data-layer-id]');
  92  |   const before = await masks.count();
  93  |   await page.getByRole("button", { name: "Add a layer" }).click();
  94  |   await page.getByRole("menuitem", { name: "Mask Layer", exact: true }).click();
  95  |   await expect(masks).toHaveCount(before + 1);
  96  | }
  97  | 
  98  | async function paintCenteredStroke(page: Page): Promise<void> {
  99  |   await page.getByRole("button", { name: "Brush", exact: true }).click();
  100 |   const canvas = page.locator("#upaint-root canvas");
  101 |   const bounds = await canvas.boundingBox();
  102 |   expect(bounds).not.toBeNull();
  103 |   if (!bounds) return;
  104 |   const centerX = bounds.x + bounds.width / 2;
  105 |   const centerY = bounds.y + bounds.height / 2;
  106 |   await page.mouse.move(centerX - 32, centerY);
  107 |   await page.mouse.down();
  108 |   await page.mouse.move(centerX + 32, centerY, { steps: 8 });
  109 |   await page.mouse.up();
  110 | }
  111 | 
  112 | async function readMaskPixel(
  113 |   page: Page,
  114 |   x: number,
  115 |   y: number,
  116 | ): Promise<number[] | null> {
  117 |   return page.evaluate(
  118 |     async ({ sampleX, sampleY }) => {
  119 |       const app = (window as TestWindow).__ultraPaintTest?.getActiveUltraPaintApp();
  120 |       if (!app) throw new Error("Ultra Paint test hook is unavailable");
  121 |       const maskUrl = app.flattenMaskToDataURL();
  122 |       if (!maskUrl) return null;
  123 |       const image = new Image();
  124 |       image.src = maskUrl;
  125 |       await image.decode();
  126 |       const canvas = document.createElement("canvas");
  127 |       canvas.width = image.naturalWidth;
  128 |       canvas.height = image.naturalHeight;
  129 |       const context = canvas.getContext("2d");
  130 |       if (!context) throw new Error("2D canvas context is unavailable");
  131 |       context.drawImage(image, 0, 0);
  132 |       return Array.from(context.getImageData(sampleX, sampleY, 1, 1).data);
  133 |     },
  134 |     { sampleX: x, sampleY: y },
  135 |   );
  136 | }
  137 | 
  138 | test("auto resolution preserves the selected square-equivalent area", () => {
  139 |   expect(calculateAutoResolution(300, 400, 1024, 64)).toEqual({
  140 |     width: 896,
  141 |     height: 1152,
  142 |   });
  143 |   expect(calculateAutoResolution(640, 640, 1024, 64)).toEqual({
  144 |     width: 1024,
  145 |     height: 1024,
  146 |   });
  147 |   expect(calculateAutoResolution(2048, 1024, 1024, 64)).toEqual({
  148 |     width: 1408,
  149 |     height: 704,
  150 |   });
  151 |   expect(calculateAutoResolution(1024, 2048, 1024, 128)).toEqual({
  152 |     width: 768,
  153 |     height: 1408,
  154 |   });
  155 | });
  156 | 
  157 | test("smoke: app loads, mounts its canvas, and logs no errors", async ({
  158 |   page,
  159 | }) => {
  160 |   const errors: string[] = [];
  161 |   page.on("console", (message) => {
  162 |     if (message.type() === "error") errors.push(message.text());
  163 |   });
  164 |   page.on("pageerror", (error) => errors.push(error.message));
  165 |   await routeOptions(page);
  166 | 
  167 |   await openApp(page);
  168 | 
  169 |   await expect(page.locator("#upaint-root canvas")).toBeVisible();
```