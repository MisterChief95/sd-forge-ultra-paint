<script lang="ts">
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { saveGeneration } from "../input/actionMap";
  import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
  import { appSettingsStore } from "../state/appSettingsStore.svelte";
  import { generationRuntimeStore } from "../state/generationRuntimeStore.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import { paintToolStore } from "../state/paintToolStore.svelte";
  import { toastStore } from "../state/toastStore.svelte";
  import { uiLayoutStore, type SidePanel } from "../state/uiLayoutStore.svelte";
  import Button from "./lib/Button.svelte";
  import CheckboxField from "./lib/CheckboxField.svelte";
  import ContextMenu, { type ContextMenuItem } from "./lib/ContextMenu.svelte";
  import Icon, { type IconName } from "./lib/Icon.svelte";
  import Slider from "./lib/Slider.svelte";
  import SliderNumberInput from "./lib/SliderNumberInput.svelte";
  import SettingsModal from "./SettingsModal.svelte";

  /**
   * Top bar: panel toggles at each end, the active tool's options, and file
   * actions. Tool selection itself lives in `ToolRail`. Labels collapse to
   * icons (keeping accessible names) when the bar is narrow.
   */
  const TOOL_NAMES = {
    brush: "Brush",
    eraser: "Eraser",
    lasso: "Lasso",
    eyedropper: "Eyedropper",
    transform: "Transform",
    "boundary-box": "Boundary Box",
    pan: "Pan",
  } as const;

  let pressurePopoverOpen = $state(false);
  let projectBusy = $state(false);
  let settingsOpen = $state(false);
  let projectInput: HTMLInputElement;
  let projectMenuOpen = $state(false);
  let projectMenuX = $state(0);
  let projectMenuY = $state(0);
  const projectMenuItems: ContextMenuItem[] = $derived([
    { label: "Save Project", action: () => void saveProject(), disabled: projectBusy },
    {
      label: "Open Project…",
      action: chooseProject,
      disabled: projectBusy || isDocumentMutationLocked(),
    },
  ]);
  const activeTool = $derived(paintToolStore.activeTool);
  const transformLayer = $derived.by(() => {
    if (layerStore.selectedLayerIds.length !== 1) return undefined;
    return layerStore.getLayer(layerStore.selectedLayerIds[0]!);
  });
  const transformDisabled = $derived(!transformLayer || transformLayer.locked);

  function openProjectMenu(event: MouseEvent): void {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    projectMenuX = bounds.right - 176; // right-align the min-w-44 menu
    projectMenuY = bounds.bottom + 4;
    projectMenuOpen = true;
  }

  function positionPressurePopover(event: MouseEvent): void {
    const button = event.currentTarget;
    const popover = document.getElementById("upaint-pressure-popover");
    if (!(button instanceof HTMLButtonElement) || !(popover instanceof HTMLElement)) return;
    const bounds = button.getBoundingClientRect();
    popover.style.left = `${bounds.left}px`;
    popover.style.top = `${bounds.bottom + 4}px`;
  }

  function dismissPressurePopover(event: PointerEvent): void {
    if (!pressurePopoverOpen || !(event.target instanceof Element)) return;
    if (
      event.target.closest("#upaint-pressure-popover") ||
      event.target.closest('[popovertarget="upaint-pressure-popover"]')
    ) {
      return;
    }
    const popover = document.getElementById("upaint-pressure-popover");
    if (popover instanceof HTMLElement && popover.matches(":popover-open")) {
      popover.hidePopover();
    }
  }

  async function saveProject(): Promise<void> {
    const app = getActiveUltraPaintApp();
    if (!app || projectBusy) return;
    projectBusy = true;
    try {
      await app.saveProject();
      toastStore.success("Project saved.");
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : "Could not save project.");
    } finally {
      projectBusy = false;
    }
  }

  function chooseProject(): void {
    if (projectBusy || isDocumentMutationLocked()) return;
    const app = getActiveUltraPaintApp();
    if (!app) return;
    if (
      (layerStore.document.layers.length > 0 || app.hasUnsavedProjectChanges()) &&
      !window.confirm("Open this project and replace the current document?")
    ) {
      return;
    }
    projectInput.click();
  }

  async function openProject(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    const app = getActiveUltraPaintApp();
    if (!file || !app || projectBusy) return;
    projectBusy = true;
    try {
      await app.openProject(file);
      toastStore.success("Project opened.");
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : "Could not open project.");
    } finally {
      projectBusy = false;
    }
  }
</script>

<svelte:window onpointerdown={dismissPressurePopover} />

