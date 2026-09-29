<script lang="ts">
  import type { Snippet } from "svelte";

  import { uiLayoutStore } from "../../state/uiLayoutStore.svelte";
  import Icon from "./Icon.svelte";

  type Props = {
    open?: boolean;
    title?: string;
    count?: number | null;
    id?: string;
    persistKey?: string;
    canEnable?: boolean;
    enabled?: boolean;
    onEnabledChange?: (value: boolean) => void;
    children?: Snippet;
    headerLeading?: Snippet;
    headerActions?: Snippet;
  } & Record<string, unknown>;

  let {
    open = $bindable(false),
    title = "",
    count = null,
    id = "",
    persistKey,
    canEnable = false,
    enabled = $bindable(false),
    onEnabledChange,
    children,
    headerLeading,
    headerActions,
    ...rest
  }: Props = $props();

  restorePersistedOpen();

  function restorePersistedOpen(): void {
    if (persistKey) open = uiLayoutStore.getAccordionOpen(persistKey, open);
  }

  function toggle(): void {
    open = !open;
    if (persistKey) uiLayoutStore.setAccordionOpen(persistKey, open);
  }

  function handleEnabledChange(event: Event): void {
    enabled = (event.currentTarget as HTMLInputElement).checked;
    onEnabledChange?.(enabled);
  }
</script>

<section
  {...rest}
  class="w-full border-b bg-(--upaint-surface)"
  style="border-color: var(--upaint-border);"
>
  <div
    class="flex w-full items-center gap-1 bg-(--upaint-surface-raised) px-2 py-1"
    data-accordion-header
  >
    {#if headerLeading}
      <div class="flex shrink-0 items-center">
        {@render headerLeading()}
      </div>
    {/if}
    <button
      type="button"
      class="flex flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-1 text-left text-xs font-semibold text-(--upaint-text)"
      aria-expanded={open}
      aria-controls={id}
      onclick={toggle}
    >
      <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      <span>{title}</span>
      {#if count !== null}
        <span class="ml-auto font-normal text-[11px] text-(--upaint-text-muted)">
          {count}
        </span>
      {/if}
    </button>
    {#if canEnable || headerActions}
      <div class="flex shrink-0 items-center gap-0.5">
        {#if canEnable}
          <label
            class="flex cursor-pointer items-center gap-1 text-[11px] text-(--upaint-text-muted)"
          >
            <input
              type="checkbox"
              checked={enabled}
              onchange={handleEnabledChange}
              class="m-0 h-3.5 w-3.5 accent-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent)"
            />
            Enabled
          </label>
        {/if}
        {#if headerActions}
          {@render headerActions()}
        {/if}
      </div>
    {/if}
  </div>

  {#if open}
    <div {id} class="flex flex-col" role="region">
      {@render children?.()}
    </div>
  {/if}
</section>
