import assert from "node:assert/strict";
import test from "node:test";
import { fillMissingRequirements } from "../server/analysis/requirement-defaults.ts";
import { parseWorkloadAnalysis } from "../lib/validation/workload.schema.ts";

const missingAnalysis = (over: Record<string, unknown> = {}, sources: Record<string, string> = {}) =>
  parseWorkloadAnalysis({
    taskType: null,
    model: null,
    minimumVramGb: null,
    gpuCount: 1,
    maxHourlyBudgetUsd: null,
    optimization: "balanced",
    difficulty: "medium",
    cudaRequired: null,
    fieldSources: {
      taskType: "missing",
      model: "missing",
      minimumVramGb: "missing",
      gpuCount: "default",
      maxHourlyBudgetUsd: "missing",
      optimization: "default",
      difficulty: "estimated",
      cudaRequired: "missing",
      ...sources,
    },
    clarificationQuestions: ["Which model?"],
    ...over,
  });

test("fills every missing field and marks it estimated", () => {
  const out = fillMissingRequirements(missingAnalysis());
  assert.equal(out.taskType, "inference");
  assert.equal(out.model, "llama-3-8b");
  assert.equal(out.minimumVramGb, 24); // 8B fp16 x1.2 = 19.2 GB -> 24 GB tier
  assert.equal(out.maxHourlyBudgetUsd, 1);
  assert.equal(out.cudaRequired, true);
  for (const f of ["taskType", "model", "minimumVramGb", "maxHourlyBudgetUsd", "cudaRequired"] as const) {
    assert.equal(out.fieldSources[f], "estimated");
  }
  assert.doesNotThrow(() => parseWorkloadAnalysis(out)); // still a valid payload
  assert.equal(out.clarificationQuestions.length, 1);
  assert.match(out.clarificationQuestions[0], /estimated for a medium inference task/);
  const easy = fillMissingRequirements(missingAnalysis({ difficulty: "easy" }));
  assert.match(easy.clarificationQuestions[0], /estimated for an easy inference task/);
});

test("difficulty changes the filled model, VRAM and budget", () => {
  const easy = fillMissingRequirements(missingAnalysis({ difficulty: "easy" }));
  const hard = fillMissingRequirements(missingAnalysis({ difficulty: "hard" }));
  assert.equal(easy.model, "llama-3.2-3b");
  assert.equal(hard.model, "llama-3-70b");
  assert.ok(easy.minimumVramGb! < hard.minimumVramGb!);
  assert.ok(easy.maxHourlyBudgetUsd! < hard.maxHourlyBudgetUsd!);
});

test("task type changes the filled model and memory need", () => {
  const tuning = fillMissingRequirements(
    missingAnalysis({ taskType: "fine-tuning" }, { taskType: "user_provided" }),
  );
  assert.equal(tuning.model, "mistral-7b");
  assert.equal(tuning.fieldSources.taskType, "user_provided");
  assert.equal(tuning.minimumVramGb, 24); // LoRA: 14 GB x1.4 = 19.6 GB -> 24 GB tier
});

test("never overwrites what the user stated", () => {
  const out = fillMissingRequirements(
    missingAnalysis(
      { taskType: "training", model: "gpt-x", minimumVramGb: 48, maxHourlyBudgetUsd: 3, cudaRequired: false },
      {
        taskType: "user_provided",
        model: "user_provided",
        minimumVramGb: "user_provided",
        maxHourlyBudgetUsd: "user_provided",
        cudaRequired: "user_provided",
      },
    ),
  );
  assert.equal(out.taskType, "training");
  assert.equal(out.model, "gpt-x");
  assert.equal(out.minimumVramGb, 48);
  assert.equal(out.maxHourlyBudgetUsd, 3);
  assert.equal(out.cudaRequired, false);
  assert.equal(out.fieldSources.model, "user_provided");
  assert.deepEqual(out.clarificationQuestions, ["Which model?"]); // nothing filled, questions kept
});

test("derives VRAM from a user-named model and scales budget by GPU count", () => {
  const out = fillMissingRequirements(
    missingAnalysis(
      { taskType: "inference", model: "llama-3-70b", gpuCount: 2 },
      { taskType: "user_provided", model: "user_provided", gpuCount: "user_provided" },
    ),
  );
  assert.equal(out.fieldSources.model, "user_provided");
  assert.equal(out.minimumVramGb, 80); // 70B x2 bytes x1.2 = 168 GB / 2 GPUs = 84 GB, capped at the 80 GB tier
  assert.equal(out.maxHourlyBudgetUsd, 7);
});

test("falls back to a difficulty-based VRAM when the model size is unknown", () => {
  const out = fillMissingRequirements(
    missingAnalysis({ taskType: "rendering", difficulty: "hard" }, { taskType: "user_provided" }),
  );
  assert.equal(out.model, "blender-cycles");
  assert.equal(out.minimumVramGb, 40);
});
