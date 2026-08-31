<script lang="ts">
  import Button from "../lib/Button.svelte";

  interface Props {
    generating: boolean;
    interrupting: boolean;
    current: number;
    total: number;
    progressPercent: number;
    onGenerate: () => void;
    onCancelCurrent: () => void;
    onCancelRemaining: () => void;
    onCancelAll: () => void;
  }

  let {
    generating,
    interrupting,
    current,
    total,
    progressPercent,
    onGenerate,
    onCancelCurrent,
    onCancelRemaining,
    onCancelAll,
  }: Props = $props();

  let menuOpen = $state(false);

  function choose(action: () => void): void {
    menuOpen = false;
    action();
  }
</script>

<div class="flex gap-1.5">
  <Button
    variant={generating ? "default" : "primary"}
    class="relative min-w-0 flex-1 overflow-hidden px-3 py-2 text-sm font-semibold"
    aria-label={generating
      ? `Generating ${current} of ${total}, ${progressPercent}% complete. Click to queue another generation.`
      : "Generate"}
    onclick={onGenerate}
  >
    {#if generating}
      <span
        class="pointer-events-none absolute inset-y-0 left-0 bg-(--upaint-accent)"
        style:width={`${progressPercent}%`}
        style:transition="width var(--upaint-transition)"
        aria-hidden="true"
      ></span>
    {/if}
    <span class="relative z-1 truncate">
      {generating ? `Generating… (${current}/${total})` : "Generate"}
    </span>
  </Button>

  {#if generating}
    <div class="group relative shrink-0">
      <Button
        class="h-full px-2.5"
        disabled={interrupting}
        aria-label="Generation queue actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Generation queue actions"
        onclick={() => (menuOpen = !menuOpen)}
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </Button>

      <div
        class={[
          "absolute right-0 top-full z-40 mt-1 min-w-40 flex-col overflow-hidden border bg-(--upaint-surface) p-1 shadow-lg",
          menuOpen ? "flex" : "hidden group-hover:flex group-focus-within:flex",
        ]}
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
        role="menu"
        aria-label="Generation queue actions"
        tabindex="-1"
        onmouseleave={() => (menuOpen = false)}
      >
        <button
          type="button"
          class="rounded px-2 py-1.5 text-left text-xs hover:bg-(--upaint-surface-raised) focus-visible:outline-2 focus-visible:outline-(--upaint-accent)"
          role="menuitem"
          onclick={() => choose(onCancelCurrent)}>Cancel Current</button
        >
        <button
          type="button"
          class="rounded px-2 py-1.5 text-left text-xs hover:bg-(--upaint-surface-raised) focus-visible:outline-2 focus-visible:outline-(--upaint-accent)"
          role="menuitem"
          onclick={() => choose(onCancelAll)}>Cancel All</button
        >
        <button
          type="button"
          class="rounded px-2 py-1.5 text-left text-xs hover:bg-(--upaint-surface-raised) focus-visible:outline-2 focus-visible:outline-(--upaint-accent)"
          role="menuitem"
          onclick={() => choose(onCancelRemaining)}>Cancel Remaining</button
        >
      </div>
    </div>
  {/if}
</div>
