<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { generationRuntimeStore } from "../state/generationRuntimeStore.svelte";
  import { previewStore } from "../state/previewStore.svelte";
  import { toastStore } from "../state/toastStore.svelte";
  import { saveFlattenedImage } from "./generation/generationApi";
  import Button from "./lib/Button.svelte";

  let applying = $state(false);

  async function apply(): Promise<void> {
    const preview = previewStore.selected;
    const app = getActiveUltraPaintApp();
    if (!preview || !app || applying) return;

    applying = true;
    try {
      const id = await app.addImageFromDataURL(preview.dataUrl, "Generated", "generated");
      app.getStore().setSelectedLayerId(id);
      previewStore.discardAll();
    } catch (error) {
      console.error("[ultra-paint] could not apply generation preview:", error);
    } finally {
      applying = false;
    }
  }

  async function save(): Promise<void> {
    const preview = previewStore.selected;
    if (!preview || generationRuntimeStore.saving) return;

    generationRuntimeStore.setSaving(true);
    try {
      const path = await saveFlattenedImage(preview.dataUrl);
      toastStore.success(`Saved to ${path}`);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : "Save failed.");
    } finally {
      generationRuntimeStore.setSaving(false);
    }
  }
</script>

{#if previewStore.hasPreviews}
  <div
    class="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2 p-2"
    role="toolbar"
    aria-label="Generation previews"
  >
    <div class="flex max-w-[70vw] items-center gap-2 overflow-x-auto px-1 py-0.5">
      {#each previewStore.previews as preview (preview.id)}
        <button
          type="button"
          class="h-28 w-28 shrink-0 cursor-pointer overflow-hidden rounded border-2 bg-black/20 p-0 shadow-lg"
          style="border-color: {preview.id === previewStore.selectedId
            ? 'var(--upaint-accent)'
            : 'var(--upaint-border)'};"
          aria-label="Preview generated image"
          aria-pressed={preview.id === previewStore.selectedId}
          onclick={() => previewStore.select(preview.id)}
        >
          <img src={preview.dataUrl} alt="" class="h-full w-full object-contain" />
        </button>
      {/each}
    </div>

    <div class="flex items-center gap-1">
      <Button
        size="icon"
        aria-label="Apply selected preview"
        title="Apply selected preview"
        disabled={!previewStore.selected || applying}
        onclick={apply}
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <path d="M3 8.5l3.2 3.2L13 4.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </Button>

      <Button
        size="icon"
        pressed={previewStore.visible}
        aria-label={previewStore.visible ? "Hide preview" : "Show preview"}
        title={previewStore.visible ? "Hide preview (A/B compare)" : "Show preview"}
        onclick={() => previewStore.toggleVisible()}
      >
        {#if previewStore.visible}
          <svg
            class="h-3.5 w-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            aria-hidden="true"
          >
            <path
              d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"
              stroke-linejoin="round"
            />
            <circle cx="8" cy="8" r="2" />
          </svg>
        {:else}
          <svg
            class="h-3.5 w-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            aria-hidden="true"
          >
            <path
              d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"
              stroke-linejoin="round"
            />
            <circle cx="8" cy="8" r="2" />
            <path d="M2 14L14 2" stroke-linecap="round" />
          </svg>
        {/if}
      </Button>

      <Button
        size="icon"
        aria-label={generationRuntimeStore.saving
          ? "Saving selected preview"
          : "Save selected preview"}
        title={generationRuntimeStore.saving ? "Saving selected preview" : "Save selected preview"}
        disabled={!previewStore.selected || generationRuntimeStore.saving}
        onclick={save}
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <path d="M2.5 2.5h8.75l2.25 2.25V13.5h-11z" stroke-linejoin="round" />
          <path d="M5 2.5v4h5.5v-4M5 13.5V9h6v4.5" stroke-linejoin="round" />
        </svg>
      </Button>

      <Button
        size="icon"
        variant="danger"
        aria-label="Discard selected preview"
        title="Discard selected preview"
        disabled={!previewStore.selected}
        onclick={() => previewStore.selected && previewStore.discard(previewStore.selected.id)}
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <path d="M3 3l10 10M13 3L3 13" stroke-linecap="round" />
        </svg>
      </Button>

      <Button
        size="icon"
        variant="danger"
        aria-label="Discard all previews"
        title="Discard all previews"
        onclick={() => previewStore.discardAll()}
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          aria-hidden="true"
        >
          <path
            d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8.4a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </Button>
    </div>
  </div>
{/if}
