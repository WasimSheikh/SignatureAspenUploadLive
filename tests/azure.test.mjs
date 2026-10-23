import test from "node:test";
import assert from "node:assert/strict";
import { randomId, BASE_PART_SIZE } from "../src/lib/security.mjs";
import { mockAzure } from "./azure-fixture.mjs";

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || "postgres://localhost/not-used",
  AZURE_STORAGE_ACCOUNT_NAME: "testaccount", AZURE_STORAGE_CONTAINER: "test-container",
  AZURE_STORAGE_ACCOUNT_KEY: Buffer.from("nonfunctional-test-key").toString("base64"),
  RESEND_API_KEY: "test-resend", FROM_EMAIL: "transfers@example.com", APP_URL: "https://example.com",
  CRON_SECRET: "test-cron-secret-with-at-least-32-characters",
  COOKIE_SECRET: "test-cookie-secret-with-at-least-32-characters",
});
const storage = await import("../src/lib/storage.js");
async function fixture(size = BASE_PART_SIZE + 3) {
  const azure = mockAzure();
  const id = randomId(), transferId = randomId();
  const file = { id, transfer_id: transferId, object_key: `transfers/${transferId}/${id}`,
    size, part_size: BASE_PART_SIZE, name: "large.psd" };
  file.upload_id = await storage.initiateFile(file);
  const upload = azure.uploads.get(file.object_key);
  upload.parts = Array.from({ length: Math.ceil(size / BASE_PART_SIZE) }, (_, index) => ({
    PartNumber: index + 1, Size: Math.min(BASE_PART_SIZE, size - index * BASE_PART_SIZE),
  }));
  return { azure, file, upload };
}

test("Azure uploads expose write-only blob-scoped HTTPS SAS on staging, never final", async () => {
  const { azure, file } = await fixture();
  try {
    const transfer = { expires_at: new Date(Date.now() + 65000) };
    const url = new URL(await storage.signPart(transfer, file, 2));
    assert.equal(url.protocol, "https:");
    assert.equal(url.searchParams.get("spr"), "https");
    assert.equal(url.searchParams.get("sp"), "w");
    assert.equal(url.searchParams.get("sr"), "b");
    assert.equal(url.searchParams.get("comp"), "block");
    assert.equal(url.searchParams.get("blockid"), storage.blockId(file, 2));
    assert.ok(url.pathname.includes("/staging/"));
    assert.ok(!url.pathname.includes("/transfers/"));
    assert.ok(new Date(url.searchParams.get("se")).getTime() <= transfer.expires_at.getTime());
    assert.equal(Buffer.from(storage.blockId(file, 1), "base64").length, Buffer.from(storage.blockId(file, 640), "base64").length);
    const download = new URL(await storage.signDownload(transfer, file));
    assert.equal(download.searchParams.get("sp"), "r");
    assert.ok(download.pathname.includes("/transfers/"));
    assert.ok(!download.toString().includes(process.env.AZURE_STORAGE_ACCOUNT_KEY));
  } finally { azure.restore(); }
});

test("Azure exact block sizes, deterministic IDs and private metadata survive recovery", async () => {
  const { azure, file, upload } = await fixture();
  try {
    const parts = await storage.listParts(file);
    assert.deepEqual(parts.map((part) => part.Size), [BASE_PART_SIZE, 3]);
    upload.parts[1].Size = 4;
    await assert.rejects(storage.completeFile(file, () => assert.fail()), { status: 409 });
    assert.equal(upload.locked, false);
    upload.parts[1].Size = 3;
    let validated = false, copied = 0;
    azure.hook = (operation, key, options) => {
      if (operation === "stageBlockFromURL") {
        assert.equal(validated, true);
        assert.ok(key.startsWith("transfers/"));
        assert.ok(new URL(options.sourceUrl).pathname.includes("/staging/"));
        assert.equal(new URL(options.sourceUrl).searchParams.get("sp"), "r");
        assert.equal(new URL(options.sourceUrl).searchParams.get("snapshot"), file.azure_snapshot);
        assert.equal(new URL(options.sourceUrl).searchParams.get("sr"), "bs");
        copied++;
      }
    };
    await storage.completeFile(file, (saved, snapshotTime) => {
      assert.deepEqual(saved, parts.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag })));
      assert.ok(snapshotTime);
      validated = true;
    });
    assert.equal(copied, 2);
    assert.equal(upload.locked, true);
    assert.equal(azure.objects.get(file.object_key).size, file.size);
    assert.deepEqual(azure.objects.get(file.object_key).metadata, {
      file_id: file.id, transfer_id: file.transfer_id, upload_id: file.upload_id,
    });
    await storage.completeFile(file, () => assert.fail("Final completion must recover without recopy"));
    assert.equal(copied, 2);
    azure.objects.get(file.object_key).metadata.file_id = "wrong";
    await assert.rejects(storage.completeFile(file, () => {}), { status: 409 });
  } finally { azure.restore(); }
});

test("Azure validates committed sizes again when a browser races validation", async () => {
  const { azure, file, upload } = await fixture();
  try {
    azure.hook = (operation, key) => {
      if (operation === "commitBlockList" && key.startsWith("staging/")) {
        // Even a broken lease cannot smuggle changed per-block lengths into final.
        upload.parts[0].Size--;
        upload.parts[1].Size++;
      }
      if (operation === "stageBlockFromURL") assert.fail("Unvalidated committed blocks must not copy");
    };
    await assert.rejects(storage.completeFile(file, () => {}), { status: 409 });
    assert.equal(azure.objects.has(file.object_key), false);
  } finally { azure.restore(); }
});

