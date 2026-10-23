import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_PART_SIZE, MAX_S3_PARTS, HttpError, randomId, hashToken, equalSecret,
  partSizeFor, expectedPartSize, safeArchiveName, validateTransfer, validateParts,
  makePasscodeHash, verifyPasscode, signUnlock, verifyUnlock, escapeHtml,
} from "../src/lib/security.mjs";

const input = (overrides = {}) => ({
  senderEmail: "sender@example.com", recipientEmails: "one@example.com,two@example.com",
  title: "Brand files", company: "Studio", message: "Final assets",
  retentionDays: 7, files: [{ name: "Brand.psd", size: 42, type: "image/vnd.adobe.photoshop" }],
  ...overrides,
});

const invalid = (fn, status = 400) => assert.throws(fn, (error) => error instanceof HttpError && error.status === status);

test("normalizes emails and accepts every supported extension", () => {
  const result = validateTransfer(input({
    senderEmail: " Sender@Example.com ",
    recipientEmails: " ONE@example.com,one@example.com ",
    files: ["psd", "ai", "pdf", "zip", "tif", "tiff"].map((extension) => ({ name: `design.${extension}`, size: 1 })),
  }));
  assert.equal(result.senderEmail, "sender@example.com");
  assert.deepEqual(result.recipientEmails, ["one@example.com"]);
  assert.equal(result.files.length, 6);
  assert.equal(result.partSize, BASE_PART_SIZE);
});

test("accepts more than 10GB and enforces configurable transfer aggregate and file count limits", () => {
  assert.equal(validateTransfer(input({ files: [{ name: "Big.zip", size: 12 * 1024 ** 3 }] })).files[0].size, 12 * 1024 ** 3);
  invalid(() => validateTransfer(input({ files: [{ name: "Big.zip", size: 21 * 1024 ** 3 }] })));
  invalid(() => validateTransfer(input({ files: [{ name: "A.zip", size: 6 }, { name: "B.zip", size: 6 }] }), { maxBytes: 10 }));
  invalid(() => validateTransfer(input(), { maxFiles: 0 }));
  assert.equal(validateTransfer(input({ files: [{ name: "Big.zip", size: 30 * 1024 ** 3 }] }),
    { maxBytes: 40 * 1024 ** 3 }).files.length, 1);
});

test("rejects invalid email, retention, metadata and passcodes", () => {
  for (const overrides of [
    { senderEmail: "bad@example.com\r\nBcc:intruder@example.com" },
    { recipientEmails: ["recipient@example.com"] },
    { recipientEmails: "" }, { recipientEmails: "valid@example.com," },
    { retentionDays: "7" }, { retentionDays: 90 }, { title: "x".repeat(201) },
    { title: "" }, { title: "   " }, { title: undefined }, { title: null },
    { company: "" }, { company: "   " }, { company: undefined }, { company: null },
    { company: { name: "bad" } }, { message: "\u0000" }, { passcode: "123" }, { passcode: "1234567" },
    { passcode: "x".repeat(129) }, { passcode: 1234 }, { files: [] },
  ]) invalid(() => validateTransfer(input(overrides)));
  invalid(() => validateTransfer(input(), { maxRecipients: 1 }));
});

test("rejects unsafe, executable, duplicate and Unicode-equivalent file names", () => {
  for (const name of ["../design.pdf", "folder\\design.pdf", "C:design.pdf", "design.pdf.exe", ".pdf", "..", "A\u0000.pdf", "A\r\n.pdf", "bad.svg", "x.pdf."]) {
    invalid(() => validateTransfer(input({ files: [{ name, size: 1 }] })));
  }
  for (const names of [["Design.PDF", "design.pdf"], ["café.pdf", "cafe\u0301.pdf"]]) {
    invalid(() => validateTransfer(input({ files: names.map((name) => ({ name, size: 1 })) })));
  }
});

test("rejects zero, negative, fractional, infinite and unsafe file sizes and MIME types", () => {
  for (const size of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "42", null]) {
    invalid(() => validateTransfer(input({ files: [{ name: "design.pdf", size }] })));
  }
  invalid(() => validateTransfer(input({ files: [{ name: "design.pdf", size: 1, type: "text/html\r\nX: y" }] })));
});