{#snippet panelToggle(panel: SidePanel, icon: IconName, name: string, controls: string)}
  {@const open = !uiLayoutStore.sidePanel(panel).collapsed}
  <Button
    size="icon"
    variant="ghost"
    style="color: {open ? 'var(--upaint-accent)' : 'var(--upaint-text-muted)'};"
    title={open ? `Hide ${name}` : `Show ${name}`}
    aria-label={open ? `Hide ${name}` : `Show ${name}`}
    aria-expanded={open}
    aria-controls={controls}
    onclick={() => uiLayoutStore.setSidePanelCollapsed(panel, open)}
  >
    <Icon name={icon} size={16} />
  </Button>
{/snippet}

{#snippet brushSlider(
  icon: IconName,
  label: string,
  value: number,
  max: number,
  unit: string,
  onValueInput: (value: number) => void,
)}
  <label class="flex shrink-0 items-center gap-1.5 text-(--upaint-text-muted)" title={label}>
    <Icon name={icon} />
    <span class="hidden @4xl:inline">{label}</span>
    <Slider
      inputClass="m-0 h-3.5 w-12 cursor-pointer accent-(--upaint-accent) @5xl:w-20"
      {value}
      min={unit === "px" ? 1 : 0}
      {max}
      step={1}
      ariaLabel={`Brush ${label.toLowerCase()}`}
      {onValueInput}
    />
    <output class="w-8 text-right tabular-nums text-(--upaint-text)">{value}{unit}</output>
  </label>
{/snippet}

<div
  class="@container box-border flex h-11 w-full select-none items-center gap-1.5 border px-1.5 text-[11px] leading-tight"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-lg); background: var(--upaint-surface); color: var(--upaint-text); font-family: var(--upaint-font);"
  role="toolbar"
  aria-label="Tool options and file actions"
>
  {@render panelToggle("left", "panel-left", "generation settings", "upaint-settings-panel")}

  <span class="h-5 w-px shrink-0 bg-(--upaint-border)" aria-hidden="true"></span>
  <span class="hidden shrink-0 text-xs font-semibold @2xl:inline">{TOOL_NAMES[activeTool]}</span>

  <div
    class="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap"
    role="group"
    aria-label={`${TOOL_NAMES[activeTool]} options`}
  >
    {#if activeTool === "brush" || activeTool === "eraser"}
      {@render brushSlider(
        "size",
        "Size",
        Math.round(paintToolStore.brush.radius),
        256,
        "px",
        (value) => paintToolStore.setBrushSettings({ radius: value }),
      )}
      {@render brushSlider(
        "hardness",
        "Hardness",
        Math.round(paintToolStore.brush.hardness * 100),
        100,
        "%",
        (value) => paintToolStore.setBrushSettings({ hardness: value / 100 }),
      )}
      {@render brushSlider(
        "alpha",
        "Opacity",
        Math.round(paintToolStore.brush.opacity * 100),
        100,
        "%",
        (value) => paintToolStore.setBrushSettings({ opacity: value / 100 }),
      )}
      <div class="flex shrink-0">
        <Button
          size="icon"
          radius="left"
          pressed={paintToolStore.brush.pressureEnabled}
          title={paintToolStore.brush.pressureEnabled
            ? "Disable pen pressure"
            : "Enable pen pressure"}
          aria-label={paintToolStore.brush.pressureEnabled
            ? "Disable pen pressure"
            : "Enable pen pressure"}
          onclick={() =>
            paintToolStore.setBrushSettings({
              pressureEnabled: !paintToolStore.brush.pressureEnabled,
            })}
        >
          <Icon name="pressure" />
        </Button>
        <Button
          size="icon"
          radius="right"
          pressed={pressurePopoverOpen}
          title="Configure pen pressure and smoothing"
          aria-label="Configure pen pressure and smoothing"
          aria-haspopup="dialog"
          popovertarget="upaint-pressure-popover"
          onclick={positionPressurePopover}
          style="width: 20px; padding: 0; border-left-width: 0;"
        >
          <Icon name="chevron-down" size={12} />
        </Button>
      </div>
    {:else if activeTool === "lasso"}
      <div class="flex shrink-0" role="group" aria-label="Lasso mode">
        <Button
          size="sm"
          radius="left"
          class="gap-1.5"
          pressed={paintToolStore.lassoMode === "polygonal"}
          title="Click vertices; close near the first point or double-click"
          onclick={() => paintToolStore.setLassoMode("polygonal")}
        >
          <Icon name="lasso-polygon" />
          Polygon
        </Button>
        <Button
          size="sm"
          radius="right"
          class="gap-1.5"
          pressed={paintToolStore.lassoMode === "freehand"}
          title="Drag to draw a closed outline"
          style="border-left-width: 0;"
          onclick={() => paintToolStore.setLassoMode("freehand")}
        >
          <Icon name="lasso" />
          Freehand
        </Button>
      </div>
    {:else if activeTool === "transform"}
      <Button
        size="sm"
        class="gap-1.5"
        title="Mirror selected layer horizontally"
        aria-label="Mirror selected layer horizontally"
        disabled={isDocumentMutationLocked() || transformDisabled}
        onclick={() => getActiveUltraPaintApp()?.mirrorSelectedLayer("horizontal")}
      >
        <Icon name="mirror-h" />
        <span class="hidden @3xl:inline">Mirror horizontal</span>
      </Button>
      <Button
        size="sm"
        class="gap-1.5"
        title="Mirror selected layer vertically"
        aria-label="Mirror selected layer vertically"
        disabled={isDocumentMutationLocked() || transformDisabled}
        onclick={() => getActiveUltraPaintApp()?.mirrorSelectedLayer("vertical")}
      >
        <Icon name="mirror-v" />
        <span class="hidden @3xl:inline">Mirror vertical</span>
      </Button>
    {:else if activeTool === "eyedropper"}
      <span class="text-(--upaint-text-muted)">Click the canvas to pick the brush color.</span>
    {:else if activeTool === "pan"}
      <span class="text-(--upaint-text-muted)"
        >Drag to pan. Pinch or use the zoom buttons to zoom.</span
      >
    {:else if activeTool === "boundary-box"}
      <span class="text-(--upaint-text-muted)">Drag to move the box; drag its edges to resize.</span
      >
    {/if}
  </div>

  <Button
    size="sm"
    class="gap-1.5"
    disabled={generationRuntimeStore.saving}
    title={generationRuntimeStore.saving
      ? "Saving image to Forge output"
      : "Save image to Forge output"}
    aria-label={generationRuntimeStore.saving
      ? "Saving image to Forge output"
      : "Save image to Forge output"}
    onclick={() => saveGeneration()}
  >
    <Icon name="save" />
    <span class="hidden @3xl:inline">Save Image</span>
  </Button>
  <Button
    size="sm"
    class="gap-1.5"
    disabled={projectBusy}
    title="Save or open an editable Ultra Paint project"
    aria-label="Project"
    aria-haspopup="menu"
    aria-expanded={projectMenuOpen}
    onclick={openProjectMenu}
  >
    <Icon name="folder" />
    <span class="hidden @3xl:inline">Project</span>
    <Icon name="chevron-down" size={12} />
  </Button>
  <input
    bind:this={projectInput}
    class="sr-only"
    type="file"
    accept=".uproj,application/zip"
    aria-label="Choose an Ultra Paint project"
    onchange={openProject}
  />

  <Button
    size="icon"
    variant="ghost"
    title="Settings"
    aria-label="Settings"
    aria-haspopup="dialog"
    onclick={() => (settingsOpen = true)}
  >
    <Icon name="settings" size={16} />
  </Button>

  <span class="h-5 w-px shrink-0 bg-(--upaint-border)" aria-hidden="true"></span>
  {@render panelToggle("right", "panel-right", "layers panel", "upaint-root-panel")}
</div>

<SettingsModal open={settingsOpen} onClose={() => (settingsOpen = false)} />

<ContextMenu
  bind:open={projectMenuOpen}
  x={projectMenuX}
  y={projectMenuY}
  items={projectMenuItems}
/>

<div
  id="upaint-pressure-popover"
  popover="auto"
  role="dialog"
  aria-label="Pen pressure and smoothing settings"
  class="fixed inset-auto z-50 m-0 w-52 flex-col gap-1.5 border p-2 text-[11px] text-(--upaint-text)"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm); background: var(--upaint-surface);"
  ontoggle={(event) => (pressurePopoverOpen = event.newState === "open")}
