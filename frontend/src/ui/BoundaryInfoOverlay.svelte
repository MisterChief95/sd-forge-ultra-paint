<script lang="ts">
  import { generationRuntimeStore } from "../state/generationRuntimeStore.svelte";
  import { generationSettingsStore } from "../state/generationSettingsStore.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import { paintToolStore } from "../state/paintToolStore.svelte";
  import { calculateAutoResolution, type Resolution } from "../util/autoResolution";

  const box = $derived(paintToolStore.liveBoundaryBox ?? layerStore.document.boundaryBox);

  const adjusted = $derived.by((): Resolution | null => {
    switch (generationSettingsStore.scaleMode) {
      case "none":
        return null;
      case "auto": {
        const step = generationRuntimeStore.resolutionStep;
        if (step === null) return null;
        return calculateAutoResolution(
          box.width,
          box.height,
          generationSettingsStore.autoBaseWidth,
          step,
        );
      }
      case "manual":
        return {
          width: generationSettingsStore.manualWidth,
          height: generationSettingsStore.manualHeight,
        };
    }
  });
</script>

<div
  class="absolute top-2 left-2 z-10 rounded border px-2 py-1 text-xs tabular-nums shadow-lg"
  style="border-color: var(--upaint-border); background: color-mix(in srgb, var(--upaint-surface) 80%, transparent); color: var(--upaint-text);"
>
  <div>{box.width} × {box.height}</div>
  {#if adjusted}
    <div class="text-(--upaint-text-muted)">→ {adjusted.width} × {adjusted.height}</div>
  {/if}
</div>
