import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, symlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { nasConfig, signNasToken, verifyNasToken, byteRange } from "../src/lib/nas-security.mjs";
import { withNasRoot, withNasDirectory, mirrorNasFile, openNasFile, removeNasTransfer, networkMountFor } from "../src/lib/nas-files.mjs";

const id = "a".repeat(32);
const fileId = "b".repeat(32);
const secret = "nas-test-independent-secret-value-123456789";
const scope = { transferId: id, fileId, employeeId: "employee-id", sessionHash: "c".repeat(64) };
const now = 1700000000000;

test("mount validation rejects disconnected mounts and local underlying fallback directories", () => {
  const mounted = [
    "1 0 0:1 / / rw - ext4 /dev/sda1 rw",
    "2 1 0:2 / /mnt/nas rw - cifs //nas/share rw",
  ].join("\n");
  assert.deepEqual(networkMountFor("/mnt/nas/transfers", mounted), { mount: "/mnt/nas", type: "cifs" });
  assert.throws(() => networkMountFor("/mnt/nas/transfers", mounted.split("\n")[0]));
  assert.throws(() => networkMountFor("/mnt/nasty/transfers", mounted));
  assert.throws(() => networkMountFor("/mnt/nas/transfers", `${mounted}\n3 2 0:3 / /mnt/nas/transfers rw - ext4 /dev/sdb1 rw`));
  assert.equal(networkMountFor("/mnt/nas shared/transfers", "2 1 0:2 / /mnt/nas\\040shared rw - nfs4 nas:/share rw").type, "nfs4");
});

test("NAS disabled by default and configured origins cannot redirect to arbitrary paths", () => {
  assert.deepEqual(nasConfig({}), { enabled: false });
  const env = { NAS_ENABLED: "true", NAS_SIGNING_SECRET: secret, NAS_LOCAL_URL: "https://nas.example.test" };
  assert.equal(nasConfig(env).host, "127.0.0.1");
  for (const url of ["http://nas.example.test", "https://user@nas.example.test", "https://nas.example.test/path", "https://nas.example.test?x=y"]) {
    assert.throws(() => nasConfig({ ...env, NAS_LOCAL_URL: url }));
  }
  assert.throws(() => nasConfig({ ...env, COOKIE_SECRET: secret }));
  assert.throws(() => nasConfig({ ...env, NAS_BIND_HOST: "nas.example.test" }));
  assert.equal(nasConfig({ ...env, NAS_LOCAL_URL: "http://127.0.0.1:8787" }).enabled, true);
});

