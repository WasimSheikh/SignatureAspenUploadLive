import { withTransferLock, recordAccess } from "./db.js";
import { endpoint, requireOrigin, readJson, json } from "./http.js";
import { requireEmployeeTransfer } from "./employees.js";
import { cookieValue, SESSION_COOKIE } from "./employee-security.mjs";
import { fail, hashToken } from "./security.mjs";
import { nasConfig, signNasToken, nasId } from "./nas-security.mjs";

export const localDownload = endpoint(async (request, context) => {
  requireOrigin(request);
  const settings = nasConfig();
  if (!settings.enabled) fail(404, "Local downloads are not enabled.");
  const { id } = await context.params;
  if (!nasId(id)) fail(404, "Transfer not found.");
  const body = await readJson(request);
  return withTransferLock(id, async (client) => {
    const { employee, transfer, files } = await requireEmployeeTransfer(request, id, client);
    const file = files.find((candidate) => candidate.id === body.fileId);
    if (!file) fail(404, "File not found.");
    const { rows } = await client.query("SELECT status FROM nas_mirrors WHERE transfer_id=$1", [id]);
    if (rows[0]?.status !== "available") {
      return json({ status: rows[0]?.status || "syncing", error: "The local copy is not ready. Use cloud download." }, 409);
    }
    const token = signNasToken({ transferId: id, fileId: file.id, employeeId: employee.id,
      sessionHash: hashToken(cookieValue(request, SESSION_COOKIE)) }, settings.secret, transfer.expires_at);
    const url = new URL("/download", settings.origin);
    url.searchParams.set("token", token);
    await recordAccess(client, id, "local_download_authorized", file.id);
    return json({ url: url.href, expiresIn: 60 });
  });
});
