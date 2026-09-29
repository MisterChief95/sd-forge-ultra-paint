<script lang="ts" module>
  import type { ExtensionManifest } from "./extensionsApi";

  export interface ExtensionValues {
    enabled: boolean;
    [inputKey: string]: unknown;
  }

  export function deriveDefaultExtensionValues(
    manifests: ExtensionManifest[],
  ): Record<string, ExtensionValues> {
    return Object.fromEntries(
      manifests.map((manifest) => [
        manifest.id,
        {
          enabled: false,
          ...Object.fromEntries(manifest.inputs.map((input) => [input.key, input.default])),
        },
      ]),
    );
  }
</script>

<script lang="ts">
  import Accordion from "../lib/Accordion.svelte";
  import ExtensionInputField from "./ExtensionInputField.svelte";

  interface Props {
    manifests: ExtensionManifest[];
    values: Record<string, ExtensionValues>;
    onValuesChange: (next: Record<string, ExtensionValues>) => void;
  }

  let { manifests, values, onValuesChange }: Props = $props();

  function updateEnabled(manifestId: string, enabled: boolean): void {
    onValuesChange({
      ...values,
      [manifestId]: { ...(values[manifestId] ?? { enabled: false }), enabled },
    });
  }

  function updateInputValue(manifestId: string, key: string, value: unknown): void {
    onValuesChange({
      ...values,
      [manifestId]: { ...(values[manifestId] ?? { enabled: false }), [key]: value },
    });
  }
</script>

{#snippet extensionBody(manifest: ExtensionManifest)}
  <div class="flex flex-col gap-2 p-2">
    {#if manifest.description}
      <p class="m-0 text-(--upaint-text-muted)">{manifest.description}</p>
    {/if}
    {#each manifest.inputs as inputSpec (inputSpec.key)}
      <ExtensionInputField
        spec={inputSpec}
        value={values[manifest.id]?.[inputSpec.key] ?? inputSpec.default}
        onValueChange={(key, newValue) => updateInputValue(manifest.id, key, newValue)}
      />
    {/each}
  </div>
{/snippet}

{#each manifests as manifest (manifest.id)}
  {#if manifest.canEnable}
    <Accordion
      title={manifest.title}
      canEnable={true}
      enabled={values[manifest.id]?.enabled ?? false}
      onEnabledChange={(next) => updateEnabled(manifest.id, next)}
    >
      {@render extensionBody(manifest)}
    </Accordion>
  {:else}
    <Accordion title={manifest.title}>
      {@render extensionBody(manifest)}
    </Accordion>
  {/if}
{/each}
