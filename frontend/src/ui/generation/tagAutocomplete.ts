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

function indexKeysFor(word: string): Set<string> {
  const keys = new Set<string>();
  const lower = word.toLowerCase();
  for (const part of lower.split(/[_ ]+/)) {
    if (part.length >= 3) keys.add(part.slice(0, 3));
  }
  if (lower.length >= 3) keys.add(lower.slice(0, 3));
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
      const response = await fetch(TAGS_URL);
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
  if (!loaded || trimmed.length < 2) return [];

  const key = trimmed.slice(0, 3);
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
