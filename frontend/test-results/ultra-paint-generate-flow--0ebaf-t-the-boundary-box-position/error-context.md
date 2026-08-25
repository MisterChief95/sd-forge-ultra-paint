# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ultra-paint.spec.ts >> generate flow adds a fixture image at the boundary-box position
- Location: tests\e2e\ultra-paint.spec.ts:828:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: '+ Blank', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - region [ref=e5]:
      - heading "Generation" [level=2] [ref=e7]
      - generic [ref=e8]:
        - button "Generate" [ref=e9] [cursor=pointer]
        - button "Save" [ref=e10] [cursor=pointer]
      - status [ref=e11]: "Generation mode: Text to image"
      - generic [ref=e12]:
        - text: Prompt
        - textbox "Prompt" [ref=e13]:
          - /placeholder: Describe what to generate
      - generic [ref=e14]:
        - text: Negative prompt
        - textbox "Negative prompt" [ref=e15]:
          - /placeholder: What to avoid
      - button "LoRAs 0" [ref=e17] [cursor=pointer]:
        - generic [ref=e18]: ▶
        - generic [ref=e19]: LoRAs
        - generic [ref=e20]: "0"
      - generic [ref=e21]:
        - button "Sampling" [expanded] [ref=e22] [cursor=pointer]:
          - generic [ref=e23]: ▼
        - region [ref=e25]:
          - generic [ref=e26]:
            - generic [ref=e27]:
              - text: Sampler
              - combobox "Sampler" [ref=e28]:
                - option "Default" [selected]
                - option "Euler a"
                - option "DPM++ 2M"
            - generic [ref=e29]:
              - text: Scheduler
              - combobox "Scheduler" [ref=e30]:
                - option "Default" [selected]
                - option "Automatic"
                - option "Karras"
          - generic [ref=e31]:
            - generic [ref=e32]:
              - generic [ref=e33]: Steps
              - spinbutton "Steps" [ref=e34]: "20"
            - slider "Steps" [ref=e35] [cursor=pointer]: "20"
          - generic [ref=e36]:
            - generic [ref=e37]:
              - generic [ref=e38]: CFG scale
              - spinbutton "CFG scale" [ref=e39]: "7"
            - slider "CFG scale" [ref=e40] [cursor=pointer]: "7"
          - generic [ref=e41]:
            - generic [ref=e42]:
              - generic [ref=e43]: Denoising strength
              - spinbutton "Denoising strength" [disabled] [ref=e44]: "0.75"
            - slider "Denoising strength" [disabled] [ref=e45] [cursor=pointer]: "0.75"
      - button "Bounding Box" [ref=e47] [cursor=pointer]:
        - generic [ref=e48]: ▶
      - button "Inpainting" [ref=e51] [cursor=pointer]:
        - generic [ref=e52]: ▶
  - generic [ref=e54]:
    - toolbar "Painting tools" [ref=e56]:
      - generic [ref=e57]:
        - button "Brush" [pressed] [ref=e58] [cursor=pointer]
        - button "Eraser" [ref=e59] [cursor=pointer]
        - button "Fill" [ref=e60] [cursor=pointer]
      - generic [ref=e61]:
        - text: Size
        - slider "Brush size" [ref=e62] [cursor=pointer]: "20"
        - status [ref=e63]: 20px
      - generic [ref=e64]:
        - text: Hardness
        - slider "Brush hardness" [ref=e65] [cursor=pointer]: "75"
        - status [ref=e66]: 75%
      - generic [ref=e67]:
        - text: Opacity
        - slider "Brush opacity" [ref=e68] [cursor=pointer]: "100"
        - status [ref=e69]: 100%
      - generic [ref=e70]:
        - text: Color
        - textbox "Brush color" [ref=e71] [cursor=pointer]: "#ffffff"
      - generic [ref=e72]:
        - generic [ref=e73]:
          - text: W
          - spinbutton "Boundary box width" [ref=e74]: "1024"
        - generic [ref=e75]: ×
        - generic [ref=e76]:
          - text: H
          - spinbutton "Boundary box height" [ref=e77]: "1024"
        - button "Lock boundary-box aspect ratio" [ref=e78] [cursor=pointer]: 🔓
        - button "Swap boundary-box width and height" [ref=e79] [cursor=pointer]: ⇄
        - button "Resize" [ref=e80] [cursor=pointer]
      - button "Boundary Box" [ref=e81] [cursor=pointer]
    - toolbar "Viewport controls" [ref=e88]:
      - 'button "Zoom: 100% (reset to 100%)" [ref=e89] [cursor=pointer]': 100%
      - button "Fit boundary box to viewport" [ref=e90] [cursor=pointer]: Fit
      - button "Scale boundary box to fit visible layers" [ref=e91] [cursor=pointer]: Fit BB
      - button "Hide pixel grid" [pressed] [ref=e92] [cursor=pointer]: Grid
  - complementary [ref=e93]:
    - generic [ref=e94]:
      - generic [ref=e95]:
        - heading "Layers & Masks" [level=2] [ref=e96]
        - button "Add a layer" [ref=e97] [cursor=pointer]: +
      - generic [ref=e98]:
        - generic [ref=e99]:
          - button "Layers 0" [expanded] [ref=e100] [cursor=pointer]:
            - generic [ref=e101]: ▼
            - generic [ref=e102]: Layers
            - generic [ref=e103]: "0"
          - region [ref=e104]:
            - generic [ref=e105]: No layers yet -- use + to add one.
        - generic [ref=e106]:
          - button "Masks 0" [expanded] [ref=e107] [cursor=pointer]:
            - generic [ref=e108]: ▼
            - generic [ref=e109]: Masks
            - generic [ref=e110]: "0"
          - region [ref=e111]:
            - generic [ref=e112]: No masks yet -- use + to add one.
        - generic [ref=e113]:
          - button "Control 0" [expanded] [ref=e114] [cursor=pointer]:
            - generic [ref=e115]: ▼
            - generic [ref=e116]: Control
            - generic [ref=e117]: "0"
          - region [ref=e118]:
            - generic [ref=e119]: No ControlNet layers yet -- use + to add one.
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
  69  |   await page.goto("./");
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
> 85  |   await page.getByRole("button", { name: "Add a layer" }).click();
      |                                                                    ^ Error: locator.click: Test timeout of 30000ms exceeded.
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
  170 |   await page.waitForTimeout(100);
  171 |   expect(errors).toEqual([]);
  172 | });
  173 | 
  174 | test("pasting an image into the focused canvas adds a layer without consuming prompt pastes", async ({
  175 |   page,
  176 | }) => {
  177 |   await routeOptions(page);
  178 |   await openApp(page);
  179 | 
  180 |   const result = await page.evaluate(() => {
  181 |     const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
  182 |     const imagePaste = () => {
  183 |       const data = new DataTransfer();
  184 |       data.items.add(new File([png], "Pasted image.png", { type: "image/png" }));
  185 |       return new ClipboardEvent("paste", {
```