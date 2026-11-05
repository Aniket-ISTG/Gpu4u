import { z } from "zod";
import {
  analyzeWorkload,
  WorkloadAnalyzerError,
} from "@/lib/ai/groq";

const RequestSchema = z
  .object({
    request: z.string().trim().min(10).max(4000),
  })
  .strict();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsedRequest = RequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return Response.json(
      { error: "Provide a compute request between 10 and 4000 characters." },
      { status: 400 },
    );
  }

  try {
    const analysis = await analyzeWorkload(parsedRequest.data.request);
    return Response.json({ analysis });
  } catch (error) {
    if (error instanceof WorkloadAnalyzerError) {
      return Response.json({ error: error.message }, { status: error.statusCode });
    }

    return Response.json(
      { error: "Workload analysis failed unexpectedly." },
      { status: 500 },
    );
  }
}