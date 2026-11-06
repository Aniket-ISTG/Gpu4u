import assert from "node:assert/strict";
import test from "node:test";
import { estimateDuration } from "../lib/estimation/duration-estimator.ts";
import { parseModelParamsB, resolveProfile } from "../lib/estimation/workload-profile.ts";
import { applyDifficulty, DIFFICULTY_SCALE } from "../lib/estimation/difficulty.ts";
import { pick } from "./fixtures/offers.ts";

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
  const est = estimateDuration(pick("H100"), 1, inference());
  assert.equal(est.kind, "estimate");
  assert.ok(est.hours > 0);
  assert.equal(est.specBasis, "spec-table");
  assert.ok(est.assumptions[0].includes("not a benchmark"));
});

test("a faster GPU finishes the same inference job sooner", () => {
  const p = inference({ numPrompts: 5000 });
  assert.ok(estimateDuration(pick("H100"), 1, p).hours < estimateDuration(pick("L4"), 1, p).hours);
  assert.ok(estimateDuration(pick("B200"), 1, p).hours < estimateDuration(pick("H100"), 1, p).hours);
});

test("more prompts, bigger models and longer outputs take longer", () => {
  const gpu = pick("RTX4090");
  const base = estimateDuration(gpu, 1, inference()).hours;
  assert.ok(estimateDuration(gpu, 1, inference({ numPrompts: 4000 })).hours > base);
  assert.ok(estimateDuration(gpu, 1, inference({ modelParamsB: 13 })).hours > base);
  assert.ok(estimateDuration(gpu, 1, inference({ avgOutputTokens: 1024 })).hours > base);
});

test("larger batch size shortens a memory-bound decode", () => {
  const gpu = pick("A100");
  const small = estimateDuration(gpu, 1, inference({ batchSize: 1, numPrompts: 2000 })).hours;
  const large = estimateDuration(gpu, 1, inference({ batchSize: 16, numPrompts: 2000 })).hours;
  assert.ok(large < small);
});

test("two GPUs are faster than one but less than twice as fast", () => {
  const p = inference({ numPrompts: 20000 });
  const gpu = pick("RTX3090");
  const one = estimateDuration(gpu, 1, p).hours;
  const two = estimateDuration(gpu, 2, p).hours;
  assert.ok(two < one);
  assert.ok(two > one / 2);
});

test("LoRA fine-tuning is cheaper than full fine-tuning and needs less VRAM", () => {
  const gpu = pick("A100");
  const lora = resolveProfile("fine-tuning", { modelParamsB: 7, lora: true }).profile;
  const full = resolveProfile("fine-tuning", { modelParamsB: 7, lora: false }).profile;
  const a = estimateDuration(gpu, 1, lora);
  const b = estimateDuration(gpu, 1, full);
  assert.ok(a.hours < b.hours);
  assert.ok(a.requiredVramGb < b.requiredVramGb);
});

test("flags a model that cannot fit in VRAM", () => {
  const est = estimateDuration(pick("RTX4090"), 1, inference({ modelParamsB: 70 }));
  assert.equal(est.fitsInVram, false);
});

test("rendering scales from the H100 reference time", () => {
  const p = resolveProfile("rendering", { referenceHoursOnH100: 2 }).profile;
  assert.ok(estimateDuration(pick("L4"), 1, p).hours > estimateDuration(pick("H100"), 1, p).hours);
});

test("an 80 GB A100 is faster at memory-bound decode than a 40 GB one", () => {
  const p = inference({ numPrompts: 4000, batchSize: 1 });
  const base = pick("A100");
  const big = { ...base, vramGb: 80 };
  const small = { ...base, vramGb: 40 };
  assert.ok(estimateDuration(big, 1, p).hours < estimateDuration(small, 1, p).hours);
});

test("a GPU missing from the spec table falls back and says so", () => {
  const unknown = { ...pick("H100"), gpuKey: "MYSTERYGPU" };
  const est = estimateDuration(unknown, 1, inference());
  assert.equal(est.specBasis, "unknown-gpu-fallback");
  assert.ok(est.hours > estimateDuration(pick("H100"), 1, inference()).hours);
  assert.ok(est.assumptions.some((a) => a.includes("Low confidence")));
});

test("difficulty scales untouched volume fields only", () => {
  const base = inference({ numPrompts: 1000 });
  const none = new Set<keyof typeof base>();
  assert.equal(applyDifficulty(base, none, null), base);
  assert.equal(applyDifficulty(base, none, "hard").numPrompts, 1000 * DIFFICULTY_SCALE.hard);
  assert.equal(applyDifficulty(base, none, "easy").numPrompts, 250);
  assert.equal(applyDifficulty(base, none, "medium").numPrompts, 1000);

  const touched = new Set<keyof typeof base>(["numPrompts"]);
  assert.equal(applyDifficulty(base, touched, "hard").numPrompts, 1000);
  assert.equal(applyDifficulty(base, none, "hard").modelParamsB, base.modelParamsB);
});

test("harder difficulty takes longer to estimate", () => {
  const gpu = pick("RTX4090");
  const none = new Set<keyof ReturnType<typeof inference>>();
  const hours = (d: "easy" | "medium" | "hard") =>
    estimateDuration(gpu, 1, applyDifficulty(inference(), none, d)).hours;
  assert.ok(hours("easy") < hours("medium"));
  assert.ok(hours("medium") < hours("hard"));
});
