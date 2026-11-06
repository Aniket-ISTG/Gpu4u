import { connection } from "next/server";
import { handleGetMarketplace } from "@/server/api/marketplace";

export const maxDuration = 60;

export async function GET() {
  // Wait for a real request: this must never call Aquanode while the app is being built.
  await connection();
  return handleGetMarketplace();
}
