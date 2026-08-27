<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { paintToolStore } from "../state/paintToolStore.svelte";
  import Slider from "./lib/Slider.svelte";

  const buttonBase = "cursor-pointer border px-2.5 py-1.5 text-[11px] leading-tight";
  const buttonInactive =
    "border-transparent bg-(--upaint-surface-raised) text-(--upaint-text) hover:border-(--upaint-border)";
  const buttonActive = "border-(--upaint-accent) bg-(--upaint-accent) text-(--upaint-text)";

  function toolButtonClass(active: boolean): string {
    return `${buttonBase} ${active ? buttonActive : buttonInactive}`;
  }

  function handleColorInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setBrushSettings({ color: input.value });
  }

  function handleSecondaryColorInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setSecondaryColor(input.value);
  }

  let pressurePopoverOpen = $state(false);
</script>

<div
  class="box-border flex h-[52px] w-full select-none items-center gap-2.5 overflow-x-auto overflow-y-hidden whitespace-nowrap border px-2 py-1.5 text-[11px] leading-tight"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-lg); background: var(--upaint-surface); color: var(--upaint-text); font-family: var(--upaint-font);"
  role="toolbar"
  aria-label="Painting tools"
>
  <div class="flex shrink-0 gap-1 border-r pr-2" style="border-color: var(--upaint-border);">
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
    <button
      type="button"
      class={toolButtonClass(paintToolStore.activeTool === "eyedropper")}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      title="Eyedropper (hold Alt to switch temporarily)"
      aria-pressed={paintToolStore.activeTool === "eyedropper"}
      onclick={() => paintToolStore.setActiveTool("eyedropper")}
    >
      <svg
        class="h-3.5 w-3.5"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        aria-hidden="true"
      >
        <path d="M11.25 2.25a2 2 0 0 1 2.83 2.83l-1.3 1.3-2.83-2.83z" stroke-linejoin="round" />
        <path
          d="M10.98 5.4 4.2 12.18a1.5 1.5 0 0 1-.66.38l-2.04.6.6-2.04c.07-.25.2-.47.38-.66L9.26 3.68"
          stroke-linejoin="round"
        />
        <path d="M8.4 5.9 10.1 7.6" />
      </svg>
    </button>
  </div>

  <label
    class="grid shrink-0 grid-cols-[auto_82px_36px] items-center gap-1 text-(--upaint-text-muted)"
  >
    Size
    <Slider
      inputClass="m-0 h-3.5 w-[82px] cursor-pointer accent-(--upaint-accent)"
      value={Math.round(paintToolStore.brush.radius)}
      min={1}
      max={256}
      step={1}
      ariaLabel="Brush size"
      onValueInput={(value) => paintToolStore.setBrushSettings({ radius: value })}
    />
    <output class="text-right tabular-nums text-(--upaint-text)">
      {Math.round(paintToolStore.brush.radius)}px
    </output>
  </label>

  <label
    class="grid shrink-0 grid-cols-[auto_82px_36px] items-center gap-1 text-(--upaint-text-muted)"
  >
    Hardness
    <Slider
      inputClass="m-0 h-3.5 w-[82px] cursor-pointer accent-(--upaint-accent)"
      value={Math.round(paintToolStore.brush.hardness * 100)}
      min={0}
      max={100}
      step={1}
      ariaLabel="Brush hardness"
      onValueInput={(value) => paintToolStore.setBrushSettings({ hardness: value / 100 })}
    />
    <output class="text-right tabular-nums text-(--upaint-text)">
      {Math.round(paintToolStore.brush.hardness * 100)}%
    </output>
  </label>

  <label
    class="grid shrink-0 grid-cols-[auto_82px_36px] items-center gap-1 text-(--upaint-text-muted)"
  >
    Opacity
    <Slider
      inputClass="m-0 h-3.5 w-[82px] cursor-pointer accent-(--upaint-accent)"
      value={Math.round(paintToolStore.brush.opacity * 100)}
      min={0}
      max={100}
      step={1}
      ariaLabel="Brush opacity"
      onValueInput={(value) => paintToolStore.setBrushSettings({ opacity: value / 100 })}
    />
    <output class="text-right tabular-nums text-(--upaint-text)">
      {Math.round(paintToolStore.brush.opacity * 100)}%
    </output>
  </label>

  <div class="relative h-7 w-[38px] shrink-0" title="Primary / secondary color (X swaps)">
    <input
      class="absolute left-0 top-0 h-6 w-6 cursor-pointer border bg-(--upaint-surface-raised) p-0.5"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm); z-index: 1;"
      type="color"
      value={paintToolStore.brush.color}
      aria-label="Primary brush color"
      oninput={handleColorInput}
    />
    <input
      class="absolute bottom-0 right-0 h-6 w-6 cursor-pointer border bg-(--upaint-surface-raised) p-0.5"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="color"
      value={paintToolStore.secondaryColor}
      aria-label="Secondary brush color"
      oninput={handleSecondaryColorInput}
    />
  </div>

  <div class="relative shrink-0">
    <button
      type="button"
      class={toolButtonClass(pressurePopoverOpen)}
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition), border-color var(--upaint-transition);"
      title="Pen pressure settings"
      aria-label="Pen pressure settings"
      aria-pressed={pressurePopoverOpen}
      onclick={() => (pressurePopoverOpen = !pressurePopoverOpen)}
    >
      <svg
        class="h-3.5 w-3.5"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.5" />
        <circle cx="8" cy="8" r="3.5" />
        <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      </svg>
    </button>
    {#if pressurePopoverOpen}
      <div
        class="fixed inset-0 z-40"
        role="presentation"
        tabindex="-1"
        onclick={() => (pressurePopoverOpen = false)}
      ></div>
      <div
        class="absolute left-0 top-full z-50 mt-1 flex w-max flex-col gap-1.5 border p-2 text-(--upaint-text)"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm); background: var(--upaint-surface);"
      >
        <label class="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={paintToolStore.brush.sizePressure}
            onchange={(event) =>
              paintToolStore.setBrushSettings({
                sizePressure: (event.currentTarget as HTMLInputElement).checked,
              })}
          />
          Size pressure
        </label>
        <label class="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={paintToolStore.brush.opacityPressure}
            onchange={(event) =>
              paintToolStore.setBrushSettings({
                opacityPressure: (event.currentTarget as HTMLInputElement).checked,
              })}
          />
          Opacity pressure
        </label>
      </div>
    {/if}
  </div>

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
