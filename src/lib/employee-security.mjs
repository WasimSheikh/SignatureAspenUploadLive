import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt, jwtVerify } from "jose";
import { equalSecret, fail } from "./security.mjs";

export const SESSION_SECONDS = 8 * 60 * 60;
export const STATE_SECONDS = 10 * 60;
export const SESSION_COOKIE = "employee_session";
export const STATE_COOKIE = "employee_oidc";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function employeeConfig(env = process.env) {
  const required = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_ALLOWED_GROUP_IDS"];
  if (required.some((name) => !env[name]?.trim())) return null;
  const groups = (value) => (value || "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
  const allowedGroups = groups(env.ENTRA_ALLOWED_GROUP_IDS);
  const adminGroups = groups(env.ENTRA_ADMIN_GROUP_IDS);
  if (!uuid.test(env.ENTRA_TENANT_ID) || !uuid.test(env.ENTRA_CLIENT_ID) ||
      !allowedGroups.length || [...allowedGroups, ...adminGroups].some((id) => !uuid.test(id))) {
    throw new Error("Invalid employee authentication configuration");
  }
  const url = new URL(env.APP_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash ||
      (env.NODE_ENV === "production" && url.protocol !== "https:") ||
      !env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32 || !env.DATABASE_URL) {
    throw new Error("Invalid employee authentication configuration");
  }
  const tenant = env.ENTRA_TENANT_ID.toLowerCase();
  return {
    tenant, clientId: env.ENTRA_CLIENT_ID.toLowerCase(), clientSecret: env.ENTRA_CLIENT_SECRET?.trim() || "",
    allowedGroups, adminGroups, appUrl: url.origin, secret: env.COOKIE_SECRET,
    secure: env.NODE_ENV === "production" || url.protocol === "https:",
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    authority: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`,
    callbackUrl: `${url.origin}/api/auth/callback`,
  };
}

export function approvedGroups(groups, cfg) {
  if (!Array.isArray(groups) || groups.some((id) => typeof id !== "string" || !uuid.test(id))) {
    fail(403, "Direct employee group membership is required.");
  }
  const normalized = groups.map((id) => id.toLowerCase());
  if (!normalized.some((id) => cfg.allowedGroups.includes(id))) fail(403, "Employee access is not allowed.");
  return normalized;
}

// groups are now checked via Graph API /me/memberOf — not from the token claim
export function employeeClaims(payload, cfg, nonce, graphGroups = []) {
  if (payload.iss !== cfg.issuer || payload.tid !== cfg.tenant || payload.aud !== cfg.clientId ||
      typeof payload.oid !== "string" || !uuid.test(payload.oid) ||
      typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000 ||
      !equalSecret(payload.nonce, nonce) || !nonce) {
    fail(403, "Employee identity was not accepted.");
  }
  // Reject group-overage tokens — groups must come from Graph call instead
  if (payload._claim_names?.groups !== undefined) {
    fail(403, "Too many group memberships to process. Contact your administrator.");
  }
  const groups = approvedGroups(graphGroups, cfg);
  const email = typeof payload.email === "string" &&
    /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(payload.email) && payload.email.length <= 254
    ? payload.email.toLowerCase() : "";
  return {
    employee: { id: payload.oid.toLowerCase(),
      name: typeof payload.name === "string" ? payload.name.slice(0, 200) : "",
      email, admin: groups.some((id) => cfg.adminGroups.includes(id)) },
    groups,
  };
}

export async function verifyEmployeeToken(token, key, cfg, nonce, graphGroups = []) {
  const { payload } = await jwtVerify(token, key, {
    issuer: cfg.issuer, audience: cfg.clientId, algorithms: ["RS256"],
    requiredClaims: ["iss", "aud", "exp", "iat", "nonce", "tid", "oid", "sub"],
    maxTokenAge: "10m", clockTolerance: 5,
  });
  return employeeClaims(payload, cfg, nonce, graphGroups);
}

function stateKey(secret) {
  return createHash("sha256").update(`employee-oidc-state:${secret}`).digest();
}

export function sealState(state, cfg) {
  return new EncryptJWT(state).setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(cfg.appUrl).setAudience("employee-oidc").setIssuedAt()
    .setExpirationTime(`${STATE_SECONDS}s`).encrypt(stateKey(cfg.secret));
}

export async function openState(value, cfg) {
  if (typeof value !== "string" || value.length > 4096) fail(400, "Sign-in has expired. Try again.");
  try {
    const { payload } = await jwtDecrypt(value, stateKey(cfg.secret), {
      issuer: cfg.appUrl, audience: "employee-oidc",
      keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
      requiredClaims: ["exp", "iat"], maxTokenAge: `${STATE_SECONDS}s`,
    });
    if (![payload.state, payload.nonce, payload.verifier].every((part) =>
      typeof part === "string" && /^[A-Za-z0-9_-]{43}$/.test(part))) throw new Error("Invalid state");
    return payload;
  } catch {
    fail(400, "Sign-in has expired. Try again.");
  }
}

export function cookieValue(request, name) {
  const cookies = (request.headers.get("cookie") || "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return cookies.length === 1 ? cookies[0].slice(name.length + 1) : null;
}

export function employeeCookie(name, value, cfg, seconds) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${name === STATE_COOKIE ? "/api/auth" : "/"}; Max-Age=${seconds}${cfg.secure ? "; Secure" : ""}`;
}
