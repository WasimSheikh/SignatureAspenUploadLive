import { db, getTransfer, getFiles, withTransferLock, recordAccess } from "./db.js";
import { config } from "./config.js";
import { endpoint, json, readJson, requireOrigin, requireUploadToken, requireLive, isUnlocked,
  requirePublic, publicMetadata } from "./http.js";
import { randomId, hashToken, validateTransfer, makePasscodeHash, verifyPasscode,
  signUnlock, fail, HttpError } from "./security.mjs";
import { resolveContactEmail } from "./contacts.mjs";
import { checkRateLimit, clientIp } from "./rate-limit.mjs";

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return;
  if (!token) fail(403, "Please complete the CAPTCHA and try again.");
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const { success } = await res.json();
    if (!success) fail(403, "CAPTCHA verification failed. Please try again.");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("Turnstile verification error:", err?.message);
  }
}
import { initiateFile, signPart, listParts, completeFile, removeFile, requireAzure, dateObjectKey } from "./storage.js";
import { sendTransferEmails, publicUrl } from "./email.js";
import { recordEmployeeUpload } from "./employees.js";
import { readEmployeeSession } from "./employee-auth.js";

async function transferId(context) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) fail(404, "Transfer not found.");
  return id;
}

function uploadFile(file) {
  return { id: file.id, name: file.name, size: Number(file.size), partSize: Number(file.part_size) };
}

export const createTransfer = endpoint(async (request) => {
  requireOrigin(request);
  const ip = clientIp(request);
  if (!checkRateLimit(`transfer:${ip}`, 10, 10 * 60 * 1000)) {
    fail(429, "Too many requests. Please try again later.");
  }
  const body = await readJson(request);
  await verifyTurnstile(body?.turnstileToken, ip);
  const input = validateTransfer(body, config());
  if (input.purpose === "proof") {
    const employee = await readEmployeeSession(request);
    if (!employee) fail(401, "Employee sign-in is required to send a design proof.");
    if (employee.email) input.senderEmail = employee.email;
  } else {
    input.recipientEmails = [resolveContactEmail(input.contactId)];
    input.message = input.message.replace(/(^|\n)Purpose:[^\n]*/gi, "").replace(/^\n+/, "").trim();
  }
  const id = randomId();
  const uploadToken = randomId();
  const passcodeHash = await makePasscodeHash(input.passcode);
  return withTransferLock(id, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO transfers
        (id, upload_token_hash, sender_email, recipient_emails, company, title, message,
         passcode_hash, retention_days, part_size, purpose, expires_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::integer,$10,$11,now() + ($9::integer * interval '1 day'))`,
      [id, hashToken(uploadToken), input.senderEmail, JSON.stringify(input.recipientEmails),
        input.company, input.title, input.message, passcodeHash, input.retentionDays, input.partSize,
        input.purpose]);
      for (const [ordinal, file] of input.files.entries()) {
        const fileId = randomId();
        await client.query(`INSERT INTO transfer_files
          (id,transfer_id,ordinal,name,size,content_type,object_key,part_size)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fileId, id, ordinal, file.name, file.size, file.type, dateObjectKey(id, fileId), input.partSize]);
      }
      await recordEmployeeUpload(request, id, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const files = await getFiles(client, id);
    try {
      // Initiate all Azure staging blobs in parallel; save IDs to DB sequentially.
      const results = await Promise.allSettled(files.map((file) => initiateFile(file)));
      for (const [i, result] of results.entries()) {
        if (result.status === "fulfilled") files[i].upload_id = result.value;
      }
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      for (const file of files) {
        await client.query("UPDATE transfer_files SET upload_id = $2 WHERE id = $1", [file.id, file.upload_id]);
      }
    } catch (error) {
      // Persist deletion intent before cleanup so cron can finish interrupted work.
      await client.query("UPDATE transfers SET status = 'deleting' WHERE id = $1", [id]);
      for (const file of files) {
        try { await removeFile(file); } catch { /* Cleanup cron retries failed storage operations. */ }
      }
      throw error;
    }
    return json({ id, uploadToken, partSize: input.partSize, files: files.map(uploadFile) }, 201);
  });
});

export const createPart = endpoint(async (request, context) => {
  requireOrigin(request);
  const id = await transferId(context);
  const body = await readJson(request);
  // Signing is read-only; lifecycle locks would serialize parallel chunk requests.
  const transfer = await getTransfer(db(), id);
  requireUploadToken(request, transfer);
  if (!["uploading", "completing"].includes(transfer.status)) fail(409, "Transfer is already complete.");
  const files = await getFiles(db(), id);
  const file = files.find((candidate) => candidate.id === body.fileId);
  if (!file) fail(404, "File not found.");
  return json({ url: await signPart(transfer, file, body.partNumber) });
});

