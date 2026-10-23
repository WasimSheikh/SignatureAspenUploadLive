import { constants } from "node:fs";
import { open, realpath, mkdir, rename, unlink, rmdir, opendir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nasId } from "./nas-security.mjs";

const roots = new Map();

export function networkMountFor(root, mountinfo) {
  if (!path.isAbsolute(root)) throw new Error("Invalid NAS root");
  let closest;
  for (const line of mountinfo.split("\n")) {
    const [details, filesystem] = line.split(" - ");
    if (!filesystem) continue;
    const mount = details.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!mount || !(root === mount || root.startsWith(mount === "/" ? "/" : `${mount}/`))) continue;
    if (!closest || mount.length >= closest.mount.length) closest = { mount, type: filesystem.split(" ")[0] };
  }
  if (!closest || !["cifs", "smb3", "nfs", "nfs4"].includes(closest.type)) {
    throw new Error("NAS_ROOT must be on a currently mounted SMB/NFS filesystem");
  }
  return closest;
}

export async function requireNasMount(root) {
  try {
    if (process.platform !== "linux") throw new Error("The NAS service requires Linux");
    networkMountFor(root, await readFile("/proc/self/mountinfo", "utf8"));
  } catch {
    const error = new Error("NAS mount unavailable");
    error.code = "NAS_MOUNT_UNAVAILABLE";
    throw error;
  }
}

// Linux directory descriptors anchor every operation; no user-controlled name
// or symlink can redirect a read, write, rename, or removal outside this root.
export async function withNasRoot(root, action) {
  if (process.platform !== "linux" || !root || !path.isAbsolute(root) || path.resolve(root) !== root || root === "/") throw new Error("Invalid NAS root");
  if (await realpath(root) !== root) throw new Error("NAS root must not contain symlinks");
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== root) throw new Error("NAS root changed");
    const { dev, ino } = await handle.stat();
    const identity = `${dev}:${ino}`;
    if (roots.has(root) && roots.get(root) !== identity) throw new Error("NAS root changed; restart after verifying the mount");
    roots.set(root, identity);
    return await action(`/proc/self/fd/${handle.fd}`);
  } finally { await handle.close(); }
}

export async function withNasDirectory(root, id, create, action) {
  if (!nasId(id)) throw new Error("Invalid transfer identifier");
  return withNasRoot(root, async (base) => {
    const location = `${base}/${id}`;
    if (create) await mkdir(location, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const handle = await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { return await action(`/proc/self/fd/${handle.fd}`); }
    finally { await handle.close(); }
  });
}

export async function mirrorNasFile(directory, file, source, signal) {
  if (!nasId(file.id) || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 1) throw new Error("Invalid file metadata");
  const staging = `${directory}/${file.id}.${randomBytes(12).toString("hex")}.partial`;
  const target = `${directory}/${file.id}`;
  const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let bytes = 0;
  const counter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > Number(file.size) ? new Error("NAS source exceeds expected size") : null, chunk);
  } });
  const output = new Writable({ write(chunk, encoding, callback) {
    (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error("NAS write made no progress");
        offset += bytesWritten;
      }
    })().then(() => callback(), callback);
  } });
  try {
    await pipeline(source, counter, output, { signal });
    if (bytes !== Number(file.size)) throw new Error("NAS source size mismatch");
    await handle.sync();
    await handle.close();
    await rename(staging, target);
  } catch (error) {
    source.destroy?.();
    await handle.close().catch(() => {});
    await unlink(staging).catch(() => {});
    throw error;
  }
}

export async function openNasFile(directory, file) {
  if (!nasId(file.id)) throw new Error("Invalid file identifier");
  const handle = await open(`${directory}/${file.id}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Number(file.size)) throw new Error("Local copy is invalid");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function removeNasTransfer(root, id) {
  try {
    await withNasDirectory(root, id, false, async (directory) => {
      for await (const entry of await opendir(directory)) {
        if (!/^[A-Za-z0-9_-]{32}(?:\.[a-f0-9]{24}\.partial)?$/.test(entry.name) || !entry.isFile()) throw new Error("Unexpected NAS directory entry");
        await unlink(`${directory}/${entry.name}`);
      }
    });
    await withNasRoot(root, (base) => rmdir(`${base}/${id}`));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function eachNasTransfer(root, action) {
  return withNasRoot(root, async (base) => {
    for await (const entry of await opendir(base)) {
      if (nasId(entry.name)) await action(entry.name);
    }
  });
}
