<script lang="ts">
  import { getActiveUltraPaintApp } from "../../app/UltraPaintApp";
  import { isDocumentMutationLocked } from "../../state/documentInteractionLock.svelte";
  import type { ScaleMode } from "../../state/generationSettingsStore.svelte";
  import { layerStore } from "../../state/layerStore.svelte";
  import { paintToolStore } from "../../state/paintToolStore.svelte";
  import { clampDimension } from "../../util/dimensions";
  import Button from "../lib/Button.svelte";
  import NumberInput from "../lib/NumberInput.svelte";
  import Select from "../lib/Select.svelte";
  import SliderNumberInput from "../lib/SliderNumberInput.svelte";

  interface Props {
    scaleMode: ScaleMode;
    autoBaseWidth: number;
    manualWidth: number;
    manualHeight: number;
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
  const documentLocked = $derived(isDocumentMutationLocked());

  function handleDimensionInput(event: Event, dimension: "width" | "height"): void {
    if (documentLocked) return;
    const ratio = paintToolStore.boundaryAspectRatio;
    const input = event.currentTarget as HTMLInputElement;
    const other = input.form?.elements.namedItem(
      dimension === "width" ? "boundary-height" : "boundary-width",
    );
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < 1) return;

    let width = dimension === "width" ? value : NaN;
    let height = dimension === "height" ? value : NaN;
    if (ratio !== null && other instanceof HTMLInputElement) {
      const otherValue = clampDimension(dimension === "width" ? value / ratio : value * ratio);
      other.value = String(otherValue);
      if (dimension === "width") height = otherValue;
      else width = otherValue;
    } else if (other instanceof HTMLInputElement) {
      const otherValue = Number(other.value);
      if (dimension === "width") height = otherValue;
      else width = otherValue;
    }

    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      return;
    getActiveUltraPaintApp()?.resizeBoundaryBox(width, height);
  }

  function toggleAspectLock(): void {
    const box = layerStore.document.boundaryBox;
    paintToolStore.setBoundaryAspectRatio(
      paintToolStore.boundaryAspectRatio === null ? box.width / box.height : null,
    );
  }

  function swapDimensions(): void {
    if (documentLocked) return;
    const box = layerStore.document.boundaryBox;
    layerStore.setBoundaryBox({ ...box, width: box.height, height: box.width });
  }

  function applyRatio(event: Event): void {
    if (documentLocked) return;
    const ratio = Number((event.currentTarget as HTMLSelectElement).value);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const box = layerStore.document.boundaryBox;
    if (paintToolStore.boundaryAspectRatio !== null) {
      paintToolStore.setBoundaryAspectRatio(ratio);
    }
    getActiveUltraPaintApp()?.resizeBoundaryBox(box.width, clampDimension(box.width / ratio));
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
    class="flex flex-col gap-2"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
  >
    <div class="flex no-wrap items-end gap-1.5">
      <div class="flex-1">
        <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
          Width
          <NumberInput
            class="px-1.5 py-1"
            name="boundary-width"
            min="1"
            max="8192"
            step="1"
            value={layerStore.document.boundaryBox.width}
            aria-label="Boundary box width"
            disabled={documentLocked}
            oninput={(event) => handleDimensionInput(event, "width")}
          />
        </label>
      </div>
      <div class="flex-1">
        <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
          Height
          <NumberInput
            class="px-1.5 py-1"
            name="boundary-height"
            min="1"
            max="8192"
            step="1"
            value={layerStore.document.boundaryBox.height}
            aria-label="Boundary box height"
            disabled={documentLocked}
            oninput={(event) => handleDimensionInput(event, "height")}
          />
        </label>
      </div>
      <div class="grow-0 gap-2">
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
          disabled={documentLocked}
          onclick={swapDimensions}
        >
          ⇄
        </Button>
      </div>
    </div>
    <Select
      bind:value={selectedRatio}
      aria-label="Boundary box aspect ratio"
      disabled={documentLocked}
      onchange={applyRatio}
    >
      <option value="">Aspect ratio…</option>
      {#each ratios as [label, ratio] (label)}
        <option value={ratio}>{label}</option>
      {/each}
    </Select>
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
    <SliderNumberInput
      label="Target resolution"
      value={autoBaseWidth}
      min={512}
      max={2048}
      sliderStep={64}
      onValueInput={onAutoBaseWidthChange}
    />
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
