import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, HeadObjectCommand, AbortMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";
import { expectedPartSize, validateParts, fail } from "./security.mjs";

let client;
export function storage() {
  if (!client) {
    const settings = config();
    client = new S3Client({ region: settings.region, endpoint: settings.endpoint,
      forcePathStyle: settings.forcePathStyle,
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
      } : undefined,
      // Compatible providers do not all implement AWS's new optional CRC defaults.
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

const objectParams = (file) => ({ Bucket: config().bucket, Key: file.object_key });
const missing = (error) => error?.$metadata?.httpStatusCode === 404 || ["NoSuchUpload", "NoSuchKey", "NotFound"].includes(error?.name);

export async function initiateFile(file) {
  const result = await storage().send(new CreateMultipartUploadCommand({
    ...objectParams(file), ContentType: "application/octet-stream",
    Metadata: { "transfer-id": file.transfer_id, "file-id": file.id },
  }));
  if (!result.UploadId) throw new Error("Storage did not return an upload ID");
  return result.UploadId;
}

export async function listParts(file) {
  if (!file.upload_id) fail(409, "File upload is not initialized.");
  const result = [];
  let marker;
  do {
    const page = await storage().send(new ListPartsCommand({
      ...objectParams(file), UploadId: file.upload_id, PartNumberMarker: marker,
    }));
    result.push(...(page.Parts || []));
    if (result.length > 10000) fail(409, "Invalid uploaded part count.");
    const next = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    if (page.IsTruncated && (!next || Number(next) <= Number(marker || 0))) throw new Error("Invalid storage pagination");
    marker = next;
  } while (marker);
  return result;
}

function lifetime(transfer, limit) {
  const seconds = Math.min(limit, Math.floor((new Date(transfer.expires_at).getTime() - Date.now()) / 1000));
  if (seconds < 1) fail(410, "Transfer has expired.");
  return seconds;
}

export async function signPart(transfer, file, partNumber) {
  if (!file.upload_id || file.completed) fail(409, "File is not accepting upload parts.");
  const size = expectedPartSize(Number(file.size), Number(file.part_size), partNumber);
  return getSignedUrl(storage(), new UploadPartCommand({
    ...objectParams(file), UploadId: file.upload_id, PartNumber: partNumber, ContentLength: size,
  }), { expiresIn: lifetime(transfer, 900) });
}

async function head(file) {
  try {
    return await storage().send(new HeadObjectCommand(objectParams(file)));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function validHead(file, object) {
  return object && Number(object.ContentLength) === Number(file.size) &&
    object.Metadata?.["file-id"] === file.id && object.Metadata?.["transfer-id"] === file.transfer_id;
}

export async function completeFile(file, onValidated) {
  // Recover a previous successful completion if its database write was interrupted.
  const existing = await head(file);
  if (existing) {
    if (!validHead(file, existing)) fail(409, "Stored file does not match the transfer.");
    return;
  }
  const uploaded = await listParts(file);
  const parts = validateParts(file, uploaded);
  await onValidated(uploaded.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag })));
  await storage().send(new CompleteMultipartUploadCommand({
    ...objectParams(file), UploadId: file.upload_id, MultipartUpload: { Parts: parts },
  }));
  if (!validHead(file, await head(file))) fail(409, "Stored file failed size verification.");
}

export async function removeFile(file) {
  // Aborting must also cover partially completed transfers.
  if (file.upload_id) {
    try {
      await storage().send(new AbortMultipartUploadCommand({ ...objectParams(file), UploadId: file.upload_id }));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  await storage().send(new DeleteObjectCommand(objectParams(file)));
}

export async function signDownload(transfer, file) {
  const fallback = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return getSignedUrl(storage(), new GetObjectCommand({
    ...objectParams(file), ResponseContentType: "application/octet-stream",
    ResponseContentDisposition: `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
  }), { expiresIn: lifetime(transfer, 300) });
}

export async function objectStream(file, signal) {
  const result = await storage().send(new GetObjectCommand(objectParams(file)), { abortSignal: signal });
  if (!result.Body) throw new Error("Storage returned an empty response");
  return result.Body;
}
