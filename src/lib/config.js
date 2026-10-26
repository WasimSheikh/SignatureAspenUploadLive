let cached;

export const isLocalMode = () => !!process.env.LOCAL_STORAGE_PATH;

function integer(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid configuration: ${name}`);
  return value;
}

export function config() {
  if (cached) return cached;
  const local = isLocalMode();
  for (const name of ["DATABASE_URL", "APP_URL", "CRON_SECRET", "COOKIE_SECRET"]) {
    if (!process.env[name]) throw new Error(`Missing configuration: ${name}`);
  }
  if (!local) {
    for (const name of ["AZURE_STORAGE_ACCOUNT_NAME", "AZURE_STORAGE_CONTAINER", "RESEND_API_KEY", "FROM_EMAIL"]) {
      if (!process.env[name]) throw new Error(`Missing configuration: ${name}`);
    }
    if (!/^[a-z0-9]{3,24}$/.test(process.env.AZURE_STORAGE_ACCOUNT_NAME)) throw new Error("Invalid Azure storage account name");
    if (!/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(process.env.AZURE_STORAGE_CONTAINER)) throw new Error("Invalid Azure storage container");
  }
  const storageAccountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
  if (!local && storageAccountKey && (!/^[A-Za-z0-9+/]+={0,2}$/.test(storageAccountKey) ||
      Buffer.from(storageAccountKey, "base64").toString("base64") !== storageAccountKey)) {
    throw new Error("Invalid Azure storage account key");
  }
  const appUrl = new URL(process.env.APP_URL);
  if (!["https:", "http:"].includes(appUrl.protocol) || appUrl.username || appUrl.password ||
      appUrl.pathname !== "/" || appUrl.search || appUrl.hash) throw new Error("APP_URL must be an origin");
  if (process.env.NODE_ENV === "production" && appUrl.protocol !== "https:") throw new Error("APP_URL must use HTTPS");
  if (process.env.COOKIE_SECRET.length < 32 || process.env.CRON_SECRET.length < 32) throw new Error("Secrets must be at least 32 characters");
  cached = {
    databaseUrl: process.env.DATABASE_URL,
    storageAccount: process.env.AZURE_STORAGE_ACCOUNT_NAME || "",
    storageContainer: process.env.AZURE_STORAGE_CONTAINER || "",
    storageAccountKey: (!local && storageAccountKey) || undefined,
    appUrl: appUrl.origin,
    cookieSecret: process.env.COOKIE_SECRET,
    cronSecret: process.env.CRON_SECRET,
    fromEmail: process.env.FROM_EMAIL || "",
    internalEmails: (process.env.INTERNAL_NOTIFICATION_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
    reminders: process.env.ENABLE_EXPIRATION_REMINDERS === "true",
    maxBytes: integer("MAX_TRANSFER_BYTES", 20 * 1024 ** 3, 5 * 1024 ** 4),
    maxFiles: integer("MAX_TRANSFER_FILES", 100, 1000),
    maxRecipients: integer("MAX_TRANSFER_RECIPIENTS", 20, 50),
    poolMax: integer("DATABASE_POOL_MAX", 10, 100),
  };
  return cached;
}
