/**
 * Client-side prompt tag autocomplete (Phase 1: plain tag/alias matching).
 *
 * Reads a TAC-format tag CSV (`name,category,count,"alias1,alias2"`, same
 * columns as sd-webui-tagcomplete-neo's tag lists) served statically from
 * `/ultra_paint/data/tags.csv`, so a full danbooru.csv-style file can be
 * dropped in without any code changes.
 */

const TAGS_URL = "/ultra_paint/data/tags.csv";
const INDEX_CHUNK_SIZE = 5000;

// Longest index-key prefix (see indexKeysFor); caps bucket-lookup cost once
// a query is at least this long. Every prefix up to this length is indexed.
// ponytail: MIN_QUERY_LENGTH is 2, not 1 -- on the real 188k-row tags.csv a
// 1-char bucket (e.g. "s") holds 15-20k+ entries vs. ~5k for 2 chars, and
// searchTags does an O(bucket) .includes()+sort on every matching keystroke.
// If profiling still shows jank at 2 chars on real hardware, move the index
// and search into a Web Worker (index can't be structured-cloned back
// cheaply, so keep it and the search there; tag results with a request id
// so a stale response can't clobber a newer one).
const KEY_LENGTH = 3;
export const MIN_QUERY_LENGTH = 2;

export interface TagEntry {
  name: string;
  category: number;
  count: number;
  aliases: string[];
}

// Minimal quoted-field CSV parser -- same approach as tagcomplete-neo's
// parseCSV, since it needs to handle the same file format (quoted alias
// lists may contain commas).
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row = 0;
  let col = 0;
  let quote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const next = text[i + 1];
    const currentRow = (rows[row] ??= []);
    currentRow[col] ??= "";

    if (c === '"' && quote && next === '"') {
      currentRow[col] += c;
      i++;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    if (c === "," && !quote) {
      col++;
      continue;
    }
    if ((c === "\r" && next === "\n") || c === "\n" || c === "\r") {
      if (c === "\r" && next === "\n") i++;
      row++;
      col = 0;
      quote = false;
      continue;
    }
    currentRow[col] += c;
  }
  return rows;
}

export function parseTagCsv(text: string): TagEntry[] {
  const entries: TagEntry[] = [];
  for (const cols of parseCsvRows(text)) {
    const name = cols[0]?.trim();
    if (!name) continue;
    const aliases = cols[3]
      ? cols[3]
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : [];
    entries.push({
      name,
      category: Number(cols[1]) || 0,
      count: Number(cols[2]) || 0,
      aliases,
    });
  }
  return entries;
}

const tagIndex = new Map<string, TagEntry[]>();
let loaded = false;
let loadPromise: Promise<void> | null = null;

// Every prefix length up to KEY_LENGTH gets its own bucket (not just the
// full 3-char one), so a 1- or 2-char query still has a bucket to look up
// instead of only ever matching once the user reaches KEY_LENGTH chars.
function addPrefixes(keys: Set<string>, str: string): void {
  for (let len = 1; len <= Math.min(str.length, KEY_LENGTH); len++) {
    keys.add(str.slice(0, len));
  }
}

function indexKeysFor(word: string): Set<string> {
  const keys = new Set<string>();
  const lower = word.toLowerCase();
  for (const part of lower.split(/[_ ]+/)) addPrefixes(keys, part);
  addPrefixes(keys, lower);
  return keys;
}

function addToIndex(entry: TagEntry): void {
  const keys = indexKeysFor(entry.name);
  for (const alias of entry.aliases) {
    for (const key of indexKeysFor(alias)) keys.add(key);
  }
  for (const key of keys) {
    const bucket = tagIndex.get(key);
    if (bucket) bucket.push(entry);
    else tagIndex.set(key, [entry]);
  }
}

async function buildIndex(entries: TagEntry[]): Promise<void> {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) addToIndex(entry);
    if (i % INDEX_CHUNK_SIZE === INDEX_CHUNK_SIZE - 1) {
      // Yield to the browser so typing doesn't stall while a large CSV indexes.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

export function ensureTagsLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      // no-store: StaticFiles sends Last-Modified/ETag but no Cache-Control,
      // so the browser's heuristic cache can otherwise keep serving a
      // pre-replacement tags.csv indefinitely without ever revalidating.
      const response = await fetch(TAGS_URL, { cache: "no-store" });
      if (!response.ok) return;
      const text = await response.text();
      const entries = parseTagCsv(text);
      await buildIndex(entries);
      loaded = true;
    } catch {
      // No tag file available -- autocomplete stays silently empty.
    }
  })();
  return loadPromise;
}

export function tagsLoaded(): boolean {
  return loaded;
}

export function searchTags(query: string, limit = 20): TagEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (!loaded || trimmed.length < MIN_QUERY_LENGTH) return [];

  const key = trimmed.slice(0, KEY_LENGTH);
  const candidates = tagIndex.get(key);
  if (!candidates) return [];

  const seen = new Set<TagEntry>();
  const matches: TagEntry[] = [];
  for (const entry of candidates) {
    if (seen.has(entry)) continue;
    const nameMatch = entry.name.toLowerCase().includes(trimmed);
    const aliasMatch = !nameMatch && entry.aliases.some((a) => a.toLowerCase().includes(trimmed));
    if (nameMatch || aliasMatch) {
      seen.add(entry);
      matches.push(entry);
    }
  }

  matches.sort((a, b) => b.count - a.count);
  return matches.slice(0, limit);
}
