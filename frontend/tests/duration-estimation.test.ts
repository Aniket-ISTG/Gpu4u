import assert from "node:assert/strict";
import test from "node:test";
import { mockGpuOffers } from "../data/mock-gpus.ts";
import { estimateDuration } from "../lib/estimation/duration-estimator.ts";
import { parseModelParamsB, resolveProfile } from "../lib/estimation/workload-profile.ts";

const offer = (model: string) => mockGpuOffers.find((o) => o.gpuModel === model)!;
const inference = (over = {}) => resolveProfile("inference", { modelParamsB: 8, ...over }).profile;

test("parses model size from names", () => {
  assert.equal(parseModelParamsB("llama-3-8b"), 8);
  assert.equal(parseModelParamsB("Mistral 7B"), 7);
  assert.equal(parseModelParamsB("DeepSeek R1 32B"), 32);
  assert.equal(parseModelParamsB("gpt-oss"), null);
  assert.equal(parseModelParamsB(null), null);
});

test("resolveProfile lists fields that came from defaults", () => {
  const { profile, defaulted } = resolveProfile("inference", { numPrompts: 50 });
  assert.equal(profile.numPrompts, 50);
  assert.ok(!defaulted.includes("numPrompts"));
  assert.ok(defaulted.includes("avgInputTokens"));
});

test("estimates are labelled as estimates and positive", () => {
  const est = estimateDuration(offer("H100"), 1, inference());
  assert.equal(est.kind, "estimate");
  assert.ok(est.hours > 0);
  assert.ok(est.assumptions[0].includes("not a benchmark"));
});

test("a faster GPU finishes the same inference job sooner", () => {
  const p = inference({ numPrompts: 5000 });
  const h100 = estimateDuration(offer("H100"), 1, p).hours;
  const l4 = estimateDuration(offer("L4"), 1, p).hours;
  assert.ok(h100 < l4);
});

test("more prompts, bigger models and longer outputs take longer", () => {
  const gpu = offer("RTX 4090");
  const base = estimateDuration(gpu, 1, inference()).hours;
  assert.ok(estimateDuration(gpu, 1, inference({ numPrompts: 4000 })).hours > base);
  assert.ok(estimateDuration(gpu, 1, inference({ modelParamsB: 13 })).hours > base);
  assert.ok(estimateDuration(gpu, 1, inference({ avgOutputTokens: 1024 })).hours > base);
});

test("larger batch size shortens a memory-bound decode", () => {
  const gpu = offer("A100 80GB");
  const small = estimateDuration(gpu, 1, inference({ batchSize: 1, numPrompts: 2000 })).hours;
  const large = estimateDuration(gpu, 1, inference({ batchSize: 16, numPrompts: 2000 })).hours;
  assert.ok(large < small);
});

test("two GPUs are faster than one but less than twice as fast", () => {
  const p = inference({ numPrompts: 20000 });
  const gpu = offer("RTX 3090");
  const one = estimateDuration(gpu, 1, p).hours;
  const two = estimateDuration(gpu, 2, p).hours;
  assert.ok(two < one);
  assert.ok(two > one / 2);
});

test("LoRA fine-tuning is cheaper than full fine-tuning and needs less VRAM", () => {
  const gpu = offer("A100 80GB");
  const lora = resolveProfile("fine-tuning", { modelParamsB: 7, lora: true }).profile;
  const full = resolveProfile("fine-tuning", { modelParamsB: 7, lora: false }).profile;
  const a = estimateDuration(gpu, 1, lora);
  const b = estimateDuration(gpu, 1, full);
  assert.ok(a.hours < b.hours);
  assert.ok(a.requiredVramGb < b.requiredVramGb);
});

test("flags a model that cannot fit in VRAM", () => {
  const est = estimateDuration(offer("RTX 4090"), 1, inference({ modelParamsB: 70 }));
  assert.equal(est.fitsInVram, false);
});

test("rendering scales from the H100 reference time", () => {
  const p = resolveProfile("rendering", { referenceHoursOnH100: 2 }).profile;
  const h100 = estimateDuration(offer("H100"), 1, p).hours;
  const l4 = estimateDuration(offer("L4"), 1, p).hours;
  assert.ok(l4 > h100);
});

test("an unknown GPU falls back to the performance score and says so", () => {
  const unknown = { ...offer("H100"), gpuModel: "Mystery GPU", performanceScore: 50 };
  const est = estimateDuration(unknown, 1, inference());
  assert.equal(est.specBasis, "performance-score-fallback");
  assert.ok(est.hours > estimateDuration(offer("H100"), 1, inference()).hours);
});
