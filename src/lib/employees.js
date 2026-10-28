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
    WHERE t.id = $1 AND t.status = 'complete' AND t.expires_at > now()`, [id]);
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
    AND ($1 = '' OR position(lower($1) in lower(t.title)) > 0
      OR position(lower($1) in lower(t.company)) > 0
      OR EXISTS (SELECT 1 FROM transfer_files f WHERE f.transfer_id = t.id
        AND position(lower($1) in lower(f.name)) > 0))
    ORDER BY t.created_at DESC,t.id DESC LIMIT 21 OFFSET $2`,
  [query, (page - 1) * 20]);
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

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const COMPANY_TZ = "America/Chicago";
const GROUPS = new Set(["folder", "date", "company"]);

function chicagoDate(at) {
  if (!at) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(at));
}

function dateLabel(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "Unknown date";
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function browseGroup(raw) {
  const group = String(raw || "folder").trim();
  if (!GROUPS.has(group)) fail(400, "Invalid group.");
  return group;
}

function browseQuery(raw) {
  const query = String(raw || "").trim();
  if (query.length > 200) fail(400, "Search is too long.");
  return query;
}

function browseKey(group, raw) {
  const key = String(raw ?? "").trim();
  if (!key) return "";
  if (key.length > 200 || key.includes("\0") || key.includes("\\") || key.includes("..")) fail(400, "Invalid group key.");
  if (group === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) fail(400, "Invalid date.");
    const [year, month, day] = key.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      fail(400, "Invalid date.");
    }
  }
  return key;
}

export function matchesBrowseQuery(row, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [row.name, row.company, row.title, row.sender_email].some((value) =>
    String(value || "").toLowerCase().includes(needle));
}

function asFile(row) {
  return {
    type: "file", id: row.id, transferId: row.transfer_id, name: row.name,
    size: Number(row.size), modified: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    senderEmail: row.sender_email, company: row.company, title: row.title,
  };
}

function collectGroups(rows, keyOf, labelOf, newestFirst = false) {
  const groups = new Map();
  for (const row of rows) {
    const name = keyOf(row);
    const modified = row.completed_at ? new Date(row.completed_at).toISOString() : null;
    let folder = groups.get(name);
    if (!folder) {
      folder = {
        type: "folder", name, path: name, label: labelOf(name, row),
        fileCount: 0, totalSize: 0, modified, transferId: null, company: "", title: "",
      };
      groups.set(name, folder);
    }
    folder.fileCount += 1;
    folder.totalSize += Number(row.size);
    if (modified && (!folder.modified || modified > folder.modified)) folder.modified = modified;
  }
  return [...groups.values()].sort((a, b) => newestFirst
    ? b.name.localeCompare(a.name, undefined, { numeric: true })
    : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
}

function browsePath(raw) {
  const trimmed = String(raw || "transfers").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "transfers";
  if (trimmed.includes("..") || trimmed.includes("\\") || trimmed.includes("\0")) fail(400, "Invalid path.");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts[0] !== "transfers" || parts.length > 5) fail(400, "Invalid path.");
  if (parts.some((part) => !/^[A-Za-z0-9._-]{1,64}$/.test(part))) fail(400, "Invalid path.");
  return parts.join("/");
}

function folderLabel(path, name, transfer) {
  const parts = path.split("/");
  if (parts.length === 3 && /^\d{2}$/.test(name)) return MONTHS[Number(name) - 1] || name;
  if (transfer && name === transfer.id) return transfer.company || transfer.title || "Transfer";
  return name;
}

function crumbLabel(path, transferById) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (parts.length === 3 && /^\d{2}$/.test(name)) return MONTHS[Number(name) - 1] || name;
  if (parts.length >= 2 && transferById.has(name)) {
    const transfer = transferById.get(name);
    return transfer.company || transfer.title || "Transfer";
  }
  return name;
}

export function listBrowseChildren(rows, path) {
  const prefix = `${path}/`;
  const folders = new Map();
  const files = [];
  for (const row of rows) {
    const key = row.object_key;
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    const modified = row.completed_at ? new Date(row.completed_at).toISOString() : null;
    if (slash === -1) {
      files.push({
        type: "file", id: row.id, transferId: row.transfer_id, name: row.name,
        size: Number(row.size), modified, senderEmail: row.sender_email,
        company: row.company, title: row.title,
      });
      continue;
    }
    const name = rest.slice(0, slash);
    const childPath = `${path}/${name}`;
    let folder = folders.get(name);
    if (!folder) {
      const isTransfer = name === row.transfer_id;
      folder = {
        type: "folder", name, path: childPath,
        label: folderLabel(childPath, name, isTransfer ? { id: row.transfer_id, company: row.company, title: row.title } : null),
        fileCount: 0, totalSize: 0, modified,
        transferId: isTransfer ? row.transfer_id : null,
        company: isTransfer ? row.company : "",
        title: isTransfer ? row.title : "",
      };
      folders.set(name, folder);
    }
    folder.fileCount += 1;
    folder.totalSize += Number(row.size);
    if (modified && (!folder.modified || modified > folder.modified)) folder.modified = modified;
  }
  const compare = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return {
    folders: [...folders.values()].sort(compare),
    files: files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
  };
}

