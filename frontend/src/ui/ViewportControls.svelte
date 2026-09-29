<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { isHostVisible, onHostVisibilityChange } from "../app/hostVisibility";
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
  import Button from "./lib/Button.svelte";
  import Icon from "./lib/Icon.svelte";

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

  function zoomBy(factor: number): void {
    getActiveUltraPaintApp()?.zoomBy(factor);
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

  function stopPolling(): void {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  let unsubscribeHostVisibility: (() => void) | null = null;

  onMount(() => {
    if (isHostVisible()) updateCameraState();
    unsubscribeHostVisibility = onHostVisibilityChange((visible) => {
      stopPolling();
      if (visible) updateCameraState();
    });
  });

  onDestroy(() => {
    unsubscribeHostVisibility?.();
    stopPolling();
  });
</script>

<div
  class="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded border p-1 shadow-lg"
  style="border-color: var(--upaint-border); background: var(--upaint-surface); color: var(--upaint-text);"
  role="toolbar"
  aria-label="Viewport controls"
>
  <Button size="sm" aria-label="Zoom out" title="Zoom out" onclick={() => zoomBy(1 / 1.25)}>
    <Icon name="minus" />
  </Button>
  <Button
    size="sm"
    class="tabular-nums"
    aria-label={`Zoom: ${Math.round(zoom * 100)}% (reset to 100%)`}
    title="Reset zoom to 100% (0)"
    onclick={resetZoom}
  >
    {Math.round(zoom * 100)}%
  </Button>
  <Button size="sm" aria-label="Zoom in" title="Zoom in" onclick={() => zoomBy(1.25)}>
    <Icon name="plus" />
  </Button>
  <Button
    size="sm"
    aria-label="Fit boundary box to viewport"
    title="Fit boundary box to viewport (F)"
    onclick={fitToBoundaryBox}
  >
    <Icon name="fit" />
  </Button>
  <Button
    size="sm"
    aria-label="Scale boundary box to fit visible layers"
    title="Scale boundary box to fit visible layers (excludes masks)"
    disabled={isDocumentMutationLocked()}
    onclick={fitBoundaryBoxToContent}
  >
    <Icon name="fit-content" />
  </Button>
  <Button
    size="sm"
    pressed={gridVisible}
    aria-label={gridVisible ? "Hide pixel grid" : "Show pixel grid"}
    title={gridVisible ? "Hide pixel grid (G)" : "Show pixel grid (G)"}
    onclick={toggleGrid}
  >
    <Icon name="grid" />
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
    <Icon name="tiles" />
  </Button>
</div>
