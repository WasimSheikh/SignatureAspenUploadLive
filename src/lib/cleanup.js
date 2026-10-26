import { config } from "./config.js";
import { db, withTransferLock, getTransfer, getFiles } from "./db.js";
import { endpoint, json } from "./http.js";
import { equalSecret, fail } from "./security.mjs";
import { removeFile, cleanupStaging } from "./storage.js";
import { sendTransferEmails } from "./email.js";

export const cleanupTransfers = endpoint(async (request) => {
  const authorization = (request.headers.get("authorization") || "").split(" ");
  if (authorization.length !== 2 || authorization[0] !== "Bearer" ||
      !equalSecret(authorization[1], config().cronSecret)) fail(401, "Unauthorized.");
  const counts = { cleaned: 0, reminded: 0, emailed: 0, skipped: 0, failed: 0 };
  const expired = await db().query(`SELECT id FROM transfers WHERE cleaned_at IS NULL
    AND (expires_at <= now() OR status = 'deleting') ORDER BY expires_at LIMIT 100`);
  for (const { id } of expired.rows) {
    try {
      await withTransferLock(id, async (client) => {
        const transfer = await getTransfer(client, id);
        if (transfer.cleaned_at || (new Date(transfer.expires_at).getTime() > Date.now() && transfer.status !== "deleting")) return;
        // Revokes all API access before any storage work, even if that work fails.
        const status = new Date(transfer.expires_at).getTime() <= Date.now() ? "expired" : "deleted";
        await client.query("UPDATE transfers SET status = $2 WHERE id = $1", [id, status === "deleted" ? "deleting" : status]);
        for (const file of await getFiles(client, id)) await removeFile(file);
        await client.query("BEGIN");
        try {
          await client.query(`UPDATE transfers SET status = $2, cleaned_at = now(),
            sender_email = '', recipient_emails = '[]', title = '', company = '', message = '',
            passcode_hash = NULL, email_results = '{}' WHERE id = $1`, [id, status]);
          await client.query("DELETE FROM transfer_access_events WHERE transfer_id = $1", [id]);
          await client.query("DELETE FROM transfer_files WHERE transfer_id = $1", [id]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        counts.cleaned++;
      });
    } catch (error) {
      if (error.status === 409) counts.skipped++;
      else { counts.failed++; console.error("Expired transfer cleanup failed."); }
    }
  }
  // Finish delivery after a worker crash without requiring the sender to retry.
  const pending = await db().query(`SELECT id FROM transfers WHERE status = 'complete'
    AND expires_at > now() AND email_status != 'sent'
    AND (email_attempted_at IS NULL OR email_attempted_at > now() - interval '23 hours')
    ORDER BY completed_at LIMIT 100`);
  for (const { id } of pending.rows) {
    try {
      await withTransferLock(id, async (client) => {
        const transfer = await getTransfer(client, id);
        if (transfer.status === "complete" && new Date(transfer.expires_at).getTime() > Date.now() && transfer.email_status !== "sent") {
          if (await sendTransferEmails(client, transfer) === "sent") counts.emailed++;
          else counts.failed++;
        }
      });
    } catch (error) {
      if (error.status === 409) counts.skipped++; else counts.failed++;
    }
  }
  if (config().reminders) {
    const reminders = await db().query(`SELECT id FROM transfers WHERE status = 'complete'
      AND expires_at > now() AND expires_at <= now() + interval '24 hours'
      AND reminder_sent_at IS NULL ORDER BY expires_at LIMIT 100`);
    for (const { id } of reminders.rows) {
      try {
        await withTransferLock(id, async (client) => {
          const transfer = await getTransfer(client, id);
          if (transfer.status === "complete" && !transfer.reminder_sent_at &&
              new Date(transfer.expires_at).getTime() > Date.now()) {
            if (await sendTransferEmails(client, transfer, true) === "sent") counts.reminded++;
            else counts.failed++;
          }
        });
      } catch (error) {
        if (error.status === 409) counts.skipped++; else counts.failed++;
      }
    }
  }
  try {
    await cleanupStaging(async (transferId, fileId, uploadId) => {
      const result = await db().query(`SELECT 1 FROM transfers t JOIN transfer_files f ON f.transfer_id = t.id
        WHERE t.id = $1 AND f.id = $2 AND f.upload_id = $3 AND t.expires_at > now()
        AND t.status IN ('uploading', 'completing')`, [transferId, fileId, uploadId]);
      return result.rowCount > 0;
    });
  } catch { counts.failed++; console.error("Staging cleanup failed."); }
  return json(counts, counts.failed ? 207 : 200);
});
