<script lang="ts">
  import { stylesStore } from "../../state/stylesStore.svelte";
  import Button from "../lib/Button.svelte";
  import Modal from "../lib/Modal.svelte";
  import Select from "../lib/Select.svelte";
  import type { PromptStyle } from "./stylesApi";

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Lets the draft be seeded from the prompts currently being written. */
    prompt: string;
    negativePrompt: string;
  }

  let { open, onClose, prompt, negativePrompt }: Props = $props();

  const PROMPT_PLACEHOLDER = "Prompt (use {prompt} to wrap the current prompt)";
  const EMPTY: PromptStyle = { name: "", prompt: "", negative_prompt: "" };

  let selected = $state("");
  let draft = $state<PromptStyle>({ ...EMPTY });
  const current = $derived(stylesStore.styles.find((style) => style.name === selected));

  // PromptFields mounts this fresh on each open, so state starts clean.
  stylesStore.load();

  function select(name: string): void {
    selected = name;
    const style = stylesStore.styles.find((candidate) => candidate.name === name);
    draft = style ? { ...style } : { ...EMPTY };
  }

  async function save(): Promise<void> {
    const name = draft.name.trim();
    if (!name) return;
    if (await stylesStore.save({ ...draft, name }, current?.name)) selected = name;
  }

  async function remove(): Promise<void> {
    if (!current || !window.confirm(`Delete style "${current.name}"?`)) return;
    if (await stylesStore.remove(current.name)) select("");
  }

  const fieldClass =
    "border bg-(--upaint-surface-raised) p-2 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)";
  const fieldStyle = "border-color: var(--upaint-border); border-radius: var(--upaint-radius);";
</script>

<Modal {open} title="Styles" {onClose} class="w-[28rem]">
  <form
    class="flex flex-col gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <div class="flex items-center gap-1">
      <Select
        class="flex-1"
        value={selected}
        aria-label="Edit style"
        onchange={(event) => select(event.currentTarget.value)}
      >
        <option value="">New style</option>
        {#each stylesStore.styles as style (style.name)}
          <option value={style.name}>{style.name}</option>
        {/each}
      </Select>
      <Button
        size="sm"
        title="Copy the current prompt fields into this style"
        onclick={() => (draft = { ...draft, prompt, negative_prompt: negativePrompt })}
      >
        Use current prompts
      </Button>
    </div>
    <input
      class={fieldClass}
      style={fieldStyle}
      placeholder="Style name"
      aria-label="Style name"
      bind:value={draft.name}
    />
    <textarea
      class={fieldClass}
      style={fieldStyle}
      rows="3"
      placeholder={PROMPT_PLACEHOLDER}
      aria-label="Style prompt"
      bind:value={draft.prompt}></textarea>
    <textarea
      class={fieldClass}
      style={fieldStyle}
      rows="3"
      placeholder="Negative prompt"
      aria-label="Style negative prompt"
      bind:value={draft.negative_prompt}></textarea>
    <div class="flex justify-between gap-1">
      <Button variant="danger" size="sm" disabled={!current} onclick={remove}>Delete</Button>
      <Button size="sm" variant="primary" type="submit" disabled={!draft.name.trim()}>
        {current ? "Save changes" : "Create style"}
      </Button>
    </div>
  </form>
</Modal>
