import { authLogin } from "@/lib/employee-auth";
import { connection } from "next/server";
import { checkRateLimit, clientIp } from "@/lib/rate-limit.mjs";
import { fail } from "@/lib/security.mjs";

export async function GET(request) {
  await connection();
  if (!checkRateLimit(`auth-login:${clientIp(request)}`, 20, 60 * 60 * 1000)) {
    fail(429, "Too many requests. Please try again later.");
  }
  return authLogin(request);
}
