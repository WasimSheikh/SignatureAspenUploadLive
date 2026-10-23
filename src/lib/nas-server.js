import { pipeline } from "node:stream/promises";
import { withTransferLock, getTransfer, getFiles, recordAccess } from "./db.js";
import { employeeHasTransfer } from "./employees.js";
import { employeeConfig, approvedGroups } from "./employee-security.mjs";
import { requireLive } from "./http.js";
import { fail } from "./security.mjs";
import { verifyNasToken, byteRange } from "./nas-security.mjs";
import { withNasDirectory, openNasFile } from "./nas-files.mjs";

export function nasRequestHandler(settings) {
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    let claims;
    try {
      const url = new URL(request.url, settings.origin);
      if (url.pathname !== "/download") fail(404, "Not found.");
      if (request.method !== "GET" && request.method !== "HEAD") fail(405, "Method not allowed.");
      if (url.searchParams.getAll("token").length !== 1) fail(401, "Local download authorization is required.");
      try { claims = verifyNasToken(url.searchParams.get("token"), settings.secret); }
      catch { fail(401, "Invalid or expired local download authorization."); }
      await withTransferLock(claims.transferId, async (client) => {
        const cfg = employeeConfig();
        if (!cfg) fail(403, "Employee access is disabled.");
        const { rows } = await client.query(`SELECT employee_id,group_ids FROM employee_sessions
          WHERE token_hash=$1 AND employee_id=$2::uuid AND tenant_id=$3::uuid AND expires_at > now()`,
        [claims.sessionHash, claims.employeeId, cfg.tenant]);
        if (!rows[0]) fail(403, "Employee session is no longer active.");
        const groups = approvedGroups(rows[0].group_ids, cfg);
        const employee = { id: claims.employeeId, admin: groups.some((id) => cfg.adminGroups.includes(id)) };
        if (!await employeeHasTransfer(client, employee, claims.transferId)) fail(404, "Transfer not found.");
        const transfer = await getTransfer(client, claims.transferId);
        requireLive(transfer);
        if (transfer.status !== "complete") fail(404, "Transfer not found.");
        const mirror = await client.query("SELECT status FROM nas_mirrors WHERE transfer_id=$1", [transfer.id]);
        if (mirror.rows[0]?.status !== "available") fail(409, "Local copy is not ready.");
        const file = (await getFiles(client, transfer.id)).find((candidate) => candidate.id === claims.fileId && candidate.completed);
        if (!file) fail(404, "File not found.");
        let range;
        try { range = byteRange(request.headers.range, Number(file.size)); }
        catch {
          response.setHeader("Content-Range", `bytes */${file.size}`);
          fail(416, "Requested range is not available.");
        }
        await withNasDirectory(settings.root, transfer.id, false, async (directory) => {
          const handle = await openNasFile(directory, file);
          try {
            // No sensitive tokens, filenames, filesystem paths, or object keys are logged.
            await recordAccess(client, transfer.id, "local_file_download", file.id);
            requireLive(transfer);
            const fallback = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
            const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
            response.setHeader("Content-Type", "application/octet-stream");
            response.setHeader("Content-Disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
            response.setHeader("Accept-Ranges", "bytes");
            response.setHeader("Content-Length", range.end - range.start + 1);
            if (range.partial) response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
            response.statusCode = range.partial ? 206 : 200;
            if (request.method === "HEAD") { response.end(); return; }
            const controller = new AbortController();
            const stop = () => controller.abort();
            const expiry = setTimeout(stop, Math.max(1, Math.min(2147483647, new Date(transfer.expires_at).getTime() - Date.now())));
            response.once("close", stop);
            try {
              await pipeline(handle.createReadStream({ start: range.start, end: range.end }), response, { signal: controller.signal });
            } finally {
              clearTimeout(expiry);
              response.removeListener("close", stop);
            }
          } finally { await handle.close(); }
        });
      });
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const status = Number.isInteger(error.status) ? error.status : 503;
      // Content-Length from an interrupted preflight must never survive an error.
      response.removeHeader("Content-Length");
      response.removeHeader("Content-Disposition");
      response.statusCode = status;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(status === 503 ? "Local download unavailable. Use cloud download." : error.message);
      if (status === 503) console.error("NAS download failed.", { transferId: claims?.transferId || null });
    }
  };
}
