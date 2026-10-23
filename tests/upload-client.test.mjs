import test from "node:test";
import assert from "node:assert/strict";
import { putPart, uploadParts, UPLOAD_CONCURRENCY } from "../src/lib/upload-client.mjs";

function fixture() {
  const files = [Object.assign(new Blob(["abcdefghij"]), { name: "design.pdf" })];
  return { files, remoteFiles: [{ id: "file", name: "design.pdf", size: 10, partSize: 2, parts: [] }] };
}

test("Azure Put Block sends raw bytes and accepts 201 without an ETag", async () => {
  const original = globalThis.XMLHttpRequest;
  let sent, method, target, progress;
  const blob = new Blob(["design block"]);
  const url = "https://account.blob.core.windows.net/transfers/staging/file?comp=block";
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(verb, address) { method = verb; target = address; }
    send(body) {
      sent = body;
      this.upload.onprogress({ loaded: body.size });
      this.status = 201;
      this.onload();
      this.onloadend();
    }
  };
  try {
    await putPart(url, blob, new AbortController().signal, (bytes) => { progress = bytes; });
    assert.equal(method, "PUT");
    assert.equal(target, url);
    assert.equal(sent, blob);
    assert.equal(progress, blob.size);
  } finally { globalThis.XMLHttpRequest = original; }
});

test("Azure block HTTP failures reject and a paused upload sends no request", async () => {
  const original = globalThis.XMLHttpRequest;
  let sent = 0;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open() {}
    send() {
      sent++;
      this.status = 403;
      this.onload();
      this.onloadend();
    }
  };
  try {
    await assert.rejects(putPart("https://example.com", new Blob(["data"]), new AbortController().signal, () => {}), /Azure Blob CORS/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(putPart("https://example.com", new Blob(["data"]), controller.signal, () => {}), { name: "AbortError" });
    assert.equal(sent, 1);
  } finally { globalThis.XMLHttpRequest = original; }
});

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

test("original filenames match server trimming and Unicode NFC normalization", async () => {
  const files = [Object.assign(new Blob(["data"]), { name: " cafe\u0301.pdf " })];
  let uploaded = false;
  await uploadParts({
    files, remoteFiles: [{ id: "file", name: "café.pdf", size: 4, partSize: 4, parts: [] }],
    signal: new AbortController().signal, sign: async () => "signed",
    send: async () => { uploaded = true; },
  });
  assert.equal(uploaded, true);
});
