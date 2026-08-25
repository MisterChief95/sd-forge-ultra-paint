<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    open?: boolean;
    title?: string;
    count?: number | null;
    id?: string;
    children?: Snippet;
  } & Record<string, unknown>;

  let {
    open = $bindable(false),
    title = "",
    count = null,
    id = "",
    children,
    ...rest
  }: Props = $props();

  function toggle(): void {
    open = !open;
  }
</script>

<section
  {...rest}
  class="border bg-(--upaint-surface)"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
>
  <button
    type="button"
    class="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-2 text-left text-xs font-semibold text-(--upaint-text)"
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

  {#if open}
    <div id={id} class="flex flex-col gap-1 p-1.5 pt-0" role="region">
      {@render children?.()}
    </div>
  {/if}
</section>
