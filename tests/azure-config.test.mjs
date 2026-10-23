import test from "node:test";
import assert from "node:assert/strict";

const base = {
  DATABASE_URL: "postgres://localhost/not-used",
  AZURE_STORAGE_ACCOUNT_NAME: "testaccount", AZURE_STORAGE_CONTAINER: "test-container",
  RESEND_API_KEY: "test-resend", FROM_EMAIL: "transfers@example.com", APP_URL: "https://example.com",
  CRON_SECRET: "test-cron-secret-with-at-least-32-characters",
  COOKIE_SECRET: "test-cookie-secret-with-at-least-32-characters",
};
let sequence = 0;
async function readConfig(overrides = {}) {
  Object.assign(process.env, base, { AZURE_STORAGE_ACCOUNT_KEY: "" }, overrides);
  const { config } = await import(`../src/lib/config.js?azureConfigCase=${++sequence}`);
  return config();
}

test("Azure config requires standard account/container names and accepts empty optional shared key", async () => {
  const saved = { ...process.env };
  try {
    const settings = await readConfig();
    assert.equal(settings.storageAccount, "testaccount");
    assert.equal(settings.storageContainer, "test-container");
    assert.equal(settings.storageAccountKey, undefined);
    for (const name of ["", "ab", "Uppercase", "https://account.blob.core.windows.net", "account.local", "a".repeat(25), " account "]) {
      await assert.rejects(readConfig({ AZURE_STORAGE_ACCOUNT_NAME: name }), /configuration|account/i);
    }
    for (const name of ["", "ab", "-container", "container-", "two--hyphens", "Uppercase", "a/b", "https://example.com", "a".repeat(64)]) {
      await assert.rejects(readConfig({ AZURE_STORAGE_CONTAINER: name }), /configuration|container/i);
    }
    for (const key of [" ", "not-a-base64-key", "https://private-key.invalid", "YWJj==="]) {
      await assert.rejects(readConfig({ AZURE_STORAGE_ACCOUNT_KEY: key }), /storage account key/);
    }
    const key = Buffer.from("nonfunctional-test-key").toString("base64");
    assert.equal((await readConfig({ AZURE_STORAGE_ACCOUNT_KEY: key })).storageAccountKey, key);
    assert.equal((await readConfig({ AZURE_CLIENT_ID: "user-assigned-managed-identity", AZURE_STORAGE_ACCOUNT_KEY: "" })).storageAccountKey, undefined);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
