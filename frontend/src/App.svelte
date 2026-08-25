<script lang="ts">
  /**
   * Root shell (Phase 2.R, T22).
   *
   * Three-pane layout mirroring the old Gradio tab's column arrangement
   * (settings / canvas / layers), now built as plain Tailwind-positioned
   * `<div>`s in this app's own document instead of Gradio `gr.Column`s.
   *
   * DOM CONTRACT (unchanged from the pre-Phase-2.R Gradio version, see
   * PLAN.md §4): `UltraPaintApp` mounts its PixiJS canvas into `#upaint-root`.
   * The old DOM-based layer panel / paint toolbar mounts
   * (`#upaint-root-panel` / `#upaint-root-toolbar`) are no longer driven by
   * `UltraPaintApp` itself (see the T22 note at the top of
   * `app/UltraPaintApp.ts`) -- `<LayerPanel>`/`<PaintToolbar>` (T19/T20) are
   * mounted directly as children here instead, inside those same-id wrapper
   * elements (kept for id stability / doc-contract continuity, not because
   * anything still queries them externally).
   *
   * `#upaint-settings-panel` is new in Phase 2.R (no Gradio equivalent to
   * preserve) -- T21's generation-settings components mount there.
   */
  import { onDestroy, onMount } from "svelte";

  import { UltraPaintApp } from "./app/UltraPaintApp";
  import { handleInputKeyDown } from "./input/actionMap";
  import GenerationPanel from "./ui/GenerationPanel.svelte";
  import LayerPanel from "./ui/LayerPanel.svelte";
  import PaintToolbar from "./ui/PaintToolbar.svelte";
  import ViewportControls from "./ui/ViewportControls.svelte";

  let ultraPaintApp: UltraPaintApp | null = null;

  onMount(() => {
    ultraPaintApp = new UltraPaintApp("upaint-root");
  });

  onDestroy(() => {
    ultraPaintApp?.destroy();
    ultraPaintApp = null;
  });

  function handleKeyDown(event: KeyboardEvent): void {
    handleInputKeyDown(event, ultraPaintApp);
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="flex h-full w-full overflow-hidden" style="background: var(--upaint-bg);">
  <aside
    id="upaint-settings-panel"
    class="w-[300px] shrink-0 overflow-y-auto"
    style="border-right: 1px solid var(--upaint-border); background: var(--upaint-surface);"
  >
    <GenerationPanel />
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <div id="upaint-root-toolbar" class="shrink-0">
      <PaintToolbar />
    </div>
    <div class="relative min-h-0 flex-1">
      <div id="upaint-root" class="h-full w-full"></div>
      <ViewportControls />
    </div>
  </div>

  <aside
    id="upaint-root-panel"
    class="w-[320px] shrink-0 overflow-y-auto"
    style="border-left: 1px solid var(--upaint-border); background: var(--upaint-surface);"
  >
    <LayerPanel />
  </aside>
</div>
