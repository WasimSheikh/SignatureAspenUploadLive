import { employeeDownload } from "@/lib/employees";
import { connection } from "next/server";

export const maxDuration = 300;
export async function GET(request, context) {
  await connection();
  return employeeDownload(request, context);
}
