<script lang="ts">
  import { appSettingsStore } from "../state/appSettingsStore.svelte";
  import CheckboxField from "./lib/CheckboxField.svelte";
  import Modal from "./lib/Modal.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();
</script>

<Modal {open} title="Settings" {onClose}>
  <CheckboxField
    label="Tag autocompletion"
    checked={appSettingsStore.tagAutocomplete}
    onchange={(event) => appSettingsStore.setTagAutocomplete(event.currentTarget.checked)}
  />
</Modal>
