import { connection } from "next/server";
import { handleStartPayment } from "@/server/api/payments";

export async function POST(request: Request) {
  await connection();
  return handleStartPayment(request);
}
