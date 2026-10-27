import { createHash, createHmac, randomUUID } from "node:crypto";
import { config, isLocalMode } from "./config.js";
import { storage, container, blobSas } from "./azure.js";
import { expectedPartSize, validateParts, fail } from "./security.mjs";
import * as local from "./local-storage.js";

export { storage };
const PREFIX = "azure-v1:";
const missing = (error) => error?.statusCode === 404 || ["BlobNotFound", "ContainerNotFound"].includes(error?.code);
export const COMPANY_TZ = "America/Chicago";

// New transfers: transfers/YYYY/MM/DD/{transferId}/{fileId}. Old rows keep their saved object_key.
export function dateObjectKey(transferId, fileId, at = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
  return `transfers/${ymd.replaceAll("-", "/")}/${transferId}/${fileId}`;
}
export function requireAzure(file) {
  if (isLocalMode()) { local.requireLocal(file); return; }
  if (!file.upload_id?.startsWith(PREFIX) || !/^[0-9a-f-]{36}$/.test(file.upload_id.slice(PREFIX.length))) {
    fail(409, "Legacy storage transfer is incompatible. Drain or migrate existing transfers before switching to Azure.");
  }
}
export function stagingKey(file) {
  requireAzure(file);
  return `staging/${file.transfer_id}/${file.id}/${file.upload_id.slice(PREFIX.length)}`;
}
export function blockId(file, number) {
  requireAzure(file);
  return Buffer.from(`${file.upload_id.slice(PREFIX.length)}:${String(number).padStart(6, "0")}`).toString("base64");
}
function leaseId(file) {
  const hex = createHmac("sha256", config().cookieSecret).update("blob-lease-v1:").update(file.upload_id).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const blob = (file) => { requireAzure(file); return container().getBlockBlobClient(file.object_key); };
function expiry(transfer, seconds) {
  const end = Math.min(Date.now() + seconds * 1000, new Date(transfer.expires_at).getTime());
  if (end <= Date.now()) fail(410, "Transfer has expired.");
  return new Date(end);
}
export async function initiateFile(file) {
  if (isLocalMode()) return local.initiateFile(file);
  const uploadId = `${PREFIX}${randomUUID()}`;
  const staged = container().getBlockBlobClient(stagingKey({ ...file, upload_id: uploadId }));
  // A committed empty blob allows an exclusive lease before inspecting uncommitted blocks.
  await staged.upload("", 0, { conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/octet-stream" } });
  return uploadId;
}
function normalizeParts(file, result) {
  const blocks = new Map();
  // An interrupted completion may have already committed the staging block list.
  for (const part of [...(result.committedBlocks || []), ...(result.uncommittedBlocks || [])]) {
    const decoded = Buffer.from(part.name, "base64").toString();
    const prefix = `${file.upload_id.slice(PREFIX.length)}:`;
    if (!decoded.startsWith(prefix) || !/^\d{6}$/.test(decoded.slice(prefix.length))) fail(409, "Unexpected uploaded block.");
    const number = Number(decoded.slice(prefix.length));
    if (part.name !== blockId(file, number)) fail(409, "Invalid uploaded block identifier.");
    blocks.set(number, { PartNumber: number, ETag: part.name, Size: part.size });
  }
  if (blocks.size > 10000) fail(409, "Invalid uploaded part count.");
  return [...blocks.values()].sort((a, b) => a.PartNumber - b.PartNumber);
}
export async function listParts(file) {
  if (isLocalMode()) return local.listParts(file);
  return normalizeParts(file, await container().getBlockBlobClient(stagingKey(file)).getBlockList("all"));
}
export async function signPart(transfer, file, partNumber) {
  if (isLocalMode()) return local.signPart(transfer, file, partNumber);
  requireAzure(file);
  if (file.completed) fail(409, "File is not accepting upload parts.");
  expectedPartSize(Number(file.size), Number(file.part_size), partNumber);
  const url = new URL(await blobSas(stagingKey(file), "w", expiry(transfer, 900)));
  url.searchParams.set("comp", "block");
  url.searchParams.set("blockid", blockId(file, partNumber));
  return url.toString();
}
async function properties(client) {
  try { return await client.getProperties(); }
  catch (error) { if (missing(error)) return null; throw error; }
}
function valid(file, object) {
  return object && Number(object.contentLength) === Number(file.size) &&
    object.metadata?.file_id === file.id && object.metadata?.transfer_id === file.transfer_id &&
    object.metadata?.upload_id === file.upload_id;
}
export async function completeFile(file, onValidated) {
  if (isLocalMode()) return local.completeFile(file, onValidated);
  const final = blob(file);
  const existing = await properties(final);
  if (existing) {
    if (!valid(file, existing)) fail(409, "Stored file does not match the transfer.");
    return;
  }
  const staged = container().getBlockBlobClient(stagingKey(file));
  const lease = staged.getBlobLeaseClient(leaseId(file));
  try { await lease.acquireLease(60); }
  catch (error) { if (error.code !== "LeaseAlreadyPresent") throw error; }
  let validated = false;
  try {
    const initial = file.azure_snapshot
      ? await staged.withSnapshot(file.azure_snapshot).getBlockList("committed")
      : await staged.getBlockList("all", { conditions: { leaseId: lease.leaseId } });
    const alreadyCommitted = initial.committedBlocks?.length === Math.ceil(Number(file.size) / Number(file.part_size));
    const uploaded = normalizeParts(file, alreadyCommitted ? { committedBlocks: initial.committedBlocks } : initial);
    validateParts(file, uploaded);
    validated = true;
    const committed = alreadyCommitted ? initial : await staged.commitBlockList(uploaded.map((part) => part.ETag), {
      conditions: { leaseId: lease.leaseId }, blobHTTPHeaders: { blobContentType: "application/octet-stream" },
    });
    if (!committed.etag) throw new Error("Azure did not return a committed ETag");
    // A write SAS can break leases. Only an immutable, conditionally created
    // snapshot is a safe source: stageBlockFromURL has no source ETag condition.
    let snapshotTime = file.azure_snapshot;
    if (!snapshotTime) {
      const snapshot = await staged.createSnapshot({ conditions: { leaseId: lease.leaseId, ifMatch: committed.etag } });
      if (!snapshot.snapshot) throw new Error("Azure did not return a snapshot identifier");
      snapshotTime = snapshot.snapshot;
    }
    const snapshot = staged.withSnapshot(snapshotTime);
    const committedList = await snapshot.getBlockList("committed");
    const lockedParts = normalizeParts(file, committedList);
    validateParts(file, lockedParts);
    const source = await snapshot.getProperties();
    if (Number(source.contentLength) !== Number(file.size) || !source.etag) fail(409, "Stored staging file failed size verification.");
    if (committedList.etag !== source.etag) fail(409, "Staging snapshot failed version verification.");
    await onValidated(lockedParts.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag })), snapshotTime);
    file.azure_snapshot = snapshotTime;
    const sourceUrl = await blobSas(stagingKey(file), "r", new Date(Date.now() + 5 * 60 * 1000), { snapshotTime });
    const version = createHash("sha256").update(`${snapshotTime}:${source.etag}`).digest("hex").slice(0, 24);
    const destinationId = (part) => Buffer.from(`${version}:${String(part.PartNumber).padStart(6, "0")}`).toString("base64");
    let previous;
    try { previous = await final.getBlockList("all"); }
    catch (error) { if (!missing(error)) throw error; }
    const ready = new Map((previous?.uncommittedBlocks || []).map((part) => [part.name, part.size]));
    const pending = uploaded.filter((part) => ready.get(destinationId(part)) !== part.Size);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let next = 0;
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(8, pending.length) }, async () => {
        while (next < pending.length && !controller.signal.aborted) {
          const part = pending[next++];
          try {
            await final.stageBlockFromURL(destinationId(part), sourceUrl,
              (part.PartNumber - 1) * Number(file.part_size), Number(part.Size), {
                abortSignal: controller.signal,
              });
          } catch (error) { controller.abort(); throw error; }
        }
      }));
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      if (rejected) throw rejected.reason;
      if (controller.signal.aborted) fail(409, "Finalizing file. Retry completion to continue.");
    } catch (error) {
      controller.abort();
      if (error.name === "AbortError") fail(409, "Finalizing file. Retry completion to continue.");
      throw error;
    } finally { clearTimeout(timer); }
    await final.commitBlockList(uploaded.map(destinationId), {
      conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      metadata: { file_id: file.id, transfer_id: file.transfer_id, upload_id: file.upload_id },
    });
    if (!valid(file, await properties(final))) fail(409, "Stored file failed size verification.");
  } finally {
    // The finite lease expires after crashes so lifecycle deletion remains possible.
    if (!validated) await lease.releaseLease();
  }
}
async function deleteBlob(client, conditions) {
  try {
    const current = await properties(client);
    if (current?.copyStatus === "pending" && current.copyId) await client.abortCopyFromURL(current.copyId);
    // Uncommitted-only blobs can return 404 to both HEAD and DELETE. Put Blob
    // discards their blocks before deletion; the condition protects new commits.
    if (!current) await client.upload("", 0, { conditions: { ifNoneMatch: "*" } });
    await client.deleteIfExists({ conditions, deleteSnapshots: "include" });
  } catch (error) { if (!missing(error)) throw error; }
}
export async function removeFile(file) {
  if (!file.upload_id) return;
  if (isLocalMode()) return local.removeFile(file);
  await deleteBlob(blob(file));
  const staged = container().getBlockBlobClient(stagingKey(file));
  const current = await properties(staged);
  if (current?.leaseStatus === "locked") await staged.getBlobLeaseClient().breakLease(0);
  await deleteBlob(staged);
}
export async function signDownload(transfer, file) {
  requireAzure(file);
  const fallback = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return blobSas(file.object_key, "r", expiry(transfer, 300), {
    contentType: "application/octet-stream",
    contentDisposition: `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
  });
}
export async function objectStream(file, signal) {
  if (isLocalMode()) return local.objectStream(file, signal);
  const result = await blob(file).download(0, undefined, { abortSignal: signal });
  if (!result.readableStreamBody) throw new Error("Storage returned an empty response");
  return result.readableStreamBody;
}

// The browser's still-valid write SAS can recreate staging after cancellation.
// Enumerate only staging; final live objects must never be inferred from a prefix scan.
export async function cleanupStaging(lookup, limit = 500) {
  if (isLocalMode()) return local.cleanupStaging(lookup, limit);
  let cleaned = 0;
  const pages = container().listBlobsFlat({ prefix: "staging/", includeUncommitedBlobs: true })
    .byPage({ maxPageSize: 500 });
  // Bound deletions, not examined entries: live uploads at the start of the
  // prefix must not starve orphan collection on a freshly started worker.
  for await (const page of pages) {
    for (const item of page.segment.blobItems) {
      const match = /^staging\/([A-Za-z0-9_-]{32})\/([A-Za-z0-9_-]{32})\/([0-9a-f-]{36})$/.exec(item.name);
      if (!match) continue;
      const [, transferId, fileId, session] = match;
      const live = await lookup(transferId, fileId, `${PREFIX}${session}`);
      if (live) continue;
      // Avoid racing creation before upload_id is saved; allow outstanding SAS to expire.
      if (item.properties?.lastModified && Date.now() - new Date(item.properties.lastModified).getTime() < 20 * 60 * 1000) continue;
      const client = container().getBlockBlobClient(item.name);
      const current = await properties(client);
      if (current?.leaseStatus === "locked") await client.getBlobLeaseClient().breakLease(0);
      await deleteBlob(client);
      cleaned++;
      if (cleaned >= limit) return cleaned;
    }
  }
  return cleaned;
}
