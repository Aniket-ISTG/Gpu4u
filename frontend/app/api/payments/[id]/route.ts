import { connection } from "next/server";
import { handleGetPayment } from "@/server/api/payments";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return handleGetPayment(id);
}
