<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    open?: boolean;
    title?: string;
    count?: number | null;
    id?: string;
    children?: Snippet;
    headerActions?: Snippet;
  } & Record<string, unknown>;

  let {
    open = $bindable(false),
    title = "",
    count = null,
    id = "",
    children,
    headerActions,
    ...rest
  }: Props = $props();

  function toggle(): void {
    open = !open;
  }
</script>

<section
  {...rest}
  class="w-full border-b bg-(--upaint-surface)"
  style="border-color: var(--upaint-border);"
>
  <div class="flex w-full items-center gap-1 px-2 py-1">
    <button
      type="button"
      class="flex flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-1 text-left text-xs font-semibold text-(--upaint-text)"
      aria-expanded={open}
      aria-controls={id}
      onclick={toggle}
    >
      <span aria-hidden="true">{open ? "▼" : "▶"}</span>
      <span>{title}</span>
      {#if count !== null}
        <span class="ml-auto font-normal text-[11px] text-(--upaint-text-muted)">
          {count}
        </span>
      {/if}
    </button>
    {#if headerActions}
      <div class="flex shrink-0 items-center gap-0.5">
        {@render headerActions()}
      </div>
    {/if}
  </div>

  {#if open}
    <div {id} class="flex flex-col" role="region">
      {@render children?.()}
    </div>
  {/if}
</section>
