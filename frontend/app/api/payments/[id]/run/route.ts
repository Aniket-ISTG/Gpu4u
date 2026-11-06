import { connection } from "next/server";
import { handleRunLease } from "@/server/api/payments";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return handleRunLease(id);
}
