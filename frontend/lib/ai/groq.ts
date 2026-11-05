import "server-only";

import { z } from "zod";
import {
  parseWorkloadAnalysis,
  WorkloadAnalysisSchema,
} from "@/lib/validation/workload.schema";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 30_000;
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";

const GroqResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
});

export class WorkloadAnalyzerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "WorkloadAnalyzerError";
  }
}

const systemPrompt = `Extract compute requirements from the user's request. Return only the required JSON object.

Rules:
- Never invent a requirement. Use null and mark its source as "missing" when the user has not stated it and it cannot be responsibly estimated.
- Mark values explicitly stated by the user as "user_provided".
- Mark only defensible inferences as "estimated"; an inferred model VRAM requirement must be labeled this way.
- When GPU count is omitted, use 1 and mark it "default". When optimization preference is omitted, use "balanced" and mark it "default".
- For every other omitted requirement, use null and source "missing".
- Ask concise clarification questions for missing task type, model, minimum VRAM, or budget when relevant. Do not treat defaults as user-provided requirements.
- Normalize model names to a concise identifier when clear, such as "llama-3-8b". Preserve uncertainty by asking a question instead of guessing.
- Map "cheapest" to cost and "fastest" to performance. Use taskType values inference, training, fine-tuning, rendering, or other.
- Set cudaRequired true only when stated or clearly required by the specified framework/model; use null when unknown.
- Include a source for every field. The allowed source values are user_provided, estimated, default, and missing.`;

export async function analyzeWorkload(
  request: string,
): Promise<ReturnType<typeof parseWorkloadAnalysis>> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new WorkloadAnalyzerError(
      "Workload analysis is not configured. Set GROQ_API_KEY in .env.local.",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: request },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "workload_analysis",
            schema: z.toJSONSchema(WorkloadAnalysisSchema),
            strict: true,
          },
        },
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WorkloadAnalyzerError(
        "Workload analysis timed out. Please try again.",
        504,
      );
    }
    throw new WorkloadAnalyzerError(
      "Could not reach the Groq workload analysis service.",
      502,
    );
  }

  if (!response.ok) {
    const message =
      response.status === 401
        ? "Groq rejected GROQ_API_KEY. Verify the server-side key."
        : response.status === 429
          ? "Groq rate limit reached. Please try again shortly."
          : response.status === 400
            ? "Groq rejected the request. Check that GROQ_MODEL supports structured outputs."
            : "Groq returned an error while analyzing the workload.";

    throw new WorkloadAnalyzerError(message, response.status === 429 ? 429 : 502);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new WorkloadAnalyzerError(
      "Groq returned malformed data.",
      502,
    );
  }

  const parsedResponse = GroqResponseSchema.safeParse(responseBody);
  const content = parsedResponse.success
    ? parsedResponse.data.choices[0].message.content
    : null;

  if (!content) {
    throw new WorkloadAnalyzerError(
      "Groq returned no structured workload result.",
      502,
    );
  }

  try {
    return parseWorkloadAnalysis(JSON.parse(content));
  } catch {
    throw new WorkloadAnalyzerError(
      "Groq's workload response did not match the required schema.",
      502,
    );
  }
}