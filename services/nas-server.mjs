import { createServer } from "node:http";
import { nasConfig } from "../src/lib/nas-security.mjs";
import { withNasRoot, requireNasMount } from "../src/lib/nas-files.mjs";
import { nasRequestHandler } from "../src/lib/nas-server.js";
import { db } from "../src/lib/db.js";

const settings = nasConfig(process.env, { filesystem: true });
if (!settings.enabled) {
  console.log("NAS local download service disabled.");
} else {
  await requireNasMount(settings.root);
  await withNasRoot(settings.root, async () => {});
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 15000 }, nasRequestHandler(settings));
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, resolve);
  });
  console.log(`NAS local download service listening on ${settings.host}:${settings.port}. Keep this endpoint private.`);
  let closing = false;
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => {
    if (closing) return;
    closing = true;
    server.close(() => { void db().end(); });
    server.closeAllConnections();
  });
}
