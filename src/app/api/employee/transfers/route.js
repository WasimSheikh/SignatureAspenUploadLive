import { employeeTransfers } from "@/lib/employees";
import { connection } from "next/server";

export async function GET(request) {
  await connection();
  return employeeTransfers(request);
}
