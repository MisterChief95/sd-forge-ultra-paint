<script lang="ts">
  import { toastStore, type ToastKind } from "../state/toastStore.svelte";

  const labels: Record<ToastKind, string> = {
    info: "Information",
    success: "Success",
    error: "Error",
  };
</script>

<div
  class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
>
  {#each toastStore.toasts as toast (toast.id)}
    <div
      class={[
        "toast pointer-events-auto flex items-start gap-3 rounded-lg border p-3 shadow-lg",
        toast.kind,
      ]}
      role={toast.kind === "error" ? "alert" : "status"}
      aria-live={toast.kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <span class="indicator mt-1 block size-2 shrink-0 rounded-full" aria-hidden="true"></span>
      <div class="min-w-0 flex-1">
        <span class="sr-only">{labels[toast.kind]}: </span>
        <p class="m-0 break-words text-sm leading-5">{toast.message}</p>
      </div>
      <button
        type="button"
        class="close -mr-1 -mt-1 rounded p-1 text-base leading-none"
        aria-label={`Dismiss ${labels[toast.kind].toLowerCase()} notification`}
        onclick={() => toastStore.dismiss(toast.id)}
      >
        ×
      </button>
    </div>
  {/each}
</div>

<style>
  .toast {
    border-color: var(--upaint-border);
    background: var(--upaint-surface-raised);
    color: var(--upaint-text);
  }

  .indicator {
    background: var(--upaint-accent);
  }

  .success .indicator {
    background: #45b882;
  }

  .error {
    border-color: color-mix(in srgb, var(--upaint-danger) 65%, var(--upaint-border));
  }

  .error .indicator {
    background: var(--upaint-danger);
  }

  .close {
    color: var(--upaint-text-muted);
    transition:
      color var(--upaint-transition),
      background var(--upaint-transition);
  }

  .close:hover,
  .close:focus-visible {
    background: color-mix(in srgb, var(--upaint-text) 10%, transparent);
    color: var(--upaint-text);
    outline: none;
  }

  .close:focus-visible {
    box-shadow: 0 0 0 2px var(--upaint-accent);
  }
</style>
