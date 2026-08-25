<script lang="ts">
  import Slider from "../lib/Slider.svelte";
  import { fetchLoras, type LoraCatalogItem } from "./generationApi";
  import { clampLoraWeight, type SelectedLora } from "./lora";

  interface Props {
    selectedLoras: SelectedLora[];
    onSelectedLorasChange: (value: SelectedLora[]) => void;
    onAddActivationWords: (text: string) => void;
  }

  let {
    selectedLoras,
    onSelectedLorasChange,
    onAddActivationWords,
  }: Props = $props();

  let picker: HTMLDialogElement;
  let catalog = $state.raw<LoraCatalogItem[] | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let query = $state("");

  const selectedNames = $derived(new Set(selectedLoras.map((lora) => lora.promptName)));
  const filteredCatalog = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return catalog ?? [];
    return (catalog ?? []).filter((lora) =>
      `${lora.name} ${lora.promptName}`.toLocaleLowerCase().includes(needle),
    );
  });

  async function openPicker(): Promise<void> {
    picker.showModal();
    if (catalog !== null || loading) return;
    loading = true;
    loadError = null;
    try {
      catalog = await fetchLoras();
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Could not load LoRAs.";
    } finally {
      loading = false;
    }
  }

  function addLora(lora: LoraCatalogItem): void {
    if (selectedNames.has(lora.promptName)) return;
    onSelectedLorasChange([
      ...selectedLoras,
      { ...lora, enabled: true, weight: clampLoraWeight(lora.preferredWeight) },
    ]);
  }

  function updateLora(promptName: string, patch: Partial<SelectedLora>): void {
    onSelectedLorasChange(selectedLoras.map((lora) =>
      lora.promptName === promptName ? { ...lora, ...patch } : lora,
    ));
  }

  function updateWeight(promptName: string, value: number): void {
    if (Number.isFinite(value)) updateLora(promptName, { weight: clampLoraWeight(value) });
  }
</script>

<div class="flex flex-col gap-2">
  <button
    type="button"
    class="self-start border bg-(--upaint-surface-raised) px-2 py-1 text-(--upaint-text) hover:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
    onclick={() => void openPicker()}
  >
    Add +
  </button>

  {#if selectedLoras.length === 0}
    <p class="m-0 text-(--upaint-text-muted)">No LoRAs selected.</p>
  {:else}
    <div class="flex flex-col gap-2" aria-label="Selected LoRAs">
      {#each selectedLoras as lora (lora.promptName)}
        <div
          class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 border p-2"
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
        >
          <span class="truncate font-medium" title={lora.name}>{lora.name}</span>

          <button
            type="button"
            class="border px-2 py-1 text-(--upaint-text-muted) aria-pressed:border-(--upaint-accent)"
            style="border-color: var(--upaint-border); border-radius: 999px;"
            aria-label={`${lora.enabled ? "Disable" : "Enable"} ${lora.name}`}
            aria-pressed={lora.enabled}
            onclick={() => updateLora(lora.promptName, { enabled: !lora.enabled })}
          >
            {lora.enabled ? "Enabled" : "Off"}
          </button>

          <button
            type="button"
            class="border px-2 py-1 text-(--upaint-text-muted) enabled:hover:border-(--upaint-accent) enabled:hover:text-(--upaint-accent) disabled:cursor-not-allowed disabled:opacity-40"
            style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
            aria-label={`Add activation words for ${lora.name}`}
            title="Add activation words to positive prompt"
            disabled={!lora.activationText.trim()}
            onclick={() => onAddActivationWords(lora.activationText)}
          >
            {`{ }`}
          </button>

          <button
            type="button"
            class="border p-1 text-(--upaint-text-muted) hover:border-(--upaint-danger) hover:text-(--upaint-danger)"
            style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
            aria-label={`Remove ${lora.name}`}
            title={`Remove ${lora.name}`}
            onclick={() => onSelectedLorasChange(selectedLoras.filter((item) => item.promptName !== lora.promptName))}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6m4-6v6" />
            </svg>
          </button>

          <label class="col-span-4 grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-2 text-(--upaint-text-muted)">
            <span class="sr-only">Strength for {lora.name}</span>
            <Slider
              value={lora.weight}
              min={-2}
              max={2}
              step={0.05}
              ariaLabel={`Strength for ${lora.name}`}
              onValueInput={(value) => updateWeight(lora.promptName, value)}
            />
            <input
              class="min-w-0 border bg-(--upaint-surface-raised) px-2 py-1 text-right text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
              style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
              type="number"
              min={-10}
              max={10}
              step={0.05}
              value={lora.weight}
              aria-label={`Strength value for ${lora.name}`}
              oninput={(event) => updateWeight(lora.promptName, Number(event.currentTarget.value))}
            />
          </label>
        </div>
      {/each}
    </div>
  {/if}
</div>

<dialog
  bind:this={picker}
  class="m-auto max-h-[min(36rem,80vh)] w-[min(32rem,90vw)] border bg-(--upaint-surface) p-0 text-xs text-(--upaint-text) backdrop:bg-black/50"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-lg);"
  aria-labelledby="upaint-lora-picker-title"
  onclose={() => query = ""}
>
  <div class="flex flex-col gap-3 p-3">
    <header class="flex items-center justify-between gap-2">
      <h3 id="upaint-lora-picker-title" class="m-0 text-sm font-semibold">Add LoRA</h3>
      <form method="dialog">
        <button type="submit" class="px-2 py-1" aria-label="Close LoRA picker">Close</button>
      </form>
    </header>

    <label class="flex flex-col gap-1 text-(--upaint-text-muted)">
      Search LoRAs
      <input
        class="border bg-(--upaint-surface-raised) px-2 py-1.5 text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
        type="search"
        bind:value={query}
        placeholder="Search by name"
      />
    </label>

    {#if loading}
      <p class="m-0 text-(--upaint-text-muted)" role="status">Loading LoRAs…</p>
    {:else if loadError}
      <p class="m-0 text-(--upaint-danger)" role="alert">{loadError}</p>
    {:else if filteredCatalog.length === 0}
      <p class="m-0 text-(--upaint-text-muted)">
        {catalog?.length === 0 ? "No LoRAs are installed." : "No matching LoRAs."}
      </p>
    {:else}
      <div class="flex max-h-96 flex-col overflow-y-auto border" style="border-color: var(--upaint-border);">
        {#each filteredCatalog as lora (lora.promptName)}
          <button
            type="button"
            class="flex items-center justify-between gap-3 border-b px-2 py-2 text-left last:border-b-0 enabled:hover:bg-(--upaint-surface-raised) disabled:opacity-50"
            style="border-color: var(--upaint-border);"
            disabled={selectedNames.has(lora.promptName)}
            aria-label={`${selectedNames.has(lora.promptName) ? "Already added" : "Add"} ${lora.name}`}
            onclick={() => addLora(lora)}
          >
            <span class="min-w-0 truncate">{lora.name}</span>
            <span class="shrink-0 text-(--upaint-text-muted)">
              {selectedNames.has(lora.promptName) ? "Added" : "Add"}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</dialog>
