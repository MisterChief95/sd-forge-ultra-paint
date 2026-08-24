<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { layerStore } from "../state/layerStore.svelte";
  import { paintToolStore } from "../state/paintToolStore.svelte";

  const buttonBase =
    "cursor-pointer border px-2.5 py-1.5 text-[11px] leading-tight";
  const buttonInactive =
    "border-transparent bg-[var(--upaint-surface-raised)] text-[var(--upaint-text)] hover:border-[var(--upaint-border)]";
  const buttonActive =
    "border-[var(--upaint-accent)] bg-[var(--upaint-accent)] text-[var(--upaint-text)]";

  function toolButtonClass(active: boolean): string {
    return `${buttonBase} ${active ? buttonActive : buttonInactive}`;
  }

  function handleRadiusInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setBrushSettings({ radius: Number(input.value) });
  }

  function handleHardnessInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setBrushSettings({ hardness: Number(input.value) / 100 });
  }

  function handleOpacityInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setBrushSettings({ opacity: Number(input.value) / 100 });
  }

  function handleColorInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setBrushSettings({ color: input.value });
  }

  function handleDocumentResize(event: SubmitEvent): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const width = Number(data.get("document-width"));
    const height = Number(data.get("document-height"));
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1
    ) {
      return;
    }
    getActiveUltraPaintApp()?.resizeBoundaryBox(width, height);
  }

  function handleBoundaryDimensionInput(
    event: Event,
    dimension: "width" | "height",
  ): void {
    const ratio = paintToolStore.boundaryAspectRatio;
    if (ratio === null) return;
    const input = event.currentTarget as HTMLInputElement;
    const form = input.form;
    const value = Number(input.value);
    if (!form || !Number.isFinite(value) || value < 1) return;
    const otherName =
      dimension === "width" ? "document-height" : "document-width";
    const other = form.elements.namedItem(otherName);
    if (!(other instanceof HTMLInputElement)) return;
    other.value = String(
      Math.max(1, Math.round(dimension === "width" ? value / ratio : value * ratio)),
    );
  }

  function toggleBoundaryAspectLock(): void {
    if (paintToolStore.boundaryAspectRatio !== null) {
      paintToolStore.setBoundaryAspectRatio(null);
      return;
    }
    const box = layerStore.document.boundaryBox;
    paintToolStore.setBoundaryAspectRatio(box.width / box.height);
  }

  function swapBoundaryDimensions(): void {
    const box = layerStore.document.boundaryBox;
    layerStore.setBoundaryBox({
      ...box,
      width: box.height,
      height: box.width,
    });
  }
</script>

<div
  class="box-border flex h-[52px] w-full select-none items-center gap-2.5 overflow-x-auto overflow-y-hidden whitespace-nowrap border px-2 py-1.5 text-[11px] leading-tight"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-lg); background: var(--upaint-surface); color: var(--upaint-text); font-family: var(--upaint-font);"
  role="toolbar"
  aria-label="Painting tools"
