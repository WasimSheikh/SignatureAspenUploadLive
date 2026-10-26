import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, rmdir, stat, rename, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { expectedPartSize, validateParts, fail } from "./security.mjs";

export const PREFIX = "local-v1:";

function root() {
  return process.env.LOCAL_STORAGE_PATH;
}

function stagingDir(file) {
  return path.join(root(), "staging", file.transfer_id, file.id, file.upload_id.slice(PREFIX.length));
}

function finalPath(file) {
  return path.join(root(), "transfers", file.transfer_id, file.id);
}

export function requireLocal(file) {
  if (!file.upload_id?.startsWith(PREFIX)) {
    fail(409, "Transfer uses Azure storage and cannot be served locally.");
  }
}

export async function initiateFile(file) {
  const uploadId = `${PREFIX}${randomUUID()}`;
  await mkdir(path.join(root(), "staging", file.transfer_id, file.id, uploadId.slice(PREFIX.length)), { recursive: true });
  return uploadId;
}

function blockKey(secret) {
  return createHmac("sha256", secret).update("local-block-v1").digest();
}

export function signBlockUrl(appUrl, transferId, fileId, uploadId, partNumber, expiresMs, secret) {
  const payload = `${transferId}:${fileId}:${uploadId}:${partNumber}:${expiresMs}`;
  const sig = createHmac("sha256", blockKey(secret)).update(payload).digest("base64url");
  const params = new URLSearchParams({ fileId, part: String(partNumber), uploadId, exp: String(expiresMs), sig });
  return `${appUrl}/api/transfers/${transferId}/block?${params}`;
}

export function verifyBlockUrl(transferId, searchParams, secret) {
  const fileId = searchParams.get("fileId");
  const part = searchParams.get("part");
  const uploadId = searchParams.get("uploadId");
  const exp = searchParams.get("exp");
  const sig = searchParams.get("sig");
  if (!fileId || !part || !uploadId || !exp || !sig) throw new Error("Missing block URL parameters");
  if (Number(exp) <= Date.now()) throw new Error("Block URL expired");
  const payload = `${transferId}:${fileId}:${uploadId}:${part}:${exp}`;
  const expected = createHmac("sha256", blockKey(secret)).update(payload).digest("base64url");
  const actual = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expected, "base64url");
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) throw new Error("Invalid block signature");
  return { fileId, partNumber: Number(part), uploadId };
}

export async function signPart(transfer, file, partNumber) {
  requireLocal(file);
  if (file.completed) fail(409, "File is not accepting upload parts.");
  expectedPartSize(Number(file.size), Number(file.part_size), partNumber);
  const exp = Math.min(Date.now() + 900_000, new Date(transfer.expires_at).getTime());
  if (exp <= Date.now()) fail(410, "Transfer has expired.");
  const s = config();
  return signBlockUrl(s.appUrl, file.transfer_id, file.id, file.upload_id.slice(PREFIX.length), partNumber, exp, s.cookieSecret);
}

export async function writeBlock(transferId, fileId, uploadId, partNumber, data) {
  const dir = path.join(root(), "staging", transferId, fileId, uploadId);
  await writeFile(path.join(dir, String(partNumber).padStart(6, "0")), data);
}

export async function listParts(file) {
  requireLocal(file);
  const dir = stagingDir(file);
  let entries;
  try { entries = await readdir(dir); }
  catch { return []; }
  const parts = [];
  for (const name of entries.filter((n) => /^\d{6}$/.test(n)).sort()) {
    const s = await stat(path.join(dir, name));
    parts.push({ PartNumber: Number(name), ETag: name, Size: s.size });
  }
  return parts;
}

export async function completeFile(file, onValidated) {
  requireLocal(file);
  const dest = finalPath(file);
  try {
    const s = await stat(dest);
    if (s.size === Number(file.size)) return;
  } catch { /* not done yet */ }

  const parts = await listParts(file);
  validateParts(file, parts);
  await onValidated(parts.map((p) => ({ partNumber: p.PartNumber, etag: p.ETag })), "local");

  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const ws = createWriteStream(tmp);
  for (const part of parts) {
    await pipeline(createReadStream(path.join(stagingDir(file), part.ETag)), ws, { end: false });
  }
  await new Promise((resolve, reject) => { ws.end(); ws.on("finish", resolve); ws.on("error", reject); });

  const s = await stat(tmp);
  if (s.size !== Number(file.size)) {
    await unlink(tmp).catch(() => {});
    fail(409, "Assembled file size mismatch.");
  }
  await rename(tmp, dest);
}

export async function removeFile(file) {
  if (!file.upload_id?.startsWith(PREFIX)) return;
  try { await unlink(finalPath(file)); } catch { /* not present */ }
  const dir = stagingDir(file);
  try {
    for (const name of await readdir(dir)) await unlink(path.join(dir, name)).catch(() => {});
    await rmdir(dir);
    await rmdir(path.dirname(dir)).catch(() => {});
    await rmdir(path.dirname(path.dirname(dir))).catch(() => {});
  } catch { /* ignore */ }
}

export async function objectStream(file, signal) {
  requireLocal(file);
  return createReadStream(finalPath(file), { signal });
}

export async function cleanupStaging(lookup, limit = 500) {
  let cleaned = 0;
  const stagingRoot = path.join(root(), "staging");
  const ls = async (p) => { try { return await readdir(p); } catch { return []; } };
  for (const transferId of await ls(stagingRoot)) {
    const transferDir = path.join(stagingRoot, transferId);
    for (const fileId of await ls(transferDir)) {
      for (const session of await ls(path.join(transferDir, fileId))) {
        if (await lookup(transferId, fileId, `${PREFIX}${session}`)) continue;
        const sessionDir = path.join(transferDir, fileId, session);
        for (const name of await ls(sessionDir)) await unlink(path.join(sessionDir, name)).catch(() => {});
        await rmdir(sessionDir).catch(() => {});
        if (++cleaned >= limit) return cleaned;
      }
      await rmdir(path.join(transferDir, fileId)).catch(() => {});
    }
    await rmdir(transferDir).catch(() => {});
  }
  return cleaned;
}
