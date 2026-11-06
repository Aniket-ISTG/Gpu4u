import { analyzeWorkload, WorkloadAnalyzerError } from "../ai/groq";
import { parseAnalyzeRequest } from "./analyze-request";

/** POST /api/workloads/analyze: natural-language request in, validated workload analysis out. */
export async function handlePostAnalyze(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = parseAnalyzeRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const analysis = await analyzeWorkload(parsed.request, parsed.difficulty);
    return Response.json({ analysis });
  } catch (error) {
    if (error instanceof WorkloadAnalyzerError) {
      return Response.json({ error: error.message }, { status: error.statusCode });
    }
    return Response.json({ error: "Workload analysis failed unexpectedly." }, { status: 500 });
  }
}
