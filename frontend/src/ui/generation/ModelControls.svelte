<script lang="ts">
  import Select from "../lib/Select.svelte";

  interface Props {
    models: string[];
    modules: string[];
    modelName: string;
    moduleNames: string[];
  }

  let { models, modules, modelName = $bindable(), moduleNames = $bindable() }: Props = $props();
  let modulePickerOpen = $state(false);
  let modulePickerRoot: HTMLDivElement;

  function addModule(module: string): void {
    if (!module || moduleNames.includes(module)) return;
    moduleNames = [...moduleNames, module];
  }

  function removeModule(module: string): void {
    moduleNames = moduleNames.filter((selected) => selected !== module);
  }

  function handlePickerKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      modulePickerOpen = false;
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      modulePickerOpen = true;
    }
  }

  function closePickerOnOutsideClick(event: MouseEvent): void {
    if (
      modulePickerOpen &&
      event.target instanceof Node &&
      !modulePickerRoot.contains(event.target)
    ) {
      modulePickerOpen = false;
    }
  }
</script>

<svelte:document onclick={closePickerOnOutsideClick} />

<div class="flex flex-col gap-2">
  <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
    Model
    <Select bind:value={modelName} aria-label="Model">
      {#each models as model (model)}
        <option value={model}>{model}</option>
      {/each}
    </Select>
  </label>

  <div class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)" bind:this={modulePickerRoot}>
    VAE / Text Encoder
    <div class="relative">
      <div
        role="combobox"
        tabindex="0"
        aria-label="VAE / Text Encoder"
        aria-controls="upaint-module-picker"
        aria-expanded={modulePickerOpen}
        aria-haspopup="listbox"
        aria-describedby="upaint-module-selection-help"
        class="flex min-h-8 cursor-pointer flex-wrap items-center gap-1 border p-1.5 outline-none transition-colors focus:border-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent)"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm); background: var(--upaint-surface-raised);"
        onclick={() => (modulePickerOpen = true)}
        onkeydown={handlePickerKeydown}
      >
        {#each moduleNames as module (module)}
          <span
            class="flex max-w-full items-center gap-1 bg-(--upaint-surface) px-1.5 py-0.5 text-(--upaint-text)"
            style="border-radius: var(--upaint-radius-sm);"
            title={module}
          >
            <span class="min-w-0 truncate">{module}</span>
            <button
              type="button"
              class="shrink-0 border-0 bg-transparent p-0.5 text-(--upaint-text-muted) hover:text-(--upaint-text) focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--upaint-accent)"
              aria-label={`Remove ${module}`}
              onclick={(event) => {
                event.stopPropagation();
                removeModule(module);
              }}
            >
              ×
            </button>
          </span>
        {/each}
        {#if moduleNames.length === 0}
          <span class="px-1 text-(--upaint-text-muted)">Choose VAE / Text Encoder files…</span>
        {/if}
      </div>

      {#if modulePickerOpen}
        <div
          id="upaint-module-picker"
          class="absolute z-20 mt-1 flex max-h-48 w-full flex-col overflow-y-auto border bg-(--upaint-surface-raised)"
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
          role="listbox"
          aria-label="VAE / Text Encoder options"
        >
          {#each modules as module (module)}
            <button
              type="button"
              role="option"
              class="flex min-w-0 items-center justify-between gap-2 border-b px-2 py-1.5 text-left last:border-b-0 enabled:hover:bg-(--upaint-surface) disabled:cursor-default disabled:opacity-50"
              style="border-color: var(--upaint-border);"
              disabled={moduleNames.includes(module)}
              aria-selected={moduleNames.includes(module)}
              onclick={() => addModule(module)}
            >
              <span class="truncate" title={module}>{module}</span>
              <span class="shrink-0 text-(--upaint-text-muted)">
                {moduleNames.includes(module) ? "Added" : "Add"}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
