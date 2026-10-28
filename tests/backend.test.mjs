import test from "node:test";
import assert from "node:assert/strict";
import { mockAzure } from "./azure-fixture.mjs";
import { readFile } from "node:fs/promises";
import { randomId, hashToken, HttpError, BASE_PART_SIZE, signUnlock } from "../src/lib/security.mjs";

// These are nonfunctional test credentials; all storage calls are stubbed below.
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL || "postgres://localhost/not-used",
  AZURE_STORAGE_ACCOUNT_NAME: "testaccount", AZURE_STORAGE_CONTAINER: "test-container",
  AZURE_STORAGE_ACCOUNT_KEY: Buffer.from("nonfunctional-test-key").toString("base64"),
  RESEND_API_KEY: "test-resend", FROM_EMAIL: "transfers@example.com", GRAPH_SENDER_EMAIL: "transfers@example.com",
  APP_URL: "https://example.com",
  CRON_SECRET: "test-cron-secret-with-at-least-32-characters",
  COOKIE_SECRET: "test-cookie-secret-with-at-least-32-characters",
});
const http = await import("../src/lib/http.js");
const { config } = await import("../src/lib/config.js");
const storage = await import("../src/lib/storage.js");
const id = randomId(), token = randomId();
const transfer = {
  id, upload_token_hash: hashToken(token), status: "complete",
  expires_at: new Date(Date.now() + 3600000), title: "Title", company: "Company",
  message: "Message", sender_email: "sender@example.com", passcode_hash: null,
};
const file = {
  id: randomId(), transfer_id: id, object_key: "test/key", name: "design.pdf",
  size: BASE_PART_SIZE + 3, part_size: BASE_PART_SIZE, upload_id: "azure-v1:12345678-1234-1234-1234-123456789abc", completed: false,
};

test("mutation origins are exact and mandatory", () => {
  for (const origin of [null, "https://evil.example", "https://example.com.evil", "null", "http://example.com"]) {
    assert.throws(() => http.requireOrigin(new Request("https://example.com/api/transfers", {
      headers: origin ? { origin } : {},
    })), { status: 403 });
  }
  assert.doesNotThrow(() => http.requireOrigin(new Request("https://example.com/api/transfers", {
    headers: { origin: "https://example.com" },
  })));
});

test("upload capability is required and expired transfers never authorize", () => {
  const authorized = new Request("https://example.com", { headers: { authorization: ["Bearer", token].join(" ") } });
  assert.doesNotThrow(() => http.requireUploadToken(authorized, transfer));
  for (const authorization of ["", token, ["Bearer", randomId()].join(" "), ["Bearer", token, "extra"].join(" ")]) {
    assert.throws(() => http.requireUploadToken(new Request("https://example.com", { headers: { authorization } }), transfer), { status: 401 });
  }
  assert.throws(() => http.requireUploadToken(authorized, { ...transfer, expires_at: new Date(0) }), { status: 410 });
  for (const status of ["expired", "deleted", "deleting"]) {
    assert.throws(() => http.requireLive({ ...transfer, status }), { status: 410 });
  }
});

test("protected metadata requires an authentic scoped cookie", () => {
  const protectedTransfer = { ...transfer, passcode_hash: "hashed" };
  const request = new Request("https://example.com");
  assert.equal(http.isUnlocked(request, protectedTransfer), false);
  assert.throws(() => http.requirePublic(request, protectedTransfer), { status: 403 });
  const cookie = `transfer_unlock_${id}=${signUnlock(id, config().cookieSecret)}`;
  assert.doesNotThrow(() => http.requirePublic(new Request("https://example.com", { headers: { cookie } }), protectedTransfer));
  assert.throws(() => http.requirePublic(request, { ...transfer, status: "uploading" }), { status: 404 });
  const metadata = http.publicMetadata(transfer, [file]);
  assert.deepEqual(Object.keys(metadata).sort(), ["company", "expiresAt", "files", "id", "message", "requiresPasscode", "senderEmail", "title"].sort());
  assert.deepEqual(metadata.files, [{ id: file.id, name: file.name, size: file.size }]);
  assert.ok(!JSON.stringify(metadata).includes(file.upload_id));
});

