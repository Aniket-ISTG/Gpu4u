import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkloadAnalysis,
  WorkloadAnalysisSchema,
} from "../lib/validation/workload.schema.ts";

const validAnalysis = {
  taskType: "inference",
  model: "llama-3-8b",
  minimumVramGb: 16,
  gpuCount: 1,
  maxHourlyBudgetUsd: 2,
  optimization: "cost",
  cudaRequired: true,
  fieldSources: {
    taskType: "user_provided",
    model: "user_provided",
    minimumVramGb: "user_provided",
    gpuCount: "default",
    maxHourlyBudgetUsd: "user_provided",
    optimization: "user_provided",
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