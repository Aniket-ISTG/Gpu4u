import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkloadAnalysis,
  withDifficultySelection,
  WorkloadAnalysisSchema,
} from "../lib/validation/workload.schema.ts";

const validAnalysis = {
  taskType: "inference",
  model: "llama-3-8b",
  minimumVramGb: 16,
  gpuCount: 1,
  maxHourlyBudgetUsd: 2,
  optimization: "cost",
  difficulty: "medium",
  cudaRequired: true,
  fieldSources: {
    taskType: "user_provided",
    model: "user_provided",
    minimumVramGb: "user_provided",
    gpuCount: "default",
    maxHourlyBudgetUsd: "user_provided",
    optimization: "user_provided",
    difficulty: "estimated",
    cudaRequired: "estimated",
  },
  clarificationQuestions: [],
};

test("accepts a valid analysis with explicit provenance", () => {
  assert.deepEqual(parseWorkloadAnalysis(validAnalysis), validAnalysis);
});

test("exports a strict JSON Schema for structured output", () => {
  const jsonSchema = WorkloadAnalysisSchema.toJSONSchema();

  assert.equal(jsonSchema.type, "object");
  assert.equal(jsonSchema.additionalProperties, false);
});

test("rejects a missing requirement that contains a value", () => {
  const invalidAnalysis = {
    ...validAnalysis,
    model: "llama-3-8b",
    fieldSources: { ...validAnalysis.fieldSources, model: "missing" },
  };

  assert.throws(() => parseWorkloadAnalysis(invalidAnalysis), /provenance/);
});

test("rejects unsupported defaults and invalid numeric requirements", () => {
  assert.throws(
    () =>
      parseWorkloadAnalysis({
        ...validAnalysis,
        gpuCount: 2,
        fieldSources: { ...validAnalysis.fieldSources, gpuCount: "default" },
      }),
    /default GPU count/,
  );

  assert.throws(
    () => parseWorkloadAnalysis({ ...validAnalysis, minimumVramGb: 0 }),
  );
});


test("difficulty is easy, medium or hard and never missing", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    assert.equal(parseWorkloadAnalysis({ ...validAnalysis, difficulty }).difficulty, difficulty);
  }
  assert.throws(() => parseWorkloadAnalysis({ ...validAnalysis, difficulty: "extreme" }));
  assert.throws(() => parseWorkloadAnalysis({ ...validAnalysis, difficulty: null }));
  assert.throws(() =>
    parseWorkloadAnalysis({
      ...validAnalysis,
      fieldSources: { ...validAnalysis.fieldSources, difficulty: "missing" },
    }),
  );
});

test("a user-selected difficulty overrides detection and is marked user_provided", () => {
  const detected = parseWorkloadAnalysis({ ...validAnalysis, difficulty: "easy" });
  const chosen = withDifficultySelection(detected, "hard");
  assert.equal(chosen.difficulty, "hard");
  assert.equal(chosen.fieldSources.difficulty, "user_provided");
  assert.equal(detected.difficulty, "easy");
  assert.doesNotThrow(() => parseWorkloadAnalysis(chosen));
});

test("without a selection the auto-detected difficulty is kept as estimated", () => {
  const detected = parseWorkloadAnalysis({ ...validAnalysis, difficulty: "easy" });
  for (const none of [undefined, null]) {
    const result = withDifficultySelection(detected, none);
    assert.equal(result.difficulty, "easy");
    assert.equal(result.fieldSources.difficulty, "estimated");
  }
});
