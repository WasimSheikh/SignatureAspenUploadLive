import { config } from "./config.js";
import { HttpError, fail, hashToken, equalSecret, verifyUnlock } from "./security.mjs";

export function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", ...extraHeaders,
  } });
}

export function endpoint(handler) {
  return async (request, context) => {
    try {
      config();
      return await handler(request, context);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      // Never serialize SDK/database errors, credentials, object keys, or configuration.
      console.error("Transfer request failed.", { type: error?.name || "Error" });
      return json({ error: "The transfer service is temporarily unavailable. Please try again." }, 503);
    }
  };
}

export function requireOrigin(request) {
  if (request.headers.get("origin") !== config().appUrl) fail(403, "Request origin is not allowed.");
}

export async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    fail(415, "Use application/json.");
  }
  if (!request.body) fail(400, "A JSON request body is required.");
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) {
        await reader.cancel();
        fail(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid JSON object.");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "Invalid JSON.");
  }
}

export function requireUploadToken(request, transfer) {
  const authorization = (request.headers.get("authorization") || "").split(" ");
  const token = authorization.length === 2 && authorization[0] === "Bearer" &&
    /^[A-Za-z0-9_-]{32}$/.test(authorization[1]) ? authorization[1] : null;
  if (!token || !equalSecret(hashToken(token), transfer.upload_token_hash)) fail(401, "Upload authorization is required.");
  requireLive(transfer);
}

export function requireLive(transfer) {
  if (new Date(transfer.expires_at).getTime() <= Date.now() || ["expired", "deleted", "deleting"].includes(transfer.status)) {
    fail(410, "This transfer has expired or was removed.");
  }
}

export function isUnlocked(request, transfer) {
  if (!transfer.passcode_hash) return true;
  const prefix = `transfer_unlock_${transfer.id}=`;
  const value = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  return verifyUnlock(value, transfer.id, config().cookieSecret);
}

export function requirePublic(request, transfer) {
  requireLive(transfer);
  if (transfer.status !== "complete") fail(404, "Transfer not found.");
  if (!isUnlocked(request, transfer)) fail(403, "A passcode is required.");
}

export function publicMetadata(transfer, files) {
  return {
    id: transfer.id, title: transfer.title, company: transfer.company, message: transfer.message,
    senderEmail: transfer.sender_email,
    files: files.map((file) => ({ id: file.id, name: file.name, size: Number(file.size) })),
    expiresAt: new Date(transfer.expires_at).toISOString(), requiresPasscode: !!transfer.passcode_hash,
  };
}
