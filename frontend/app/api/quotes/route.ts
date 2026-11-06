import { connection } from "next/server";
import { handleCreateQuote } from "@/server/api/payments";

export const maxDuration = 60;

export async function POST(request: Request) {
  await connection();
  return handleCreateQuote(request);
}