test("JSON parser is bounded and rejects malformed or non-object input", async () => {
  const make = (body, contentType = "application/json") => new Request("https://example.com", {
    method: "POST", body, headers: { "content-type": contentType },
  });
  assert.deepEqual(await http.readJson(make('{"ok":true}')), { ok: true });
  for (const body of ["null", "[]", '"string"', "{"]) await assert.rejects(http.readJson(make(body)), { status: 400 });
  await assert.rejects(http.readJson(make("{}", "text/plain")), { status: 415 });
  await assert.rejects(http.readJson(make("{}", "application/json-unrecognized")), { status: 415 });
  await assert.rejects(http.readJson(make(JSON.stringify({ text: "a".repeat(128 * 1024) }))), { status: 413 });
});

test("API errors are safe and all JSON responses prohibit caching", async () => {
  const safe = http.json({ ok: true });
  assert.equal(safe.headers.get("cache-control"), "no-store");
  const expected = await http.endpoint(() => { throw new HttpError(409, "Conflict."); })(new Request("https://example.com"));
  assert.equal(expected.status, 409);
  assert.deepEqual(await expected.json(), { error: "Conflict." });
  const original = console.error;
  console.error = () => {};
  try {
    const response = await http.endpoint(() => { throw new Error("DATABASE_URL=private"); })(new Request("https://example.com"));
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private"));
  } finally {
    console.error = original;
  }
});

test("proof transfers send the customer a download link, not the inbound confirmation", async () => {
  const { isProofTransfer } = await import("../src/lib/email.js");
  assert.equal(isProofTransfer({ message: "Purpose: proof\nFrom: Wasim Sheikh" }), true);
  assert.equal(isProofTransfer({ purpose: "proof" }), true);
  assert.equal(isProofTransfer({ message: "From: Jordan\nFinal art" }), false);
});

test("staff and customer email links go to dashboard, transfer, or prefilled upload", async () => {
  const { dashboardUrl, dashboardUploadsUrl, publicUrl, uploadRequestUrl } = await import("../src/lib/email.js");
  assert.equal(dashboardUrl("https://files.example"), "https://files.example/dashboard");
  assert.equal(dashboardUploadsUrl("https://files.example"), "https://files.example/dashboard?tab=files");
  assert.match(publicUrl("TransferId012345678901234567890"), /\/transfer\/TransferId012345678901234567890$/);
  assert.equal(
    uploadRequestUrl({ id: "jturner" }, { number: "1042", title: "Trade show", company: "Acme" }, "https://files.example"),
    "https://files.example/?contact=jturner&job=1042&title=Trade+show&company=Acme",
  );
});

test("new transfers store files under a Houston calendar date path", () => {
  const transferId = "A".repeat(32), fileId = "B".repeat(32);
  assert.equal(storage.dateObjectKey(transferId, fileId, new Date("2026-10-27T18:00:00Z")),
    `transfers/2026/10/27/${transferId}/${fileId}`);
  // 04:00 UTC Oct 28 is still 11pm CDT Oct 27.
  assert.equal(storage.dateObjectKey(transferId, fileId, new Date("2026-10-28T04:00:00Z")),
    `transfers/2026/10/27/${transferId}/${fileId}`);
});

test("part and download signatures contain bounded expiry and no unsafe content disposition", async () => {
  const url = new URL(await storage.signPart(transfer, file, 2));
  assert.equal(url.searchParams.get("blockid"), storage.blockId(file, 2));
  assert.equal(url.searchParams.get("comp"), "block");
  assert.equal(url.searchParams.get("sp"), "w");
  assert.ok(new Date(url.searchParams.get("se")).getTime() <= Date.now() + 900000);
  await assert.rejects(storage.signPart(transfer, file, 3), { status: 400 });
  await assert.rejects(storage.signPart(transfer, { ...file, completed: true }, 1), { status: 409 });
  const download = new URL(await storage.signDownload(transfer, { ...file, name: 'draft "final".pdf' }));
  assert.equal(download.searchParams.get("sp"), "r");
  assert.ok(new Date(download.searchParams.get("se")).getTime() <= Date.now() + 300000);
  assert.match(download.searchParams.get("rscd"), /filename="draft _final_\.pdf"/);
  assert.equal(download.searchParams.get("rsct"), "application/octet-stream");
  await assert.rejects(storage.signDownload({ ...transfer, expires_at: new Date(0) }, file), { status: 410 });
});

test("object downloads return a streaming source", async () => {
  const azure = mockAzure();
  try {
    const body = await storage.objectStream(file);
    let value = "";
    for await (const chunk of body) value += chunk;
    assert.equal(value, "PDF");
  } finally { azure.restore(); }
});

