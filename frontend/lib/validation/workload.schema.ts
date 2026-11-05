import { z } from "zod";

const FieldSourceSchema = z.enum([
  "user_provided",
  "estimated",
  "default",
  "missing",
]);

export const WorkloadAnalysisSchema = z
  .object({
    taskType: z
      .enum(["inference", "training", "fine-tuning", "rendering", "other"])
      .nullable(),
    model: z.string().min(1).nullable(),
    minimumVramGb: z.number().positive().nullable(),
    gpuCount: z.number().int().positive(),
    maxHourlyBudgetUsd: z.number().positive().nullable(),
    optimization: z.enum(["cost", "performance", "balanced"]),
    cudaRequired: z.boolean().nullable(),
    fieldSources: z
      .object({
        taskType: FieldSourceSchema,
        model: FieldSourceSchema,
        minimumVramGb: FieldSourceSchema,
        gpuCount: FieldSourceSchema,
        maxHourlyBudgetUsd: FieldSourceSchema,
        optimization: FieldSourceSchema,
        cudaRequired: FieldSourceSchema,
      })
      .strict(),
    clarificationQuestions: z.array(z.string()),
  })
  .strict();

export type WorkloadAnalysis = z.infer<typeof WorkloadAnalysisSchema>;

const nullableFields = [
  "taskType",
  "model",
  "minimumVramGb",
  "maxHourlyBudgetUsd",
  "cudaRequired",
] as const;

export function parseWorkloadAnalysis(input: unknown): WorkloadAnalysis {
  const analysis = WorkloadAnalysisSchema.parse(input);

  for (const field of nullableFields) {
    const source = analysis.fieldSources[field];
    const value = analysis[field];

    if ((source === "missing") !== (value === null)) {
      throw new Error(`Invalid provenance for ${field}`);
    }
  }

  for (const field of ["gpuCount", "optimization"] as const) {
    if (analysis.fieldSources[field] === "missing") {
      throw new Error(`Invalid provenance for ${field}`);
    }
  }

  if (
    analysis.fieldSources.gpuCount === "default" &&
    analysis.gpuCount !== 1
  ) {
    throw new Error("The default GPU count must be one");
  }

  if (
    analysis.fieldSources.optimization === "default" &&
    analysis.optimization !== "balanced"
  ) {
    throw new Error("The default optimization must be balanced");
  }

  return analysis;
}