<script lang="ts">
  import type { Snippet } from "svelte";

  import Button from "./Button.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    open: boolean;
    title: string;
    onClose: () => void;
    class?: string;
    children: Snippet;
  }

  let { open, title, onClose, class: className = "w-80", children }: Props = $props();

  const titleId = `upaint-modal-${Math.random().toString(36).slice(2)}`;
  const FOCUSABLE = "button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

  let dialogEl = $state<HTMLDivElement | undefined>(undefined);

  // Focus moves into the dialog on open and back to the opener on close.
  $effect(() => {
    if (!open || !dialogEl) return;
    const returnFocus = document.activeElement;
    dialogEl.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    };
  });

  // Escape is caught on the window (capture) so it still closes the dialog
  // when focus has fallen to <body>, e.g. after the focused button is disabled.
  $effect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !dialogEl) return;
    const items = [...dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !(el as HTMLButtonElement).disabled,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  let pressedBackdrop = false;
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    role="presentation"
    onmousedown={(event) => (pressedBackdrop = event.target === event.currentTarget)}
    onclick={(event) => {
      // Ignore drags that started inside the dialog and ended on the backdrop.
      if (pressedBackdrop && event.target === event.currentTarget) onClose();
    }}
  >
    <div
      bind:this={dialogEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabindex="-1"
      class={`flex max-h-[90vh] max-w-[95vw] flex-col gap-3 overflow-y-auto border p-3 text-xs text-(--upaint-text) shadow-lg ${className}`}
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); background: var(--upaint-surface);"
      onclick={(event) => event.stopPropagation()}
      onkeydown={handleKeydown}
    >
      <div class="flex items-center justify-between">
        <h2 id={titleId} class="m-0 text-sm font-semibold">{title}</h2>
        <Button
          size="icon"
          variant="ghost"
          title={`Close ${title.toLowerCase()}`}
          aria-label={`Close ${title.toLowerCase()}`}
          onclick={onClose}
        >
          <Icon name="x" size={14} />
        </Button>
      </div>
      {@render children()}
    </div>
  </div>
{/if}
