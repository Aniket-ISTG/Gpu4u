import { z } from "zod";
import { DifficultySchema, type Difficulty } from "../../lib/validation/workload.schema.ts";

const AnalyzeRequestSchema = z
  .object({
    request: z.string().trim().min(10).max(4000),
    difficulty: DifficultySchema.optional(),
  })
  .strict();

export type ParsedAnalyzeRequest =
  | { ok: true; request: string; difficulty?: Difficulty }
  | { ok: false; error: string };

/** Validates the body of POST /api/workloads/analyze. Pure, so it can be tested without a network. */
export function parseAnalyzeRequest(body: unknown): ParsedAnalyzeRequest {
  const parsed = AnalyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "Provide a compute request between 10 and 4000 characters." };
  }
  return { ok: true, request: parsed.data.request, difficulty: parsed.data.difficulty };
}