test("delivery emails include escaped file inventories in HTML and readable plain text", async () => {
  const { sendTransferEmails } = await import("../src/lib/email.js");
  const originalFetch = globalThis.fetch;
  const deliveries = [];
  const client = {
    query: async (sql) => ({
      rows: sql.startsWith("SELECT * FROM transfer_files")
        ? [{ name: '<asset "final">.pdf', size: 2048 }, { name: "large.psd", size: 12 * 1024 ** 3 }]
        : [],
    }),
  };
  try {
    globalThis.fetch = async (_url, options) => {
      deliveries.push(JSON.parse(options.body));
      return Response.json({ id: randomId() });
    };
    assert.equal(await sendTransferEmails(client, {
      ...transfer, recipient_emails: ["recipient@example.com"], email_results: {}, email_status: "pending",
    }), "sent");
    assert.equal(deliveries.length, 2);
    for (const delivery of deliveries) {
      assert.ok(delivery.html.includes("&lt;asset &quot;final&quot;&gt;.pdf"));
      assert.ok(!delivery.html.includes('<asset "final">'));
      assert.ok(delivery.html.includes("2,048 bytes"));
      assert.ok(delivery.html.includes("12,884,901,888 bytes"));
      assert.ok(delivery.text.includes('- <asset "final">.pdf — 2,048 bytes'));
      assert.ok(delivery.text.includes("- large.psd — 12,884,901,888 bytes"));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PostgreSQL-backed lifecycle: resume, protected delivery, email idempotency, ZIP, cancel and expiry", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { db } = await import("../src/lib/db.js");
  const handlers = await import("../src/lib/transfers.js");
  const { downloadTransfer } = await import("../src/lib/downloads.js");
  const { cleanupTransfers } = await import("../src/lib/cleanup.js");
  const pool = db();
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const azure = mockAzure(), originalFetch = globalThis.fetch;
  const { objects, uploads } = azure;
  const deliveries = [], createdIds = [];
  let failRecipient = null;
  const request = (path, method = "GET", body, capability, cookie) => {
    const headers = { origin: "https://example.com" };
    if (capability) headers.authorization = ["Bearer", capability].join(" ");
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(`https://example.com/api/transfers${path}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  const context = (transferId) => ({ params: Promise.resolve({ id: transferId }) });
  const metadata = {
    senderEmail: "sender@example.com", recipientEmails: "recipient@example.com",
    company: "Studio", title: "<script>Title</script>", message: "<img src=x onerror=alert(1)>",
    retentionDays: 7, passcode: "test1234", files: [{ name: "artwork.pdf", size: 3, type: "application/pdf" }],
  };
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://api.resend.com/emails");
      const delivery = JSON.parse(options.body);
      deliveries.push(delivery);
      if (delivery.to[0] === failRecipient) {
        failRecipient = null;
        return Response.json({ name: "validation_error", message: "Test rejection" }, { status: 422 });
      }
      return Response.json({ id: randomId() });
    };
    const create = await handlers.createTransfer(request("", "POST", metadata));
    assert.equal(create.status, 201, await create.clone().text());
    const upload = await create.json();
    createdIds.push(upload.id);
    const ctx = context(upload.id), path = `/${upload.id}`;
    assert.ok(!JSON.stringify(upload).includes("upload_id"));
    assert.ok(!JSON.stringify(upload).includes("object_key"));
    assert.equal((await handlers.readTransfer(request(path), ctx)).status, 404);
    assert.equal((await handlers.createPart(request(`${path}/parts`, "POST", {
      fileId: upload.files[0].id, partNumber: 1,
    }), ctx)).status, 401);
    assert.equal((await handlers.createPart(request(`${path}/parts`, "POST", {
      fileId: upload.files[0].id, partNumber: 1,
    }, upload.uploadToken), ctx)).status, 200);
    const parallelSignatures = await Promise.all(Array.from({ length: 3 }, () =>
      handlers.createPart(request(`${path}/parts`, "POST", {
        fileId: upload.files[0].id, partNumber: 1,
      }, upload.uploadToken), ctx)));
    assert.deepEqual(parallelSignatures.map((response) => response.status), [200, 200, 200]);
    const empty = await handlers.completeTransfer(request(`${path}/complete`, "POST", {}, upload.uploadToken), ctx);
    assert.equal(empty.status, 409);
    assert.equal(deliveries.length, 0);
    const pending = await pool.query("SELECT * FROM transfer_files WHERE transfer_id=$1", [upload.id]);
    const stagingUploadKey = (file) => `transfers/${file.transfer_id}/${file.id}`;
    assert.match(pending.rows[0].object_key, new RegExp(`^transfers/\\d{4}/\\d{2}/\\d{2}/${upload.id}/${upload.files[0].id}$`));
    uploads.get(stagingUploadKey(pending.rows[0])).parts = [{ PartNumber: 1, ETag: '"uploaded"', Size: 3 }];
    const resumed = await handlers.uploadStatus(request(`${path}/upload`, "GET", undefined, upload.uploadToken), ctx);
    assert.deepEqual((await resumed.json()).files[0].parts, [{ partNumber: 1, etag: storage.blockId(pending.rows[0], 1) }]);
    const complete = await handlers.completeTransfer(request(`${path}/complete`, "POST", {}, upload.uploadToken), ctx);
    assert.equal(complete.status, 200, await complete.clone().text());
    assert.deepEqual(await complete.json(), { url: `https://example.com/transfer/${upload.id}`, emailStatus: "sent", requiresPasscode: true });
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries[0].html.includes("&lt;script&gt;"));
    assert.ok(!deliveries[0].html.includes("<script>"));
    assert.ok(deliveries[0].html.includes("artwork.pdf — 3 bytes"));
    await handlers.completeTransfer(request(`${path}/complete`, "POST", {}, upload.uploadToken), ctx);
    assert.equal(deliveries.length, 2);
    const completedResume = await handlers.uploadStatus(request(`${path}/upload`, "GET", undefined, upload.uploadToken), ctx);
    assert.equal(completedResume.status, 200);
    const completedState = await completedResume.json();
    assert.equal(completedState.status, "complete");
    assert.equal(completedState.files[0].completed, true);
    assert.deepEqual(completedState.files[0].parts, [{ partNumber: 1, etag: storage.blockId(pending.rows[0], 1) }]);
    assert.deepEqual(await (await handlers.readTransfer(request(path), ctx)).json(), { id: upload.id, requiresPasscode: true });
    assert.equal((await downloadTransfer(request(`${path}/download`), ctx)).status, 403);
    assert.equal((await handlers.unlockTransfer(request(`${path}/unlock`, "POST", { passcode: "bad" }), ctx)).status, 403);
    const unlocked = await handlers.unlockTransfer(request(`${path}/unlock`, "POST", { passcode: "test1234" }), ctx);
    assert.equal(unlocked.status, 200);
    const setCookie = unlocked.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    assert.match(setCookie, /; Secure/);
    const cookie = setCookie.split(";")[0];
    const visible = await handlers.readTransfer(request(path, "GET", undefined, undefined, cookie), ctx);
    assert.equal((await visible.json()).files.length, 1);
    const download = await downloadTransfer(request(`${path}/download?file=${upload.files[0].id}`, "GET", undefined, undefined, cookie), ctx);
    assert.equal(download.status, 302);
    const archive = await downloadTransfer(request(`${path}/download`, "GET", undefined, undefined, cookie), ctx);
    assert.equal(archive.headers.get("content-type"), "application/zip");
    assert.match(archive.headers.get("content-disposition") || "", /filename="Studio - <script>Title<\/script>\.zip"/);
    const bytes = Buffer.from(await archive.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.ok(bytes.includes(Buffer.from("artwork.pdf")));
    assert.ok(bytes.includes(Buffer.from("PDF")));
    const events = await pool.query("SELECT event FROM transfer_access_events WHERE transfer_id=$1", [upload.id]);
    for (const event of ["view", "unlock", "unlock_failed", "file_download", "archive_download"]) {
      assert.ok(events.rows.some((row) => row.event === event));
    }
    const lock = await pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [upload.id]);
      assert.equal((await handlers.completeTransfer(request(`${path}/complete`, "POST", {}, upload.uploadToken), ctx)).status, 409);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [upload.id]);
      lock.release();
    }
    const cancel = await (await handlers.createTransfer(request("", "POST", metadata))).json();
    createdIds.push(cancel.id);
    assert.equal((await handlers.deleteTransfer(request(`/${cancel.id}`, "DELETE", undefined, cancel.uploadToken), context(cancel.id))).status, 200);
    assert.equal((await handlers.deleteTransfer(request(`/${cancel.id}`, "DELETE", undefined, cancel.uploadToken), context(cancel.id))).status, 200);
    const expire = await (await handlers.createTransfer(request("", "POST", {
      ...metadata, files: [...metadata.files, { name: "other.ai", size: 3 }],
    }))).json();
    createdIds.push(expire.id);
    const expireFiles = await pool.query("SELECT * FROM transfer_files WHERE transfer_id=$1 ORDER BY ordinal", [expire.id]);
    const partial = expireFiles.rows[0];
    objects.set(partial.object_key, { size: 3, metadata: uploads.get(stagingUploadKey(partial)).metadata });
    uploads.delete(stagingUploadKey(partial));
    await pool.query("UPDATE transfers SET expires_at = now() - interval '1 second', status='completing' WHERE id=$1", [expire.id]);
    assert.equal((await handlers.uploadStatus(request(`/${expire.id}/upload`, "GET", undefined, expire.uploadToken), context(expire.id))).status, 410);
    const cleanup = await cleanupTransfers(new Request("https://example.com/api/cron/cleanup", {
      headers: { authorization: ["Bearer", config().cronSecret].join(" ") },
    }));
    assert.equal(cleanup.status, 200, await cleanup.clone().text());
    assert.equal((await cleanup.json()).cleaned, 1);
    assert.equal(uploads.has(stagingUploadKey(pending.rows[0])), false);
    assert.equal(objects.has(pending.rows[0].object_key), true);
    const scrubbed = (await pool.query("SELECT * FROM transfers WHERE id=$1", [expire.id])).rows[0];
    assert.equal(scrubbed.status, "expired");
    assert.equal(scrubbed.sender_email, "");
    assert.equal((await pool.query("SELECT * FROM transfer_files WHERE transfer_id=$1", [expire.id])).rowCount, 0);
    assert.ok(!objects.has(partial.object_key));
    assert.ok(azure.deletes >= 3);
    await pool.query("UPDATE transfers SET expires_at=now() + interval '23 hours' WHERE id=$1", [upload.id]);
    config().reminders = true;
    const cronRequest = () => new Request("https://example.com/api/cron/cleanup", {
      headers: { authorization: ["Bearer", config().cronSecret].join(" ") },
    });
    const reminder = await cleanupTransfers(cronRequest());
    assert.equal((await reminder.json()).reminded, 1);
    const afterReminder = deliveries.length;
    assert.equal((await (await cleanupTransfers(cronRequest())).json()).reminded, 0);
    assert.equal(deliveries.length, afterReminder);
    config().reminders = false;
    const retry = await (await handlers.createTransfer(request("", "POST", { ...metadata, passcode: "" }))).json();
    createdIds.push(retry.id);
    const retryFile = (await pool.query("SELECT * FROM transfer_files WHERE transfer_id=$1", [retry.id])).rows[0];
    uploads.get(stagingUploadKey(retryFile)).parts = [{ PartNumber: 1, ETag: '"retry"', Size: 3 }];
    failRecipient = metadata.senderEmail;
    const failedEmail = await handlers.completeTransfer(request(`/${retry.id}/complete`, "POST", {}, retry.uploadToken), context(retry.id));
    assert.equal(failedEmail.status, 200);
    assert.equal((await failedEmail.json()).emailStatus, "failed");
    assert.equal((await handlers.readTransfer(request(`/${retry.id}`), context(retry.id))).status, 200);
    const deliveriesBeforeRetry = deliveries.length;
    const recoveredEmail = await handlers.completeTransfer(request(`/${retry.id}/complete`, "POST", {}, retry.uploadToken), context(retry.id));
    assert.equal((await recoveredEmail.json()).emailStatus, "sent");
    assert.equal(deliveries.length, deliveriesBeforeRetry + 1);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await handlers.unlockTransfer(request(`${path}/unlock`, "POST", { passcode: "wrong" }), ctx)).status, 403);
    }
    assert.equal((await handlers.unlockTransfer(request(`${path}/unlock`, "POST", { passcode: "test1234" }), ctx)).status, 429);
  } finally {
    azure.restore();
    globalThis.fetch = originalFetch;
    for (const transferId of createdIds) await pool.query("DELETE FROM transfers WHERE id=$1", [transferId]);
    await pool.end();
  }
});
