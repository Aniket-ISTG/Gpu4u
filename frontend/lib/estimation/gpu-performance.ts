/**
 * ASSUMED performance model. These are approximate public peak spec-sheet figures plus
 * fixed efficiency factors. They are NOT measured benchmarks and every
 * duration derived from them is an estimate.
 */
export interface GpuSpec {
  /** Peak memory bandwidth, GB/s. */
  bandwidthGBs: number;
  /** Peak dense FP16/BF16 tensor throughput, TFLOPs. */
  fp16Tflops: number;
}

/**
 * Keyed by GPUOffer.gpuKey (provider short name, upper-case alphanumerics).
 * Approximate vendor peak figures: dense FP16/BF16 tensor throughput (consumer
 * cards at FP32 accumulate) and memory bandwidth. GPUs not listed use a flagged fallback.
 */
export const GPU_SPECS: Record<string, GpuSpec> = {
  RTX3060: { bandwidthGBs: 360, fp16Tflops: 25 },
  RTX3090: { bandwidthGBs: 936, fp16Tflops: 71 },
  RTX4090: { bandwidthGBs: 1008, fp16Tflops: 165 },
  RTX4070S: { bandwidthGBs: 504, fp16Tflops: 71 },
  RTX4070TIS: { bandwidthGBs: 672, fp16Tflops: 88 },
  RTX5060TI: { bandwidthGBs: 448, fp16Tflops: 95 },
  RTX5070TI: { bandwidthGBs: 896, fp16Tflops: 176 },
  RTX5080: { bandwidthGBs: 960, fp16Tflops: 225 },
  RTX5090: { bandwidthGBs: 1792, fp16Tflops: 210 },
  PRO6000: { bandwidthGBs: 1792, fp16Tflops: 500 },
  PRO6000WS: { bandwidthGBs: 1792, fp16Tflops: 500 },
  RTXPRO5000: { bandwidthGBs: 1344, fp16Tflops: 258 },
  V100: { bandwidthGBs: 900, fp16Tflops: 125 },
  A100: { bandwidthGBs: 1555, fp16Tflops: 312 }, // 80 GB variants: see A100_80GB_BANDWIDTH_GBS
  H100: { bandwidthGBs: 3350, fp16Tflops: 989 },
  H200: { bandwidthGBs: 4800, fp16Tflops: 989 },
  B200: { bandwidthGBs: 8000, fp16Tflops: 2250 },
  L4: { bandwidthGBs: 300, fp16Tflops: 121 },
  L40: { bandwidthGBs: 864, fp16Tflops: 181 },
  L40S: { bandwidthGBs: 864, fp16Tflops: 362 },
  A6000: { bandwidthGBs: 768, fp16Tflops: 155 },
  A4000: { bandwidthGBs: 448, fp16Tflops: 77 },
  "6000ADA": { bandwidthGBs: 960, fp16Tflops: 364 },
};

const A100_80GB_BANDWIDTH_GBS = 2039;
/** Unlisted GPUs are assumed to perform at this fraction of an H100. Low confidence, and flagged as such. */
export const UNKNOWN_GPU_H100_FRACTION = 0.1;

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

export type SpecBasis = "spec-table" | "unknown-gpu-fallback";

export function getGpuSpec(gpuKey: string, vramGb?: number): { spec: GpuSpec; basis: SpecBasis } {
  const known = GPU_SPECS[gpuKey];
  if (known) {
    const spec =
      gpuKey === "A100" && (vramGb ?? 0) >= 80 ? { ...known, bandwidthGBs: A100_80GB_BANDWIDTH_GBS } : known;
    return { spec, basis: "spec-table" };
  }

  return {
    spec: {
      bandwidthGBs: GPU_SPECS.H100.bandwidthGBs * UNKNOWN_GPU_H100_FRACTION,
      fp16Tflops: GPU_SPECS.H100.fp16Tflops * UNKNOWN_GPU_H100_FRACTION,
    },
    basis: "unknown-gpu-fallback",
  };
}

export function multiGpuSpeedup(gpuCount: number): number {
  return 1 + Math.max(0, gpuCount - 1) * MULTI_GPU_EFFICIENCY;
}
