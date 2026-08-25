<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";

  let zoom = 1;
  let gridVisible = true;
  let animationFrame: number | null = null;

  function updateCameraState(): void {
    const app = getActiveUltraPaintApp();
    if (app) {
      zoom = app.getZoom();
      gridVisible = app.isGridVisible();
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
  <button
    type="button"
    class="cursor-pointer rounded border px-2 py-1 text-[11px] tabular-nums hover:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); background: var(--upaint-surface-raised);"
    aria-label={`Zoom: ${Math.round(zoom * 100)}% (reset to 100%)`}
    title="Reset zoom to 100%"
    onclick={resetZoom}
  >
    {Math.round(zoom * 100)}%
  </button>
  <button
    type="button"
    class="cursor-pointer rounded border px-2 py-1 text-[11px] hover:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); background: var(--upaint-surface-raised);"
    aria-label="Fit boundary box to viewport"
    title="Fit boundary box to viewport"
    onclick={fitToBoundaryBox}
  >
    Fit
  </button>
  <button
    type="button"
    class="cursor-pointer rounded border px-2 py-1 text-[11px] hover:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); background: var(--upaint-surface-raised);"
    aria-label="Scale boundary box to fit visible layers"
    title="Scale boundary box to fit visible layers (excludes masks)"
    onclick={fitBoundaryBoxToContent}
  >
    Fit BB
  </button>
  <button
    type="button"
    class="cursor-pointer rounded border px-2 py-1 text-[11px] hover:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); background: var(--upaint-surface-raised);"
    aria-label={gridVisible ? "Hide pixel grid" : "Show pixel grid"}
    title={gridVisible ? "Hide pixel grid" : "Show pixel grid"}
    aria-pressed={gridVisible}
    onclick={toggleGrid}
  >
    Grid
  </button>
</div>