test("part size always satisfies the 10000-part ceiling", () => {
  for (const size of [1, BASE_PART_SIZE, 20 * 1024 ** 3, BASE_PART_SIZE * 10000 + 1, 5 * 1024 ** 4]) {
    const partSize = partSizeFor(size);
    assert.ok(partSize >= BASE_PART_SIZE);
    assert.ok(Math.ceil(size / partSize) <= MAX_S3_PARTS);
    assert.equal(partSize % (1024 * 1024), 0);
  }
  assert.equal(expectedPartSize(BASE_PART_SIZE + 1, BASE_PART_SIZE, 1), BASE_PART_SIZE);
  assert.equal(expectedPartSize(BASE_PART_SIZE + 1, BASE_PART_SIZE, 2), 1);
  for (const number of [0, -1, 3, 1.5, "1"]) invalid(() => expectedPartSize(BASE_PART_SIZE + 1, BASE_PART_SIZE, number));
});

test("completion requires every expected part in order with exact lengths and ETags", () => {
  const file = { size: BASE_PART_SIZE + 3, part_size: BASE_PART_SIZE };
  const parts = [
    { PartNumber: 1, Size: BASE_PART_SIZE, ETag: '"one"' },
    { PartNumber: 2, Size: 3, ETag: '"two"' },
  ];
  assert.deepEqual(validateParts(file, parts), [
    { PartNumber: 1, ETag: '"one"' }, { PartNumber: 2, ETag: '"two"' },
  ]);
  for (const bad of [
    [], parts.slice(0, 1), [...parts, { PartNumber: 3, Size: 1, ETag: '"three"' }],
    [parts[1], parts[0]], [parts[0], { ...parts[1], Size: 2 }],
    [parts[0], { ...parts[1], ETag: "" }],
    [{ ...parts[0], Size: BASE_PART_SIZE + 1 }, parts[1]],
  ]) invalid(() => validateParts(file, bad), 409);
});

test("capabilities use cryptographic randomness and only token digests are persisted", () => {
  const ids = new Set(Array.from({ length: 100 }, randomId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{32}$/);
  const token = randomId();
  assert.match(hashToken(token), /^[a-f0-9]{64}$/);
  assert.ok(equalSecret(hashToken(token), hashToken(token)));
  assert.ok(!equalSecret(hashToken(token), hashToken(randomId())));
  assert.ok(!equalSecret("a", "ab"));
  assert.ok(!equalSecret(undefined, "a"));
});

test("scrypt passcodes are salted, verifiable and never stored verbatim", async () => {
  const first = await makePasscodeHash("correct horse battery staple");
  const second = await makePasscodeHash("correct horse battery staple");
  assert.notEqual(first, second);
  assert.ok(!first.includes("correct horse"));
  assert.equal(await verifyPasscode("correct horse battery staple", first), true);
  assert.equal(await verifyPasscode("incorrect", first), false);
  assert.equal(await verifyPasscode(null, first), false);
  assert.equal(await makePasscodeHash(""), null);
});

test("unlock cookies are scoped, signed, expire, and reject forged/future payloads", () => {
  const id = randomId(), secret = randomId() + randomId(), now = Date.now();
  const value = signUnlock(id, secret, now + 60000);
  assert.ok(verifyUnlock(value, id, secret, now));
  assert.ok(!verifyUnlock(value, randomId(), secret, now));
  assert.ok(!verifyUnlock(value, id, "wrong", now));
  assert.ok(!verifyUnlock(value + "x", id, secret, now));
  assert.ok(!verifyUnlock(value, id, secret, now + 60001));
  assert.ok(!verifyUnlock(signUnlock(id, secret, now + 2 * 3600000), id, secret, now));
  assert.ok(!verifyUnlock(undefined, id, secret, now));
  assert.ok(!verifyUnlock(value + ".extra", id, secret, now));
});

test("archive entries cannot escape ZIP root and email HTML is escaped", () => {
  assert.equal(safeArchiveName("../../escape.pdf"), "escape.pdf");
  assert.equal(safeArchiveName("C:\\secret\\file.ai"), "file.ai");
  assert.equal(safeArchiveName("C:drive.pdf"), "C_drive.pdf");
  assert.equal(safeArchiveName("../../.."), "file");
  assert.equal(safeArchiveName(""), "file");
  assert.equal(safeArchiveName("bad\u0000.pdf"), "bad_.pdf");
  assert.equal(escapeHtml(`<script>"&'</script>`), "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;");
});
