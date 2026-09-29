import { isDocumentMutationLocked, markHandedOff } from "../state/documentInteractionLock.svelte";
import { generationRuntimeStore } from "../state/generationRuntimeStore.svelte";
import { toastStore } from "../state/toastStore.svelte";

/**
 * Pop-out: the Forge tab's iframe hands the document to a full-window tab and
 * freezes; "bring back" (or closing that tab) hands it back and the iframe
 * reloads. Both sides sync through the server-side autosave and settings, so
 * a hand-off is: save everything, then freeze so this copy never overwrites
 * the tab that takes over.
 */

/** True when running inside Forge's tab iframe. */
export const isEmbedded = window.self !== window.top;

const APP_URL = "/ultra_paint/app/";
const RETURN = "ultra-paint:return";
const RETURNED = "ultra-paint:returned";

type Saver = () => Promise<boolean>;
const savers = new Set<Saver>();

/** Register work that must reach the server before another tab takes over. */
export function registerHandOffSaver(saver: Saver): () => void {
  savers.add(saver);
  return () => savers.delete(saver);
}

/** Save and freeze this copy; resolves to an error message, or null on success. */
async function handOff(): Promise<string | null> {
  if (generationRuntimeStore.generating) return "Wait for generation to finish first.";
  if (isDocumentMutationLocked()) return "Apply or discard the preview or filter first.";
  const results = await Promise.all([...savers].map((save) => save().catch(() => false)));
  if (!results.every(Boolean)) return "Could not save the current document. Try again.";
  markHandedOff();
  return null;
}

let poppedOut: Window | null = null;

/** Iframe side: open the app in a new tab and hand the document to it. */
export async function popOut(): Promise<void> {
  // Open before any await so the click still counts as a user gesture.
  const tab = window.open("", "_blank");
  if (!tab) {
    toastStore.error("The browser blocked the new tab. Allow pop-ups for Forge.");
    return;
  }
  const error = await handOff();
  if (error) {
    tab.close();
    toastStore.error(error);
    return;
  }
  poppedOut = tab;
  tab.location.href = `${APP_URL}?v=${Date.now()}`;
  window.addEventListener("message", (event) => {
    if (event.source !== tab || event.data?.type !== RETURNED) return;
    if (event.data.error) toastStore.error(event.data.error);
    else window.location.reload();
  });
  // ponytail: closing the tab directly keeps only its last autosave (it
  // flushes when hidden); "Bring back here" is the lossless path.
  window.setInterval(() => {
    if (tab.closed) window.location.reload();
  }, 1000);
}

/** Iframe side: ask the popped-out tab to hand the document back. */
export function bringBack(): void {
  if (!poppedOut || poppedOut.closed) window.location.reload();
  else poppedOut.postMessage({ type: RETURN }, window.location.origin);
}

/** Popped-out tab side: answer the iframe's bring-back request. */
export function listenForBringBack(): () => void {
  const opener = window.opener as Window | null;
  if (isEmbedded || !opener) return () => {};
  const onMessage = async (event: MessageEvent): Promise<void> => {
    if (event.source !== opener || event.origin !== window.location.origin) return;
    if (event.data?.type !== RETURN) return;
    const error = await handOff();
    if (error) toastStore.error(error);
    opener.postMessage({ type: RETURNED, error }, window.location.origin);
    if (!error) window.close();
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