test("NAS worker publishes only exact complete copies, removes expired copies and retries failures safely", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "designfiles-nas-")));
  const previous = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgres://unused/test", S3_BUCKET: "unused", AWS_REGION: "us-east-1",
    RESEND_API_KEY: "unused", FROM_EMAIL: "sender@example.test", APP_URL: "https://app.example.test",
    CRON_SECRET: "test-cron-independent-value-1234567890", COOKIE_SECRET: "test-cookie-independent-value-1234567890",
  });
  const { db } = await import("../src/lib/db.js");
  const { storage } = await import("../src/lib/storage.js");
  const { syncNasTransfer } = await import("../src/lib/nas-worker.js");
  const pool = db();
  const originalConnect = pool.connect;
  const store = storage();
  const originalSend = store.send;
  const transfer = { id, status: "complete", expires_at: new Date(Date.now() + 120000) };
  const file = { id: fileId, transfer_id: id, completed: true, size: 6, object_key: "unused" };
  const statuses = [];
  let sourceText = "abcdef";
  let locked = false;
  pool.connect = async () => ({ release() {}, async query(sql) {
    if (sql.includes("pg_try_advisory_lock")) { locked = true; return { rows: [{ locked: true }] }; }
    if (sql.includes("pg_advisory_unlock")) { locked = false; return { rows: [] }; }
    if (sql.includes("SELECT * FROM transfers")) return { rows: [transfer] };
    if (sql.includes("FROM transfer_files")) return { rows: [file] };
    if (sql.includes("INSERT INTO nas_mirrors")) { statuses.push("syncing"); return { rows: [] }; }
    if (sql.includes("status='available'")) { statuses.push("available"); return { rows: [] }; }
    if (sql.includes("status='failed'")) { statuses.push("failed"); return { rows: [] }; }
    throw new Error("Unexpected worker query");
  } });
  store.send = async () => {
    assert.equal(locked, true);
    return { Body: Readable.from([Buffer.from(sourceText)]) };
  };
  try {
    await syncNasTransfer(id, { root });
    assert.deepEqual(statuses, ["syncing", "available"]);
    assert.equal((await readFile(`${root}/${id}/${fileId}`)).toString(), "abcdef");
    sourceText = "short";
    await assert.rejects(syncNasTransfer(id, { root }));
    assert.deepEqual(statuses.slice(-2), ["syncing", "failed"]);
    await assert.rejects(stat(`${root}/${id}`), { code: "ENOENT" });
    sourceText = "abcdef";
    await syncNasTransfer(id, { root });
    transfer.expires_at = new Date(Date.now() - 1);
    await syncNasTransfer(id, { root });
    assert.equal(statuses.at(-1), "failed");
    await assert.rejects(stat(`${root}/${id}`), { code: "ENOENT" });
    transfer.expires_at = new Date(Date.now() + 120000);
    await syncNasTransfer(id, { root });
    transfer.status = "deleted";
    await syncNasTransfer(id, { root });
    await assert.rejects(stat(`${root}/${id}`), { code: "ENOENT" });
    transfer.status = "complete";
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(syncNasTransfer(id, { root }, controller.signal));
    assert.equal(statuses.at(-1), "failed");
    await assert.rejects(stat(`${root}/${id}`), { code: "ENOENT" });
    assert.equal(locked, false);
  } finally {
    pool.connect = originalConnect;
    store.send = originalSend;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("NAS tokens bind employee, session, transfer and file; max lifetime is 60 seconds", () => {
  const token = signNasToken(scope, secret, now + 600000, now);
  assert.deepEqual(verifyNasToken(token, secret, now), { ...scope, v: 1, aud: "nas-download", iat: now / 1000, exp: now / 1000 + 60 });
  assert.throws(() => verifyNasToken(token, secret, now + 60000));
  assert.throws(() => verifyNasToken(token, "different-secret", now));
  assert.throws(() => verifyNasToken(`x${token}`, secret, now));
  assert.throws(() => verifyNasToken(token, secret, now - 1000));
  assert.throws(() => signNasToken({ ...scope, fileId: "../escape" }, secret, now + 60000, now));
  assert.throws(() => signNasToken(scope, secret, now, now));
  const short = signNasToken(scope, secret, now + 10000, now);
  assert.equal(verifyNasToken(short, secret, now).exp, now / 1000 + 10);
});

test("single byte ranges support normal, open and suffix requests; malformed/multiple rejected", () => {
  assert.deepEqual(byteRange(undefined, 20), { start: 0, end: 19, partial: false });
  assert.deepEqual(byteRange("bytes=5-", 20), { start: 5, end: 19, partial: true });
  assert.deepEqual(byteRange("bytes=-5", 20), { start: 15, end: 19, partial: true });
  assert.deepEqual(byteRange("bytes=2-100", 20), { start: 2, end: 19, partial: true });
  for (const range of ["bytes=20-", "bytes=4-2", "bytes=-0", "bytes=0-1,3-4", "bytes=-", "bytes=9007199254740993-"]) {
    assert.throws(() => byteRange(range, 20));
  }
});

test("NAS copies stream atomically, validate exact bytes, reject symlinks and remove all transfer files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "designfiles-nas-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "designfiles-nas-outside-")));
  const file = { id: fileId, size: 6 };
  try {
    await withNasDirectory(root, id, true, async (directory) => {
      await mirrorNasFile(directory, file, Readable.from([Buffer.from("abc"), Buffer.from("def")]));
      const handle = await openNasFile(directory, file);
      try { assert.equal((await handle.readFile()).toString(), "abcdef"); }
      finally { await handle.close(); }
      assert.equal((await stat(`${directory}/${fileId}`)).mode & 0o777, 0o600);
      await assert.rejects(mirrorNasFile(directory, file, Readable.from([Buffer.from("short")])));
      await assert.rejects(mirrorNasFile(directory, file, Readable.from([Buffer.from("toolong")])));
      assert.equal((await readFile(`${directory}/${fileId}`)).toString(), "abcdef");
      await assert.rejects(withNasDirectory(root, "../escape", true, () => {}));
      await writeFile(`${outside}/secret`, "secret");
      const linkId = "d".repeat(32);
      await symlink(`${outside}/secret`, `${directory}/${linkId}`);
      await assert.rejects(openNasFile(directory, { id: linkId, size: 6 }));
      await rm(`${directory}/${linkId}`);
    });

    await removeNasTransfer(root, id);
    await assert.rejects(stat(`${root}/${id}`), { code: "ENOENT" });
    await symlink(outside, `${root}/${id}`);
    await assert.rejects(withNasDirectory(root, id, false, () => {}));
    await assert.rejects(removeNasTransfer(root, id));
    await assert.rejects(withNasRoot(`${root}/${id}`, () => {}));
    assert.equal((await readFile(`${outside}/secret`)).toString(), "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("cloud employee issuance and local streaming enforce origin, session/ACL revocation, expiry and ranges", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "designfiles-nas-")));
      const uuid = "11111111-1111-4111-8111-111111111111";
      const previous = { ...process.env };
      Object.assign(process.env, {
        DATABASE_URL: "postgres://unused/test", S3_BUCKET: "unused", AWS_REGION: "us-east-1",
        RESEND_API_KEY: "unused", FROM_EMAIL: "sender@example.test", APP_URL: "https://app.example.test",
        CRON_SECRET: "test-cron-independent-value-1234567890", COOKIE_SECRET: "test-cookie-independent-value-1234567890",
        ENTRA_TENANT_ID: uuid, ENTRA_CLIENT_ID: uuid, ENTRA_CLIENT_SECRET: "unused",
        ENTRA_ALLOWED_GROUP_IDS: uuid, ENTRA_ADMIN_GROUP_IDS: "",
        NAS_ENABLED: "true", NAS_SIGNING_SECRET: secret, NAS_LOCAL_URL: "https://nas.example.test",
      });
      const { db } = await import("../src/lib/db.js");
      const { nasRequestHandler } = await import("../src/lib/nas-server.js");
      const { localDownload } = await import("../src/lib/nas.js");
      const { hashToken } = await import("../src/lib/security.mjs");
      const { SESSION_COOKIE } = await import("../src/lib/employee-security.mjs");
      const cookie = "s".repeat(43);
      const transfer = { id, status: "complete", expires_at: new Date(Date.now() + 120000) };
      const file = { id: fileId, transfer_id: id, completed: true, name: "test file.txt", size: 6 };
      let sessionActive = true;
      let sessionExpiresAt = Date.now() + 120000;
      let mirrorStatus = "available";
      let allowed = true;
      let locked = false;
      const events = [];
      const client = { release() {}, async query(sql, params) {
        if (sql.includes("pg_try_advisory_lock")) { locked = true; return { rows: [{ locked: true }] }; }
        if (sql.includes("pg_advisory_unlock")) { locked = false; return { rows: [] }; }
        if (sql.includes("FROM employee_sessions")) return { rows: sessionActive && sessionExpiresAt > Date.now() ? [{ employee_id: uuid, group_ids: [uuid] }] : [] };
        if (sql.includes("SELECT t.id FROM transfers")) return { rows: allowed ? [{ id }] : [] };
        if (sql.includes("SELECT * FROM transfers")) return { rows: [transfer] };
        if (sql.includes("FROM transfer_files")) return { rows: [file] };
        if (sql.includes("FROM nas_mirrors")) return { rows: mirrorStatus ? [{ status: mirrorStatus }] : [] };
        if (sql.includes("UPDATE nas_mirrors")) { mirrorStatus = "failed"; return { rows: [] }; }
        if (sql.includes("INSERT INTO transfer_access_events")) { events.push(params[1]); return { rows: [] }; }
        throw new Error(`Unexpected query: ${sql}`);
      } };
      const pool = db();
      const originalConnect = pool.connect;
      pool.connect = async () => client;
      const server = createServer(nasRequestHandler({ secret, origin: "https://nas.example.test", root }));
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const address = `http://127.0.0.1:${server.address().port}`;
      const post = (origin = process.env.APP_URL) => localDownload(new Request(`${process.env.APP_URL}/api/employee/transfers/${id}/local`, {
        method: "POST", headers: { origin, cookie: `${SESSION_COOKIE}=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      }), { params: Promise.resolve({ id }) });
      try {
        await withNasDirectory(root, id, true, (directory) => mirrorNasFile(directory, file, Readable.from(["abcdef"])));
        assert.equal((await post("https://evil.example.test")).status, 403);
        const issued = await post();
        assert.equal(issued.status, 200);
        const { url } = await issued.json();
        assert.equal(new URL(url).origin, "https://nas.example.test");
        const token = new URL(url).searchParams.get("token");
        assert.equal(verifyNasToken(token, secret).sessionHash, hashToken(cookie));
        const target = `${address}/download?token=${token}`;
        const full = await fetch(target);
        assert.equal(full.status, 200);
        assert.equal(await full.text(), "abcdef");
        await new Promise((done) => setTimeout(done, 10));
        assert.equal(locked, false);
        const range = await fetch(target, { headers: { Range: "bytes=1-3" } });
        assert.equal(range.status, 206);
        assert.equal(range.headers.get("content-range"), "bytes 1-3/6");
        assert.equal(await range.text(), "bcd");
        const head = await fetch(target, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get("content-length"), "6");
        assert.equal((await fetch(target, { headers: { Range: "bytes=50-" } })).status, 416);
        sessionActive = false;
        assert.equal((await fetch(target)).status, 403);
        assert.equal((await post()).status, 401);
        sessionActive = true;
        sessionExpiresAt = Date.now() - 1;
        assert.equal((await fetch(target)).status, 403);
        sessionExpiresAt = Date.now() + 120000;
        allowed = false;
        assert.equal((await fetch(target)).status, 404);
        allowed = true;
        mirrorStatus = null;
        assert.equal((await fetch(target)).status, 409);
        assert.equal((await post()).status, 409);
        mirrorStatus = "failed";
        assert.equal((await fetch(target)).status, 409);
        mirrorStatus = "available";
        transfer.status = "deleted";
        assert.equal((await fetch(target)).status, 410);
        transfer.status = "deleting";
        assert.equal((await fetch(target)).status, 410);
        transfer.status = "complete";
        transfer.expires_at = new Date(Date.now() - 1);
        assert.equal((await fetch(target)).status, 410);
        assert.equal((await fetch(`${address}/download?token=invalid`)).status, 401);
        assert.ok(events.includes("local_download_authorized"));
        assert.ok(events.includes("local_file_download"));
      } finally {
        await new Promise((done) => server.close(done));
        pool.connect = originalConnect;
        await pool.end();
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
        await rm(root, { recursive: true, force: true });
      }
});
