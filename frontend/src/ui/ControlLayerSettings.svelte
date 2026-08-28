<script lang="ts">
  import { layerStore } from "../state/layerStore.svelte";
  import type { ControlLayer, ControlMode, ControlResizeMode } from "../state/schema";
  import { fetchControlModels } from "./generation/controlnetApi";
  import CheckboxField from "./lib/CheckboxField.svelte";
  import Select from "./lib/Select.svelte";
  import Slider from "./lib/Slider.svelte";

  interface Props {
    layer: ControlLayer;
  }

  const { layer }: Props = $props();

  const CONTROL_MODES: { value: ControlMode; label: string }[] = [
    { value: "balanced", label: "Balanced" },
    { value: "prompt", label: "My prompt is more important" },
    { value: "control", label: "ControlNet is more important" },
  ];
  const RESIZE_MODES: { value: ControlResizeMode; label: string }[] = [
    { value: "resize", label: "Just Resize" },
    { value: "crop", label: "Crop and Resize" },
    { value: "fill", label: "Resize and Fill" },
  ];

  // Module-level cache: every open control-layer panel shares one catalog
  // fetch instead of re-requesting Forge's ControlNet routes per row.
  let catalog = $state<{ models: string[] } | null>(null);
  let catalogFailed = $state(false);

  $effect(() => {
    if (catalog || catalogFailed) return;
    void (async () => {
      const models = await fetchControlModels();
      if (models.length === 0) {
        catalogFailed = true;
        return;
      }
      catalog = { models };
    })();
  });
</script>

<div
  class="col-span-5 flex flex-col gap-1.5 border-t pt-1.5 text-[11px] text-(--upaint-text-muted)"
  style="border-color: var(--upaint-border);"
>
  <label class="flex flex-col gap-0.5">
    Model
    <Select
      surface="base"
      class="px-1 py-1 text-[11px]"
      value={layer.model}
      onchange={(event) =>
        layerStore.setControlParams(layer.id, {
          model: (event.currentTarget as HTMLSelectElement).value,
        })}
    >
      {#if !catalog?.models.includes(layer.model)}
        <option value={layer.model}>{layer.model}</option>
      {/if}
      {#each catalog?.models ?? [] as model (model)}
        <option value={model}>{model}</option>
      {/each}
    </Select>
  </label>

  {#if catalogFailed}
    <p class="m-0 text-(--upaint-danger)">
      Could not reach Forge's ControlNet routes -- is the extension installed?
    </p>
  {/if}

  <div class="grid grid-cols-[auto_minmax(0,1fr)_36px] items-center gap-1.5">
    <span>Weight</span>
    <Slider
      value={layer.weight}
      min={0}
      max={2}
      step={0.05}
      title="Control weight"
      ariaLabel={`Control weight of "${layer.name}"`}
      onValueInput={(value) => layerStore.setControlParams(layer.id, { weight: value })}
    />
    <output class="text-right tabular-nums">{layer.weight.toFixed(2)}</output>

    <span>Start</span>
    <Slider
      value={layer.guidanceStart}
      min={0}
      max={1}
      step={0.01}
      title="Guidance start"
      ariaLabel={`Guidance start of "${layer.name}"`}
      onValueInput={(value) => layerStore.setControlParams(layer.id, { guidanceStart: value })}
    />
    <output class="text-right tabular-nums">{layer.guidanceStart.toFixed(2)}</output>

    <span>End</span>
    <Slider
      value={layer.guidanceEnd}
      min={0}
      max={1}
      step={0.01}
      title="Guidance end"
      ariaLabel={`Guidance end of "${layer.name}"`}
      onValueInput={(value) => layerStore.setControlParams(layer.id, { guidanceEnd: value })}
    />
    <output class="text-right tabular-nums">{layer.guidanceEnd.toFixed(2)}</output>
  </div>

  <div class="grid grid-cols-2 gap-1.5">
    <label class="flex flex-col gap-0.5">
      Control mode
      <Select
        surface="base"
        class="px-1 py-1 text-[11px]"
        value={layer.controlMode}
        onchange={(event) =>
          layerStore.setControlParams(layer.id, {
            controlMode: (event.currentTarget as HTMLSelectElement).value as ControlMode,
          })}
      >
        {#each CONTROL_MODES as mode (mode.value)}
          <option value={mode.value}>{mode.label}</option>
        {/each}
      </Select>
    </label>

    <label class="flex flex-col gap-0.5">
      Resize mode
      <Select
        surface="base"
        class="px-1 py-1 text-[11px]"
        value={layer.resizeMode}
        onchange={(event) =>
          layerStore.setControlParams(layer.id, {
            resizeMode: (event.currentTarget as HTMLSelectElement).value as ControlResizeMode,
          })}
      >
        {#each RESIZE_MODES as mode (mode.value)}
          <option value={mode.value}>{mode.label}</option>
        {/each}
      </Select>
    </label>
  </div>

  <CheckboxField
    label="Pixel Perfect"
    checked={layer.pixelPerfect}
    onchange={(event) =>
      layerStore.setControlParams(layer.id, {
        pixelPerfect: event.currentTarget.checked,
      })}
  />
</div>
