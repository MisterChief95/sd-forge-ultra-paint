<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
  import Button from "./lib/Button.svelte";

  let zoom = $state(1);
  let gridVisible = $state(true);
  let tileBordersVisible = $state(false);
  let animationFrame: number | null = null;

  function updateCameraState(): void {
    const app = getActiveUltraPaintApp();
    if (app) {
      zoom = app.getZoom();
      gridVisible = app.isGridVisible();
      tileBordersVisible = app.isTileDebugBordersVisible();
    }
    animationFrame = requestAnimationFrame(updateCameraState);
  }

  function resetZoom(): void {
    getActiveUltraPaintApp()?.resetZoom();
  }

  function fitToBoundaryBox(): void {
    getActiveUltraPaintApp()?.fitToBoundaryBox(8);
  }

  function fitBoundaryBoxToContent(): void {
    getActiveUltraPaintApp()?.fitBoundaryBoxToContent(8);
  }

  function toggleGrid(): void {
    const app = getActiveUltraPaintApp();
    if (!app) return;
    app.setGridVisible(!app.isGridVisible());
  }

  function toggleTileBorders(): void {
    const app = getActiveUltraPaintApp();
    if (!app) return;
    app.setTileDebugBorders(!app.isTileDebugBordersVisible());
  }

  onMount(() => {
    updateCameraState();
  });

  onDestroy(() => {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  });
</script>

<div
  class="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded border p-1 shadow-lg"
  style="border-color: var(--upaint-border); background: var(--upaint-surface); color: var(--upaint-text);"
  role="toolbar"
  aria-label="Viewport controls"
>
  <Button
    size="sm"
    class="tabular-nums"
    aria-label={`Zoom: ${Math.round(zoom * 100)}% (reset to 100%)`}
    title="Reset zoom to 100%"
    onclick={resetZoom}
  >
    {Math.round(zoom * 100)}%
  </Button>
  <Button
    size="sm"
    aria-label="Fit boundary box to viewport"
    title="Fit boundary box to viewport"
    onclick={fitToBoundaryBox}
  >
    Fit
  </Button>
  <Button
    size="sm"
    aria-label="Scale boundary box to fit visible layers"
    title="Scale boundary box to fit visible layers (excludes masks)"
    disabled={isDocumentMutationLocked()}
    onclick={fitBoundaryBoxToContent}
  >
    Fit BB
  </Button>
  <Button
    size="sm"
    pressed={gridVisible}
    aria-label={gridVisible ? "Hide pixel grid" : "Show pixel grid"}
    title={gridVisible ? "Hide pixel grid" : "Show pixel grid"}
    onclick={toggleGrid}
  >
    Grid
  </Button>
  <Button
    size="sm"
    pressed={tileBordersVisible}
    aria-label={tileBordersVisible ? "Hide tile borders" : "Show tile borders"}
    title={tileBordersVisible
      ? "Hide tile borders (debug)"
      : "Show tile borders (debug) -- outlines each tiled layer's GPU tiles in green"}
    onclick={toggleTileBorders}
  >
    Tiles
  </Button>
</div>
