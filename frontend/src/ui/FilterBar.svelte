<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { filterStore } from "../state/filterStore.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import { fetchControlModules, preprocessControlImage } from "./generation/controlnetApi";
  import Button from "./lib/Button.svelte";
  import NumberInput from "./lib/NumberInput.svelte";
  import Select from "./lib/Select.svelte";

  const layer = $derived(
    filterStore.targetLayerId ? layerStore.getLayer(filterStore.targetLayerId) : undefined,
  );

  let modules = $state<string[]>([]);
  let modulesFailed = $state(false);
  let accepting = $state(false);

  $effect(() => {
    if (!filterStore.active || modules.length > 0 || modulesFailed) return;
    void (async () => {
      const result = await fetchControlModules();
      if (result.length === 0) {
        modulesFailed = true;
        return;
      }
      modules = result;
      if (!filterStore.module || filterStore.module === "none") {
        filterStore.setParams({ module: result[0] });
      }
    })();
  });

  async function preview(): Promise<void> {
    const app = getActiveUltraPaintApp();
    const targetId = filterStore.targetLayerId;
    if (!app || !targetId) return;
    const source = app.layerSourceDataURL(targetId);
    if (!source) {
      filterStore.setError("Layer has no pixels to preview yet.");
      return;
    }
    filterStore.setPending(true);
    const result = await preprocessControlImage(
      filterStore.module,
      source,
      filterStore.thresholdA,
      filterStore.thresholdB,
    );
    if (filterStore.targetLayerId !== targetId) return;
    if (result === null) {
      filterStore.setError("Preview failed -- is ControlNet installed?");
      return;
    }
    filterStore.setPreviewResult(result);
  }

  async function accept(): Promise<void> {
    const app = getActiveUltraPaintApp();
    const targetId = filterStore.targetLayerId;
    const dataUrl = filterStore.previewDataUrl;
    if (!app || !targetId || !dataUrl || accepting) return;
    accepting = true;
    try {
      await app.acceptFilterResult(targetId, dataUrl);
      filterStore.cancel();
    } catch (error) {
      console.error("[ultra-paint] could not accept filter result:", error);
      filterStore.setError("Could not apply the filter result to the layer.");
    } finally {
      accepting = false;
    }
  }
</script>

{#if filterStore.active && layer}
  <div
    class="absolute bottom-2 left-1/2 z-10 flex w-[min(420px,90vw)] -translate-x-1/2 flex-col gap-2 border p-2 shadow-lg"
    style="border-color: var(--upaint-border); background: var(--upaint-surface-raised); border-radius: var(--upaint-radius-sm);"
    role="toolbar"
    aria-label={`Filter "${layer.name}"`}
  >
    <div class="flex items-center justify-between text-[11px] font-medium">
      <span>Filter &ldquo;{layer.name}&rdquo;</span>
    </div>

    <div class="grid grid-cols-2 gap-1.5 text-[11px] text-(--upaint-text-muted)">
      <label class="flex flex-col gap-0.5">
        Filter type
        <Select
          surface="base"
          class="px-1 py-1 text-[11px]"
          value="controlnet-preprocessor"
          disabled
        >
          <option value="controlnet-preprocessor">ControlNet Preprocessor</option>
        </Select>
      </label>

      <label class="flex flex-col gap-0.5">
        Preprocessor
        <Select
          surface="base"
          class="px-1 py-1 text-[11px]"
          value={filterStore.module}
          onchange={(event) =>
            filterStore.setParams({ module: (event.currentTarget as HTMLSelectElement).value })}
        >
          {#if !modules.includes(filterStore.module)}
            <option value={filterStore.module}
              >{filterStore.module || "Select a preprocessor"}</option
            >
          {/if}
          {#each modules as module (module)}
            <option value={module}>{module}</option>
          {/each}
        </Select>
      </label>
    </div>

    {#if modulesFailed}
      <p class="m-0 text-[11px] text-(--upaint-danger)">
        Could not reach Forge's ControlNet routes -- is the extension installed?
      </p>
    {/if}

    <div class="grid grid-cols-2 gap-1.5 text-[11px] text-(--upaint-text-muted)">
      <label class="flex flex-col gap-0.5">
        Threshold A
        <NumberInput
          surface="base"
          value={filterStore.thresholdA}
          min={0}
          onchange={(event) =>
            filterStore.setParams({
              thresholdA: Number((event.currentTarget as HTMLInputElement).value) || 0,
            })}
        />
      </label>
      <label class="flex flex-col gap-0.5">
        Threshold B
        <NumberInput
          surface="base"
          value={filterStore.thresholdB}
          min={0}
          onchange={(event) =>
            filterStore.setParams({
              thresholdB: Number((event.currentTarget as HTMLInputElement).value) || 0,
            })}
        />
      </label>
    </div>

    {#if filterStore.error}
      <p class="m-0 text-[11px] text-(--upaint-danger)">{filterStore.error}</p>
    {/if}

    <div class="flex items-center justify-end gap-1.5">
      <Button variant="default" size="sm" onclick={() => filterStore.cancel()}>Cancel</Button>
      <Button
        variant="default"
        size="sm"
        disabled={filterStore.pending}
        onclick={() => void preview()}
      >
        {filterStore.pending ? "Previewing..." : "Preview"}
      </Button>
      <Button
        variant="primary"
        size="sm"
        disabled={!filterStore.previewDataUrl || accepting}
        onclick={() => void accept()}
      >
        {accepting ? "Accepting..." : "Accept"}
      </Button>
    </div>
  </div>
{/if}
