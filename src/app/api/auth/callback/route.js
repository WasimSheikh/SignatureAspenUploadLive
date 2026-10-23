import { authCallback } from "@/lib/employee-auth";
import { connection } from "next/server";

export async function GET(request) {
  await connection();
  return authCallback(request);
}