>
  <div
    class="flex shrink-0 gap-1 border-r pr-2"
    style="border-color: var(--upaint-border);"
  >
    <button
      type="button"
      class={toolButtonClass(paintToolStore.activeTool === "brush")}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      aria-pressed={paintToolStore.activeTool === "brush"}
      onclick={() => paintToolStore.setActiveTool("brush")}
    >
      Brush
    </button>
    <button
      type="button"
      class={toolButtonClass(paintToolStore.activeTool === "eraser")}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      aria-pressed={paintToolStore.activeTool === "eraser"}
      onclick={() => paintToolStore.setActiveTool("eraser")}
    >
      Eraser
    </button>
    <button
      type="button"
      class={`${buttonBase} ${buttonInactive}`}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      title="Fill the selected layer"
      onclick={() => getActiveUltraPaintApp()?.fillSelectedLayer()}
    >
      Fill
    </button>
  </div>

  <label
    class="grid shrink-0 grid-cols-[auto_82px_36px] items-center gap-1 text-[var(--upaint-text-muted)]"
  >
    Size
    <input
      class="m-0 h-3.5 w-[82px] cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="1"
      max="256"
      step="1"
      value={Math.round(paintToolStore.brush.radius)}
      aria-label="Brush size"
      oninput={handleRadiusInput}
    />
    <output class="text-right tabular-nums text-[var(--upaint-text)]">
      {Math.round(paintToolStore.brush.radius)}px
    </output>
  </label>

  <label
    class="grid shrink-0 grid-cols-[auto_82px_36px] items-center gap-1 text-[var(--upaint-text-muted)]"
  >
    Hardness
    <input
      class="m-0 h-3.5 w-[82px] cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="0"
      max="100"
      step="1"
      value={Math.round(paintToolStore.brush.hardness * 100)}
      aria-label="Brush hardness"
      oninput={handleHardnessInput}
    />
    <output class="text-right tabular-nums text-[var(--upaint-text)]">
      {Math.round(paintToolStore.brush.hardness * 100)}%
    </output>
  </label>

  <label
    class="grid shrink-0 grid-cols-[auto_82px_36px] items-center gap-1 text-[var(--upaint-text-muted)]"
  >
    Opacity
    <input
      class="m-0 h-3.5 w-[82px] cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="0"
      max="100"
      step="1"
      value={Math.round(paintToolStore.brush.opacity * 100)}
      aria-label="Brush opacity"
      oninput={handleOpacityInput}
    />
    <output class="text-right tabular-nums text-[var(--upaint-text)]">
      {Math.round(paintToolStore.brush.opacity * 100)}%
    </output>
  </label>

  <label
    class="grid shrink-0 grid-cols-[auto_30px] items-center gap-1 text-[var(--upaint-text-muted)]"
  >
    Color
    <input
      class="h-7 w-[30px] cursor-pointer border bg-[var(--upaint-surface-raised)] p-0.5"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="color"
      value={paintToolStore.brush.color}
      aria-label="Brush color"
      oninput={handleColorInput}
    />
  </label>

  <form
    class="flex shrink-0 items-center gap-1 border-l pl-2"
    style="border-color: var(--upaint-border);"
    onsubmit={handleDocumentResize}
  >
    <label class="flex items-center gap-1 text-[var(--upaint-text-muted)]">
      W
      <input
        class="h-7 w-[62px] border bg-[var(--upaint-surface-raised)] px-1 text-right tabular-nums text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
        type="number"
        name="document-width"
        min="1"
        max="16384"
        step="1"
        value={layerStore.document.boundaryBox.width}
        aria-label="Boundary box width"
        oninput={(event) => handleBoundaryDimensionInput(event, "width")}
      />
    </label>
    <span class="text-[var(--upaint-text-muted)]" aria-hidden="true">×</span>
    <label class="flex items-center gap-1 text-[var(--upaint-text-muted)]">
      H
      <input
        class="h-7 w-[62px] border bg-[var(--upaint-surface-raised)] px-1 text-right tabular-nums text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
        type="number"
        name="document-height"
        min="1"
        max="16384"
        step="1"
        value={layerStore.document.boundaryBox.height}
        aria-label="Boundary box height"
        oninput={(event) => handleBoundaryDimensionInput(event, "height")}
      />
    </label>
    <button
      type="button"
      class={toolButtonClass(paintToolStore.boundaryAspectRatio !== null)}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      title="Lock boundary-box aspect ratio"
      aria-label="Lock boundary-box aspect ratio"
      aria-pressed={paintToolStore.boundaryAspectRatio !== null}
      onclick={toggleBoundaryAspectLock}
    >
      {paintToolStore.boundaryAspectRatio !== null ? "🔒" : "🔓"}
    </button>
    <button
      type="button"
      class={`${buttonBase} ${buttonInactive}`}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      title="Swap boundary-box width and height"
      aria-label="Swap boundary-box width and height"
      onclick={swapBoundaryDimensions}
    >
      ⇄
    </button>
    <button
      type="submit"
      class={`${buttonBase} ${buttonInactive}`}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      title="Resize and center the boundary box"
    >
      Resize
    </button>
  </form>

  <button
    type="button"
    class={`ml-auto flex shrink-0 items-center gap-1.5 ${toolButtonClass(paintToolStore.activeTool === "boundary-box")}`}
    style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
    title="Move or resize the boundary box"
    aria-pressed={paintToolStore.activeTool === "boundary-box"}
    onclick={() => paintToolStore.setActiveTool("boundary-box")}
  >
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <rect x="2.25" y="2.25" width="11.5" height="11.5" />
      <path d="M5 2.25v11.5M11 2.25v11.5M2.25 5h11.5M2.25 11h11.5" opacity="0.45" />
    </svg>
    Boundary Box
  </button>
</div>
