import { setTimeout as delay } from "node:timers/promises";
import { nasConfig } from "../src/lib/nas-security.mjs";
import { runNasCycle } from "../src/lib/nas-worker.js";
import { db } from "../src/lib/db.js";

const settings = nasConfig(process.env, { filesystem: true });
if (!settings.enabled) {
  console.log("NAS mirror disabled (set NAS_ENABLED=true to enable).");
} else {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
  try {
    do {
      try { console.log("NAS cycle completed.", await runNasCycle(controller.signal)); }
      catch { if (!controller.signal.aborted) console.error("NAS cycle failed; retrying after interval."); }
      if (process.argv.includes("--once")) break;
      await delay(settings.interval, undefined, { signal: controller.signal }).catch(() => {});
    } while (!controller.signal.aborted);
  } finally { await db().end(); }
}
