<script lang="ts">
  import { fromAction } from "svelte/attachments";

  import TagAutocompleteDropdown from "./TagAutocompleteDropdown.svelte";
  import { ensureTagsLoaded, searchTags, tagsLoaded, type TagEntry } from "./tagAutocomplete";

  interface Props {
    prompt: string;
    negativePrompt: string;
  }

  let { prompt = $bindable(), negativePrompt = $bindable() }: Props = $props();

  const SEARCH_DEBOUNCE_MS = 150;
  const BLUR_CLOSE_DELAY_MS = 150;

  function disableSpellcheck(node: HTMLTextAreaElement): void {
    node.spellcheck = false;
    node.setAttribute("autocomplete", "off");
    node.setAttribute("autocorrect", "off");
    node.setAttribute("autocapitalize", "off");
  }

  // Local autocomplete state for a single textarea, so the two prompt fields
  // don't share an open/selected dropdown.
  function createFieldState() {
    let results = $state<TagEntry[]>([]);
    let selectedIndex = $state(-1);
    let open = $state(false);
    let loading = $state(false);
    let wordStart = 0;
    let wordEnd = 0;
    let debounceHandle: ReturnType<typeof setTimeout> | undefined;
    let blurHandle: ReturnType<typeof setTimeout> | undefined;

    function currentWordRange(value: string, caret: number): [number, number] {
      const start = value.lastIndexOf(",", caret - 1) + 1;
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

      if (word.length < 2) {
        close();
        return;
      }

      if (!tagsLoaded()) {
        loading = true;
        open = true;
        void ensureTagsLoaded().then(() => runSearch(textarea));
        return;
      }

      loading = false;
      results = searchTags(word);
      selectedIndex = results.length > 0 ? 0 : -1;
      open = true;
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
      const insertion = `${needsLeadingSpace ? " " : ""}${entry.name}, `;
      const newValue = before + insertion + after.replace(/^\s+/, "");
      const caret = before.length + insertion.length;

      textarea.value = newValue;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.setSelectionRange(caret, caret);
      textarea.focus();
      close();
    }

    function onKeydown(event: KeyboardEvent): void {
      if (!open || results.length === 0) return;
      const textarea = event.currentTarget as HTMLTextAreaElement;

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
      onInput,
      onKeydown,
      onBlur,
      onSelect,
    };
  }

  const promptField = createFieldState();
  const negativePromptField = createFieldState();
</script>

<label class="relative flex flex-col gap-1 text-(--upaint-text-muted)">
  Prompt
  <textarea
    {@attach fromAction(disableSpellcheck)}
    bind:value={prompt}
    class="upaint-prompt-textarea min-h-24 resize-y border bg-(--upaint-surface-raised) p-2 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition);"
    placeholder="Describe what to generate"
    oninput={promptField.onInput}
    onkeydown={promptField.onKeydown}
    onblur={promptField.onBlur}></textarea>
  {#if promptField.open}
    <TagAutocompleteDropdown
      items={promptField.results}
      selectedIndex={promptField.selectedIndex}
      loading={promptField.loading}
      onSelect={(entry) => {
        const textarea = document.activeElement as HTMLTextAreaElement;
        promptField.onSelect(textarea, entry);
      }}
    />
  {/if}
</label>

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
      onSelect={(entry) => {
        const textarea = document.activeElement as HTMLTextAreaElement;
        negativePromptField.onSelect(textarea, entry);
      }}
    />
  {/if}
</label>
