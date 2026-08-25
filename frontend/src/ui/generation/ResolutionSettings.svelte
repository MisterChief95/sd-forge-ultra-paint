<script lang="ts">
  import type { ScaleMode } from "../../state/generationSettingsStore.svelte";
  import type { Resolution } from "../../util/autoResolution";
  import  SliderNumberInput from "../lib/SliderNumberInput.svelte";

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

  function updateScaleMode(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === "none" || value === "auto" || value === "manual") {
      onScaleModeChange(value);
    }
  }
</script>

<div class="flex flex-col gap-2 border bg-(--upaint-surface-raised) p-2" style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);">
  <label class="flex flex-col gap-1 text-(--upaint-text-muted)">
    Resolution scale
    <select class="border bg-(--upaint-surface) px-2 py-1.5 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)" style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);" value={scaleMode} aria-label="Resolution scale mode" onchange={updateScaleMode}>
      <option value="none">None</option>
      <option value="auto">Auto</option>
      <option value="manual">Manual</option>
    </select>
  </label>

  {#if scaleMode === "auto"}
    <div class="flex items-center justify-between gap-2 text-(--upaint-text-muted)">
      <SliderNumberInput label="Target resolution" value={autoBaseWidth} min={512} max={2048} sliderStep={64} onValueInput={onAutoBaseWidthChange} />
      <span>Adjusted</span>
      <output aria-label="Auto target size" class="tabular-nums text-(--upaint-text)">
        {autoTargetResolution
          ? `${autoTargetResolution.width} × ${autoTargetResolution.height}`
          : "Loading model profile…"}
      </output>
    </div>
  {:else if scaleMode === "manual"}
    <div class="grid grid-cols-2 gap-2">
      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
        Target width
        <input class="min-w-0 border bg-(--upaint-surface) px-1.5 py-1 text-right tabular-nums text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)" style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);" type="number" min="1" max="16384" step="1" value={manualWidth} aria-label="Target width" oninput={(event) => onManualWidthChange(Number(event.currentTarget.value))} />
      </label>
      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
        Target height
        <input class="min-w-0 border bg-(--upaint-surface) px-1.5 py-1 text-right tabular-nums text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)" style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);" type="number" min="1" max="16384" step="1" value={manualHeight} aria-label="Target height" oninput={(event) => onManualHeightChange(Number(event.currentTarget.value))} />
      </label>
    </div>
  {/if}
</div>
