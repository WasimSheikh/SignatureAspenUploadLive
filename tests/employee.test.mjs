import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { generateKeyPair, exportJWK, SignJWT, EncryptJWT } from "jose";
import {
  employeeConfig, employeeClaims, verifyEmployeeToken, sealState, openState, employeeCookie,
  cookieValue, SESSION_COOKIE, STATE_COOKIE, SESSION_SECONDS,
} from "../src/lib/employee-security.mjs";
import { hashToken, randomId } from "../src/lib/security.mjs";
import {
  employeeDatabase, readEmployeeSession, requireEmployee, authLogin, authCallback, authLogout,
  authSession, employeeEndpoint,
} from "../src/lib/employee-auth.js";
import {
  employeeHasTransfer, requireEmployeeTransfer, recordEmployeeUpload, employeeTransfers,
  employeeBrowse, listBrowseChildren, matchesBrowseQuery, employeeDashboard, employeeCalendar,
  employeeShare, employeeDownload, employeeAssign,
} from "../src/lib/employees.js";

const tenant = "11111111-1111-1111-1111-111111111111";
const clientId = "22222222-2222-2222-2222-222222222222";
const oid = "33333333-3333-3333-3333-333333333333";
const group = "44444444-4444-4444-4444-444444444444";
const adminGroup = "55555555-5555-5555-5555-555555555555";
const otherGroup = "66666666-6666-6666-6666-666666666666";
Object.assign(process.env, {
  NODE_ENV: "test", ENTRA_TENANT_ID: tenant, ENTRA_CLIENT_ID: clientId,
  ENTRA_CLIENT_SECRET: "nonfunctional-test-client-secret", ENTRA_ALLOWED_GROUP_IDS: group,
  ENTRA_ADMIN_GROUP_IDS: adminGroup, DATABASE_URL: "postgres://localhost/not-used",
  APP_URL: "https://example.com", COOKIE_SECRET: "employee-test-cookie-secret-at-least-32-characters",
});
const cfg = employeeConfig();
const nonce = randomBytes(32).toString("base64url");
const payload = (overrides = {}) => ({
  iss: cfg.issuer, tid: tenant, aud: clientId, oid, nonce, ver: "2.0", sub: "subject", acct: 0,
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  groups: [group], name: "Employee", email: "Employee@example.com", ...overrides,
});
const request = (cookie = "", init = {}) => new Request("https://example.com/api/employee/transfers", {
  ...init, headers: { cookie, ...init.headers },
});
const opaque = randomBytes(32).toString("base64url");
const sessionCookie = `${SESSION_COOKIE}=${opaque}`;
const sessionRow = { employee_id: oid, name: "Employee", email: "employee@example.com", group_ids: [group] };
const id = randomId();
const transfer = { id, title: "Designs", company: "Company", sender_email: "sender@example.com",
  status: "complete", expires_at: new Date(Date.now() + 60000), passcode_hash: "protected" };
const file = { id: randomId(), transfer_id: id, name: "Design.pdf", size: "20" };
const database = employeeDatabase();
async function withQueries(query, run) {
  const original = database.query;
  database.query = query;
  try { return await run(); } finally { database.query = original; }
}

test("SSO configuration is optional, but tenant/client/groups/origin/secrets are validated", () => {
  assert.equal(employeeConfig({}), null);
  assert.equal(employeeConfig({ ...process.env, ENTRA_ALLOWED_GROUP_IDS: "" }), null);
  for (const overrides of [
    { ENTRA_TENANT_ID: "common" }, { ENTRA_CLIENT_ID: "invalid" },
    { ENTRA_ALLOWED_GROUP_IDS: "bad" }, { ENTRA_ADMIN_GROUP_IDS: "bad" },
    { APP_URL: "https://example.com/path" }, { COOKIE_SECRET: "short" },
    { NODE_ENV: "production", APP_URL: "http://example.com" },
  ]) assert.throws(() => employeeConfig({ ...process.env, ...overrides }));
  assert.equal(employeeCookie(SESSION_COOKIE, opaque, cfg, SESSION_SECONDS),
    `${sessionCookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800; Secure`);
});

