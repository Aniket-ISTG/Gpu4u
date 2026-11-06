import { connection } from "next/server";
import { handleGetConfig } from "@/server/api/payments";

export async function GET() {
  await connection();
  return handleGetConfig();
}
