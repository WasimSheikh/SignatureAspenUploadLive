import test from "node:test";
import assert from "node:assert/strict";
import { uploadParts, UPLOAD_CONCURRENCY } from "../src/lib/upload-client.mjs";

function fixture() {
  const files = [Object.assign(new Blob(["abcdefghij"]), { name: "design.pdf" })];
  return { files, remoteFiles: [{ id: "file", name: "design.pdf", size: 10, partSize: 2, parts: [] }] };
}

test("parallel uploads are bounded and progress counts each byte exactly once", async () => {
  let active = 0, peak = 0;
  const parts = [];
  const updates = [];
  await uploadParts({
    ...fixture(), signal: new AbortController().signal,
    sign: async (_, part) => String(part),
    send: async (url, blob, signal, progress) => {
      active++;
      peak = Math.max(peak, active);
      parts.push(Number(url));
      progress(blob.size);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    },
    onProgress: (value) => updates.push(value),
  });
  assert.equal(peak, UPLOAD_CONCURRENCY);
  assert.deepEqual(parts.sort(), [1, 2, 3, 4, 5]);
  assert.equal(updates.at(-1).bytes, 10);
  assert.ok(updates.every(({ bytes, total, speed }) => bytes >= 0 && bytes <= total && speed >= 0));
});

test("resume skips completed parts and retries do not double-count progress", async () => {
  const input = fixture();
  input.remoteFiles[0].parts = [{ partNumber: 1, etag: "etag" }];
  const attempts = new Map();
  const updates = [];
  await uploadParts({
    ...input, signal: new AbortController().signal, retryDelay: 0,
    sign: async (_, part) => {
      assert.notEqual(part, 1);
      attempts.set(part, (attempts.get(part) || 0) + 1);
      return String(part);
    },
    send: async (url, blob, signal, progress) => {
      progress(blob.size);
      if (Number(url) === 2 && attempts.get(2) === 1) throw new Error("Disconnected");
    },
    onProgress: (value) => updates.push(value),
  });
  assert.equal(attempts.get(2), 2);
  assert.equal(updates[0].bytes, 2);
  assert.equal(updates.at(-1).bytes, 10);
  assert.ok(updates.every(({ bytes }) => bytes <= 10));
});

test("fatal failure aborts and settles sibling uploads before returning", async () => {
  let active = 0;
  const input = fixture();
  await assert.rejects(uploadParts({
    ...input, signal: new AbortController().signal, retryDelay: 0,
    sign: async (_, part) => String(part),
    send: async (url, blob, signal) => {
      if (url === "1") throw Object.assign(new Error("Forbidden"), { status: 403 });
      active++;
      try {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        });
      } finally { active--; }
    },
  }), /Forbidden/);
  assert.equal(active, 0);
});

test("pause aborts retry backoff promptly and does not start new jobs", async () => {
  const controller = new AbortController();
  const result = uploadParts({
    ...fixture(), signal: controller.signal,
    sign: async () => { throw new Error("Offline"); },
    onRetry: () => controller.abort(new DOMException("Paused", "AbortError")),
    send: () => assert.fail("No chunk should be sent"),
  });
  await assert.rejects(result, { name: "AbortError" });
});

test("completed transfers perform no PUTs; mismatched file lists are rejected", async () => {
  const input = fixture();
  input.remoteFiles[0].parts = [1, 2, 3, 4, 5].map((partNumber) => ({ partNumber }));
  let last;
  await uploadParts({
    ...input, signal: new AbortController().signal,
    sign: () => assert.fail("Already complete"), send: () => assert.fail("Already complete"),
    onProgress: (progress) => { last = progress; },
  });
  assert.equal(last.bytes, 10);
  await assert.rejects(uploadParts({ ...fixture(), remoteFiles: [], signal: new AbortController().signal }), /do not match/);
  await assert.rejects(uploadParts({ ...fixture(), concurrency: 0, signal: new AbortController().signal }), /concurrency/);
});
