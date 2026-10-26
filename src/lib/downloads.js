import { Readable, PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import { db, getTransfer, getFiles, recordAccess } from "./db.js";
import { endpoint, requirePublic } from "./http.js";
import { transferId } from "./transfers.js";
import { signDownload, objectStream } from "./storage.js";
import { safeArchiveName, fail } from "./security.mjs";
import { isLocalMode } from "./config.js";

export const downloadTransfer = endpoint(async (request, context) => {
  const id = await transferId(context);
  const transfer = await getTransfer(db(), id);
  requirePublic(request, transfer);
  const files = await getFiles(db(), id);
  const url = new URL(request.url);
  if (url.searchParams.has("file")) {
    const file = files.find((candidate) => candidate.id === url.searchParams.get("file"));
    if (!file) fail(404, "File not found.");
    await recordAccess(db(), id, "file_download", file.id);
    if (isLocalMode()) {
      const stream = await objectStream(file, request.signal);
      const fallback = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      return new Response(Readable.toWeb(Readable.from(stream)), { headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        "Content-Length": String(file.size),
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      } });
    }
    const location = await signDownload(transfer, file);
    return new Response(null, { status: 302, headers: {
      Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    } });
  }
  if (!files.length) fail(404, "Files not found.");
  await recordAccess(db(), id, "archive_download");
  // ZIP64 and store mode support multi-gigabyte design files without CPU-heavy
  // recompression. Async sources open only when archiver consumes that entry.
  const archive = new ZipArchive({ store: true, forceZip64: true });
  const output = new PassThrough({ highWaterMark: 256 * 1024 });
  const controller = new AbortController();
  const sources = [];
  const stop = (error) => {
    controller.abort();
    archive.abort();
    for (const source of sources) source.destroy();
    if (error && !output.destroyed) output.destroy(error);
  };
  archive.on("error", stop);
  archive.on("warning", stop);
  request.signal.addEventListener("abort", () => {
    stop();
    output.destroy();
  }, { once: true });
  output.on("close", () => {
    if (!archive.writableFinished) stop();
  });
  archive.pipe(output);
  for (const file of files) {
    const source = Readable.from((async function* () {
      let body;
      try {
        body = await objectStream(file, controller.signal);
        for await (const chunk of body) yield chunk;
      } finally {
        body?.destroy?.();
      }
    })());
    source.on("error", stop);
    sources.push(source);
    archive.append(source, { name: safeArchiveName(file.name), date: new Date(transfer.completed_at), store: true });
  }
  void archive.finalize().catch(stop);
  return new Response(Readable.toWeb(output), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="transfer-${id}.zip"`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  } });
});
