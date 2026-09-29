<script lang="ts">
  import { fromAction } from "svelte/attachments";

  import { appSettingsStore } from "../../state/appSettingsStore.svelte";
  import { stylesStore } from "../../state/stylesStore.svelte";
  import Chip from "../lib/Chip.svelte";
  import StylesMenu from "./StylesMenu.svelte";
  import StylesModal from "./StylesModal.svelte";
  import TagAutocompleteDropdown from "./TagAutocompleteDropdown.svelte";
  import { adjustPromptWeight, sanitizeInsertedTag, WEIGHT_STEP } from "./promptFormat";
  import {
    ensureTagsLoaded,
    MIN_QUERY_LENGTH,
    searchTags,
    tagsLoaded,
    type TagEntry,
  } from "./tagAutocomplete";

  interface Props {
    prompt: string;
    negativePrompt: string;
    negativeEnabled: boolean;
  }

  let {
    prompt = $bindable(),
    negativePrompt = $bindable(),
    negativeEnabled = $bindable(),
  }: Props = $props();

  let stylesOpen = $state(false);

  // Borderless glyph buttons overlaid on a prompt box's top-right corner.
  const overlayButtonClass =
    "cursor-pointer border-0 bg-transparent px-1 font-mono text-[11px] leading-none text-(--upaint-text-muted) outline-none hover:text-(--upaint-accent) focus-visible:text-(--upaint-accent)";

  const SEARCH_DEBOUNCE_MS = 150;
  const BLUR_CLOSE_DELAY_MS = 150;

  function disableSpellcheck(node: HTMLTextAreaElement): void {
    node.spellcheck = false;
    node.setAttribute("autocomplete", "off");
    node.setAttribute("autocorrect", "off");
    node.setAttribute("autocapitalize", "off");
  }

  // Properties that affect text layout -- mirrored onto a hidden div so a
  // marker span placed at the caret index lands at the same pixel spot the
  // browser would render the caret, letting the dropdown open right under it
  // instead of at the bottom of the (possibly tall) textarea.
  const CARET_MIRROR_PROPS = [
    "boxSizing",
    "width",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textTransform",
    "wordSpacing",
    "tabSize",
  ] as const;

  // Reused across calls (both prompt fields share it) instead of creating and
  // removing a mirror div on every debounced keystroke -- that create/measure
  // /destroy cycle forces layout each time, which is real cost on a page that
  // already does an O(bucket) tag search per search (see tagAutocomplete.ts).
  let mirrorEl: HTMLDivElement | undefined;
  let markerEl: HTMLSpanElement | undefined;

  function caretOffset(
    textarea: HTMLTextAreaElement,
    position: number,
  ): { top: number; left: number } {
    if (!mirrorEl || !markerEl) {
      mirrorEl = document.createElement("div");
      mirrorEl.style.position = "absolute";
      mirrorEl.style.visibility = "hidden";
      mirrorEl.style.whiteSpace = "pre-wrap";
      mirrorEl.style.wordWrap = "break-word";
      mirrorEl.style.top = "0";
      mirrorEl.style.left = "-9999px";
      markerEl = document.createElement("span");
      markerEl.textContent = "​";
      mirrorEl.appendChild(markerEl);
      document.body.appendChild(mirrorEl);
    }

    const style = getComputedStyle(textarea);
    for (const prop of CARET_MIRROR_PROPS) mirrorEl.style[prop] = style[prop];
    mirrorEl.textContent = textarea.value.slice(0, position);
    mirrorEl.appendChild(markerEl);

    const top = markerEl.offsetTop - textarea.scrollTop + markerEl.offsetHeight;
    const left = markerEl.offsetLeft - textarea.scrollLeft;

    return { top, left };
  }

  // Local autocomplete state for a single textarea, so the two prompt fields
  // don't share an open/selected dropdown.
  function createFieldState() {
    let results = $state<TagEntry[]>([]);
    let selectedIndex = $state(-1);
    let open = $state(false);
    let loading = $state(false);
    let dropdownTop = $state(0);
    let dropdownLeft = $state(0);
    let wordStart = 0;
    let wordEnd = 0;
    let debounceHandle: ReturnType<typeof setTimeout> | undefined;
    let blurHandle: ReturnType<typeof setTimeout> | undefined;

    function currentWordRange(value: string, caret: number): [number, number] {
      let start = value.lastIndexOf(",", caret - 1) + 1;
      // Skip past whitespace right after the comma so it lands in `before`
      // instead of getting swallowed into the replaced word span.
      while (start < caret && /\s/.test(value[start] ?? "")) start++;
      let end = value.indexOf(",", caret);
      if (end === -1) end = value.length;
      return [start, end];
    }

    function close(): void {
      open = false;
      results = [];
      selectedIndex = -1;
    }

    function runSearch(textarea: HTMLTextAreaElement): void {
      const caret = textarea.selectionStart;
      const [start, end] = currentWordRange(textarea.value, caret);
      const word = textarea.value.slice(start, end).trim();
      wordStart = start;
      wordEnd = end;

      if (!appSettingsStore.tagAutocomplete || word.length < MIN_QUERY_LENGTH) {
        close();
        return;
      }

      const rect = textarea.getBoundingClientRect();
      const offset = caretOffset(textarea, caret);
      dropdownTop = rect.top + offset.top;
      dropdownLeft = rect.left + offset.left;

      if (!tagsLoaded()) {
        loading = true;
        open = true;
        // Only re-search if tags actually loaded: a missing/failed tag file
        // leaves them unloaded, and re-entering runSearch would spin forever on
        // the already-settled load promise, starving every timer on the page.
        void ensureTagsLoaded().then(() => {
          if (tagsLoaded()) {
            runSearch(textarea);
          } else {
            loading = false;
            close();
          }
        });
        return;
      }

      loading = false;
      results = searchTags(word);
      selectedIndex = results.length > 0 ? 0 : -1;
      open = results.length > 0;
    }

    function onInput(event: Event): void {
      const textarea = event.currentTarget as HTMLTextAreaElement;
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => runSearch(textarea), SEARCH_DEBOUNCE_MS);
    }

    function insert(textarea: HTMLTextAreaElement, entry: TagEntry): void {
      const value = textarea.value;
      const before = value.slice(0, wordStart);
      const after = value.slice(wordEnd);
      const needsLeadingSpace = before.length > 0 && !/[\s,]$/.test(before);
      const insertion = `${needsLeadingSpace ? " " : ""}${sanitizeInsertedTag(entry.name)}, `;
      const newValue = before + insertion + after.replace(/^\s+/, "");
      const caret = before.length + insertion.length;

      textarea.value = newValue;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.setSelectionRange(caret, caret);
      textarea.focus();
      close();
    }

    function onKeydown(event: KeyboardEvent): void {
      const textarea = event.currentTarget as HTMLTextAreaElement;

      if (event.ctrlKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const delta = event.key === "ArrowUp" ? WEIGHT_STEP : -WEIGHT_STEP;
        const result = adjustPromptWeight(textarea.value, textarea.selectionStart, delta);
        textarea.value = result.value;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.setSelectionRange(result.caret, result.caret);
        return;
      }

      if (!open || results.length === 0) return;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          selectedIndex = (selectedIndex + 1) % results.length;
          break;
        case "ArrowUp":
          event.preventDefault();
          selectedIndex = (selectedIndex - 1 + results.length) % results.length;
          break;
        case "Enter":
        case "Tab": {
          const entry = results[selectedIndex >= 0 ? selectedIndex : 0];
          event.preventDefault();
          if (entry) insert(textarea, entry);
          break;
        }
        case "Escape":
          event.preventDefault();
          close();
          break;
      }
    }

    function onBlur(): void {
      // Delay so a result's mousedown handler can still fire first.
      blurHandle = setTimeout(close, BLUR_CLOSE_DELAY_MS);
    }

    function onSelect(textarea: HTMLTextAreaElement, entry: TagEntry): void {
      clearTimeout(blurHandle);
      insert(textarea, entry);
    }

    return {
      get results() {
        return results;
      },
      get selectedIndex() {
        return selectedIndex;
      },
      get open() {
        return open;
      },
      get loading() {
        return loading;
      },
      get dropdownTop() {
        return dropdownTop;
      },
      get dropdownLeft() {
        return dropdownLeft;
      },
      onInput,
      onKeydown,
      onBlur,
      onSelect,
    };
  }

  const promptField = createFieldState();
  const negativePromptField = createFieldState();
