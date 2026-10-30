import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// Derive a domain-specific key so COOKIE_SECRET is never used raw across multiple HMAC roles.
function domainKey(secret, label) {
  return createHash("sha256").update(label).update(":").update(secret).digest();
}
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const BASE_PART_SIZE = 16 * 1024 * 1024;
export const MAX_UPLOAD_PARTS = 10000;
const allowedExtensions = new Set(["psd", "ai", "pdf", "zip", "tif", "tiff"]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function fail(status, message) {
  throw new HttpError(status, message);
}

export function randomId() {
  return randomBytes(24).toString("base64url");
}

export function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function partSizeFor(size) {
  return Math.max(BASE_PART_SIZE, Math.ceil(size / MAX_UPLOAD_PARTS / (1024 * 1024)) * 1024 * 1024);
}

export function expectedPartSize(size, partSize, partNumber) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.ceil(size / partSize)) {
    fail(400, "Invalid part number.");
  }
  return Math.min(partSize, size - (partNumber - 1) * partSize);
}

export function safeArchiveName(name) {
  // Strip path separators, then remove chars invalid on Windows/macOS/Linux filesystems
  const stripped = name.normalize("NFC")
    .replaceAll("\\", "/").split("/").pop()   // path → last component
    .replace(/[:\u0000-\u001f\u007f*?"<>|]/g, "_")  // filesystem-invalid chars
    .replace(/\s+/g, " ")                    // collapse whitespace
    .trim()
    .replace(/^\.+|\.+$/g, "_");             // leading/trailing dots
  return !stripped || stripped === "_" ? "file" : stripped;
}

export function jobNumberFromTitle(title) {
  const text = String(title || "").trim();
  if (!text) return "";
  const hashed = text.match(/#\s*([A-Za-z]?\d[\w.-]{2,})/);
  if (hashed) return hashed[1];
  if (/^[A-Za-z]?-?\d[\w.-]{2,}$/.test(text)) return text.replace(/^#/, "");
  const leading = text.match(/^(\d{4,})\b/);
  return leading ? leading[1] : "";
}

function safeFilePart(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function archiveDownloadName(transfer) {
  const company = safeFilePart(transfer?.company);
  const job = safeFilePart(jobNumberFromTitle(transfer?.title) || transfer?.title);
  const parts = [...new Set([company, job].filter(Boolean))];
  const base = parts.join(" - ") || `transfer-${transfer?.id || "files"}`;
  return `${base}.zip`;
}

export function contentDisposition(filename) {
  const fallback = String(filename || "download").replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function text(value, name, max, fallback = "") {
  if (value == null) return fallback;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(400, `Invalid ${name}.`);
  }
  return value.trim();
}

function email(value) {
  const result = text(value, "email address", 254).toLowerCase();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(result)) fail(400, "Invalid email address.");
  return result;
}

export function validateTransfer(input, limits = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "Invalid request.");
  const maxBytes = limits.maxBytes ?? 20 * 1024 ** 3;
  const maxFiles = limits.maxFiles ?? 100;
  const maxRecipients = limits.maxRecipients ?? 20;
  const purpose = input.purpose === "proof" ? "proof" : "upload";
  const senderEmail = email(input.senderEmail);
  let recipientEmails, contactId;
  if (purpose === "proof") {
    if (typeof input.recipientEmails !== "string" || input.recipientEmails.length > maxRecipients * 256) {
      fail(400, "Provide comma-separated recipient email addresses.");
    }
    recipientEmails = [...new Set(input.recipientEmails.split(",").map(email))];
    if (!recipientEmails.length || recipientEmails.length > maxRecipients) fail(400, "Too many recipients.");
  } else {
    if (typeof input.contactId !== "string" || !/^[a-z][a-z0-9]{0,49}$/.test(input.contactId)) {
      fail(400, "Invalid contact.");
    }
    contactId = input.contactId;
    recipientEmails = [];
  }
  if (![7, 14, 30].includes(input.retentionDays)) fail(400, "Retention must be 7, 14, or 30 days.");
  const title = text(input.title, "title", 200);
  const company = text(input.company, "company", 200);
  if (!title || !company) fail(400, "Title and company are required.");
  const message = text(input.message, "message", 5000);
  const passcode = input.passcode ?? "";
  if (typeof passcode !== "string" || (passcode.length > 0 && (passcode.length < 8 || passcode.length > 128))) {
    fail(400, "Passcodes must contain 8–128 characters.");
  }
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > maxFiles) {
    fail(400, `Choose between 1 and ${maxFiles} files.`);
  }
  let total = 0;
  const names = new Set();
  const files = input.files.map((file) => {
    if (!file || typeof file !== "object") fail(400, "Invalid file.");
    const name = text(file.name, "file name", 255);
    if (!name || /[\\/:*?"<>|\r\n]/.test(name) || name === "." || name === ".." || name.startsWith(".") ||
        name.endsWith(".") || !allowedExtensions.has(name.split(".").pop().toLowerCase())) {
      fail(400, "Files must have safe PSD, AI, PDF, ZIP, TIF, or TIFF names (no * ? \" < > | characters).");
    }
    const key = name.normalize("NFC").toLowerCase();
    if (names.has(key)) fail(400, "Duplicate file names are not allowed.");
    names.add(key);
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxBytes) fail(400, "Invalid file size.");
    total += file.size;
    if (!Number.isSafeInteger(total) || total > maxBytes) fail(400, "Transfer exceeds the size limit.");
    const type = text(file.type, "file type", 150, "application/octet-stream");
    if (type && !/^[\w.+-]+\/[\w.+-]+$/.test(type)) fail(400, "Invalid file type.");
    return { name: name.normalize("NFC"), size: file.size, type: type || "application/octet-stream" };
  });
  return { senderEmail, recipientEmails, contactId, title, company, message, retentionDays: input.retentionDays,
    passcode, files, purpose, partSize: partSizeFor(Math.max(...files.map((file) => file.size))) };
}

export async function makePasscodeHash(passcode) {
  if (!passcode) return null;
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(passcode, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPasscode(passcode, stored) {
  if (typeof passcode !== "string" || passcode.length > 128 || typeof stored !== "string") return false;
  const [salt, expected] = stored.split(":");
  const key = await scrypt(passcode, salt, 64);
  return equalSecret(key.toString("hex"), expected);
}

export function signUnlock(id, secret, expiry = Date.now() + 60 * 60 * 1000) {
  const payload = `${id}.${expiry}`;
  return `${payload}.${createHmac("sha256", domainKey(secret, "transfer-unlock-v1")).update(payload).digest("base64url")}`;
}

export function verifyUnlock(value, id, secret, now = Date.now()) {
  if (typeof value !== "string" || value.length > 300) return false;
  const [cookieId, expiry, signature, extra] = value.split(".");
  if (extra || cookieId !== id || !/^\d+$/.test(expiry) || Number(expiry) <= now ||
      Number(expiry) > now + 60 * 60 * 1000 + 5000) return false;
  const expected = createHmac("sha256", domainKey(secret, "transfer-unlock-v1")).update(`${cookieId}.${expiry}`).digest("base64url");
  return equalSecret(signature, expected);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function validateParts(file, parts) {
  const count = Math.ceil(Number(file.size) / Number(file.part_size));
  if (parts.length !== count) fail(409, "Some file parts are missing. Resume the upload and try again.");
  return parts.map((part, index) => {
    if (part.PartNumber !== index + 1 || !part.ETag ||
        Number(part.Size) !== expectedPartSize(Number(file.size), Number(file.part_size), index + 1)) {
      fail(409, "Uploaded parts do not match the declared file size.");
    }
    return { PartNumber: part.PartNumber, ETag: part.ETag };
  });
}