test("Azure immutable snapshots survive a source rewrite even if a browser breaks the lease", async () => {
  const { azure, file, upload } = await fixture();
  try {
    azure.hook = (operation) => {
      if (operation === "stageBlockFromURL") upload.etag = '"attacker-version"';
    };
    await storage.completeFile(file, () => {});
    assert.equal(azure.objects.get(file.object_key).size, file.size);
  } finally { azure.restore(); }
});

test("Azure snapshot creation rejects a staging replacement after the validated commit", async () => {
  const { azure, file, upload } = await fixture();
  try {
    azure.hook = (operation) => {
      if (operation === "createSnapshot") upload.etag = '"browser-raced-snapshot"';
      if (operation === "stageBlockFromURL") assert.fail("Changed source must not be copied");
    };
    await assert.rejects(storage.completeFile(file, () => {}), { statusCode: 412 });
    assert.equal(azure.objects.size, 0);
  } finally { azure.restore(); }
});

test("Azure 10 GiB completion copies bounded ranges without app buffering and resumes staged final blocks", async () => {
  const { azure, file, upload } = await fixture(10 * 1024 ** 3);
  try {
    let copied = 0, shouldFail = true;
    azure.hook = (operation, _key, options) => {
      if (operation !== "stageBlockFromURL") return;
      copied++;
      assert.ok(options.size <= BASE_PART_SIZE);
      assert.ok(options.offset + options.size <= file.size);
      if (shouldFail && copied === 20) throw new Error("interrupted");
    };
    await assert.rejects(storage.completeFile(file, () => {}), /interrupted/);
    const count = azure.objects.get(file.object_key).parts.length;
    assert.ok(count > 0);
    assert.ok(file.azure_snapshot);
    const reloadedFile = { ...file };
    upload.parts = [];
    upload.etag = '"browser-replaced-base"';
    shouldFail = false;
    copied = 0;
    await storage.completeFile(reloadedFile, () => {});
    assert.equal(copied, 640 - count);
    assert.equal(azure.snapshots.size, 1);
    assert.equal(azure.objects.get(file.object_key).size, 10 * 1024 ** 3);
  } finally { azure.restore(); }
});

test("Azure cleanup deletes locked staging, reaps recreated cancelled orphans, preserves live finals", async () => {
  const { azure, file, upload } = await fixture();
  try {
    await storage.completeFile(file, () => {});
    const final = azure.objects.get(file.object_key);
    await storage.removeFile(file);
    assert.equal(azure.objects.size, 0);
    assert.equal(azure.uploads.size, 0);
    assert.equal(azure.snapshots.size, 0);
    azure.uploads.set(file.object_key, { ...upload, uncommittedOnly: true, locked: false });
    let materialized = false;
    azure.hook = (operation) => { if (operation === "upload") materialized = true; };
    assert.equal(await storage.cleanupStaging(async () => true), 0);
    assert.equal(materialized, false);
    assert.equal(await storage.cleanupStaging(async () => false), 1);
    assert.equal(materialized, true);
    assert.equal(azure.uploads.size, 0);
    azure.uploads.set(file.object_key, { ...upload, locked: false });
    azure.objects.set(file.object_key, final);
    assert.equal(await storage.cleanupStaging(async () => true), 0);
    assert.equal(await storage.cleanupStaging(async () => false), 1);
    assert.equal(azure.uploads.size, 0);
    assert.equal(azure.objects.get(file.object_key), final);
    await storage.removeFile(file);
  } finally { azure.restore(); }
});

test("Azure refuses legacy provider rows for upload, download, completion and NAS streaming", async () => {
  const { azure, file } = await fixture();
  try {
    const legacy = { ...file, upload_id: "old-s3-upload-id", completed: true };
    for (const operation of [
      () => storage.listParts(legacy), () => storage.signPart({ expires_at: new Date(Date.now() + 60000) }, legacy, 1),
      () => storage.signDownload({ expires_at: new Date(Date.now() + 60000) }, legacy),
      () => storage.completeFile(legacy, () => {}), () => storage.objectStream(legacy), () => storage.removeFile(legacy),
    ]) await assert.rejects(operation(), { status: 409 });
    const controller = new AbortController();
    azure.hook = (operation, _key, options) => {
      if (operation === "download") assert.equal(options.abortSignal, controller.signal);
    };
    assert.ok(await storage.objectStream(file, controller.signal));
  } finally { azure.restore(); }
});

test("Azure staging GC reaches orphans behind a full page of live uploads", async () => {
  const { azure, file, upload } = await fixture();
  try {
    azure.uploads.clear();
    for (let index = 0; index < 500; index++) {
      const transferId = randomId(), fileId = randomId();
      azure.uploads.set(`transfers/${transferId}/${fileId}`, {
        ...upload, key: `staging/${transferId}/${fileId}/${file.upload_id.slice("azure-v1:".length)}`,
      });

    }
    azure.uploads.set(file.object_key, upload);
    assert.equal(await storage.cleanupStaging(async (transferId) => transferId !== file.transfer_id), 1);
    assert.equal(azure.uploads.size, 500);
    assert.equal(azure.uploads.has(file.object_key), false);
  } finally { azure.restore(); }
});

test("Azure cancellation discards uncommitted final blocks when HEAD and DELETE would return 404", async () => {
  const { azure, file } = await fixture();
  try {
    azure.objects.set(file.object_key, { uncommittedOnly: true, parts: [{ name: "partial", size: 3 }] });
    let discarded = false;
    azure.hook = (operation, key) => { if (operation === "upload" && key === file.object_key) discarded = true; };
    await storage.removeFile(file);
    assert.equal(discarded, true);
    assert.equal(azure.objects.size, 0);
    assert.equal(azure.uploads.size, 0);
  } finally { azure.restore(); }
});