test("only tenant immutable oid and direct approved groups authorize, never an email", () => {
  assert.deepEqual(employeeClaims(payload(), cfg, nonce).employee,
    { id: oid, name: "Employee", email: "employee@example.com", admin: false });
  assert.equal(employeeClaims(payload({ groups: [group, adminGroup] }), cfg, nonce).employee.admin, true);
  for (const overrides of [
    { tid: otherGroup }, { iss: `${cfg.issuer}/` }, { aud: otherGroup },
    { aud: [clientId, otherGroup] }, { oid: "" }, { oid: "employee@example.com" },
    { nonce: "wrong" }, { exp: 0 }, { ver: "1.0" }, { groups: [] }, { groups: [otherGroup] },
    { groups: [adminGroup] }, { groups: undefined }, { groups: group }, { groups: ["bad"] },
    { hasgroups: true }, { _claim_names: { groups: "src1" } }, { acct: 1 }, { acct: "1" }, { acct: undefined },
  ]) assert.throws(() => employeeClaims(payload(overrides), cfg, nonce), { status: 403 });
  assert.equal(employeeClaims(payload({ email: undefined, preferred_username: "untrusted@example.com" }), cfg, nonce).employee.email, "");
});

test("jose enforces signature, issuer, audience, nonce, expiry, required claims and RS256", async () => {
  const keys = await generateKeyPair("RS256");
  const sign = (claims, key = keys.privateKey, alg = "RS256") =>
    new SignJWT(claims).setProtectedHeader({ alg }).sign(key);
  assert.equal((await verifyEmployeeToken(await sign(payload()), keys.publicKey, cfg, nonce)).employee.id, oid);
  for (const overrides of [
    { iss: "https://evil.example" }, { aud: otherGroup }, { exp: 0 }, { iat: 1 },
    { nonce: "wrong" }, { tid: otherGroup }, { oid: undefined }, { groups: undefined },
  ]) await assert.rejects(verifyEmployeeToken(await sign(payload(overrides)), keys.publicKey, cfg, nonce));
  const attacker = await generateKeyPair("RS256");
  await assert.rejects(verifyEmployeeToken(await sign(payload(), attacker.privateKey), keys.publicKey, cfg, nonce));
  const hs = await sign(payload(), randomBytes(32), "HS256");
  await assert.rejects(verifyEmployeeToken(hs, keys.publicKey, cfg, nonce));
});

test("OIDC state is encrypted, authenticated, expiry bounded and cookie parsing rejects duplicates", async () => {
  const state = { state: nonce, nonce, verifier: nonce };
  const sealed = await sealState(state, cfg);
  assert.ok(!sealed.includes(nonce));
  assert.equal((await openState(sealed, cfg)).verifier, nonce);
  await assert.rejects(openState(`${sealed}x`, cfg), { status: 400 });
  await assert.rejects(openState(sealed, { ...cfg, secret: "different secret" }), { status: 400 });
  await assert.rejects(openState(await sealState({ ...state, verifier: "bad" }, cfg), cfg), { status: 400 });
  const expired = await new EncryptJWT(state).setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(cfg.appUrl).setAudience("employee-oidc").setIssuedAt(1).setExpirationTime(2)
    .encrypt(createHash("sha256").update(`employee-oidc-state:${cfg.secret}`).digest());
  await assert.rejects(openState(expired, cfg), { status: 400 });
  assert.equal(cookieValue(request(`${sessionCookie}; ${sessionCookie}`), SESSION_COOKIE), null);
});

