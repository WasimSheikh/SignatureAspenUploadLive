let cached;

function integer(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid configuration: ${name}`);
  return value;
}

export function config() {
  if (cached) return cached;
  for (const name of ["DATABASE_URL", "S3_BUCKET", "AWS_REGION",
    "RESEND_API_KEY", "FROM_EMAIL", "APP_URL", "CRON_SECRET", "COOKIE_SECRET"]) {
    if (!process.env[name]) throw new Error(`Missing configuration: ${name}`);
  }
  if (!!process.env.AWS_ACCESS_KEY_ID !== !!process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Storage credential configuration is incomplete");
  }
  const appUrl = new URL(process.env.APP_URL);
  if (!["https:", "http:"].includes(appUrl.protocol) || appUrl.username || appUrl.password ||
      appUrl.pathname !== "/" || appUrl.search || appUrl.hash) throw new Error("APP_URL must be an origin");
  if (process.env.NODE_ENV === "production" && appUrl.protocol !== "https:") throw new Error("APP_URL must use HTTPS");
  if (process.env.COOKIE_SECRET.length < 32 || process.env.CRON_SECRET.length < 32) throw new Error("Secrets must be at least 32 characters");
  cached = {
    databaseUrl: process.env.DATABASE_URL,
    bucket: process.env.S3_BUCKET,
    region: process.env.AWS_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    appUrl: appUrl.origin,
    cookieSecret: process.env.COOKIE_SECRET,
    cronSecret: process.env.CRON_SECRET,
    fromEmail: process.env.FROM_EMAIL,
    internalEmails: (process.env.INTERNAL_NOTIFICATION_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
    reminders: process.env.ENABLE_EXPIRATION_REMINDERS === "true",
    maxBytes: integer("MAX_TRANSFER_BYTES", 20 * 1024 ** 3, 5 * 1024 ** 4),
    maxFiles: integer("MAX_TRANSFER_FILES", 100, 1000),
    maxRecipients: integer("MAX_TRANSFER_RECIPIENTS", 20, 50),
    poolMax: integer("DATABASE_POOL_MAX", 10, 100),
  };
  return cached;
}
