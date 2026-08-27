<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { previewStore } from "../state/previewStore.svelte";

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
          <img src={preview.dataUrl} alt="" class="h-full w-full object-cover" />
        </button>
      {/each}
    </div>

    <div class="flex items-center gap-1">
      <button
        type="button"
        class="flex cursor-pointer items-center justify-center rounded border p-1.5 hover:border-(--upaint-accent) disabled:cursor-not-allowed disabled:opacity-50"
        style="border-color: var(--upaint-border); background: var(--upaint-surface-raised);"
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
      </button>

      <button
        type="button"
        class="flex cursor-pointer items-center justify-center rounded border p-1.5 hover:border-(--upaint-accent)"
        style="border-color: var(--upaint-border); background: var(--upaint-surface-raised);"
        aria-label={previewStore.visible ? "Hide preview" : "Show preview"}
        title={previewStore.visible ? "Hide preview (A/B compare)" : "Show preview"}
        aria-pressed={previewStore.visible}
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
      </button>

      <button
        type="button"
        class="flex cursor-pointer items-center justify-center rounded border p-1.5 hover:border-(--upaint-danger) disabled:cursor-not-allowed disabled:opacity-50"
        style="border-color: var(--upaint-border); background: var(--upaint-surface-raised); color: var(--upaint-danger);"
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
      </button>

      <button
        type="button"
        class="flex cursor-pointer items-center justify-center rounded border p-1.5 hover:border-(--upaint-danger)"
        style="border-color: var(--upaint-border); background: var(--upaint-surface-raised); color: var(--upaint-danger);"
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
      </button>
    </div>
  </div>
{/if}