</script>

{#if stylesOpen}
  <StylesModal open onClose={() => (stylesOpen = false)} {prompt} {negativePrompt} />
{/if}

<div class="relative flex flex-col gap-1 text-(--upaint-text-muted)">
  <span id="upaint-prompt-label">Prompt</span>
  <!-- The box owns the border so the icon column and style chips live inside it
       without text ever flowing under them. -->
  <div
    class="relative flex flex-col border bg-(--upaint-surface-raised) focus-within:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition);"
  >
    <textarea
      {@attach fromAction(disableSpellcheck)}
      bind:value={prompt}
      aria-labelledby="upaint-prompt-label"
      class="upaint-prompt-textarea min-h-24 resize-y border-0 bg-transparent p-2 text-xs text-(--upaint-text) outline-none"
      style="padding-right: 1.75rem;"
      placeholder="Describe what to generate"
      oninput={promptField.onInput}
      onkeydown={promptField.onKeydown}
      onblur={promptField.onBlur}></textarea>
    <!-- Icon column: sits left of the (8px) scrollbar, which stays at the far right. -->
    <div class="absolute top-1 right-3 flex flex-col items-center gap-1">
      <button
        type="button"
        class={overlayButtonClass}
        title={negativeEnabled ? "Turn negative prompt off" : "Turn negative prompt on"}
        aria-label="Use negative prompt"
        aria-pressed={negativeEnabled}
        style:color={negativeEnabled ? "var(--upaint-accent)" : undefined}
        onclick={() => (negativeEnabled = !negativeEnabled)}>(-)</button
      >
      <StylesMenu class={overlayButtonClass} onEdit={() => (stylesOpen = true)} />
    </div>
    {#if stylesStore.selected.length > 0}
      <div class="flex flex-wrap gap-1 px-2 pt-1 pb-2" role="list" aria-label="Applied styles">
        {#each stylesStore.selected as name (name)}
          <span role="listitem"
            ><Chip label={name} onRemove={() => stylesStore.deselect(name)} /></span
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if promptField.open}
    <TagAutocompleteDropdown
      items={promptField.results}
      selectedIndex={promptField.selectedIndex}
      loading={promptField.loading}
      top={promptField.dropdownTop}
      left={promptField.dropdownLeft}
      onSelect={(entry) => {
        const textarea = document.activeElement as HTMLTextAreaElement;
        promptField.onSelect(textarea, entry);
      }}
    />
  {/if}
</div>

{#if negativeEnabled}
  <label class="relative flex flex-col gap-1 text-(--upaint-text-muted)">
    Negative prompt
    <textarea
      {@attach fromAction(disableSpellcheck)}
      bind:value={negativePrompt}
      class="upaint-prompt-textarea min-h-20 resize-y border bg-(--upaint-surface-raised) p-2 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition);"
      placeholder="What to avoid"
      oninput={negativePromptField.onInput}
      onkeydown={negativePromptField.onKeydown}
      onblur={negativePromptField.onBlur}></textarea>
    {#if negativePromptField.open}
      <TagAutocompleteDropdown
        items={negativePromptField.results}
        selectedIndex={negativePromptField.selectedIndex}
        loading={negativePromptField.loading}
        top={negativePromptField.dropdownTop}
        left={negativePromptField.dropdownLeft}
        onSelect={(entry) => {
          const textarea = document.activeElement as HTMLTextAreaElement;
          negativePromptField.onSelect(textarea, entry);
        }}
      />
    {/if}
  </label>
{/if}
