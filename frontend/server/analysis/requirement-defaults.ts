import type { Difficulty, WorkloadAnalysis } from "../../lib/validation/workload.schema.ts";
import { estimateRequiredVramGb } from "../../lib/estimation/duration-estimator.ts";
import { parseModelParamsB, resolveProfile, type TaskType } from "../../lib/estimation/workload-profile.ts";

/**
 * Representative model for a task and difficulty when the user names none.
 * These are ASSUMED starting points, not recommendations from a benchmark.
 */
export const DEFAULT_MODELS: Record<TaskType, Record<Difficulty, string>> = {
  inference: { easy: "llama-3.2-3b", medium: "llama-3-8b", hard: "llama-3-70b" },
  "fine-tuning": { easy: "llama-3.2-3b", medium: "mistral-7b", hard: "qwen2.5-32b" },
  training: { easy: "tinyllama-1b", medium: "llama-3.2-3b", hard: "mistral-7b" },
  rendering: { easy: "blender-cycles", medium: "blender-cycles", hard: "blender-cycles" },
  other: { easy: "generic-gpu-workload", medium: "generic-gpu-workload", hard: "generic-gpu-workload" },
};

/** Per-GPU VRAM used when no model size is known (rendering/other, or an unparseable model name). */
const FALLBACK_VRAM_GB: Record<Difficulty, number> = { easy: 8, medium: 16, hard: 40 };

const VRAM_TIERS_GB = [8, 12, 16, 24, 40, 48, 80];

/** Assumed hourly budget per GPU for a VRAM tier, in USD. Set to cover typical offers, not a market quote. */
const BUDGET_PER_GPU_USD: Record<number, number> = {
  8: 0.75,
  12: 0.75,
  16: 1,
  24: 1,
  40: 1.5,
  48: 1.75,
  80: 3.5,
};

function roundUpToTier(gb: number): number {
  return VRAM_TIERS_GB.find((tier) => tier >= gb) ?? VRAM_TIERS_GB[VRAM_TIERS_GB.length - 1];
}

export type FilledField = "taskType" | "model" | "minimumVramGb" | "maxHourlyBudgetUsd" | "cudaRequired";

/**
 * Fills requirements the user did not state, from the task type and difficulty.
 * Filled fields are marked "estimated"; anything the user stated is untouched.
 */
export function fillMissingRequirements(analysis: WorkloadAnalysis): WorkloadAnalysis {
  const filled: FilledField[] = [];
  const next: WorkloadAnalysis = { ...analysis, fieldSources: { ...analysis.fieldSources } };
  const mark = (field: FilledField) => {
    next.fieldSources[field] = "estimated";
    filled.push(field);
  };

  if (next.taskType === null) {
    next.taskType = "inference";
    mark("taskType");
  }
  const taskType = next.taskType as TaskType;

  if (next.model === null) {
    next.model = DEFAULT_MODELS[taskType][next.difficulty];
    mark("model");
  }

  if (next.minimumVramGb === null) {
    const params = parseModelParamsB(next.model);
    let perGpuGb = FALLBACK_VRAM_GB[next.difficulty];
    if (params !== null) {
      const profile = resolveProfile(taskType, { modelParamsB: params }).profile;
      perGpuGb = estimateRequiredVramGb(profile) / Math.max(1, next.gpuCount);
    }
    next.minimumVramGb = roundUpToTier(perGpuGb);
    mark("minimumVramGb");
  }

  if (next.maxHourlyBudgetUsd === null) {
    next.maxHourlyBudgetUsd = BUDGET_PER_GPU_USD[roundUpToTier(next.minimumVramGb)] * next.gpuCount;
    mark("maxHourlyBudgetUsd");
  }

  if (next.cudaRequired === null) {
    next.cudaRequired = true;
    mark("cudaRequired");
  }

  if (filled.length) {
    next.clarificationQuestions = [
      `Not stated, so estimated for ${/^[aeiou]/.test(next.difficulty) ? "an" : "a"} ${next.difficulty} ${taskType} task: ${filled.join(", ")}. Edit them in the router filters if they are wrong.`,
    ];
  }
  return next;
}
