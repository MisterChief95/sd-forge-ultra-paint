const OPTIONS_URL = "/ultra_paint/api/options";
const LORAS_URL = "/ultra_paint/api/loras";
const GENERATE_URL = "/ultra_paint/api/generate";
const SAVE_URL = "/ultra_paint/api/save";
const PROGRESS_URL = "/ultra_paint/api/progress";
const INTERRUPT_URL = "/ultra_paint/api/interrupt";

export type GenerationMode = "txt2img" | "img2img";

export interface GenerationOptions {
  samplers: string[];
  schedulers: string[];
  nativeResolution: number | null;
  isVideoModel: boolean;
  resolutionStep: number | null;
}

export interface LoraCatalogItem {
  name: string;
  promptName: string;
  activationText: string;
  preferredWeight: number;
}

/** Wire payload for one visible `ControlLayer`, matching `ControlLayerRequest`. */
export interface ControlLayerPayload {
  image: string;
  maskImage: string | null;
  model: string;
  preprocessor: string;
  preprocessorResolution: number;
  preprocessorThresholdA: number;
  preprocessorThresholdB: number;
  weight: number;
  guidanceStart: number;
  guidanceEnd: number;
  controlMode: string;
  pixelPerfect: boolean;
  resizeMode: string;
  enabled: boolean;
}

export interface GenerationParameters {
  generationMode: GenerationMode;
  prompt: string;
  negativePrompt: string;
  steps: number;
  cfgScale: number;
  denoisingStrength: number;
  maskBlur: number;
  inpaintPadding: number;
  inpaintFullRes: boolean;
  softInpaintingEnabled: boolean;
  inpaintControlNetEnabled: boolean;
  inpaintControlNetModel: string;
  inpaintControlNetWeight: number;
  coherencePassEnabled: boolean;
  coherenceEdgeSize: number;
  coherencePassFast: boolean;
  samplerName: string;
  scheduler: string;
  targetResolution: { width: number; height: number } | null;
  seed: number;
}

export interface ProgressResponse {
  job?: string;
  job_count?: number;
  job_no?: number;
  sampling_step?: number;
  sampling_steps?: number;
  current_image?: string | null;
}

interface RawGenerationOptions {
  samplers: unknown;
  schedulers: unknown;
  native_resolution: unknown;
  is_video_model: unknown;
  resolution_step: unknown;
}

interface RawLoraCatalogItem {
  name?: unknown;
  prompt_name?: unknown;
  activation_text?: unknown;
  preferred_weight?: unknown;
}

export class GenerationApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GenerationApiError";
  }
}

export async function fetchGenerationOptions(): Promise<GenerationOptions> {
  const response = await fetch(OPTIONS_URL);
  if (!response.ok) {
    throw new GenerationApiError(`options request failed (${response.status})`, response.status);
  }

  const body = (await response.json()) as Partial<RawGenerationOptions>;
  return {
    samplers: stringArray(body.samplers),
    schedulers: stringArray(body.schedulers),
    nativeResolution: positiveSafeInteger(body.native_resolution),
    resolutionStep: positiveSafeInteger(body.resolution_step),
    isVideoModel: body.is_video_model === true,
  };
}

export async function fetchLoras(): Promise<LoraCatalogItem[]> {
  const response = await fetch(LORAS_URL);
  if (!response.ok) {
    throw new GenerationApiError(`LoRA request failed (${response.status})`, response.status);
  }

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("LoRA catalog returned an invalid response.");

  return body.flatMap((item): LoraCatalogItem[] => {
    if (typeof item !== "object" || item === null) return [];
    const raw = item as RawLoraCatalogItem;
    if (typeof raw.name !== "string" || typeof raw.prompt_name !== "string") return [];
    return [
      {
        name: raw.name,
        promptName: raw.prompt_name,
        activationText: typeof raw.activation_text === "string" ? raw.activation_text : "",
        preferredWeight:
          typeof raw.preferred_weight === "number" && Number.isFinite(raw.preferred_weight)
            ? raw.preferred_weight
            : 1,
      },
    ];
  });
}

