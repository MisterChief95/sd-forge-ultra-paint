<script lang="ts">
  import { getActiveUltraPaintApp } from "../../app/UltraPaintApp";
  import type { ScaleMode } from "../../state/generationSettingsStore.svelte";
  import { layerStore } from "../../state/layerStore.svelte";
  import { paintToolStore } from "../../state/paintToolStore.svelte";
  import type { Resolution } from "../../util/autoResolution";
  import Button from "../lib/Button.svelte";
  import NumberInput from "../lib/NumberInput.svelte";
  import Select from "../lib/Select.svelte";
  import SliderNumberInput from "../lib/SliderNumberInput.svelte";

  interface Props {
    scaleMode: ScaleMode;
    autoBaseWidth: number;
    manualWidth: number;
    manualHeight: number;
    autoTargetResolution: Resolution | null;
    onScaleModeChange: (value: ScaleMode) => void;
    onAutoBaseWidthChange: (value: number) => void;
    onManualWidthChange: (value: number) => void;
    onManualHeightChange: (value: number) => void;
  }

  let {
    scaleMode,
    autoBaseWidth,
    manualWidth,
    manualHeight,
    autoTargetResolution,
    onScaleModeChange,
    onAutoBaseWidthChange,
    onManualWidthChange,
    onManualHeightChange,
  }: Props = $props();

  const ratios = [
    ["1:1", 1],
    ["3:4", 3 / 4],
    ["4:3", 4 / 3],
    ["2:3", 2 / 3],
    ["3:2", 3 / 2],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["9:21", 9 / 21],
    ["21:9", 21 / 9],
  ] as const;

  let selectedRatio = $state("");

  function handleResize(event: SubmitEvent): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const width = Number(data.get("boundary-width"));
    const height = Number(data.get("boundary-height"));
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      return;
    getActiveUltraPaintApp()?.resizeBoundaryBox(width, height);
  }

  function syncLockedDimension(event: Event, dimension: "width" | "height"): void {
    const ratio = paintToolStore.boundaryAspectRatio;
    const input = event.currentTarget as HTMLInputElement;
    const other = input.form?.elements.namedItem(
      dimension === "width" ? "boundary-height" : "boundary-width",
    );
    const value = Number(input.value);
    if (
      ratio === null ||
      !(other instanceof HTMLInputElement) ||
      !Number.isFinite(value) ||
      value < 1
    )
      return;
    other.value = String(
      Math.max(1, Math.round(dimension === "width" ? value / ratio : value * ratio)),
    );
  }

  function toggleAspectLock(): void {
    const box = layerStore.document.boundaryBox;
    paintToolStore.setBoundaryAspectRatio(
      paintToolStore.boundaryAspectRatio === null ? box.width / box.height : null,
    );
  }

  function swapDimensions(): void {
    const box = layerStore.document.boundaryBox;
    layerStore.setBoundaryBox({ ...box, width: box.height, height: box.width });
  }

  function applyRatio(event: Event): void {
    const ratio = Number((event.currentTarget as HTMLSelectElement).value);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const box = layerStore.document.boundaryBox;
    if (paintToolStore.boundaryAspectRatio !== null) {
      paintToolStore.setBoundaryAspectRatio(ratio);
    }
    getActiveUltraPaintApp()?.resizeBoundaryBox(
      box.width,
      Math.max(1, Math.round(box.width / ratio)),
    );
  }

  function updateScaleMode(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === "none" || value === "auto" || value === "manual") {
      onScaleModeChange(value);
    }
  }
</script>

<div class="flex flex-col gap-2">
  <form
    class="flex flex-col gap-2 border bg-(--upaint-surface-raised) p-2"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
    onsubmit={handleResize}
  >
    <div class="grid grid-cols-[1fr_auto_1fr_auto_auto] items-end gap-1.5">
      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
        Width
        <NumberInput
          surface="base"
          class="px-1.5 py-1"
          name="boundary-width"
          min="1"
          max="16384"
          step="1"
          value={layerStore.document.boundaryBox.width}
          aria-label="Boundary box width"
          oninput={(event) => syncLockedDimension(event, "width")}
        />
      </label>
      <span class="pb-1.5 text-(--upaint-text-muted)" aria-hidden="true">×</span>
      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
        Height
        <NumberInput
          surface="base"
          class="px-1.5 py-1"
          name="boundary-height"
          min="1"
          max="16384"
          step="1"
          value={layerStore.document.boundaryBox.height}
          aria-label="Boundary box height"
          oninput={(event) => syncLockedDimension(event, "height")}
        />
      </label>
      <Button
        size="icon"
        pressed={paintToolStore.boundaryAspectRatio !== null}
        title="Lock boundary-box aspect ratio"
        aria-label="Lock boundary-box aspect ratio"
        onclick={toggleAspectLock}
      >
        {paintToolStore.boundaryAspectRatio !== null ? "🔒" : "🔓"}
      </Button>
      <Button
        size="icon"
        title="Swap boundary-box width and height"
        aria-label="Swap boundary-box width and height"
        onclick={swapDimensions}
      >
        ⇄
      </Button>
    </div>
    <div class="flex gap-2">
      <Select
        class="flex-1"
        surface="base"
        bind:value={selectedRatio}
        aria-label="Boundary box aspect ratio"
        onchange={applyRatio}
      >
        <option value="">Aspect ratio…</option>
        {#each ratios as [label, ratio] (label)}
          <option value={ratio}>{label}</option>
        {/each}
      </Select>
      <Button type="submit" title="Resize and center the boundary box">Resize</Button>
    </div>
  </form>

  <label class="flex flex-col gap-1 text-(--upaint-text-muted)">
    Resolution scale
    <Select value={scaleMode} aria-label="Resolution scale mode" onchange={updateScaleMode}>
      <option value="none">None</option>
      <option value="auto">Auto</option>
      <option value="manual">Manual</option>
    </Select>
  </label>

  {#if scaleMode === "auto"}
    <div class="grid grid-cols-3 justify-between gap-2 text-(--upaint-text-muted)">
      <div class="col-span-2">
        <SliderNumberInput
          label="Target resolution"
          value={autoBaseWidth}
          min={512}
          max={2048}
          sliderStep={64}
          onValueInput={onAutoBaseWidthChange}
        />
      </div>
      <div class="min-w-8">
        <p>Adjusted</p>
        <output aria-label="Auto target size" class="tabular-nums text-(--upaint-text)">
          {#if autoTargetResolution}
            Width: {autoTargetResolution.width} <br /> Height: {autoTargetResolution.height}
          {:else}
            Loading model profile…
          {/if}
        </output>
      </div>
    </div>
  {:else if scaleMode === "manual"}
    <div class="grid grid-cols-2 gap-2">
      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
        Target width
        <NumberInput
          surface="base"
          class="px-1.5 py-1"
          min="1"
          max="16384"
          step="1"
          value={manualWidth}
          aria-label="Target width"
          oninput={(event) => onManualWidthChange(Number(event.currentTarget.value))}
        />
      </label>
      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
        Target height
        <NumberInput
          surface="base"
          class="px-1.5 py-1"
          min="1"
          max="16384"
          step="1"
          value={manualHeight}
          aria-label="Target height"
          oninput={(event) => onManualHeightChange(Number(event.currentTarget.value))}
        />
      </label>
    </div>
  {/if}
</div>
