import { Readable } from "node:stream";
import { storage, blockId } from "../src/lib/storage.js";

export function mockAzure() {
  const service = storage(), original = service.getContainerClient;
  const objects = new Map(), uploads = new Map(), snapshots = new Map();
  const absent = () => Object.assign(new Error("missing"), { statusCode: 404, code: "BlobNotFound" });
  let sequence = 0, deletes = 0, leases = 0;
  const clients = new Map();
  const state = { objects, uploads, snapshots, hook: null };
  function client(key, snapshotTime) {
    const cacheKey = `${key}?snapshot=${snapshotTime || ""}`;
    if (clients.has(cacheKey)) return clients.get(cacheKey);
    const isStaging = key.startsWith("staging/");
    const segments = key.split("/");
    const finalKey = `transfers/${segments[1]}/${segments[2]}`;
    const lookup = () => snapshotTime ? snapshots.get(`${key}?snapshot=${snapshotTime}`) : isStaging ? uploads.get(finalKey) : objects.get(key);
    const api = {
      url: `https://testaccount.blob.core.windows.net/test-container/${key}`,
      async upload() {
        await state.hook?.("upload", key);
        const item = { parts: [], metadata: {}, size: 0, etag: `"v${++sequence}"`, key };
        if (isStaging) uploads.set(finalKey, item);
        else objects.set(key, { ...item, committed: true });
      },
      withSnapshot(time) { return client(key, time); },
      async createSnapshot(options) {
        await state.hook?.("createSnapshot", key, options);
        const item = lookup();
        if (!item) throw absent();
        if (options.conditions.ifMatch !== item.etag) throw Object.assign(new Error("changed"), { statusCode: 412 });
        const time = new Date().toISOString().replace("Z", `${String(++sequence).padStart(4, "0")}Z`);
        snapshots.set(`${key}?snapshot=${time}`, structuredClone(item));
        return { snapshot: time, etag: item.etag };
      },
      async getProperties(options) {
        const item = lookup();
        if (!item || item.uncommittedOnly || (!isStaging && !item.committed)) throw absent();
        if (options?.conditions?.ifMatch && options.conditions.ifMatch !== item.etag) throw Object.assign(new Error("changed"), { statusCode: 412 });
        return { contentLength: item.size, metadata: item.metadata, etag: item.etag, leaseStatus: item.locked ? "locked" : "unlocked" };
      },
      getBlobLeaseClient(id) {
        return { leaseId: id, async acquireLease() {
          leases++;
          const item = lookup();
          if (!item) throw absent();
          if (item.locked) throw Object.assign(new Error("leased"), { code: "LeaseAlreadyPresent" });
          item.locked = true;
        }, async releaseLease() { lookup().locked = false; }, async breakLease() { lookup().locked = false; } };
      },
      async getBlockList(type, options) {
        await state.hook?.("getBlockList", key, options);
        const item = lookup();
        if (!item) { if (isStaging) throw absent(); return { committedBlocks: [], uncommittedBlocks: [] }; }
        if (options?.conditions?.ifMatch && options.conditions.ifMatch !== item.etag) throw Object.assign(new Error("changed"), { statusCode: 412 });
        const parts = (item.parts || []).map((p) => ({ name: p.name || blockId({
          upload_id: `azure-v1:${segments[3]}`,
        }, p.PartNumber), size: p.Size ?? p.size }));
        return { etag: item.etag, committedBlocks: item.committed ? parts : [],
          uncommittedBlocks: type === "committed" || item.committed ? [] : parts };
      },
      async commitBlockList(ids, options) {
        await state.hook?.("commitBlockList", key, options);
        const item = lookup();
        if (!item) throw absent();
        if (options.conditions?.ifNoneMatch && item.committed) throw Object.assign(new Error("exists"), { statusCode: 412 });
        const selected = ids.map((name) => {
          const part = item.parts.find((p) => (p.name || blockId({ upload_id: `azure-v1:${segments[3]}` }, p.PartNumber)) === name);
          if (!part) throw new Error("Missing block");
          return part;
        });
        item.parts = selected;
        item.size = selected.reduce((n, p) => n + (p.Size ?? p.size), 0);
        item.metadata = options.metadata || {};
        item.committed = true;
        item.etag = `"v${++sequence}"`;
        return { etag: item.etag };
      },
      async stageBlockFromURL(name, sourceUrl, offset, size, options) {
        await state.hook?.("stageBlockFromURL", key, { sourceUrl, offset, size, ...options });
        const url = new URL(sourceUrl);
        const sourceKey = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
        // Match the real SDK: stageBlockFromURL does not support sourceConditions.
        const source = url.searchParams.get("snapshot")
          ? snapshots.get(`${sourceKey}?snapshot=${url.searchParams.get("snapshot")}`)
          : [...uploads.values()].find((item) => item.key === sourceKey);
        if (!source) throw absent();
        let item = objects.get(key);
        if (!item) { item = { parts: [], committed: false }; objects.set(key, item); }
        item.parts = item.parts.filter((p) => p.name !== name);
        item.parts.push({ name, size });
      },
      async deleteIfExists() {
        deletes++;
        if (lookup()?.uncommittedOnly) return { succeeded: false };
        if (isStaging) {
          uploads.delete(finalKey);
          for (const name of snapshots.keys()) if (name.startsWith(`${key}?snapshot=`)) snapshots.delete(name);
        } else objects.delete(key);
      },
      async download(_offset, _count, options) {
        await state.hook?.("download", key, options);
        return { readableStreamBody: Readable.from([Buffer.from("PDF")]) };
      },
    };
    clients.set(cacheKey, api);
    return api;
  }
  service.getContainerClient = () => ({
    getBlockBlobClient: client,
    listBlobsFlat() {
      return { byPage({ maxPageSize = 500 } = {}) {
        const items = [...uploads.values()].map((item) => ({
          name: item.key, properties: { lastModified: item.uncommittedOnly ? undefined : new Date(Date.now() - 30 * 60 * 1000) },
        }));
        return (async function* () {
          for (let index = 0; index < items.length; index += maxPageSize) {
            yield { segment: { blobItems: items.slice(index, index + maxPageSize) } };
          }
        })();
      } };
    },
  });
  state.client = client;
  state.restore = () => { service.getContainerClient = original; };
  Object.defineProperties(state, { deletes: { get: () => deletes }, leases: { get: () => leases } });
  return state;
}
