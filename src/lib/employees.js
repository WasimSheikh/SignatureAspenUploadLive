import {
  employeeDatabase, requireEmployee, readEmployeeSession, employeeEndpoint, employeeJson,
  employeeOrigin, authConfig,
} from "./employee-auth.js";
import { employeeConfig } from "./employee-security.mjs";
import { fail, signUnlock } from "./security.mjs";
import { readJson } from "./http.js";

const transferIdPattern = /^[A-Za-z0-9_-]{32}$/;
export async function employeeHasTransfer(client, employee, id) {
  if (!employee?.id || !transferIdPattern.test(id)) return false;
  const { rows } = await client.query(`SELECT t.id FROM transfers t
    WHERE t.id = $1 AND t.status = 'complete' AND t.expires_at > now()
    AND ($3::boolean OR EXISTS (
      SELECT 1 FROM transfer_employee_access a WHERE a.transfer_id = t.id AND a.employee_id = $2::uuid
    ))`, [id, employee.id, employee.admin === true]);
  return rows.length > 0;
}

export async function requireEmployeeTransfer(request, id, client) {
  const database = client || employeeDatabase();
  const employee = await requireEmployee(request, database);
  if (!await employeeHasTransfer(database, employee, id)) fail(404, "Transfer not found.");
  const { rows } = await database.query(
    "SELECT * FROM transfers WHERE id = $1 AND status = 'complete' AND expires_at > now()", [id]);
  if (!rows[0]) fail(404, "Transfer not found.");
  const files = await database.query("SELECT * FROM transfer_files WHERE transfer_id = $1 ORDER BY ordinal", [id]);
  return { employee, transfer: rows[0], files: files.rows };
}

export async function recordEmployeeUpload(request, transferId, client) {
  if (!employeeConfig()) return false;
  const employee = await readEmployeeSession(request, client);
  if (!employee) return false;
  await client.query(`INSERT INTO transfer_employee_access (transfer_id, employee_id)
    VALUES ($1,$2::uuid) ON CONFLICT DO NOTHING`, [transferId, employee.id]);
  return true;
}

export const employeeTransfers = employeeEndpoint(async (request) => {
  const client = employeeDatabase();
  const employee = await requireEmployee(request, client);
  const params = new URL(request.url).searchParams;
  const pageText = params.get("page") || "1";
  if (!/^[1-9]\d{0,5}$/.test(pageText)) fail(400, "Invalid page.");
  const page = Number(pageText);
  const query = (params.get("q") || "").trim();
  if (query.length > 200) fail(400, "Search is too long.");
  const { rows } = await client.query(`SELECT t.id,t.title,t.company,t.sender_email,t.expires_at
    FROM transfers t WHERE t.status = 'complete' AND t.expires_at > now()
    AND ($1::boolean OR EXISTS (
      SELECT 1 FROM transfer_employee_access a WHERE a.transfer_id = t.id AND a.employee_id = $2::uuid
    ))
    AND ($3 = '' OR position(lower($3) in lower(t.title)) > 0
      OR position(lower($3) in lower(t.company)) > 0
      OR EXISTS (SELECT 1 FROM transfer_files f WHERE f.transfer_id = t.id
        AND position(lower($3) in lower(f.name)) > 0))
    ORDER BY t.created_at DESC,t.id DESC LIMIT 21 OFFSET $4`,
  [employee.admin, employee.id, query, (page - 1) * 20]);
  const visible = rows.slice(0, 20);
  const ids = visible.map((row) => row.id);
  const files = ids.length ? (await client.query(`SELECT id,transfer_id,name,size FROM transfer_files
    WHERE transfer_id = ANY($1::text[]) ORDER BY ordinal`, [ids])).rows : [];
  const mirrors = ids.length && process.env.NAS_ENABLED === "true"
    ? (await client.query("SELECT transfer_id,status FROM nas_mirrors WHERE transfer_id = ANY($1::text[])", [ids])).rows : [];
  return employeeJson({ transfers: visible.map((row) => {
    const transferFiles = files.filter((file) => file.transfer_id === row.id);
    return { id: row.id, title: row.title, company: row.company, senderEmail: row.sender_email,
      expiresAt: new Date(row.expires_at).toISOString(),
      totalSize: transferFiles.reduce((sum, file) => sum + Number(file.size), 0),
      files: transferFiles.map((file) => ({ id: file.id, name: file.name, size: Number(file.size) })),
      nasStatus: mirrors.find((mirror) => mirror.transfer_id === row.id)?.status ||
        (process.env.NAS_ENABLED === "true" ? "pending" : null),
      canShare: true };
  }), page, hasMore: rows.length > 20 });
});

export const employeeShare = employeeEndpoint(async (request, context) => {
  const cfg = authConfig();
  employeeOrigin(request, cfg);
  const { id } = await context.params;
  const { transfer } = await requireEmployeeTransfer(request, id);
  return employeeJson({ url: `${cfg.appUrl}/transfer/${transfer.id}`, requiresPasscode: !!transfer.passcode_hash });
});

export const employeeAssign = employeeEndpoint(async (request, context) => {
  employeeOrigin(request);
  const { id } = await context.params;
  const client = employeeDatabase();
  const { employee } = await requireEmployeeTransfer(request, id, client);
  if (!employee.admin) fail(403, "Administrator access is required.");
  const { employeeId } = await readJson(request);
  if (typeof employeeId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employeeId)) {
    fail(400, "A valid employee object ID is required.");
  }
  await client.query(`INSERT INTO transfer_employee_access (transfer_id, employee_id)
    VALUES ($1,$2::uuid) ON CONFLICT DO NOTHING`, [id, employeeId.toLowerCase()]);
  return employeeJson({ assigned: true });
});

export const employeeDownload = employeeEndpoint(async (request, context) => {
  const { id } = await context.params;
  const { transfer } = await requireEmployeeTransfer(request, id);
  const headers = new Headers(request.headers);
  // A private server-only cookie delegates to the existing cloud/ZIP implementation.
  // It is never emitted to the browser and is generated only after employee ACL checks.
  headers.set("cookie", `transfer_unlock_${id}=${signUnlock(id, authConfig().secret)}`);
  const authorized = new Request(request.url, { method: "GET", headers, signal: request.signal });
  const { downloadTransfer } = await import("./downloads.js");
  return downloadTransfer(authorized, { params: Promise.resolve({ id: transfer.id }) });
});