export const employeeBrowse = employeeEndpoint(async (request) => {
  const client = employeeDatabase();
  const employee = await requireEmployee(request, client);
  const params = new URL(request.url).searchParams;
  const group = browseGroup(params.get("group"));
  const query = browseQuery(params.get("q"));
  const key = browseKey(group, params.get("key"));
  const { rows } = await client.query(`SELECT f.id, f.transfer_id, f.name, f.size, f.object_key,
      t.title, t.company, t.sender_email, t.completed_at
    FROM transfer_files f
    JOIN transfers t ON t.id = f.transfer_id
    WHERE t.status = 'complete' AND t.expires_at > now()
    AND f.object_key LIKE 'transfers/%'
    ORDER BY f.object_key LIMIT 5000`);
  const visible = query ? rows.filter((row) => matchesBrowseQuery(row, query)) : rows;
  const compareFiles = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  if (group === "date") {
    const dateOf = (row) => chicagoDate(row.completed_at);
    if (!key) {
      const folders = collectGroups(visible, dateOf, (name) => dateLabel(name), true);
      return employeeJson({
        group, query, key: "", path: "", parent: "",
        crumbs: [{ path: "", label: "By date" }],
        folders, files: [],
      });
    }
    const files = visible.filter((row) => dateOf(row) === key).map(asFile).sort(compareFiles);
    return employeeJson({
      group, query, key, path: key, parent: "",
      crumbs: [{ path: "", label: "By date" }, { path: key, label: dateLabel(key) }],
      folders: [], files,
    });
  }

  if (group === "company") {
    const companyOf = (row) => (row.company || "").trim() || "Untitled company";
    if (!key) {
      const folders = collectGroups(visible, companyOf, (name) => name);
      return employeeJson({
        group, query, key: "", path: "", parent: "",
        crumbs: [{ path: "", label: "By company" }],
        folders, files: [],
      });
    }
    const files = visible.filter((row) => companyOf(row) === key).map(asFile).sort(compareFiles);
    return employeeJson({
      group, query, key, path: key, parent: "",
      crumbs: [{ path: "", label: "By company" }, { path: key, label: key }],
      folders: [], files,
    });
  }

  const path = browsePath(params.get("path"));
  const transferById = new Map();
  for (const row of visible) {
    if (!transferById.has(row.transfer_id)) {
      transferById.set(row.transfer_id, { id: row.transfer_id, company: row.company, title: row.title });
    }
  }
  const parts = path.split("/");
  const crumbs = parts.map((_, index) => {
    const crumbPath = parts.slice(0, index + 1).join("/");
    return { path: crumbPath, label: crumbLabel(crumbPath, transferById) };
  });
  const { folders, files } = listBrowseChildren(visible, path);
  const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return employeeJson({ group, query, key: "", path, parent, crumbs, folders, files });
});

function sqlDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function parseMonth(raw) {
  const text = String(raw || "").trim() || chicagoDate(new Date()).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) fail(400, "Invalid month.");
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  if (year < 2000 || year > 2100) fail(400, "Invalid month.");
  return { year, month, key: text };
}

function parseDay(raw) {
  const key = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) fail(400, "Invalid date.");
  const [year, month, day] = key.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    fail(400, "Invalid date.");
  }
  if (year < 2000 || year > 2100) fail(400, "Invalid date.");
  return key;
}

async function filesForTransfers(client, rows) {
  const ids = rows.map((row) => row.id);
  const files = ids.length ? (await client.query(`SELECT id,transfer_id,name,size FROM transfer_files
    WHERE transfer_id = ANY($1::text[]) ORDER BY ordinal`, [ids])).rows : [];
  return rows.map((row) => {
    const transferFiles = files.filter((file) => file.transfer_id === row.id);
    return {
      id: row.id, title: row.title, company: row.company, senderEmail: row.sender_email,
      expiresAt: new Date(row.expires_at).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      totalSize: transferFiles.reduce((sum, file) => sum + Number(file.size), 0),
      files: transferFiles.map((file) => ({ id: file.id, name: file.name, size: Number(file.size) })),
      canShare: true,
    };
  });
}

