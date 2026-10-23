import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgres://localhost/not-used",
  AZURE_STORAGE_ACCOUNT_NAME: "testaccount", AZURE_STORAGE_CONTAINER: "test-container",
  RESEND_API_KEY: "test-resend", FROM_EMAIL: "transfers@example.com", APP_URL: "https://example.com",
  CRON_SECRET: "test-cron-secret-with-at-least-32-characters",
  COOKIE_SECRET: "test-cookie-secret-with-at-least-32-characters",
});
delete process.env.AZURE_STORAGE_ACCOUNT_KEY;
const { storage, blobSas } = await import("../src/lib/azure.js");
const { endpoint } = await import("../src/lib/http.js");

test("DefaultAzureCredential SAS uses a bounded delegation cache with concurrent refresh and failure recovery", async () => {
  const service = storage(), original = service.getUserDelegationKey;
  let calls = 0, key, fail = false;
  try {
    service.getUserDelegationKey = async (startsOn, expiresOn) => {
      calls++;
      assert.ok(expiresOn.getTime() - startsOn.getTime() <= 65 * 60 * 1000);
      assert.ok(expiresOn.getTime() <= Date.now() + 60 * 60 * 1000);
      await Promise.resolve();
      if (fail) throw new Error("Azure RBAC denied delegation key");
      key = {
        signedObjectId: "00000000-0000-0000-0000-000000000001",
        signedTenantId: "00000000-0000-0000-0000-000000000002",
        signedStartsOn: startsOn, signedExpiresOn: expiresOn, signedService: "b",
        signedVersion: "2025-11-05", value: Buffer.from("nonfunctional-delegation-key").toString("base64"),
      };
      return key;
    };
    const sign = () => blobSas("staging/test/file/session", "w", new Date(Date.now() + 900000));
    const urls = await Promise.all(Array.from({ length: 20 }, sign));
    assert.equal(calls, 1);
    for (const value of urls) {
      const url = new URL(value);
      assert.equal(url.searchParams.get("sp"), "w");
      assert.equal(url.searchParams.get("skoid"), key.signedObjectId);
      assert.ok(url.searchParams.get("sig"));
      assert.ok(!value.includes(key.value));
    }
    const read = new URL(await blobSas("transfers/test/file", "r", new Date(Date.now() + 300000)));
    assert.equal(read.searchParams.get("sp"), "r");
    assert.equal(read.searchParams.get("skoid"), key.signedObjectId);
    assert.equal(calls, 1);
    key.signedExpiresOn = new Date(0);
    await Promise.all(Array.from({ length: 10 }, sign));
    assert.equal(calls, 2);
    key.signedExpiresOn = new Date(0);
    fail = true;
    await assert.rejects(sign(), /RBAC/);
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await endpoint(sign)(new Request("https://example.com"));
      assert.equal(response.status, 503);
      assert.ok(!(await response.text()).includes("RBAC"));
    } finally { console.error = originalError; }
    fail = false;
    await sign();
    assert.equal(calls, 5);
  } finally { service.getUserDelegationKey = original; }
});
