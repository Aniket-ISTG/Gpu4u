export type TaskType = "inference" | "training" | "fine-tuning" | "rendering" | "other";

/**
 * Size of the job. Everything here is either supplied by the user or filled
 * from a documented default; `defaulted` lists the latter so the UI can say so.
 */
export interface WorkloadProfile {
  taskType: TaskType;
  /** Model size in billions of parameters (not used for rendering/other). */
  modelParamsB: number;
  /** Inference: number of prompts/requests to process. */
  numPrompts: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** Inference: concurrent sequences per decode step. */
  batchSize: number;
  /** Training / fine-tuning: tokens per epoch. */
  datasetTokens: number;
  epochs: number;
  /** Fine-tuning only: LoRA-style (cheaper) vs full fine-tune. */
  lora: boolean;
  /** Bytes per weight: 2 = fp16/bf16, 1 = int8, 0.5 = int4. */
  precisionBytes: number;
  /** Rendering / other: how long the job takes on one H100, in hours. */
  referenceHoursOnH100: number;
}

export interface ResolvedProfile {
  profile: WorkloadProfile;
  /** Field names that were not provided and came from DEFAULTS. */
  defaulted: (keyof WorkloadProfile)[];
}

export const DEFAULTS: Record<TaskType, WorkloadProfile> = {
  inference: {
    taskType: "inference",
    modelParamsB: 7,
    numPrompts: 1000,
    avgInputTokens: 512,
    avgOutputTokens: 256,
    batchSize: 8,
    datasetTokens: 0,
    epochs: 1,
    lora: false,
    precisionBytes: 2,
    referenceHoursOnH100: 1,
  },
  training: {
    taskType: "training",
    modelParamsB: 1,
    numPrompts: 0,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    batchSize: 32,
    datasetTokens: 200_000_000,
    epochs: 1,
    lora: false,
    precisionBytes: 2,
    referenceHoursOnH100: 1,
  },
  "fine-tuning": {
    taskType: "fine-tuning",
    modelParamsB: 7,
    numPrompts: 0,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    batchSize: 16,
    datasetTokens: 20_000_000,
    epochs: 3,
    lora: true,
    precisionBytes: 2,
    referenceHoursOnH100: 1,
  },
  rendering: {
    taskType: "rendering",
    modelParamsB: 0,
    numPrompts: 0,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    batchSize: 1,
    datasetTokens: 0,
    epochs: 1,
    lora: false,
    precisionBytes: 2,
    referenceHoursOnH100: 2,
  },
  other: {
    taskType: "other",
    modelParamsB: 0,
    numPrompts: 0,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    batchSize: 1,
    datasetTokens: 0,
    epochs: 1,
    lora: false,
    precisionBytes: 2,
    referenceHoursOnH100: 2,
  },
};

/** "llama-3-8b" -> 8, "Mistral 7B" -> 7, "DeepSeek R1 32B" -> 32. Null when no size is present. */
export function parseModelParamsB(model: string | null | undefined): number | null {
  if (!model) return null;
  const match = model.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveProfile(
  taskType: TaskType | null | undefined,
  provided: Partial<WorkloadProfile> = {},
): ResolvedProfile {
  const type: TaskType = taskType ?? provided.taskType ?? "inference";
  const base = DEFAULTS[type];
  const profile: WorkloadProfile = { ...base, taskType: type };
  const defaulted: (keyof WorkloadProfile)[] = [];

  for (const key of Object.keys(base) as (keyof WorkloadProfile)[]) {
    if (key === "taskType") continue;
    const value = provided[key];
    if (value === undefined || value === null) {
      defaulted.push(key);
    } else {
      (profile as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return { profile, defaulted };
}