export const employeeDashboard = employeeEndpoint(async (request) => {
  const client = employeeDatabase();
  const employee = await requireEmployee(request, client);
  const { year, month, key } = parseMonth(new URL(request.url).searchParams.get("month"));
  const monthStart = `${key}-01`;
  const [statsResult, filesResult, recentResult, companiesResult, daysResult] = await Promise.all([
    client.query(`SELECT count(*)::int AS transfers,
        count(*) FILTER (WHERE (t.completed_at AT TIME ZONE '${COMPANY_TZ}')::date
          = (now() AT TIME ZONE '${COMPANY_TZ}')::date)::int AS today,
        count(*) FILTER (WHERE date_trunc('month', t.completed_at AT TIME ZONE '${COMPANY_TZ}')
          = date_trunc('month', now() AT TIME ZONE '${COMPANY_TZ}'))::int AS this_month,
        count(*) FILTER (WHERE t.expires_at <= now() + interval '7 days')::int AS expiring,
        count(DISTINCT nullif(btrim(t.company), ''))::int AS companies
      FROM transfers t WHERE t.status = 'complete' AND t.expires_at > now()`),
    client.query(`SELECT count(f.id)::int AS files, coalesce(sum(f.size), 0)::bigint AS total_size
      FROM transfer_files f JOIN transfers t ON t.id = f.transfer_id
      WHERE t.status = 'complete' AND t.expires_at > now()`),
    client.query(`SELECT t.id, t.title, t.company, t.sender_email, t.expires_at, t.completed_at
      FROM transfers t WHERE t.status = 'complete' AND t.expires_at > now()
      ORDER BY t.completed_at DESC NULLS LAST, t.id DESC LIMIT 8`),
    client.query(`SELECT coalesce(nullif(btrim(t.company), ''), 'Untitled company') AS company,
        count(*)::int AS transfers
      FROM transfers t WHERE t.status = 'complete' AND t.expires_at > now()
      GROUP BY 1 ORDER BY transfers DESC, company ASC LIMIT 8`),
    client.query(`SELECT (t.completed_at AT TIME ZONE '${COMPANY_TZ}')::date AS calendar_days,
        count(DISTINCT t.id)::int AS transfer_count,
        count(f.id)::int AS file_count,
        coalesce(sum(f.size), 0)::bigint AS total_size
      FROM transfers t JOIN transfer_files f ON f.transfer_id = t.id
      WHERE t.status = 'complete' AND t.expires_at > now()
      AND (t.completed_at AT TIME ZONE '${COMPANY_TZ}') >= $1::date
      AND (t.completed_at AT TIME ZONE '${COMPANY_TZ}') < ($1::date + interval '1 month')
      GROUP BY 1 ORDER BY 1`, [monthStart]),
  ]);
  const stats = statsResult.rows[0] || {};
  const fileStats = filesResult.rows[0] || {};
  return employeeJson({
    timezone: COMPANY_TZ,
    today: chicagoDate(new Date()),
    month: { year, month, key, label: `${MONTHS[month - 1]} ${year}` },
    stats: {
      transfers: Number(stats.transfers || 0),
      files: Number(fileStats.files || 0),
      totalSize: Number(fileStats.total_size || 0),
      companies: Number(stats.companies || 0),
      today: Number(stats.today || 0),
      thisMonth: Number(stats.this_month || 0),
      expiring: Number(stats.expiring || 0),
    },
    recent: await filesForTransfers(client, recentResult.rows),
    companies: companiesResult.rows.map((row) => ({ company: row.company, transfers: Number(row.transfers) })),
    days: daysResult.rows.map((row) => ({
      date: sqlDate(row.calendar_days),
      transferCount: Number(row.transfer_count),
      fileCount: Number(row.file_count),
      totalSize: Number(row.total_size),
    })),
  });
});

export const employeeCalendar = employeeEndpoint(async (request) => {
  const client = employeeDatabase();
  const employee = await requireEmployee(request, client);
  const date = parseDay(new URL(request.url).searchParams.get("date"));
  const { rows } = await client.query(`SELECT t.id, t.title, t.company, t.sender_email, t.expires_at, t.completed_at
    FROM transfers t WHERE t.status = 'complete' AND t.expires_at > now()
    AND (t.completed_at AT TIME ZONE '${COMPANY_TZ}')::date = $1::date
    ORDER BY t.completed_at DESC, t.id DESC LIMIT 200`, [date]);
  return employeeJson({ date, label: dateLabel(date), transfers: await filesForTransfers(client, rows) });
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