test("successful callback exchanges code with verifier, verifies remote JWKS and rotates opaque eight-hour session", async () => {
  const state = { state: nonce, nonce, verifier: nonce };
  const cookie = `${STATE_COOKIE}=${await sealState(state, cfg)}; ${sessionCookie}`;
  const keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "employee-test", alg: "RS256", use: "sig" };
  const signed = await new SignJWT(payload()).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).sign(keys.privateKey);
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/token")) {
      assert.equal(String(url), `${cfg.authority}/token`);
      assert.equal(init.body.get("code_verifier"), nonce);
      assert.equal(init.body.get("client_secret"), cfg.clientSecret);
      assert.equal(init.body.get("redirect_uri"), cfg.callbackUrl);
      assert.equal(init.body.get("grant_type"), "authorization_code");
      assert.equal(init.redirect, "error");
      return Response.json({ id_token: signed });
    }
    assert.equal(String(url), `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`);
    return Response.json({ keys: [jwk] });
  };
  let consumed = false;
  try {
    await withQueries(async (sql, values) => {
      seen.push({ sql, values });
      if (sql.includes("employee_login_states")) {
        if (consumed) return { rows: [] };
        consumed = true;
        return { rows: [{ state_hash: hashToken(nonce) }] };
      }
      return { rows: [] };
    }, async () => {
      const callbackRequest = new Request(`${cfg.callbackUrl}?state=${nonce}&code=nonfunctional-code`, { headers: { cookie } });
      const response = await authCallback(callbackRequest);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), `${cfg.appUrl}/dashboard`);
      const setCookie = response.headers.get("set-cookie");
      const session = setCookie.match(/employee_session=([A-Za-z0-9_-]{43})/)[1];
      assert.notEqual(session, opaque);
      assert.match(setCookie, /Max-Age=28800/);
      assert.match(setCookie, /employee_oidc=; HttpOnly/);
      assert.match(seen[1].sql, /interval '8 hours'/);
      assert.match(seen[1].sql, /DELETE FROM employee_sessions/);
      assert.equal(seen[1].values[0], hashToken(session));
      assert.equal(seen[1].values[6], hashToken(opaque));
      assert.equal(seen[1].values[2], oid);
      assert.ok(!JSON.stringify(seen).includes(signed));
      assert.ok(!JSON.stringify(seen).includes(session));
      assert.equal((await authCallback(callbackRequest)).status, 400);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("login uses tenant code flow, PKCE S256, minimal OIDC scopes and no redirect input", async () => {
  const calls = [];
  await withQueries(async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; }, async () => {
    const response = await authLogin(new Request("https://example.com/api/auth/login?next=https://evil.example"));
    assert.equal(response.status, 303);
    const url = new URL(response.headers.get("location"));
    assert.equal(url.origin, "https://login.microsoftonline.com");
    assert.equal(url.pathname, `/${tenant}/oauth2/v2.0/authorize`);
    assert.equal(url.searchParams.get("scope"), "openid profile email");
    assert.equal(url.searchParams.get("redirect_uri"), cfg.callbackUrl);
    assert.equal(url.searchParams.get("response_type"), "code");
    const cookie = response.headers.get("set-cookie");
    const state = await openState(cookie.split(";")[0].slice(STATE_COOKIE.length + 1), cfg);
    assert.equal(url.searchParams.get("state"), state.state);
    assert.equal(url.searchParams.get("nonce"), state.nonce);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge"),
      createHash("sha256").update(state.verifier).digest("base64url"));
    assert.equal(calls[1].values[0], hashToken(state.state));
    assert.ok(!JSON.stringify(calls).includes(state.verifier));
    assert.match(cookie, /HttpOnly; SameSite=Lax; Path=\/api\/auth; Max-Age=600; Secure/);
  });
});

test("callback rejects mismatched, replayed or denied state and clears the cookie without leaking queries", async () => {
  const state = { state: nonce, nonce, verifier: nonce };
  const cookie = `${STATE_COOKIE}=${await sealState(state, cfg)}`;
  await withQueries(async () => ({ rows: [] }), async () => {
    for (const query of [`state=bad&code=sensitive`, `state=${nonce}&code=sensitive`,
      `state=${nonce}&state=${nonce}&code=sensitive`]) {
      const response = await authCallback(new Request(`${cfg.callbackUrl}?${query}`, { headers: { cookie } }));
      assert.equal(response.status, 400);
      assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.ok(!(await response.text()).includes("sensitive"));
    }
  });
  await withQueries(async () => ({ rows: [{ state_hash: hashToken(nonce) }] }), async () => {
    const response = await authCallback(new Request(`${cfg.callbackUrl}?state=${nonce}&error=access_denied&error_description=private`,
      { headers: { cookie } }));
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("private"));
  });
});

