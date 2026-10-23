import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet } from "jose";
import { HttpError, fail, hashToken, equalSecret } from "./security.mjs";
import {
  employeeConfig, approvedGroups, verifyEmployeeToken, sealState, openState, cookieValue,
  employeeCookie, SESSION_COOKIE, STATE_COOKIE, SESSION_SECONDS, STATE_SECONDS,
} from "./employee-security.mjs";

let pool;
let remoteKeys;
export function employeeDatabase() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("Employee database is not configured");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5,
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on("error", () => console.error("Employee database connection error."));
  }
  return pool;
}

export function authConfig() {
  const cfg = employeeConfig();
  if (!cfg) fail(503, "Employee sign-in is not enabled.");
  return cfg;
}

export function employeeJson(value, status = 200) {
  return Response.json(value, { status, headers: {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  } });
}

export function employeeEndpoint(handler) {
  return async (request, context) => {
    try { return await handler(request, context); } catch (error) {
      if (error instanceof HttpError) return employeeJson({ error: error.message }, error.status);
      console.error("Employee request failed.", { type: error?.name || "Error" });
      return employeeJson({ error: "The employee service is temporarily unavailable." }, 503);
    }
  };
}

export function employeeOrigin(request, cfg = authConfig()) {
  if (request.headers.get("origin") !== cfg.appUrl) fail(403, "Request origin is not allowed.");
}

export async function readEmployeeSession(request, client, cfg = employeeConfig()) {
  if (!cfg) return null;
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await (client || employeeDatabase()).query(`SELECT employee_id, name, email, group_ids
    FROM employee_sessions WHERE token_hash = $1 AND expires_at > now() AND tenant_id = $2`,
  [hashToken(token), cfg.tenant]);
  const session = rows[0];
  if (!session) return null;
  let groups;
  try { groups = approvedGroups(session.group_ids, cfg); } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
  return { id: session.employee_id, name: session.name, email: session.email,
    admin: groups.some((id) => cfg.adminGroups.includes(id)) };
}

export async function requireEmployee(request, client) {
  const cfg = authConfig();
  const employee = await readEmployeeSession(request, client, cfg);
  if (!employee) fail(401, "Employee sign-in is required.");
  return employee;
}

export const authSession = employeeEndpoint(async (request) => {
  const cfg = employeeConfig();
  return employeeJson({ employee: cfg ? await readEmployeeSession(request, undefined, cfg) : null, enabled: !!cfg });
});

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location,
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export const authLogin = employeeEndpoint(async () => {
  const cfg = authConfig();
  const random = () => randomBytes(32).toString("base64url");
  const state = { state: random(), nonce: random(), verifier: random() };
  const sealed = await sealState(state, cfg);
  const client = employeeDatabase();
  await client.query("DELETE FROM employee_login_states WHERE expires_at <= now()");
  await client.query(`INSERT INTO employee_login_states (state_hash, expires_at)
    VALUES ($1, now() + interval '10 minutes')`, [hashToken(state.state)]);
  const url = new URL(`${cfg.authority}/authorize`);
  url.search = new URLSearchParams({
    client_id: cfg.clientId, response_type: "code", redirect_uri: cfg.callbackUrl,
    response_mode: "query", scope: "openid profile email", state: state.state, nonce: state.nonce,
    code_challenge: createHash("sha256").update(state.verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const response = redirect(url.href);
  response.headers.append("Set-Cookie", employeeCookie(STATE_COOKIE, sealed, cfg, STATE_SECONDS));
  return response;
});

export const authCallback = async (request) => {
  let cfg;
  let response;
  try {
    cfg = authConfig();
    const url = new URL(request.url);
    const state = await openState(cookieValue(request, STATE_COOKIE), cfg);
    if (url.searchParams.getAll("state").length !== 1 ||
        !equalSecret(url.searchParams.get("state"), state.state)) fail(400, "Sign-in state was not accepted.");
    const client = employeeDatabase();
    const consumed = await client.query(`DELETE FROM employee_login_states
      WHERE state_hash = $1 AND expires_at > now() RETURNING state_hash`, [hashToken(state.state)]);
    if (!consumed.rows.length) fail(400, "Sign-in has expired. Try again.");
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 ||
        !code || code.length > 8192) fail(400, "Sign-in was not completed.");
    const exchange = await fetch(`${cfg.authority}/token`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret,
        grant_type: "authorization_code", code, redirect_uri: cfg.callbackUrl, code_verifier: state.verifier }),
    });
    if (!exchange.ok) fail(401, "Sign-in could not be verified.");
    const token = await exchange.json();
    if (typeof token.id_token !== "string" || token.id_token.length > 32768) fail(401, "Sign-in could not be verified.");
    remoteKeys ||= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${cfg.tenant}/discovery/v2.0/keys`));
    let verified;
    try { verified = await verifyEmployeeToken(token.id_token, remoteKeys, cfg, state.nonce); } catch {
      fail(403, "Employee identity or group membership was not accepted.");
    }
    const opaque = randomBytes(32).toString("base64url");
    const previous = cookieValue(request, SESSION_COOKIE);
    const previousHash = previous && /^[A-Za-z0-9_-]{43}$/.test(previous) ? hashToken(previous) : "";
    await client.query(`WITH revoked AS (
        DELETE FROM employee_sessions WHERE token_hash = $7 OR expires_at <= now()
      ) INSERT INTO employee_sessions
        (token_hash, tenant_id, employee_id, name, email, group_ids, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,now() + interval '8 hours')`,
      [hashToken(opaque), cfg.tenant, verified.employee.id, verified.employee.name,
        verified.employee.email, JSON.stringify(verified.groups), previousHash]);
    response = redirect(`${cfg.appUrl}/`);
    response.headers.append("Set-Cookie", employeeCookie(SESSION_COOKIE, opaque, cfg, SESSION_SECONDS));
  } catch (error) {
    // Never render the callback query or upstream errors, which can contain codes/tokens.
    response = employeeJson({ error: error instanceof HttpError ? error.message : "Employee sign-in is temporarily unavailable." },
      error instanceof HttpError ? error.status : 503);
  }
  if (cfg) response.headers.append("Set-Cookie", employeeCookie(STATE_COOKIE, "", cfg, 0));
  return response;
};

export const authLogout = employeeEndpoint(async (request) => {
  const cfg = authConfig();
  employeeOrigin(request, cfg);
  const token = cookieValue(request, SESSION_COOKIE);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    await employeeDatabase().query("DELETE FROM employee_sessions WHERE token_hash = $1", [hashToken(token)]);
  }
  const response = employeeJson({ loggedOut: true });
  response.headers.append("Set-Cookie", employeeCookie(SESSION_COOKIE, "", cfg, 0));
  response.headers.append("Set-Cookie", employeeCookie(STATE_COOKIE, "", cfg, 0));
  return response;
});

export { requireEmployeeTransfer } from "./employees.js";