export const uploadStatus = endpoint(async (request, context) => {
  const id = await transferId(context);
  return withTransferLock(id, async (client) => {
    const transfer = await getTransfer(client, id);
    requireUploadToken(request, transfer);
    const files = await getFiles(client, id);
    const result = [];
    for (const file of files) {
      requireAzure(file);
      let parts = file.completed_parts;
      if (!file.completed) {
        try {
          parts = (await listParts(file)).map((part) => ({ partNumber: part.PartNumber, etag: part.ETag }));
        } catch (error) {
          // Finalization can succeed just before a process interruption.
          // Stored validated parts let the client resume by retrying completion.
          if (error?.statusCode !== 404 || !file.completed_parts?.length) throw error;
        }
      }
      result.push({ ...uploadFile(file), parts, completed: file.completed });
    }
    return json({ id, partSize: Number(transfer.part_size), status: transfer.status, files: result });
  });
});

export const completeTransfer = endpoint(async (request, context) => {
  requireOrigin(request);
  const id = await transferId(context);
  return withTransferLock(id, async (client) => {
    let transfer = await getTransfer(client, id);
    requireUploadToken(request, transfer);
    if (transfer.status !== "complete") {
      await client.query("UPDATE transfers SET status = 'completing' WHERE id = $1", [id]);
      const files = await getFiles(client, id);
      if (!files.length) fail(409, "Transfer has no files.");
      for (const file of files) {
        requireLive(transfer);
        await completeFile(file, async (parts, snapshot) => {
          await client.query("UPDATE transfer_files SET completed_parts = $2::jsonb, azure_snapshot = $3 WHERE id = $1",
            [file.id, JSON.stringify(parts), snapshot]);
        });
        await client.query("UPDATE transfer_files SET completed = true WHERE id = $1", [file.id]);
      }
      requireLive(transfer);
      await client.query("UPDATE transfers SET status = 'complete', completed_at = now() WHERE id = $1", [id]);
      transfer = await getTransfer(client, id);
    }
    const emailStatus = transfer.email_status === "sent" ? "sent" : await sendTransferEmails(client, transfer);
    return json({ url: publicUrl(id), emailStatus, requiresPasscode: !!transfer.passcode_hash });
  });
});

export const deleteTransfer = endpoint(async (request, context) => {
  requireOrigin(request);
  const id = await transferId(context);
  return withTransferLock(id, async (client) => {
    const transfer = await getTransfer(client, id);
    // Retry deletion even after its previous attempt was interrupted.
    requireUploadToken(request, { ...transfer, status: "uploading" });
    if (transfer.status === "deleted") return json({ deleted: true });
    await client.query("UPDATE transfers SET status = 'deleting' WHERE id = $1", [id]);
    for (const file of await getFiles(client, id)) await removeFile(file);
    await client.query("BEGIN");
    try {
      await client.query(`UPDATE transfers SET status = 'deleted', cleaned_at = now(),
        sender_email = '', recipient_emails = '[]', company = '', title = '', message = '',
        passcode_hash = NULL, email_results = '{}' WHERE id = $1`, [id]);
      await client.query("DELETE FROM transfer_access_events WHERE transfer_id = $1", [id]);
      await client.query("DELETE FROM transfer_files WHERE transfer_id = $1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return json({ deleted: true });
  });
});

export const readTransfer = endpoint(async (request, context) => {
  const id = await transferId(context);
  const transfer = await getTransfer(db(), id);
  requireLive(transfer);
  if (transfer.status !== "complete") fail(404, "Transfer not found.");
  if (!isUnlocked(request, transfer)) return json({ id, requiresPasscode: true });
  const files = await getFiles(db(), id);
  await recordAccess(db(), id, "view");
  return json(publicMetadata(transfer, files));
});

export const unlockTransfer = endpoint(async (request, context) => {
  requireOrigin(request);
  const id = await transferId(context);
  const { passcode } = await readJson(request);
  return withTransferLock(id, async (client) => {
    const transfer = await getTransfer(client, id);
    requireLive(transfer);
    if (transfer.status !== "complete") fail(404, "Transfer not found.");
    if (transfer.passcode_hash) {
      const windowActive = transfer.unlock_window_at && Date.now() - new Date(transfer.unlock_window_at).getTime() < 15 * 60 * 1000;
      if (windowActive && transfer.unlock_failures >= 5) fail(429, "Too many attempts. Try again in 15 minutes.");
      if (!await verifyPasscode(passcode, transfer.passcode_hash)) {
        await client.query(`UPDATE transfers SET unlock_failures = $2, unlock_window_at = $3 WHERE id = $1`,
        [id, windowActive ? transfer.unlock_failures + 1 : 1, windowActive ? transfer.unlock_window_at : new Date()]);
        await recordAccess(client, id, "unlock_failed");
        fail(403, "Incorrect passcode.");
      }
      await client.query("UPDATE transfers SET unlock_failures = 0, unlock_window_at = NULL WHERE id = $1", [id]);
    }
    await recordAccess(client, id, "unlock");
    const files = await getFiles(client, id);
    const maxAge = Math.min(3600, Math.floor((new Date(transfer.expires_at).getTime() - Date.now()) / 1000));
    const cookie = `transfer_unlock_${id}=${signUnlock(id, config().cookieSecret, Date.now() + maxAge * 1000)}; HttpOnly; SameSite=Strict; Path=/api/transfers/${id}; Max-Age=${maxAge}${config().appUrl.startsWith("https:") ? "; Secure" : ""}`;
    return json(publicMetadata(transfer, files), 200, { "Set-Cookie": cookie });
  });
});

export { transferId, requirePublic };
