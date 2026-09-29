import type { Renderer } from "pixi.js";
import { strFromU8, strToU8, unzip, zipSync, type Unzipped } from "fflate";

import type { LayerStore } from "./layerStore.svelte";
import {
  decodePortableDocument,
  encodePortableDocument,
  type DecodedPortableProject,
} from "./projectCodec";

const MANIFEST_PATH = "manifest.json";
// fflate allocates each entry's declared size up front, so a hostile archive
// could claim gigabytes. A 1024px RGBA tile PNG tops out near 4 MiB.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
// Object URLs revoked too soon can cancel the download in Firefox/Safari.
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/** Thin ZIP adapter around the reusable portable-document codec. */
export async function createProjectArchive(renderer: Renderer, store: LayerStore): Promise<Blob> {
  const encoded = await encodePortableDocument(renderer, store, __ULTRA_PAINT_VERSION__);
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: strToU8(JSON.stringify(encoded.manifest)),
  };
  for (const asset of encoded.assets) entries[asset.path] = asset.data;
  return new Blob([new Uint8Array(zipSync(entries, { level: 6 }))], {
    type: "application/zip",
  });
}

export async function openProjectArchive(
  renderer: Renderer,
  file: Blob,
  controlModels: readonly string[],
): Promise<DecodedPortableProject> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Async unzip inflates on worker threads so a large project doesn't freeze the UI.
  const entries = await new Promise<Unzipped>((resolve, reject) =>
    unzip(
      bytes,
      {
        filter: (entry) =>
          (entry.name === MANIFEST_PATH || entry.name.startsWith("pixels/")) &&
          entry.originalSize <= MAX_ENTRY_BYTES,
      },
      (error, data) =>
        error ? reject(new Error("Project file is not a valid archive.")) : resolve(data),
    ),
  );
  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) throw new Error("Project archive is missing manifest.json.");

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error("Project manifest is not valid JSON.");
  }
  return await decodePortableDocument(renderer, manifest, (path) => entries[path], controlModels);
}

export function downloadProjectArchive(blob: Blob, documentId: string): void {
  const safeId = documentId.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeId || "ultra-paint-project"}.uproj`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}