test("sessions use token digests, DB fixed expiry, current group policy and no cloud config", async () => {
  const seen = [];
  await withQueries(async (sql, values) => { seen.push({ sql, values }); return { rows: [sessionRow] }; }, async () => {
    assert.deepEqual(await readEmployeeSession(request(sessionCookie)), {
      id: oid, name: "Employee", email: "employee@example.com", admin: false,
    });
    assert.equal(seen[0].values[0], hashToken(opaque));
    assert.match(seen[0].sql, /expires_at > now\(\) AND tenant_id = \$2/);
    assert.ok(!JSON.stringify(seen).includes(opaque));
    assert.equal(await readEmployeeSession(request(`${SESSION_COOKIE}=invalid`)), null);
  });
  await withQueries(async () => ({ rows: [{ ...sessionRow, group_ids: [adminGroup] }] }), async () => {
    assert.equal(await readEmployeeSession(request(sessionCookie)), null);
  });
  await withQueries(async () => ({ rows: [] }), async () => {
    assert.equal(await readEmployeeSession(request(sessionCookie)), null);
    await assert.rejects(requireEmployee(request(sessionCookie)), { status: 401 });
    assert.deepEqual(await (await authSession(request())).json(), { employee: null, enabled: true });
  });
  const secret = process.env.ENTRA_CLIENT_SECRET;
  delete process.env.ENTRA_CLIENT_SECRET;
  try {
    assert.deepEqual(await (await authSession(request())).json(), { employee: null, enabled: false });
    assert.equal((await authLogin(request())).status, 503);
    assert.equal(await recordEmployeeUpload(request(), id, database), false);
  } finally { process.env.ENTRA_CLIENT_SECRET = secret; }
});

test("ACLs query only complete live transfers and immutable employee IDs including admin policy", async () => {
  const queries = [];
  const client = { query: async (sql, values) => { queries.push({ sql, values }); return { rows: [{ id }] }; } };
  assert.equal(await employeeHasTransfer(client, { id: oid, admin: false }, id), true);
  assert.match(queries[0].sql, /status = 'complete' AND t.expires_at > now\(\)/);
  assert.match(queries[0].sql, /a.employee_id = \$2::uuid/);
  assert.deepEqual(queries[0].values, [id, oid, false]);
  assert.equal(await employeeHasTransfer(client, { id: oid, admin: "true" }, id), true);
  assert.equal(queries[1].values[2], false);
  assert.equal(await employeeHasTransfer(client, { id: oid, admin: true }, "bad"), false);
  const denied = { query: async () => ({ rows: [] }) };
  assert.equal(await employeeHasTransfer(denied, { id: oid, admin: false }, id), false);
});

test("upload mapping reads server session, ignores supplied identity and returns false anonymously", async () => {
  const seen = [];
  const client = { query: async (sql, values) => {
    seen.push({ sql, values });
    return { rows: sql.includes("employee_sessions") ? [sessionRow] : [] };
  } };
  const forged = request(sessionCookie, { headers: { "x-employee-id": otherGroup } });
  assert.equal(await recordEmployeeUpload(forged, id, client), true);
  assert.deepEqual(seen[1].values, [id, oid]);
  assert.equal(await recordEmployeeUpload(request(), id, client), false);
});

test("authorized transfer, listing and sharing never expose upload credentials or bypass public passcodes", async () => {
  await withQueries(async (sql) => {
    if (sql.includes("employee_sessions")) return { rows: [sessionRow] };
    if (sql.includes("SELECT * FROM transfers")) return { rows: [{ ...transfer, upload_token_hash: "private" }] };
    if (sql.startsWith("SELECT * FROM transfer_files") || sql.startsWith("SELECT id,transfer_id")) return { rows: [file] };
    return { rows: [transfer] };
  }, async () => {
    const result = await requireEmployeeTransfer(request(sessionCookie), id);
    assert.equal(result.employee.id, oid);
    assert.equal(result.transfer.id, id);
    assert.equal(result.files[0].id, file.id);
    const response = await employeeTransfers(request(sessionCookie));
    const list = await response.json();
    assert.equal(list.transfers[0].totalSize, 20);
    assert.equal(list.transfers[0].canShare, true);
    assert.equal(list.transfers[0].nasStatus, null);
    assert.equal(list.page, 1);
    assert.equal(list.hasMore, false);
    assert.ok(!JSON.stringify(list).includes("private"));
    assert.deepEqual(await (await employeeShare(request(sessionCookie, {
      method: "POST", headers: { origin: cfg.appUrl },
    }), { params: Promise.resolve({ id }) })).json(),
    { url: `${cfg.appUrl}/transfer/${id}`, requiresPasscode: true });
    assert.equal((await employeeShare(request(sessionCookie, {
      method: "POST", headers: { origin: "https://evil.example" },
    }), { params: Promise.resolve({ id }) })).status, 403);
  });
});