>
  <CheckboxField
    label="Size pressure"
    checked={paintToolStore.brush.sizePressure}
    onchange={(event) =>
      paintToolStore.setBrushSettings({ sizePressure: event.currentTarget.checked })}
  />
  <CheckboxField
    label="Opacity pressure"
    checked={paintToolStore.brush.opacityPressure}
    onchange={(event) =>
      paintToolStore.setBrushSettings({ opacityPressure: event.currentTarget.checked })}
  />
  <SliderNumberInput
    label="Sensitivity (firm to light)"
    ariaLabel="Pen pressure sensitivity"
    value={appSettingsStore.pressureSensitivity}
    min={-100}
    max={100}
    sliderStep={5}
    numberStep={1}
    onValueInput={(value) => appSettingsStore.setPressureSensitivity(value)}
  />
  <SliderNumberInput
    label="Minimum pressure %"
    ariaLabel="Minimum pen pressure percent"
    value={Math.round(appSettingsStore.pressureMin * 100)}
    min={0}
    max={90}
    sliderStep={1}
    onValueInput={(value) => appSettingsStore.setPressureMin(value / 100)}
  />
  <SliderNumberInput
    label="Smoothing %"
    ariaLabel="Stroke smoothing percent"
    value={Math.round(appSettingsStore.smoothing * 100)}
    min={0}
    max={90}
    sliderStep={1}
    onValueInput={(value) => appSettingsStore.setSmoothing(value / 100)}
  />
</div>

<style>
  #upaint-pressure-popover:popover-open {
    display: flex;
  }
</style>
