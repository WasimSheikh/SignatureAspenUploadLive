import { endpoint, json } from "@/lib/http";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { equalSecret, fail } from "@/lib/security.mjs";
import { sendDailySummary } from "@/lib/email";

export const GET = endpoint(async (request) => {
  const authorization = (request.headers.get("authorization") || "").split(" ");
  if (authorization.length !== 2 || authorization[0] !== "Bearer" ||
      !equalSecret(authorization[1], config().cronSecret)) fail(401, "Unauthorized.");
  const result = await sendDailySummary(db());
  return json({ result });
});