export interface GenerationResult {
  images: unknown[];
  seeds: number[];
}

export async function requestGeneration(
  compositeImage: string,
  maskImage: string | null,
  parameters: GenerationParameters,
  controlLayers: ControlLayerPayload[] = [],
): Promise<GenerationResult> {
  const response = await fetch(GENERATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      composite_image: compositeImage,
      generation_mode: parameters.generationMode,
      ...(maskImage === null ? {} : { mask_image: maskImage }),
      control_layers: controlLayers.map((layer) => ({
        image: layer.image,
        ...(layer.maskImage === null ? {} : { mask_image: layer.maskImage }),
        model: layer.model,
        preprocessor: layer.preprocessor,
        preprocessor_resolution: layer.preprocessorResolution,
        preprocessor_threshold_a: layer.preprocessorThresholdA,
        preprocessor_threshold_b: layer.preprocessorThresholdB,
        weight: layer.weight,
        guidance_start: layer.guidanceStart,
        guidance_end: layer.guidanceEnd,
        control_mode: layer.controlMode,
        pixel_perfect: layer.pixelPerfect,
        resize_mode: layer.resizeMode,
        enabled: layer.enabled,
      })),
      gen_params: {
        prompt: parameters.prompt,
        negative_prompt: parameters.negativePrompt,
        steps: parameters.steps,
        cfg_scale: parameters.cfgScale,
        denoising_strength: parameters.denoisingStrength,
        mask_blur: parameters.maskBlur,
        inpaint_full_res_padding: parameters.inpaintPadding,
        inpaint_full_res: parameters.inpaintFullRes,
        soft_inpainting_enabled: parameters.softInpaintingEnabled,
        inpaint_controlnet_enabled: parameters.inpaintControlNetEnabled,
        inpaint_controlnet_weight: parameters.inpaintControlNetWeight,
        ...(parameters.inpaintControlNetModel
          ? { inpaint_controlnet_model: parameters.inpaintControlNetModel }
          : {}),
        coherence_pass_enabled: parameters.coherencePassEnabled,
        coherence_edge_size: parameters.coherenceEdgeSize,
        coherence_pass_fast: parameters.coherencePassFast,
        sampler_name: parameters.samplerName || null,
        scheduler: parameters.scheduler || null,
        seed: parameters.seed,
        ...(parameters.targetResolution === null
          ? {}
          : {
              target_width: parameters.targetResolution.width,
              target_height: parameters.targetResolution.height,
            }),
      },
    }),
  });

  if (!response.ok) throw new Error(await responseError(response));
  const body = (await response.json()) as { images?: unknown; seeds?: unknown };
  if (!Array.isArray(body.images)) {
    throw new Error("Generation returned an invalid image response.");
  }
  return {
    images: body.images,
    seeds: Array.isArray(body.seeds)
      ? body.seeds.filter((seed): seed is number => typeof seed === "number")
      : [],
  };
}

export async function saveFlattenedImage(image: string): Promise<string> {
  const response = await fetch(SAVE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Save"));

  const body = (await response.json()) as { path?: unknown };
  if (typeof body.path !== "string" || !body.path.trim()) {
    throw new Error("Save returned an invalid response.");
  }
  return body.path;
}

export async function fetchGenerationProgress(): Promise<ProgressResponse> {
  const response = await fetch(PROGRESS_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new GenerationApiError(`progress request failed (${response.status})`, response.status);
  }
  return (await response.json()) as ProgressResponse;
}

export async function interruptGeneration(): Promise<void> {
  const response = await fetch(INTERRUPT_URL, { method: "POST" });
  if (!response.ok) {
    throw new GenerationApiError(`interrupt request failed (${response.status})`, response.status);
  }
}

async function responseError(response: Response, action = "Generation"): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) {
      return body.detail;
    }
  } catch {
    // Fall through to a status-based message for a non-JSON error response.
  }
  return `${action} request failed (${response.status} ${response.statusText})`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function positiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}