test("blob explorer lists folders from object keys and stays ACL-scoped", async () => {
  const dated = {
    id: file.id, transfer_id: id, name: "Design.pdf", size: "20",
    object_key: `transfers/2026/10/27/${id}/${file.id}`,
    title: "Designs", company: "Company", sender_email: "sender@example.com",
    completed_at: new Date("2026-10-27T17:00:00Z"),
  };
  let browseSql;
  await withQueries(async (sql) => {
    if (sql.includes("employee_sessions")) return { rows: [sessionRow] };
    if (sql.includes("object_key LIKE")) { browseSql = sql; return { rows: [dated] }; }
    return { rows: [] };
  }, async () => {
    const root = await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse",
      { headers: { cookie: sessionCookie } }));
    const rootBody = await root.json();
    assert.equal(root.status, 200);
    assert.equal(rootBody.path, "transfers");
    assert.deepEqual(rootBody.folders.map((folder) => folder.name), ["2026"]);
    assert.equal(rootBody.folders[0].label, "2026");
    assert.equal(rootBody.files.length, 0);
    const month = await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?path=transfers/2026/10",
      { headers: { cookie: sessionCookie } }));
    const monthBody = await month.json();
    assert.equal(monthBody.folders[0].name, "27");
    assert.equal(monthBody.crumbs.at(-1).label, "October");
    const leaf = await employeeBrowse(new Request(
      `https://example.com/api/employee/transfers/browse?path=transfers/2026/10/27/${id}`,
      { headers: { cookie: sessionCookie } }));
    const leafBody = await leaf.json();
    assert.equal(leafBody.files[0].name, "Design.pdf");
    assert.equal(leafBody.files[0].transferId, id);
    assert.equal(leafBody.crumbs.at(-1).label, "Company");
    assert.ok(!JSON.stringify(leafBody).includes("private"));
    assert.match(browseSql, /a.employee_id = \$2::uuid/);
    assert.equal((await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?path=staging",
      { headers: { cookie: sessionCookie } }))).status, 400);
    assert.equal((await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?path=transfers/../etc",
      { headers: { cookie: sessionCookie } }))).status, 400);
    const byDate = await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?group=date",
      { headers: { cookie: sessionCookie } }));
    const dateBody = await byDate.json();
    assert.equal(dateBody.folders[0].name, "2026-10-27");
    assert.match(dateBody.folders[0].label, /October 27/);
    const dateFiles = await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?group=date&key=2026-10-27",
      { headers: { cookie: sessionCookie } }));
    assert.equal((await dateFiles.json()).files[0].name, "Design.pdf");
    const byCompany = await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?group=company",
      { headers: { cookie: sessionCookie } }));
    assert.equal((await byCompany.json()).folders[0].label, "Company");
    const found = await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?q=Design.pdf",
      { headers: { cookie: sessionCookie } }));
    assert.equal((await found.json()).folders[0].name, "2026");
    const missed = await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?q=missing-file",
      { headers: { cookie: sessionCookie } }));
    assert.deepEqual((await missed.json()).folders, []);
    assert.equal((await employeeBrowse(new Request(
      "https://example.com/api/employee/transfers/browse?group=owner",
      { headers: { cookie: sessionCookie } }))).status, 400);
    assert.equal((await employeeBrowse(new Request(
      `https://example.com/api/employee/transfers/browse?q=${"x".repeat(201)}`,
      { headers: { cookie: sessionCookie } }))).status, 400);
  });
  const children = listBrowseChildren([dated], "transfers/2026/10/27");
  assert.equal(children.folders[0].transferId, id);
  assert.equal(children.folders[0].label, "Company");
  assert.equal(matchesBrowseQuery(dated, "company"), true);
  assert.equal(matchesBrowseQuery(dated, "nope"), false);
});

