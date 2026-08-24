<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import {
    generationSettingsStore,
    type ScaleMode,
  } from "../state/generationSettingsStore.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import {
    calculateAutoResolution,
    type Resolution,
  } from "../util/autoResolution";

  function disableSpellcheck(node: HTMLTextAreaElement): void {
    node.spellcheck = false;
    node.setAttribute("autocomplete", "off");
    node.setAttribute("autocorrect", "off");
    node.setAttribute("autocapitalize", "off");
  }

  const OPTIONS_URL = "/ultra_paint/api/options";
  const GENERATE_URL = "/ultra_paint/api/generate";
  const SAVE_URL = "/ultra_paint/api/save";
  const PROGRESS_URL = "/ultra_paint/api/progress";
  const INTERRUPT_URL = "/ultra_paint/api/interrupt";
  const POLL_INTERVAL_MS = 750;
  const MAX_PROGRESS_POLLS = 1200;

  interface GenerationOptions {
    samplers: string[];
    schedulers: string[];
    native_resolution: number;
    is_video_model: boolean;
    resolution_step: number;
  }

  interface GenerationResponse {
    images: string[];
  }

  interface SaveResponse {
    path: string;
  }

  interface ProgressResponse {
    job?: string;
    job_count?: number;
    job_no?: number;
    sampling_step?: number;
    sampling_steps?: number;
    current_image?: string | null;
  }

  let prompt = $state("");
  let negativePrompt = $state("");
  let samplers = $state<string[]>([]);
  let schedulers = $state<string[]>([]);
  let samplerName = $state("");
  let scheduler = $state("");
  let nativeResolution = $state<number | null>(null);
  let resolutionStep = $state<number | null>(null);
  let isVideoModel = $state(false);
  let steps = $state(20);
  let cfgScale = $state(7);
  let denoisingStrength = $state(0.75);
  let generating = $state(false);
  let saving = $state(false);
  let interrupting = $state(false);
  let errorMessage = $state<string | null>(null);
  let saveMessage = $state<string | null>(null);
  let progress = $state<ProgressResponse | null>(null);

  let destroyed = false;
  let progressRunId = 0;
  let saveMessageTimer: number | null = null;

  const progressPercent = $derived.by(() => {
    const total = progress?.sampling_steps ?? 0;
    const current = progress?.sampling_step ?? 0;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  });

  const autoTargetResolution = $derived.by((): Resolution | null => {
    if (nativeResolution === null || resolutionStep === null) return null;
    const box = layerStore.document.boundaryBox;
    return calculateAutoResolution(
      box.width,
      box.height,
      nativeResolution,
      resolutionStep,
    );
  });

  const selectedTargetResolution = $derived.by((): Resolution | null => {
    switch (generationSettingsStore.scaleMode) {
      case "none":
        return null;
      case "auto":
        return autoTargetResolution;
      case "manual":
        return {
          width: generationSettingsStore.manualWidth,
          height: generationSettingsStore.manualHeight,
        };
    }
  });

  onMount(() => {
    void loadOptions();
  });

  onDestroy(() => {
    destroyed = true;
    progressRunId += 1;
    if (saveMessageTimer !== null) window.clearTimeout(saveMessageTimer);
  });

  async function loadOptions(): Promise<void> {
    try {
      const response = await fetch(OPTIONS_URL);
      if (!response.ok) {
        throw new Error(`options request failed (${response.status})`);
      }
      const body = (await response.json()) as Partial<GenerationOptions>;
      if (destroyed) return;
      samplers = Array.isArray(body.samplers)
        ? body.samplers.filter((value): value is string => typeof value === "string")
        : [];
      schedulers = Array.isArray(body.schedulers)
        ? body.schedulers.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      nativeResolution =
        Number.isSafeInteger(body.native_resolution) &&
        (body.native_resolution ?? 0) > 0
          ? (body.native_resolution ?? null)
          : null;
      resolutionStep =
        Number.isSafeInteger(body.resolution_step) &&
        (body.resolution_step ?? 0) > 0
          ? (body.resolution_step ?? null)
          : null;
      isVideoModel = body.is_video_model === true;
    } catch (error) {
      console.warn("[ultra-paint] could not load generation options:", error);
    }
  }

  function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function pollProgress(runId: number): Promise<void> {
    for (let poll = 0; poll < MAX_PROGRESS_POLLS; poll += 1) {
      if (destroyed || !generating || runId !== progressRunId) return;
      try {
        const response = await fetch(PROGRESS_URL, { cache: "no-store" });
        if (response.ok) {
          const next = (await response.json()) as ProgressResponse;
          if (!destroyed && runId === progressRunId) progress = next;
        } else {
          console.warn(
            `[ultra-paint] progress request failed (${response.status})`,
          );
        }
      } catch (error) {
        console.warn("[ultra-paint] progress polling failed:", error);
      }
      await wait(POLL_INTERVAL_MS);
    }

    if (!destroyed && runId === progressRunId) {
      console.warn("[ultra-paint] progress polling reached its safety cutoff");
    }
  }

  async function responseError(
    response: Response,
    action = "Generation",
  ): Promise<string> {
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string" && body.detail.trim()) {
        return body.detail;
      }
    } catch {
      // Fall through to a status-based message for a non-JSON error response.
    }
    return `${action} request failed (${response.status} ${response.statusText})`;
  }

  function handleScaleModeChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === "none" || value === "auto" || value === "manual") {
      generationSettingsStore.setScaleMode(value satisfies ScaleMode);
    }
  }

  function handleManualWidth(event: Event): void {
    generationSettingsStore.setManualWidth(
      Number((event.currentTarget as HTMLInputElement).value),
    );
  }

  function handleManualHeight(event: Event): void {
    generationSettingsStore.setManualHeight(
      Number((event.currentTarget as HTMLInputElement).value),
    );
  }

  function handleMaskBlur(event: Event): void {
    generationSettingsStore.setMaskBlur(
      Number((event.currentTarget as HTMLInputElement).value),
    );
  }

  function handleInpaintPadding(event: Event): void {
    generationSettingsStore.setInpaintPadding(
      Number((event.currentTarget as HTMLInputElement).value),
    );
  }

  function handleSoftInpainting(event: Event): void {
    generationSettingsStore.setSoftInpaintingEnabled(
      (event.currentTarget as HTMLInputElement).checked,
    );
  }

  async function generate(): Promise<void> {
    if (generating) return;
    errorMessage = null;
    progress = null;

    const app = getActiveUltraPaintApp();
    if (!app) {
      errorMessage = "The painting canvas is not ready yet.";
      return;
    }

    const targetResolution = selectedTargetResolution;
    if (
      generationSettingsStore.scaleMode === "auto" &&
      targetResolution === null
    ) {
      errorMessage = "The model's native resolution is not available yet.";
      return;
    }

    let compositeImage: string;
    let maskImage: string | null;
    try {
      compositeImage = app.flattenToDataURL();
      maskImage = app.flattenMaskToDataURL();
    } catch (error) {
      console.error("[ultra-paint] flatten failed:", error);
      errorMessage = "The painting canvas is not ready yet.";
      return;
    }

    generating = true;
    const runId = ++progressRunId;
    void pollProgress(runId);

    try {
      const response = await fetch(GENERATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          composite_image: compositeImage,
          ...(maskImage === null ? {} : { mask_image: maskImage }),
          gen_params: {
            prompt,
            negative_prompt: negativePrompt,
            steps,
            cfg_scale: cfgScale,
            denoising_strength: denoisingStrength,
            mask_blur: generationSettingsStore.maskBlur,
            inpaint_full_res_padding: generationSettingsStore.inpaintPadding,
            soft_inpainting_enabled:
              generationSettingsStore.softInpaintingEnabled,
            sampler_name: samplerName || null,
            scheduler: scheduler || null,
            ...(targetResolution === null
              ? {}
              : {
                  target_width: targetResolution.width,
                  target_height: targetResolution.height,
                }),
          },
        }),
      });

      // The generation request is complete, so stop progress polling before
      // decoding its returned images into paintable layer textures.
      if (runId === progressRunId) progressRunId += 1;

      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as Partial<GenerationResponse>;
      if (!Array.isArray(body.images)) {
        throw new Error("Generation returned an invalid image response.");
      }

      for (const image of body.images) {
        if (typeof image !== "string") continue;
        const activeApp = getActiveUltraPaintApp();
        if (!activeApp) {
          throw new Error("The painting canvas closed before results were added.");
        }
        const id = await activeApp.addImageFromDataURL(
          image,
          "Generated",
          "generated",
        );
        activeApp.getStore().setSelectedLayerId(id);
      }
    } catch (error) {
      if (!destroyed) {
        errorMessage =
          error instanceof Error ? error.message : "Generation failed.";
      }
    } finally {
      if (runId === progressRunId) progressRunId += 1;
      if (!destroyed) {
        generating = false;
        interrupting = false;
      }
    }
  }

  async function saveImage(): Promise<void> {
    if (saving) return;
    errorMessage = null;
    saveMessage = null;

    const app = getActiveUltraPaintApp();
    if (!app) {
      errorMessage = "The painting canvas is not ready yet.";
      return;
    }

    let image: string;
    try {
      image = app.flattenToDataURL();
    } catch (error) {
      console.error("[ultra-paint] flatten failed:", error);
      errorMessage = "The painting canvas is not ready yet.";
      return;
    }

    saving = true;
    try {
      const response = await fetch(SAVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Save"));

      const body = (await response.json()) as Partial<SaveResponse>;
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw new Error("Save returned an invalid response.");
      }
      if (destroyed) return;
      saveMessage = `Saved to ${body.path}`;
      if (saveMessageTimer !== null) window.clearTimeout(saveMessageTimer);
      saveMessageTimer = window.setTimeout(() => {
        saveMessage = null;
        saveMessageTimer = null;
      }, 4000);
    } catch (error) {
      if (!destroyed) {
        errorMessage = error instanceof Error ? error.message : "Save failed.";
      }
    } finally {
      if (!destroyed) saving = false;
    }
  }

  /**
   * Best-effort cancel: flips Forge's shared `state.interrupted` flag
   * (`ultra_paint/interrupt_api.py`), the same one the stock txt2img/img2img
   * tabs' own Interrupt button sets. Fire-and-forget from this component's
   * point of view -- `generate()`'s own `finally` block is what actually
   * clears `generating` once the interrupted request resolves, same as it
   * already does for a normal completion or a hard error.
   */
  async function cancelGeneration(): Promise<void> {
    if (!generating || interrupting) return;
    interrupting = true;
    try {
      const response = await fetch(INTERRUPT_URL, { method: "POST" });
      if (!response.ok) {
        console.warn(`[ultra-paint] interrupt request failed (${response.status})`);
      }
    } catch (error) {
      console.warn("[ultra-paint] interrupt request failed:", error);
    }
  }
