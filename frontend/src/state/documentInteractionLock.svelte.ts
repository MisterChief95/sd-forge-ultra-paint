import { filterStore } from "./filterStore.svelte";
import { previewStore } from "./previewStore.svelte";

/** Document pixels and structure stay frozen until an active preview is resolved. */
export function isDocumentMutationLocked(): boolean {
  return previewStore.selected !== null || filterStore.active;
}
