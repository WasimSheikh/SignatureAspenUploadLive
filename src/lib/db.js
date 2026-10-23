import pg from "pg";
import { config } from "./config.js";
import { fail } from "./security.mjs";

let pool;
export function db() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config().databaseUrl, max: config().poolMax,
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on("error", () => console.error("Database pool connection error."));
  }
  return pool;
}

export async function withTransferLock(id, action) {
  const client = await db().connect();
  let locked = false;
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [id]);
    locked = rows[0].locked;
    if (!locked) fail(409, "This transfer is busy. Please try again shortly.");
    return await action(client);
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [id]);
      client.release();
    } catch {
      client.release(true);
    }
  }
}

export async function getTransfer(client, id) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) fail(404, "Transfer not found.");
  const { rows } = await client.query("SELECT * FROM transfers WHERE id = $1", [id]);
  if (!rows[0]) fail(404, "Transfer not found.");
  return rows[0];
}

export async function getFiles(client, id) {
  const { rows } = await client.query("SELECT * FROM transfer_files WHERE transfer_id = $1 ORDER BY ordinal", [id]);
  return rows;
}

export async function recordAccess(client, id, event, fileId = null) {
  await client.query("INSERT INTO transfer_access_events (transfer_id, event, file_id) VALUES ($1, $2, $3)", [id, event, fileId]);
}
