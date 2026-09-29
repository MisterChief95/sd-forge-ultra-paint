<script lang="ts">
  import { appSettingsStore, type TouchMode } from "../state/appSettingsStore.svelte";
  import CheckboxField from "./lib/CheckboxField.svelte";
  import Modal from "./lib/Modal.svelte";
  import Select from "./lib/Select.svelte";

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
  <label class="flex flex-col gap-1 text-(--upaint-text-muted)">
    <span>One-finger touch on the canvas</span>
    <Select
      value={appSettingsStore.touchMode}
      onchange={(event) => appSettingsStore.setTouchMode(event.currentTarget.value as TouchMode)}
    >
      <option value="auto">Paint, until a pen is used (then pan)</option>
      <option value="paint">Always paint</option>
      <option value="pan">Always pan</option>
    </Select>
    <span class="text-[11px]"
      >Two-finger tap undoes, three-finger tap redoes. Touches near an active pen are ignored.</span
    >
  </label>
</Modal>
