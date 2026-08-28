/**
 * Thin client for Ultra Paint's OWN ControlNet catalog routes
 * (`ultra_paint/controlnet_catalog_api.py`), not Forge ControlNet's routes directly.
 * Forge's own `/controlnet/model_list` etc. (`lib_controlnet/api.py`) only mount when
 * the server is launched with `--api` (see `scripts/controlnet.py`), which is not
 * guaranteed -- the same reason `ultra_paint/options_api.py` doesn't reuse
 * `/sdapi/v1/samplers`. Ultra Paint's routes always mount and read ControlNet's
 * internals (`lib_controlnet.global_state`) in-process instead, the same way
 * `aadetailer-neoforge` does. Every function here still degrades to an empty/`null`
 * result instead of throwing when the routes fail -- ControlNet is an optional Forge
 * extension and its absence must not break the rest of Ultra Paint.
 */

const MODEL_LIST_URL = "/ultra_paint/api/controlnet/model_list";
const MODULE_LIST_URL = "/ultra_paint/api/controlnet/module_list";
const CONTROL_TYPES_URL = "/ultra_paint/api/controlnet/control_types";
const DETECT_URL = "/ultra_paint/api/controlnet/detect";

/** One entry of `GET /controlnet/control_types`, keyed by tag (e.g. "Canny", "Inpaint"). */
export interface ControlType {
  moduleList: string[];
  modelList: string[];
  defaultOption: string;
  defaultModel: string;
}

interface RawControlType {
  module_list?: unknown;
  model_list?: unknown;
  default_option?: unknown;
  default_model?: unknown;
}

/** `GET /controlnet/model_list` -- installed ControlNet model filenames. */
export async function fetchControlModels(): Promise<string[]> {
  return stringArrayField(await getJson(MODEL_LIST_URL), "model_list");
}

/** `GET /controlnet/module_list` -- available preprocessor names. */
export async function fetchControlModules(): Promise<string[]> {
  return stringArrayField(await getJson(MODULE_LIST_URL), "module_list");
}

/**
 * `GET /controlnet/control_types` -- preprocessor/model tags (e.g. "Inpaint",
 * "Canny"), each pre-filtered to the models and modules that apply to it, plus
 * Forge's own suggested default pick. Used to populate the Filter tool's
 * module picker.
 */
export async function fetchControlTypes(): Promise<Record<string, ControlType>> {
  const body = await getJson(CONTROL_TYPES_URL);
  const raw = recordField(body, "control_types");
  const out: Record<string, ControlType> = {};
  for (const [tag, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as RawControlType;
    out[tag] = {
      moduleList: asStringArray(entry.module_list),
      modelList: asStringArray(entry.model_list),
      defaultOption: typeof entry.default_option === "string" ? entry.default_option : "none",
      defaultModel: typeof entry.default_model === "string" ? entry.default_model : "None",
    };
  }
  return out;
}

/**
 * `POST /ultra_paint/api/controlnet/detect` -- runs one preprocessor over one
 * image, without running generation. `imageDataUrl` is a
 * `data:image/...;base64,...` URL (e.g. from `UltraPaintApp.layerSourceDataURL()`);
 * the response is the same shape, used by the Filter tool's on-canvas
 * preview. Always runs "pixel perfect" -- the backend derives the
 * preprocessor's resolution from the source image itself, so the result
 * always comes back at the same size as the layer being processed. Returns
 * `null` on any failure (module unavailable, ControlNet not installed, bad
 * image) -- callers should treat a `null` result as "couldn't preview", not
 * an error.
 */
export async function preprocessControlImage(
  module: string,
  imageDataUrl: string,
  thresholdA = 64,
  thresholdB = 64,
): Promise<string | null> {
  try {
    const response = await fetch(DETECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        module,
        image: imageDataUrl,
        threshold_a: thresholdA,
        threshold_b: thresholdB,
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { image?: unknown };
    return typeof body.image === "string" && body.image.length > 0 ? body.image : null;
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function recordField(body: unknown, key: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringArrayField(body: unknown, key: string): string[] {
  if (typeof body !== "object" || body === null) return [];
  return asStringArray((body as Record<string, unknown>)[key]);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
