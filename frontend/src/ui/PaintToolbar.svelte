<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { paintToolStore } from "../state/paintToolStore.svelte";
  import brushIcon from "./img/brush-tool-svgrepo-com.svg";
  import eraserIcon from "./img/eraser-svgrepo-com.svg";
  import fillIcon from "./img/fill-svgrepo-com.svg";
  import Button from "./lib/Button.svelte";
  import CheckboxField from "./lib/CheckboxField.svelte";
  import Slider from "./lib/Slider.svelte";

  function handleColorInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setBrushSettings({ color: input.value });
  }

  function handleSecondaryColorInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    paintToolStore.setSecondaryColor(input.value);
  }

  let pressurePopoverOpen = $state(false);

  function positionPressurePopover(event: MouseEvent): void {
    const button = event.currentTarget;
    const popover = document.getElementById("upaint-pressure-popover");
    if (!(button instanceof HTMLButtonElement) || !(popover instanceof HTMLElement)) return;
    const bounds = button.getBoundingClientRect();
    popover.style.left = `${bounds.left}px`;
    popover.style.top = `${bounds.bottom + 4}px`;
  }

  function dismissPressurePopover(event: PointerEvent): void {
    if (!pressurePopoverOpen || !(event.target instanceof Element)) return;
    if (
      event.target.closest("#upaint-pressure-popover") ||
      event.target.closest('[popovertarget="upaint-pressure-popover"]')
    ) {
      return;
    }
    const popover = document.getElementById("upaint-pressure-popover");
    if (popover instanceof HTMLElement && popover.matches(":popover-open")) {
      popover.hidePopover();
    }
  }
</script>

<svelte:window onpointerdown={dismissPressurePopover} />

<div
  class="box-border flex h-[52px] w-full select-none items-center gap-2.5 overflow-x-auto overflow-y-hidden whitespace-nowrap border px-2 py-1.5 text-[11px] leading-tight"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-lg); background: var(--upaint-surface); color: var(--upaint-text); font-family: var(--upaint-font);"
  role="toolbar"
  aria-label="Painting tools"
>
  <div class="flex shrink-0 gap-1 border-r pr-2" style="border-color: var(--upaint-border);">
    <Button
      size="icon"
      pressed={paintToolStore.activeTool === "brush"}
      title="Brush"
      aria-label="Brush"
      onclick={() => paintToolStore.setActiveTool("brush")}
    >
      <img src={brushIcon} alt="" class="h-4 w-4 brightness-0 invert" />
    </Button>
    <Button
      size="icon"
      pressed={paintToolStore.activeTool === "eraser"}
      title="Eraser"
      aria-label="Eraser"
      onclick={() => paintToolStore.setActiveTool("eraser")}
    >
      <img src={eraserIcon} alt="" class="h-4 w-4 brightness-0 invert" />
    </Button>
    <Button
      size="icon"
      title="Fill the selected layer"
      aria-label="Fill the selected layer"
      onclick={() => getActiveUltraPaintApp()?.fillSelectedLayer()}
    >
      <img src={fillIcon} alt="" class="h-4 w-4 brightness-0 invert" />
    </Button>
    <Button
      size="icon"
      pressed={paintToolStore.activeTool === "eyedropper"}
      title="Eyedropper (hold Alt to switch temporarily)"
      aria-label="Eyedropper (hold Alt to switch temporarily)"
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
    </Button>
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

  <div class="flex shrink-0">
    <Button
      size="icon"
      radius="left"
      pressed={paintToolStore.brush.pressureEnabled}
      title={paintToolStore.brush.pressureEnabled ? "Disable pen pressure" : "Enable pen pressure"}
      aria-label={paintToolStore.brush.pressureEnabled
        ? "Disable pen pressure"
        : "Enable pen pressure"}
      onclick={() =>
        paintToolStore.setBrushSettings({
          pressureEnabled: !paintToolStore.brush.pressureEnabled,
        })}
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
    </Button>
    <Button
      size="icon"
      radius="right"
      pressed={pressurePopoverOpen}
      title="Configure pen pressure"
      aria-label="Configure pen pressure"
      aria-haspopup="dialog"
      popovertarget="upaint-pressure-popover"
      onclick={positionPressurePopover}
      style="width: 20px; padding: 0; border-left-width: 0;"
    >
      <svg
        class="h-3 w-3"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path d="m4 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </Button>
  </div>

  <Button
    class="ml-auto gap-1.5"
    pressed={paintToolStore.activeTool === "boundary-box"}
    title="Move or resize the boundary box"
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
  </Button>
</div>

<div
  id="upaint-pressure-popover"
  popover="auto"
  role="dialog"
  aria-label="Pen pressure settings"
  class="fixed inset-auto z-50 m-0 w-max flex-col gap-1.5 border p-2 text-[11px] text-(--upaint-text)"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm); background: var(--upaint-surface);"
  ontoggle={(event) => (pressurePopoverOpen = event.newState === "open")}
>
  <CheckboxField
    label="Size pressure"
    checked={paintToolStore.brush.sizePressure}
    onchange={(event) =>
      paintToolStore.setBrushSettings({ sizePressure: event.currentTarget.checked })}
  />
  <CheckboxField
    label="Opacity pressure"
    checked={paintToolStore.brush.opacityPressure}
    onchange={(event) =>
      paintToolStore.setBrushSettings({ opacityPressure: event.currentTarget.checked })}
  />
</div>

<style>
  #upaint-pressure-popover:popover-open {
    display: flex;
  }
</style>
