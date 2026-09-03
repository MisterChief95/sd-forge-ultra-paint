/**
 * Prompt text editing helpers: autocomplete-insertion sanitizing, spacing
 * normalization before generation, and caret-relative (attention) weight
 * adjustment.
 */

const WEIGHT_STEP = 0.1;

/** Underscores -> spaces, and literal parens escaped, for a tag inserted from autocomplete. */
export function sanitizeInsertedTag(name: string): string {
  return name.replace(/_/g, " ").replace(/[()]/g, (c) => `\\${c}`);
}

/**
 * Collapses any run of commas/whitespace (e.g. `,  ,, ,`) into a single ", ",
 * adds a space after periods while skipping decimal points like `1.1`, and
 * trims leading/trailing commas and whitespace.
 */
export function autoFormatPromptSpacing(text: string): string {
  const commasCollapsed = text.replace(/[,\s]*,[,\s]*/g, ", ");
  const periodsSpaced = commasCollapsed.replace(
    /(\.)(?=\S)/g,
    (punct, _g, offset: number, str: string) => {
      if (/\d/.test(str[offset - 1] ?? "") && /\d/.test(str[offset + 1] ?? "")) return punct;
      return `${punct} `;
    },
  );
  return periodsSpaced.replace(/^[,\s]+/, "").replace(/[,\s]+$/, "");
}

function roundWeight(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseWeightedContent(content: string): { text: string; weight: number | null } {
  const match = content.match(/^([\s\S]*):(-?\d+(?:\.\d+)?)$/);
  if (!match) return { text: content, weight: null };
  return { text: match[1] ?? "", weight: Number(match[2]) };
}

/** Innermost unescaped `(...)` pair enclosing `caret`, or null if none. */
function findEnclosingGroup(value: string, caret: number): { start: number; end: number } | null {
  const stack: number[] = [];
  let best: { start: number; end: number } | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const escaped = value[i - 1] === "\\";
    if (ch === "(" && !escaped) {
      stack.push(i);
    } else if (ch === ")" && !escaped) {
      const start = stack.pop();
      if (start === undefined) continue;
      if (start < caret && caret <= i && (!best || start > best.start)) {
        best = { start, end: i };
      }
    }
  }
  return best;
}

/** Range of the comma/period-delimited group containing `caret`, trimmed of whitespace. */
function tokenGroupRange(value: string, caret: number): [number, number] {
  let start = caret;
  while (start > 0 && value[start - 1] !== "," && value[start - 1] !== ".") start--;
  let end = caret;
  while (end < value.length && value[end] !== "," && value[end] !== ".") end++;
  while (start < end && /\s/.test(value[start] ?? "")) start++;
  while (end > start && /\s/.test(value[end - 1] ?? "")) end--;
  return [start, end];
}

/**
 * Adjusts the attention weight of the token group (or existing `(...:w)`
 * group) at `caret` by `delta`. Wraps an unweighted group in parens on the
 * first adjustment; further adjustments inside that group retarget it.
 */
export function adjustPromptWeight(
  value: string,
  caret: number,
  delta: number,
): { value: string; caret: number } {
  const group = findEnclosingGroup(value, caret);

  if (group) {
    const inner = value.slice(group.start + 1, group.end);
    const { text, weight } = parseWeightedContent(inner);
    const newWeight = roundWeight((weight ?? 1) + delta);
    const newInner = `${text}:${newWeight.toFixed(1)}`;
    const newValue = value.slice(0, group.start + 1) + newInner + value.slice(group.end);
    const shift = newInner.length - inner.length;
    const newCaret = caret <= group.end ? caret : caret + shift;
    return { value: newValue, caret: newCaret };
  }

  const [start, end] = tokenGroupRange(value, caret);
  if (start === end) return { value, caret };
  const text = value.slice(start, end);
  const newWeight = roundWeight(1 + delta);
  const replacement = `(${text}:${newWeight.toFixed(1)})`;
  const newValue = value.slice(0, start) + replacement + value.slice(end);
  const newCaret = start + 1 + Math.min(caret - start, text.length);
  return { value: newValue, caret: newCaret };
}

export { WEIGHT_STEP };