</script>

<section
  class="box-border flex h-full w-full flex-col gap-3 p-3 text-xs"
  style="color: var(--upaint-text); font-family: var(--upaint-font);"
  aria-labelledby="upaint-generation-title"
>
  <header class="border-b pb-2" style="border-color: var(--upaint-border);">
    <h2 id="upaint-generation-title" class="m-0 text-sm font-semibold">
      Generation
    </h2>
  </header>

  {#if isVideoModel}
    <p
      class="m-0 border px-2 py-1.5 text-xs text-[var(--upaint-danger)]"
      style="border-color: var(--upaint-danger); border-radius: var(--upaint-radius-sm);"
      role="alert"
    >
      A Wan/video model is loaded. Generate will be rejected; select a supported
      image model first.
    </p>
  {/if}

  <div
    class="flex flex-col gap-2 border bg-[var(--upaint-surface-raised)] p-2"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
  >
    <label class="flex flex-col gap-1 text-[var(--upaint-text-muted)]">
      Resolution scale
      <select
        class="border bg-[var(--upaint-surface)] px-2 py-1.5 text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
        value={generationSettingsStore.scaleMode}
        aria-label="Resolution scale mode"
        onchange={handleScaleModeChange}
      >
        <option value="none">None</option>
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      </select>
    </label>

    {#if generationSettingsStore.scaleMode === "auto"}
      <div class="flex items-center justify-between gap-2 text-[var(--upaint-text-muted)]">
        <span>Target</span>
        <output aria-label="Auto target size" class="tabular-nums text-[var(--upaint-text)]">
          {autoTargetResolution
            ? `${autoTargetResolution.width} × ${autoTargetResolution.height}`
            : "Loading model profile…"}
        </output>
      </div>
    {:else if generationSettingsStore.scaleMode === "manual"}
      <div class="grid grid-cols-2 gap-2">
        <label class="flex min-w-0 flex-col gap-1 text-[var(--upaint-text-muted)]">
          Target width
          <input
            class="min-w-0 border bg-[var(--upaint-surface)] px-1.5 py-1 text-right tabular-nums text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
            style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
            type="number"
            min="1"
            max="16384"
            step="1"
            value={generationSettingsStore.manualWidth}
            aria-label="Target width"
            oninput={handleManualWidth}
          />
        </label>
        <label class="flex min-w-0 flex-col gap-1 text-[var(--upaint-text-muted)]">
          Target height
          <input
            class="min-w-0 border bg-[var(--upaint-surface)] px-1.5 py-1 text-right tabular-nums text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
            style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
            type="number"
            min="1"
            max="16384"
            step="1"
            value={generationSettingsStore.manualHeight}
            aria-label="Target height"
            oninput={handleManualHeight}
          />
        </label>
      </div>
    {/if}
  </div>

  <!--
    The cancel button is always in the DOM (never conditionally rendered) so
    the row's flex layout is computed identically whether or not it's
    "visible" -- toggling opacity/pointer-events/aria-hidden instead of
    presence keeps the Generate button's own width perfectly stable, per the
    developer's explicit requirement. A conditional {#if generating} here
    would instead reduce the space left for Generate's flex-1 the moment the
    cancel button appeared, resizing it.
  -->
  <div class="flex gap-2">
    <button
      type="button"
      class="flex-1 cursor-pointer border border-[var(--upaint-accent)] bg-[var(--upaint-accent)] px-3 py-2 text-sm font-semibold text-[var(--upaint-text)] hover:bg-[var(--upaint-accent-muted)] disabled:cursor-wait disabled:opacity-60"
      style="border-radius: var(--upaint-radius); transition: background-color var(--upaint-transition), opacity var(--upaint-transition);"
      disabled={generating}
      onclick={() => void generate()}
    >
      {generating ? "Generating…" : "Generate"}
    </button>

    <button
      type="button"
      class="shrink-0 cursor-pointer border bg-[var(--upaint-surface-raised)] px-3 py-2 text-sm font-semibold text-[var(--upaint-text)] hover:border-[var(--upaint-accent)] disabled:cursor-wait disabled:opacity-60"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition), opacity var(--upaint-transition);"
      disabled={saving}
      onclick={() => void saveImage()}
    >
      {saving ? "Saving…" : "Save"}
    </button>

    <button
      type="button"
      class="shrink-0 cursor-pointer border border-[var(--upaint-danger)] bg-[var(--upaint-surface-raised)] px-3 py-2 text-sm font-semibold text-[var(--upaint-danger)] hover:bg-[var(--upaint-danger)] hover:text-[var(--upaint-text)] disabled:cursor-wait disabled:opacity-60"
      style="border-radius: var(--upaint-radius); transition: background-color var(--upaint-transition), color var(--upaint-transition), opacity var(--upaint-transition); visibility: {generating
        ? 'visible'
        : 'hidden'};"
      disabled={interrupting || !generating}
      tabindex={generating ? 0 : -1}
      aria-hidden={!generating}
      title="Cancel generation"
      aria-label="Cancel generation"
      onclick={() => void cancelGeneration()}
    >
      ×
    </button>
  </div>

  {#if generating}
    <div
      class="flex flex-col gap-2 border bg-[var(--upaint-surface-raised)] p-2"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
      aria-live="polite"
    >
      <div class="flex justify-between text-[11px] text-[var(--upaint-text-muted)]">
        <span>{progress?.job || "Generating"}</span>
        {#if (progress?.sampling_steps ?? 0) > 0}
          <span>
            Step {progress?.sampling_step ?? 0} / {progress?.sampling_steps ?? 0}
          </span>
        {/if}
      </div>
      <div
        class="h-2 overflow-hidden bg-[var(--upaint-surface)]"
        style="border-radius: var(--upaint-radius-sm);"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={progressPercent}
      >
        <div
          class="h-full bg-[var(--upaint-accent)]"
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
      class="m-0 border px-2 py-1.5 text-xs text-[var(--upaint-text)]"
      style="border-color: var(--upaint-accent); border-radius: var(--upaint-radius-sm);"
      role="status"
    >
      {saveMessage}
    </p>
  {/if}

  {#if errorMessage}
    <p
      class="m-0 border px-2 py-1.5 text-xs text-[var(--upaint-danger)]"
      style="border-color: var(--upaint-danger); border-radius: var(--upaint-radius-sm);"
      role="alert"
    >
      {errorMessage}
    </p>
  {/if}

  <label class="flex flex-col gap-1 text-[var(--upaint-text-muted)]">
    Prompt
    <textarea
      use:disableSpellcheck
      bind:value={prompt}
      class="min-h-24 resize-y border bg-[var(--upaint-surface-raised)] p-2 text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition);"
      placeholder="Describe what to generate"
    ></textarea>
  </label>

  <label class="flex flex-col gap-1 text-[var(--upaint-text-muted)]">
    Negative prompt
    <textarea
      use:disableSpellcheck
      bind:value={negativePrompt}
      class="min-h-20 resize-y border bg-[var(--upaint-surface-raised)] p-2 text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition);"
      placeholder="What to avoid"
    ></textarea>
  </label>

  <div class="grid grid-cols-2 gap-2">
    <label class="flex min-w-0 flex-col gap-1 text-[var(--upaint-text-muted)]">
      Sampler
      <select
        bind:value={samplerName}
        class="min-w-0 border bg-[var(--upaint-surface-raised)] px-2 py-1.5 text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      >
        <option value="">Default</option>
        {#each samplers as sampler}
          <option value={sampler}>{sampler}</option>
        {/each}
      </select>
    </label>

    <label class="flex min-w-0 flex-col gap-1 text-[var(--upaint-text-muted)]">
      Scheduler
      <select
        bind:value={scheduler}
        class="min-w-0 border bg-[var(--upaint-surface-raised)] px-2 py-1.5 text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      >
        <option value="">Default</option>
        {#each schedulers as schedulerOption}
          <option value={schedulerOption}>{schedulerOption}</option>
        {/each}
      </select>
    </label>
  </div>

  <label class="grid grid-cols-[1fr_58px] items-center gap-x-2 gap-y-1 text-[var(--upaint-text-muted)]">
    <span class="col-span-2">Steps</span>
    <input
      bind:value={steps}
      class="m-0 h-4 min-w-0 cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="1"
      max="150"
      step="1"
    />
    <input
      bind:value={steps}
      class="w-full border bg-[var(--upaint-surface-raised)] px-1.5 py-1 text-right text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="number"
      min="1"
      max="150"
      step="1"
    />
  </label>

  <label class="grid grid-cols-[1fr_58px] items-center gap-x-2 gap-y-1 text-[var(--upaint-text-muted)]">
    <span class="col-span-2">CFG scale</span>
    <input
      bind:value={cfgScale}
      class="m-0 h-4 min-w-0 cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="1"
      max="30"
      step="0.5"
    />
    <input
      bind:value={cfgScale}
      class="w-full border bg-[var(--upaint-surface-raised)] px-1.5 py-1 text-right text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="number"
      min="1"
      max="30"
      step="0.5"
    />
  </label>

  <label class="grid grid-cols-[1fr_58px] items-center gap-x-2 gap-y-1 text-[var(--upaint-text-muted)]">
    <span class="col-span-2">Denoising strength</span>
    <input
      bind:value={denoisingStrength}
      class="m-0 h-4 min-w-0 cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="0"
      max="1"
      step="0.01"
    />
    <input
      bind:value={denoisingStrength}
      class="w-full border bg-[var(--upaint-surface-raised)] px-1.5 py-1 text-right text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="number"
      min="0"
      max="1"
      step="0.01"
    />
  </label>

  <label class="grid grid-cols-[1fr_58px] items-center gap-x-2 gap-y-1 text-[var(--upaint-text-muted)]">
    <span class="col-span-2">Mask blur</span>
    <input
      class="m-0 h-4 min-w-0 cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="0"
      max="64"
      step="4"
      value={generationSettingsStore.maskBlur}
      oninput={handleMaskBlur}
    />
    <input
      class="w-full border bg-[var(--upaint-surface-raised)] px-1.5 py-1 text-right text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="number"
      min="0"
      max="64"
      step="1"
      value={generationSettingsStore.maskBlur}
      oninput={handleMaskBlur}
    />
  </label>

  <label class="grid grid-cols-[1fr_58px] items-center gap-x-2 gap-y-1 text-[var(--upaint-text-muted)]">
    <span class="col-span-2">Context padding</span>
    <input
      class="m-0 h-4 min-w-0 cursor-pointer accent-[var(--upaint-accent)]"
      type="range"
      min="0"
      max="256"
      step="8"
      value={generationSettingsStore.inpaintPadding}
      oninput={handleInpaintPadding}
    />
    <input
      class="w-full border bg-[var(--upaint-surface-raised)] px-1.5 py-1 text-right text-xs text-[var(--upaint-text)] outline-none focus:border-[var(--upaint-accent)]"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="number"
      min="0"
      max="256"
      step="1"
      value={generationSettingsStore.inpaintPadding}
      oninput={handleInpaintPadding}
    />
  </label>

  <label class="flex cursor-pointer items-center gap-2 text-[var(--upaint-text-muted)]">
    <input
      class="m-0 h-4 w-4 accent-[var(--upaint-accent)]"
      type="checkbox"
      checked={generationSettingsStore.softInpaintingEnabled}
      onchange={handleSoftInpainting}
    />
    Soft inpainting
  </label>
</section>
