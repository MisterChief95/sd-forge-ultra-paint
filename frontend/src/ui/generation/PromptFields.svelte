<script lang="ts">
  import { fromAction } from "svelte/attachments";

  interface Props {
    prompt: string;
    negativePrompt: string;
  }

  let { prompt = $bindable(), negativePrompt = $bindable() }: Props = $props();

  function disableSpellcheck(node: HTMLTextAreaElement): void {
    node.spellcheck = false;
    node.setAttribute("autocomplete", "off");
    node.setAttribute("autocorrect", "off");
    node.setAttribute("autocapitalize", "off");
  }
</script>

<label class="flex flex-col gap-1 text-(--upaint-text-muted)">
  Prompt
  <textarea
    {@attach fromAction(disableSpellcheck)}
    bind:value={prompt}
    class="min-h-24 resize-y border bg-(--upaint-surface-raised) p-2 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition);"
    placeholder="Describe what to generate"
  ></textarea>
</label>

<label class="flex flex-col gap-1 text-(--upaint-text-muted)">
  Negative prompt
  <textarea
    {@attach fromAction(disableSpellcheck)}
    bind:value={negativePrompt}
    class="min-h-20 resize-y border bg-(--upaint-surface-raised) p-2 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); transition: border-color var(--upaint-transition);"
    placeholder="What to avoid"
  ></textarea>
</label>
