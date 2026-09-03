import { expect, test } from "@playwright/test";

type TestWindow = Window & {
  __ultraPaintTest?: {
    getActiveUltraPaintApp(): {
      ready: Promise<void>;
      addBlankLayer(): Promise<string>;
      fillSelectedLayer(): void;
      layerSourceDataURL(id: string): string | null;
      undo(): void;
      redo(): void;
    } | null;
    layerStore: {
      document: { layers: Array<{ id: string }>; layerOrder: string[] };
      selectedLayerIds: readonly string[];
      setSelectedLayerIds(ids: readonly string[]): void;
      removeLayers(ids: readonly string[]): void;
      getTiledSurface(id: string): { tileCount: number } | undefined;
    };
    paintToolStore: {
      setBrushSettings(settings: { color?: string; opacity?: number }): void;
    };
  };
};

test("deleted tiled layers undo and redo as one history step", async ({ page }) => {
  await page.goto("./");
  const result = await page.evaluate(async () => {
    const hook = (window as TestWindow).__ultraPaintTest;
    const app = hook?.getActiveUltraPaintApp();
    if (!hook || !app) throw new Error("Ultra Paint test hook is unavailable");
    await app.ready;

    const first = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerIds([first]);
    hook.paintToolStore.setBrushSettings({ color: "#ff0000", opacity: 1 });
    app.fillSelectedLayer();
    const second = await app.addBlankLayer();
    hook.layerStore.setSelectedLayerIds([second]);
    hook.paintToolStore.setBrushSettings({ color: "#0000ff", opacity: 1 });
    app.fillSelectedLayer();
    const before = [app.layerSourceDataURL(first), app.layerSourceDataURL(second)];
    const tilesBefore = [
      hook.layerStore.getTiledSurface(first)?.tileCount,
      hook.layerStore.getTiledSurface(second)?.tileCount,
    ];
    const orderBefore = [...hook.layerStore.document.layerOrder];

    hook.layerStore.setSelectedLayerIds([first, second]);
    hook.layerStore.removeLayers([first, second]);
    const countAfterDelete = hook.layerStore.document.layers.length;

    app.undo();
    const afterUndo = [app.layerSourceDataURL(first), app.layerSourceDataURL(second)];
    const orderAfterUndo = [...hook.layerStore.document.layerOrder];
    const selectionAfterUndo = [...hook.layerStore.selectedLayerIds];
    const tilesAfterUndo = [
      hook.layerStore.getTiledSurface(first)?.tileCount,
      hook.layerStore.getTiledSurface(second)?.tileCount,
    ];

    app.redo();
    const countAfterRedo = hook.layerStore.document.layers.length;
    app.undo();

    return {
      before,
      tilesBefore,
      afterUndo,
      orderBefore,
      orderAfterUndo,
      selectionAfterUndo,
      tilesAfterUndo,
      countAfterDelete,
      countAfterRedo,
      countAfterSecondUndo: hook.layerStore.document.layers.length,
    };
  });

  expect(result.countAfterDelete).toBe(0);
  expect(result.countAfterRedo).toBe(0);
  expect(result.countAfterSecondUndo).toBe(2);
  expect(result.afterUndo).toEqual(result.before);
  expect(result.orderAfterUndo).toEqual(result.orderBefore);
  expect(result.selectionAfterUndo).toEqual(result.orderBefore.slice().reverse());
  expect(result.tilesAfterUndo).toEqual(result.tilesBefore);
});
