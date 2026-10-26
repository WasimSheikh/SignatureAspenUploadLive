import { verifyBlockUrl, writeBlock } from "@/lib/local-storage";
import { config } from "@/lib/config";
import { HttpError, fail } from "@/lib/security.mjs";
import { json } from "@/lib/http";

export async function PUT(request, context) {
  try {
    if (!process.env.LOCAL_STORAGE_PATH) fail(404, "Not found.");
    const { id: transferId } = await context.params;
    if (!/^[A-Za-z0-9_-]{32}$/.test(transferId)) fail(404, "Not found.");
    const url = new URL(request.url);
    const { fileId, partNumber, uploadId } = verifyBlockUrl(transferId, url.searchParams, config().cookieSecret);
    const data = Buffer.from(await request.arrayBuffer());
    await writeBlock(transferId, fileId, uploadId, partNumber, data);
    return new Response(null, { status: 200, headers: { ETag: `"${String(partNumber).padStart(6, "0")}"` } });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error("Local block upload failed.", { type: error?.name });
    return json({ error: "Block upload failed." }, 500);
  }
}
