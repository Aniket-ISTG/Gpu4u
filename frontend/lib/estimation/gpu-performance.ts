/**
 * ASSUMED performance model. These are public peak spec-sheet figures plus
 * fixed efficiency factors. They are NOT measured benchmarks and every
 * duration derived from them is an estimate.
 */
export interface GpuSpec {
  /** Peak memory bandwidth, GB/s. */
  bandwidthGBs: number;
  /** Peak dense FP16/BF16 tensor throughput, TFLOPs. */
  fp16Tflops: number;
}

export const GPU_SPECS: Record<string, GpuSpec> = {
  "RTX 3090": { bandwidthGBs: 936, fp16Tflops: 71 },
  "RTX 4090": { bandwidthGBs: 1008, fp16Tflops: 165 },
  "A100 40GB": { bandwidthGBs: 1555, fp16Tflops: 312 },
  "A100 80GB": { bandwidthGBs: 2039, fp16Tflops: 312 },
  H100: { bandwidthGBs: 3350, fp16Tflops: 989 },
  L4: { bandwidthGBs: 300, fp16Tflops: 121 },
  L40S: { bandwidthGBs: 864, fp16Tflops: 362 },
  "RTX A6000": { bandwidthGBs: 768, fp16Tflops: 155 },
};

/** Fraction of peak bandwidth achieved while decoding. */
export const DECODE_BW_EFFICIENCY = 0.65;
/** Fraction of peak FLOPs achieved in prefill and batched decode. */
export const INFERENCE_MFU = 0.45;
/** Fraction of peak FLOPs achieved in training. */
export const TRAINING_MFU = 0.35;
/** Each additional GPU adds this fraction of one GPU's throughput. */
export const MULTI_GPU_EFFICIENCY = 0.9;
/** Fixed container start + weight load overhead, seconds. */
export const STARTUP_SECONDS = 30;
/** Weight loading rate from storage, bytes/second. */
export const WEIGHT_LOAD_BYTES_PER_SECOND = 2e9;

export type SpecBasis = "spec-table" | "performance-score-fallback";

export function getGpuSpec(
  gpuModel: string,
  performanceScore?: number,
): { spec: GpuSpec; basis: SpecBasis } {
  const known = GPU_SPECS[gpuModel];
  if (known) return { spec: known, basis: "spec-table" };

  // Unknown GPU: scale the H100 spec by the provider-supplied performance score.
  const factor = Math.max(0.05, Math.min(1, (performanceScore ?? 50) / 100));
  return {
    spec: {
      bandwidthGBs: GPU_SPECS.H100.bandwidthGBs * factor,
      fp16Tflops: GPU_SPECS.H100.fp16Tflops * factor,
    },
    basis: "performance-score-fallback",
  };
}

export function multiGpuSpeedup(gpuCount: number): number {
  return 1 + Math.max(0, gpuCount - 1) * MULTI_GPU_EFFICIENCY;
}
