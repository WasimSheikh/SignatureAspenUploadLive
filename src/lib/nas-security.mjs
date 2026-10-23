import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const nasId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value);

export function nasConfig(env = process.env, { filesystem = false } = {}) {
  if (env.NAS_ENABLED !== "true") return { enabled: false };
  if (!env.NAS_SIGNING_SECRET || env.NAS_SIGNING_SECRET.length < 32 ||
      [env.COOKIE_SECRET, env.CRON_SECRET, env.EMPLOYEE_COOKIE_SECRET].includes(env.NAS_SIGNING_SECRET)) {
    throw new Error("NAS_SIGNING_SECRET must be an independent secret of at least 32 characters");
  }
  const url = new URL(env.NAS_LOCAL_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && env.NODE_ENV !== "production"))) {
    throw new Error("NAS_LOCAL_URL must be an HTTPS origin (HTTP loopback allowed in development)");
  }
  const port = Number(env.NAS_PORT || 8787);
  const interval = Number(env.NAS_SYNC_INTERVAL_MS || 30000);
  const host = env.NAS_BIND_HOST || "127.0.0.1";
  if (host !== "localhost" && !isIP(host)) throw new Error("NAS_BIND_HOST must be an explicit IP address");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !Number.isSafeInteger(interval) || interval < 1000) throw new Error("Invalid NAS port or interval");
  if (filesystem && (!env.NAS_ROOT || !env.NAS_ROOT.startsWith("/"))) throw new Error("NAS_ROOT must be an existing absolute directory");
  return { enabled: true, secret: env.NAS_SIGNING_SECRET, origin: url.origin, root: env.NAS_ROOT, host, port, interval };
}

export function signNasToken({ transferId, fileId, employeeId, sessionHash }, secret, expiresAt, now = Date.now()) {
  if (!nasId(transferId) || !nasId(fileId) || typeof employeeId !== "string" || !employeeId || employeeId.length > 200 ||
      !/^[a-f0-9]{64}$/.test(sessionHash || "")) {
    throw new Error("Invalid NAS token scope");
  }
  const iat = Math.floor(now / 1000);
  const exp = Math.min(iat + 60, Math.floor(new Date(expiresAt).getTime() / 1000));
  if (!Number.isFinite(exp) || exp <= iat) throw new Error("Transfer expired");
  const payload = Buffer.from(JSON.stringify({ v: 1, aud: "nas-download", transferId, fileId, employeeId, sessionHash, iat, exp })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyNasToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid local download token");
  const [payload, signature] = token.split(".");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid local download token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const seconds = Math.floor(now / 1000);
  if (claims.v !== 1 || claims.aud !== "nas-download" || !nasId(claims.transferId) || !nasId(claims.fileId) ||
      typeof claims.employeeId !== "string" || !claims.employeeId || claims.employeeId.length > 200 ||
      !/^[a-f0-9]{64}$/.test(claims.sessionHash || "") ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat > seconds || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 60) {
    throw new Error("Invalid or expired local download token");
  }
  return claims;
}

export function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid byte range");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error("Invalid byte range");
  return { start, end, partial: true };
}
