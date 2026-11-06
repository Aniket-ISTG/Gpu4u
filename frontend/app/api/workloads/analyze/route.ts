import { handlePostAnalyze } from "@/server/api/analyze";

export async function POST(request: Request) {
  return handlePostAnalyze(request);
}
