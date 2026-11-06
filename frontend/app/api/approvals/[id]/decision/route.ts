import { connection } from "next/server";
import { handleDecision } from "@/server/api/payments";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return handleDecision(id, request);
}
