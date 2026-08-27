<script lang="ts">
  import Button from "../lib/Button.svelte";
  import type { ProgressResponse } from "./generationApi";

  interface Props {
    generating: boolean;
    saving: boolean;
    interrupting: boolean;
    progress: ProgressResponse | null;
    progressPercent: number;
    saveMessage: string | null;
    errorMessage: string | null;
    onGenerate: () => void;
    onSave: () => void;
    onCancel: () => void;
  }

  let {
    generating,
    saving,
    interrupting,
    progress,
    progressPercent,
    saveMessage,
    errorMessage,
    onGenerate,
    onSave,
    onCancel,
  }: Props = $props();
</script>

<!-- Keep cancel mounted so Generate retains the same width in both states. -->
<div class="flex gap-2">
  <Button
    variant="primary"
    class="flex-1 px-3 py-2 text-sm font-semibold disabled:cursor-wait"
    disabled={generating}
    onclick={onGenerate}
  >
    {generating ? "Generating…" : "Generate"}
  </Button>

  <Button
    class="px-3 py-2 text-sm font-semibold disabled:cursor-wait"
    disabled={saving}
    onclick={onSave}
  >
    {saving ? "Saving…" : "Save"}
  </Button>

  <Button
    variant="danger"
    class="px-3 py-2 text-sm font-semibold enabled:hover:bg-(--upaint-danger) enabled:hover:text-(--upaint-text) disabled:cursor-wait"
    style="visibility: {generating ? 'visible' : 'hidden'};"
    disabled={interrupting || !generating}
    tabindex={generating ? 0 : -1}
    aria-hidden={!generating}
    title="Cancel generation"
    aria-label="Cancel generation"
    onclick={onCancel}
  >
    ×
  </Button>
</div>

{#if generating}
  <div
    class="flex flex-col gap-2 border bg-(--upaint-surface-raised) p-2"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
    aria-live="polite"
  >
    <div class="flex justify-between text-[11px] text-(--upaint-text-muted)">
      <span>{progress?.job || "Generating"}</span>
      {#if (progress?.sampling_steps ?? 0) > 0}
        <span>Step {progress?.sampling_step ?? 0} / {progress?.sampling_steps ?? 0}</span>
      {/if}
    </div>
    <div
      class="h-2 overflow-hidden bg-(--upaint-surface)"
      style="border-radius: var(--upaint-radius-sm);"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={progressPercent}
    >
      <div
        class="h-full bg-(--upaint-accent)"
        style={`width: ${progressPercent}%; transition: width var(--upaint-transition);`}
      ></div>
    </div>
    {#if progress?.current_image}
      <img
        class="max-h-52 w-full object-contain"
        style="border-radius: var(--upaint-radius-sm);"
        src={progress.current_image}
        alt="Live generation preview"
      />
    {/if}
  </div>
{/if}

{#if saveMessage}
  <p
    class="m-0 border px-2 py-1.5 text-xs text-(--upaint-text)"
    style="border-color: var(--upaint-accent); border-radius: var(--upaint-radius-sm);"
    role="status"
  >
    {saveMessage}
  </p>
{/if}

{#if errorMessage}
  <p
    class="m-0 border px-2 py-1.5 text-xs text-(--upaint-danger)"
    style="border-color: var(--upaint-danger); border-radius: var(--upaint-radius-sm);"
    role="alert"
  >
    {errorMessage}
  </p>
{/if}
