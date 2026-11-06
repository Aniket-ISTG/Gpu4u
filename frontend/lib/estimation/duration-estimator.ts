import type { GPUOffer } from "../marketplace/types.ts";
import type { WorkloadProfile } from "./workload-profile.ts";
import {
  DECODE_BW_EFFICIENCY,
  GPU_SPECS,
  INFERENCE_MFU,
  STARTUP_SECONDS,
  TRAINING_MFU,
  WEIGHT_LOAD_BYTES_PER_SECOND,
  getGpuSpec,
  multiGpuSpeedup,
  type SpecBasis,
} from "./gpu-performance.ts";

export interface DurationEstimate {
  /** Always "estimate": this is a model-based prediction, never a measurement. */
  kind: "estimate";
  hours: number;
  breakdown: { label: string; seconds: number }[];
  specBasis: SpecBasis;
  /** Estimated memory needed across the GPUs used, GB. */
  requiredVramGb: number;
  fitsInVram: boolean;
  assumptions: string[];
}

const GB = 1e9;

/** Rough memory footprint: weights (+20% runtime overhead) for inference/LoRA, ~16 bytes/param for full training. */
export function estimateRequiredVramGb(profile: WorkloadProfile): number {
  const params = profile.modelParamsB * 1e9;
  if (params === 0) return 0;
  const weights = (params * profile.precisionBytes) / GB;

  if (profile.taskType === "training" || (profile.taskType === "fine-tuning" && !profile.lora)) {
    return (params * 16) / GB; // fp16 weights+grads, fp32 master weights + Adam states
  }
  if (profile.taskType === "fine-tuning") return weights * 1.4; // LoRA: frozen weights + activations
  return weights * 1.2;
}

export function estimateDuration(
  offer: GPUOffer,
  gpusUsed: number,
  profile: WorkloadProfile,
): DurationEstimate {
  const { spec, basis } = getGpuSpec(offer.gpuModel, offer.performanceScore);
  const speedup = multiGpuSpeedup(gpusUsed);
  const params = profile.modelParamsB * 1e9;
  const weightBytes = params * profile.precisionBytes;
  const breakdown: { label: string; seconds: number }[] = [];
  const assumptions: string[] = [
    "Estimate from peak spec-sheet figures and assumed efficiency factors; not a benchmark.",
    `Multi-GPU scaling assumed at ${gpusUsed} GPU(s) = ${speedup.toFixed(2)}x one GPU.`,
  ];

  const startup = STARTUP_SECONDS + weightBytes / WEIGHT_LOAD_BYTES_PER_SECOND;
  breakdown.push({ label: "Startup and weight load", seconds: startup });

  if (profile.taskType === "inference") {
    const prefillTokens = profile.numPrompts * profile.avgInputTokens;
    const prefill =
      (2 * params * prefillTokens) / (spec.fp16Tflops * 1e12 * INFERENCE_MFU * speedup);

    const batch = Math.max(1, profile.batchSize);
    const steps = Math.ceil(profile.numPrompts / batch) * profile.avgOutputTokens;
    const memoryBoundStep = weightBytes / (spec.bandwidthGBs * 1e9 * DECODE_BW_EFFICIENCY);
    const computeBoundStep = (batch * 2 * params) / (spec.fp16Tflops * 1e12 * INFERENCE_MFU);
    const decode = (steps * Math.max(memoryBoundStep, computeBoundStep)) / speedup;

    breakdown.push({ label: "Prefill", seconds: prefill });
    breakdown.push({ label: "Decode", seconds: decode });
    assumptions.push(
      "Decode time is the slower of memory-bandwidth-bound and compute-bound per step; batch size raises throughput until compute-bound.",
    );
  } else if (profile.taskType === "training" || profile.taskType === "fine-tuning") {
    const flopsPerToken = profile.taskType === "fine-tuning" && profile.lora ? 4 : 6;
    const flops = flopsPerToken * params * profile.datasetTokens * profile.epochs;
    const train = flops / (spec.fp16Tflops * 1e12 * TRAINING_MFU * speedup);
    breakdown.push({ label: "Training", seconds: train });
    assumptions.push(
      `Training uses ${flopsPerToken}*params*tokens FLOPs at an assumed ${TRAINING_MFU * 100}% utilization; batch size is not modelled.`,
    );
  } else {
    const h100 = GPU_SPECS.H100.fp16Tflops;
    const seconds = (profile.referenceHoursOnH100 * 3600 * (h100 / spec.fp16Tflops)) / speedup;
    breakdown.push({ label: "Job (scaled from H100 reference)", seconds });
    assumptions.push("Duration scaled from the user-supplied H100 reference time by FP16 throughput.");
  }

  const seconds = breakdown.reduce((sum, part) => sum + part.seconds, 0);
  const requiredVramGb = estimateRequiredVramGb(profile);
  const availableVramGb = offer.vramGb * gpusUsed;

  return {
    kind: "estimate",
    hours: seconds / 3600,
    breakdown,
    specBasis: basis,
    requiredVramGb,
    fitsInVram: requiredVramGb <= availableVramGb,
    assumptions:
      basis === "performance-score-fallback"
        ? [...assumptions, "GPU not in the spec table; scaled from the H100 by the provider performance score."]
        : assumptions,
  };
}
