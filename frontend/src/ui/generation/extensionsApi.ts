import { GenerationApiError } from "./generationApi";

const EXTENSIONS_URL = "/ultra_paint/api/extensions";

interface ExtensionInputCommon {
  key: string;
  label: string;
  info?: string;
}

export interface ExtensionSelectOption {
  label: string;
  value: string;
}

export interface ExtensionNumberInput extends ExtensionInputCommon {
  type: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface ExtensionTextInput extends ExtensionInputCommon {
  type: "text";
  default: string;
  maxLength?: number;
  placeholder?: string;
}

export interface ExtensionBooleanInput extends ExtensionInputCommon {
  type: "boolean";
  default: boolean;
}

export interface ExtensionSelectInput extends ExtensionInputCommon {
  type: "select";
  default: string;
  options: ExtensionSelectOption[];
}

/** Mirrors one entry of a `upaint.json` manifest's `inputs` array (see
 * `ultra_paint/schemas/upaint.schema.json`). */
export type ExtensionInputSpec =
  ExtensionNumberInput | ExtensionTextInput | ExtensionBooleanInput | ExtensionSelectInput;

/** Mirrors one discovered `upaint.json` manifest, as served by
 * `GET /ultra_paint/api/extensions` (`ultra_paint/extension_manifest.py`'s
 * `ExtensionManifest`). Field names stay camelCase end-to-end: this is a
 * pass-through of an extension author's on-disk manifest, not
 * backend-computed data, so there is no snake_case wire shape to remap. */
export interface ExtensionManifest {
  id: string;
  title: string;
  scriptTitle: string;
  description?: string;
  canEnable: boolean;
  inputs: ExtensionInputSpec[];
}

export async function fetchExtensionManifests(): Promise<ExtensionManifest[]> {
  const response = await fetch(EXTENSIONS_URL);
  if (!response.ok) {
    throw new GenerationApiError(`extensions request failed (${response.status})`, response.status);
  }

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) return [];

  return body.flatMap((item): ExtensionManifest[] => {
    const manifest = parseManifest(item);
    return manifest ? [manifest] : [];
  });
}

function parseManifest(value: unknown): ExtensionManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.scriptTitle !== "string" ||
    typeof raw.canEnable !== "boolean"
  ) {
    return null;
  }

  const inputs = Array.isArray(raw.inputs)
    ? raw.inputs.flatMap((entry): ExtensionInputSpec[] => {
        const input = parseInput(entry);
        return input ? [input] : [];
      })
    : [];

  return {
    id: raw.id,
    title: raw.title,
    scriptTitle: raw.scriptTitle,
    canEnable: raw.canEnable,
    inputs,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
  };
}

function parseInput(value: unknown): ExtensionInputSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.key !== "string" || typeof raw.label !== "string") return null;
  const info = typeof raw.info === "string" ? { info: raw.info } : {};

  switch (raw.type) {
    case "number":
      if (typeof raw.default !== "number") return null;
      return {
        type: "number",
        key: raw.key,
        label: raw.label,
        default: raw.default,
        ...(typeof raw.min === "number" ? { min: raw.min } : {}),
        ...(typeof raw.max === "number" ? { max: raw.max } : {}),
        ...(typeof raw.step === "number" ? { step: raw.step } : {}),
        ...info,
      };
    case "text":
      if (typeof raw.default !== "string") return null;
      return {
        type: "text",
        key: raw.key,
        label: raw.label,
        default: raw.default,
        ...(typeof raw.maxLength === "number" ? { maxLength: raw.maxLength } : {}),
        ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
        ...info,
      };
    case "boolean":
      if (typeof raw.default !== "boolean") return null;
      return { type: "boolean", key: raw.key, label: raw.label, default: raw.default, ...info };
    case "select": {
      if (typeof raw.default !== "string" || !Array.isArray(raw.options)) return null;
      const options = raw.options.flatMap((option): ExtensionSelectOption[] => {
        if (typeof option !== "object" || option === null) return [];
        const optionRaw = option as Record<string, unknown>;
        return typeof optionRaw.label === "string" && typeof optionRaw.value === "string"
          ? [{ label: optionRaw.label, value: optionRaw.value }]
          : [];
      });
      if (options.length === 0) return null;
      return {
        type: "select",
        key: raw.key,
        label: raw.label,
        default: raw.default,
        options,
        ...info,
      };
    }
    default:
      return null;
  }
}
