import { connection } from "next/server";
import { handleResolveAccount } from "@/server/api/payments";

export async function GET(request: Request) {
  await connection();
  return handleResolveAccount(request);
}