test("dashboard statistics and calendar stay ACL-scoped on Houston dates", async () => {
  let dashboardSql = "";
  await withQueries(async (sql) => {
    if (sql.includes("employee_sessions")) return { rows: [sessionRow] };
    if (sql.includes("this_month")) {
      dashboardSql = sql;
      return { rows: [{ transfers: 3, today: 1, this_month: 2, expiring: 1, companies: 2 }] };
    }
    if (sql.includes("count(f.id)::int AS files")) return { rows: [{ files: 5, total_size: "40" }] };
    if (sql.includes("NULLS LAST")) {
      return { rows: [{ ...transfer, sender_email: "sender@example.com", completed_at: new Date("2026-10-27T17:00:00Z") }] };
    }
    if (sql.includes("ORDER BY transfers DESC")) return { rows: [{ company: "Company", transfers: 2 }] };
    if (sql.includes("calendar_days")) {
      return { rows: [{ calendar_days: "2026-10-27", transfer_count: 1, file_count: 1, total_size: "20" }] };
    }
    if (sql.includes("::date = $3::date")) {
      return { rows: [{ ...transfer, sender_email: "sender@example.com", completed_at: new Date("2026-10-27T17:00:00Z") }] };
    }
    if (sql.startsWith("SELECT id,transfer_id")) return { rows: [file] };
    return { rows: [] };
  }, async () => {
    const dashboard = await employeeDashboard(new Request(
      "https://example.com/api/employee/dashboard?month=2026-10",
      { headers: { cookie: sessionCookie } }));
    const body = await dashboard.json();
    assert.equal(dashboard.status, 200);
    assert.equal(body.timezone, "America/Chicago");
    assert.equal(body.month.key, "2026-10");
    assert.equal(body.stats.transfers, 3);
    assert.equal(body.stats.files, 5);
    assert.equal(body.stats.thisMonth, 2);
    assert.equal(body.companies[0].company, "Company");
    assert.equal(body.days[0].date, "2026-10-27");
    assert.equal(body.recent[0].files[0].name, "Design.pdf");
    assert.match(dashboardSql, /a.employee_id = \$2::uuid/);
    const day = await employeeCalendar(new Request(
      "https://example.com/api/employee/transfers/calendar?date=2026-10-27",
      { headers: { cookie: sessionCookie } }));
    const dayBody = await day.json();
    assert.equal(dayBody.transfers[0].title, "Designs");
    assert.match(dayBody.label, /October 27/);
    assert.equal((await employeeDashboard(new Request(
      "https://example.com/api/employee/dashboard?month=2026-13",
      { headers: { cookie: sessionCookie } }))).status, 400);
    assert.equal((await employeeCalendar(new Request(
      "https://example.com/api/employee/transfers/calendar?date=2026-02-30",
      { headers: { cookie: sessionCookie } }))).status, 400);
  });
});

test("unauthorized direct share/download and invalid pagination fail closed", async () => {
  await withQueries(async (sql) => ({ rows: sql.includes("employee_sessions") ? [sessionRow] : [] }), async () => {
    await assert.rejects(requireEmployeeTransfer(request(sessionCookie), id), { status: 404 });
    assert.equal((await employeeDownload(request(sessionCookie), { params: Promise.resolve({ id }) })).status, 404);
    const response = await employeeTransfers(new Request("https://example.com/api/employee/transfers?page=-1",
      { headers: { cookie: sessionCookie } }));
    assert.equal(response.status, 400);
  });
});

test("NAS-enabled transfers without a mirror row report pending and filename search stays ACL-scoped", async () => {
  const original = process.env.NAS_ENABLED;
  process.env.NAS_ENABLED = "true";
  let listingSql;
  try {
    await withQueries(async (sql) => {
      if (sql.includes("employee_sessions")) return { rows: [sessionRow] };
      if (sql.includes("FROM nas_mirrors")) return { rows: [] };
      if (sql.startsWith("SELECT id,transfer_id")) return { rows: [file] };
      listingSql = sql;
      return { rows: [transfer] };
    }, async () => {
      const response = await employeeTransfers(request(sessionCookie));
      const result = await response.json();
      assert.equal(result.transfers[0].nasStatus, "pending");
      assert.match(listingSql, /FROM transfer_files f WHERE f.transfer_id = t.id/);
      assert.match(listingSql, /position\(lower\(\$3\) in lower\(f.name\)\)/);
      assert.match(listingSql, /a.employee_id = \$2::uuid/);
    });
  } finally {
    if (original === undefined) delete process.env.NAS_ENABLED;
    else process.env.NAS_ENABLED = original;
  }
});

