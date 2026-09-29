import { GenerationApiError } from "./generationApi";

const STYLES_URL = "/ultra_paint/api/styles";

/** One Forge prompt style (`GET /ultra_paint/api/styles`). */
export interface PromptStyle {
  name: string;
  prompt: string;
  negative_prompt: string;
}

/** Forge's `apply_styles_to_prompt`: a `{prompt}` placeholder wraps the
 * current text; otherwise the style is appended after a comma. */
export function applyStyleText(prompt: string, style: string): string {
  if (style.includes("{prompt}")) return style.replaceAll("{prompt}", prompt);
  return [prompt.trim(), style.trim()].filter(Boolean).join(", ");
}

/** Apply each selected style in order (Forge does the same), skipping empty texts. */
export function applyStyles(
  text: string,
  selected: readonly string[],
  styles: readonly PromptStyle[],
  field: "prompt" | "negative_prompt",
): string {
  return selected.reduce((result, name) => {
    const style = styles.find((candidate) => candidate.name === name);
    return style?.[field] ? applyStyleText(result, style[field]) : result;
  }, text);
}

async function readStyles(response: Response): Promise<PromptStyle[]> {
  if (!response.ok) {
    let detail = `styles request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // Keep the status-based message.
    }
    throw new GenerationApiError(detail, response.status);
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) return [];
  return body.flatMap((item): PromptStyle[] => {
    const raw = item as Record<string, unknown> | null;
    if (!raw || typeof raw.name !== "string") return [];
    return [
      {
        name: raw.name,
        prompt: typeof raw.prompt === "string" ? raw.prompt : "",
        negative_prompt: typeof raw.negative_prompt === "string" ? raw.negative_prompt : "",
      },
    ];
  });
}

export async function fetchStyles(): Promise<PromptStyle[]> {
  return readStyles(await fetch(STYLES_URL, { cache: "no-store" }));
}

/** Create a style, or edit/rename one when `originalName` is given. */
export async function saveStyle(style: PromptStyle, originalName?: string): Promise<PromptStyle[]> {
  return readStyles(
    await fetch(STYLES_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...style, original_name: originalName ?? null }),
    }),
  );
}

export async function deleteStyle(name: string): Promise<PromptStyle[]> {
  return readStyles(
    await fetch(`${STYLES_URL}?name=${encodeURIComponent(name)}`, { method: "DELETE" }),
  );
}
