<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { generationRuntimeStore } from "../state/generationRuntimeStore.svelte";
  import { previewStore } from "../state/previewStore.svelte";
  import { toastStore } from "../state/toastStore.svelte";
  import { saveFlattenedImage } from "./generation/generationApi";
  import Button from "./lib/Button.svelte";
  import Icon from "./lib/Icon.svelte";

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
      toastStore.error("Could not apply the generated image.");
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
        <Icon name="check" />
      </Button>

      <Button
        size="icon"
        pressed={previewStore.visible}
        aria-label={previewStore.visible ? "Hide preview" : "Show preview"}
        title={previewStore.visible ? "Hide preview (A/B compare)" : "Show preview"}
        onclick={() => previewStore.toggleVisible()}
      >
        <Icon name={previewStore.visible ? "eye" : "eye-off"} />
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
        <Icon name="save" />
      </Button>

      <Button
        size="icon"
        variant="danger"
        aria-label="Discard selected preview"
        title="Discard selected preview"
        disabled={!previewStore.selected}
        onclick={() => previewStore.selected && previewStore.discard(previewStore.selected.id)}
      >
        <Icon name="x" />
      </Button>

      <Button
        size="icon"
        variant="danger"
        aria-label="Discard all previews"
        title="Discard all previews"
        onclick={() => previewStore.discardAll()}
      >
        <Icon name="trash" />
      </Button>
    </div>
  </div>
{/if}