test("only approved-group administrators may assign access by object ID", async () => {
  const post = (employeeId) => request(sessionCookie, { method: "POST",
    headers: { origin: cfg.appUrl, "content-type": "application/json" },
    body: JSON.stringify({ employeeId }) });
  const context = { params: Promise.resolve({ id }) };
  let admin = false;
  const assignments = [];
  await withQueries(async (sql, values) => {
    if (sql.includes("employee_sessions")) return { rows: [{ ...sessionRow,
      group_ids: admin ? [group, adminGroup] : [group] }] };
    if (sql.includes("INSERT INTO transfer_employee_access")) assignments.push(values);
    return { rows: sql.includes("transfer_files") ? [file] : [transfer] };
  }, async () => {
    assert.equal((await employeeAssign(post(oid), context)).status, 403);
    admin = true;
    assert.equal((await employeeAssign(post("employee@example.com"), context)).status, 400);
    assert.equal(assignments.length, 0);
    assert.equal((await employeeAssign(post(otherGroup), context)).status, 200);
    assert.deepEqual(assignments, [[id, otherGroup]]);
  });
});

test("logout requires exact origin, revokes digest in DB and clears HTTP-only cookies", async () => {
  const calls = [];
  await withQueries(async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; }, async () => {
    for (const origin of [undefined, "https://evil.example", "https://example.com.evil"]) {
      assert.equal((await authLogout(request(sessionCookie, {
        method: "POST", headers: origin ? { origin } : {},
      }))).status, 403);
    }
    assert.equal(calls.length, 0);
    const response = await authLogout(request(sessionCookie, { method: "POST", headers: { origin: cfg.appUrl } }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0].values, [hashToken(opaque)]);
    assert.match(calls[0].sql, /DELETE FROM employee_sessions/);
    assert.match(response.headers.get("set-cookie"), /employee_session=; HttpOnly/);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("unexpected errors never reveal infrastructure credentials", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const response = await employeeEndpoint(() => { throw new Error("secret-password"); })(request());
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("secret-password"));
  } finally { console.error = original; }
});

test("authorized employee cloud file and ZIP downloads bypass passcode without setting a public unlock cookie", async () => {
  Object.assign(process.env, {
    AZURE_STORAGE_ACCOUNT_NAME: "teststorageaccount", AZURE_STORAGE_CONTAINER: "test-transfers",
    AZURE_STORAGE_ACCOUNT_KEY: Buffer.from("nonfunctional-storage-test-key").toString("base64"),
    RESEND_API_KEY: "test-resend", FROM_EMAIL: "sender@example.com",
    CRON_SECRET: "nonfunctional-test-cron-secret-32-characters",
  });
  const { db } = await import("../src/lib/db.js");
  const { storage } = await import("../src/lib/storage.js");
  const cloudDb = db();
  const originalQuery = cloudDb.query;
  const originalContainer = storage().getContainerClient;
  cloudDb.query = async (sql) => ({
    rows: sql.includes("FROM transfers") ? [{ ...transfer, completed_at: new Date() }]
      : sql.includes("FROM transfer_files") ? [{ ...file, object_key: "test/design.pdf",
        upload_id: "azure-v1:11111111-1111-4111-8111-111111111111" }] : [],
  });
  storage().getContainerClient = () => ({
    getBlockBlobClient: (key) => ({
      url: `https://teststorageaccount.blob.core.windows.net/test-transfers/${key}`,
      download: async () => ({ readableStreamBody: Readable.from([Buffer.from("design data")]) }),
    }),
  });
  try {
    await withQueries(async (sql) => ({
      rows: sql.includes("employee_sessions") ? [sessionRow]
        : sql.includes("transfer_files") ? [file] : [transfer],
    }), async () => {
      const downloadRequest = new Request(`https://example.com/api/employee/transfers/${id}/download?file=${file.id}`,
        { headers: { cookie: sessionCookie } });
      const response = await employeeDownload(downloadRequest, { params: Promise.resolve({ id }) });
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location"));
      assert.equal(location.hostname, "teststorageaccount.blob.core.windows.net");
      assert.ok(location.searchParams.has("sig"));
      assert.equal(location.searchParams.get("sp"), "r");
      assert.equal(response.headers.get("set-cookie"), null);
      const zip = await employeeDownload(request(sessionCookie), { params: Promise.resolve({ id }) });
      assert.equal(zip.status, 200);
      assert.equal(zip.headers.get("content-type"), "application/zip");
      assert.equal(zip.headers.get("set-cookie"), null);
      const body = Buffer.from(await zip.arrayBuffer());
      assert.equal(body.readUInt32LE(0), 0x04034b50);
      assert.ok(body.includes(Buffer.from(file.name)));
    });
  } finally {
    cloudDb.query = originalQuery;
    storage().getContainerClient = originalContainer;
  }
});
