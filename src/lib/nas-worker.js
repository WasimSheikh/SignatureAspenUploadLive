import { db, getTransfer, getFiles, withTransferLock } from "./db.js";
import { objectStream } from "./storage.js";
import { requireLive } from "./http.js";
import { nasConfig } from "./nas-security.mjs";
import { eachNasTransfer, withNasDirectory, mirrorNasFile, removeNasTransfer } from "./nas-files.mjs";

const live = (transfer) => transfer && transfer.status === "complete" && new Date(transfer.expires_at).getTime() > Date.now();

export async function syncNasTransfer(id, settings, signal) {
  return withTransferLock(id, async (client) => {
    const transfer = await getTransfer(client, id);
    if (!live(transfer)) {
      await removeNasTransfer(settings.root, id);
      await client.query("UPDATE nas_mirrors SET status='failed', error='Transfer unavailable', updated_at=now() WHERE transfer_id=$1", [id]);
      return;
    }
    await client.query(`INSERT INTO nas_mirrors (transfer_id,status) VALUES ($1,'syncing')
      ON CONFLICT (transfer_id) DO UPDATE SET status='syncing',error=NULL,updated_at=now()`, [id]);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const expiry = setTimeout(stop, Math.min(2147483647, Math.max(1, new Date(transfer.expires_at).getTime() - Date.now())));
    try {
      const files = await getFiles(client, id);
      if (!files.length || files.some((file) => !file.completed)) throw new Error("Incomplete transfer");
      await removeNasTransfer(settings.root, id);
      await withNasDirectory(settings.root, id, true, async (directory) => {
        for (const file of files) {
          requireLive(transfer);
          controller.signal.throwIfAborted();
          const source = await objectStream(file, controller.signal);
          try { await mirrorNasFile(directory, file, source, controller.signal); }
          finally { source.destroy?.(); }
        }
      });
      requireLive(await getTransfer(client, id));
      controller.signal.throwIfAborted();
      await client.query("UPDATE nas_mirrors SET status='available',error=NULL,updated_at=now() WHERE transfer_id=$1", [id]);
    } catch (error) {
      await removeNasTransfer(settings.root, id).catch(() => {});
      await client.query("UPDATE nas_mirrors SET status='failed',error='Local copy failed; retry pending',updated_at=now() WHERE transfer_id=$1", [id]);
      throw error;
    } finally {
      clearTimeout(expiry);
      signal?.removeEventListener("abort", stop);
    }
  });
}

export async function runNasCycle(signal) {
  const settings = nasConfig(process.env, { filesystem: true });
  if (!settings.enabled) return { enabled: false };
  let removed = 0;
  // Disk enumeration also finds orphans whose cloud transfer/file rows have
  // already been removed by cloud cleanup, including interrupted partial copies.
  await eachNasTransfer(settings.root, async (id) => {
    signal?.throwIfAborted();
    try {
      await withTransferLock(id, async (client) => {
        const { rows } = await client.query("SELECT status,expires_at FROM transfers WHERE id=$1", [id]);
        if (live(rows[0])) return;
        await removeNasTransfer(settings.root, id);
        await client.query("UPDATE nas_mirrors SET status='failed',error='Transfer unavailable',updated_at=now() WHERE transfer_id=$1", [id]);
        removed++;
      });
    } catch (error) { if (error.status !== 409) throw error; }
  });
  const stale = await db().query(`SELECT t.id FROM transfers t JOIN nas_mirrors n ON n.transfer_id=t.id
    WHERE n.status <> 'failed' AND (t.status <> 'complete' OR t.expires_at <= now()) LIMIT 100`);
  for (const { id } of stale.rows) {
    try { await syncNasTransfer(id, settings, signal); }
    catch (error) { if (error.status !== 409) throw error; }
  }
  const { rows } = await db().query(`SELECT t.id FROM transfers t
    LEFT JOIN nas_mirrors n ON n.transfer_id=t.id
    WHERE t.status='complete' AND t.expires_at > now()
    AND (n.transfer_id IS NULL OR n.status <> 'available')
    ORDER BY n.updated_at ASC NULLS FIRST, t.completed_at ASC LIMIT 100`);
  let copied = 0;
  let failed = 0;
  for (const { id } of rows) {
    signal?.throwIfAborted();
    try { await syncNasTransfer(id, settings, signal); copied++; }
    catch (error) {
      if (signal?.aborted) throw error;
      if (error.status !== 409) { failed++; console.error("NAS mirror failed.", { transferId: id }); }
    }
  }
  return { enabled: true, copied, failed, removed };
}
