export const UPLOAD_CONCURRENCY = 3;

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Upload paused", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function uploadParts({
  files, remoteFiles, partSize, sign, send, signal, onProgress = () => {},
  onRetry = () => {}, concurrency = UPLOAD_CONCURRENCY, retryDelay = 1000,
  clock = () => Date.now(),
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    throw new Error("Upload concurrency must be between 1 and 6.");
  }
  if (files.length !== remoteFiles.length) throw new Error("The selected files do not match this transfer.");
  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  let done = 0;
  for (let index = 0; index < files.length; index++) {
    const remote = remoteFiles[index];
    if (files[index].size !== remote.size || files[index].name !== remote.name) {
      throw new Error("The selected files do not match this transfer.");
    }
    const chunkSize = remote.partSize || partSize;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("Invalid upload chunk size.");
    const count = Math.ceil(remote.size / chunkSize);
    const seen = new Set();
    for (const part of remote.parts) {
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > count || seen.has(part.partNumber)) {
        throw new Error("Invalid saved upload parts.");
      }
      seen.add(part.partNumber);
      done += Math.min(chunkSize, remote.size - (part.partNumber - 1) * chunkSize);
    }
  }
  const initial = done;
  const started = clock();
  const inFlight = new Map();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const update = () => {
    const bytes = done + [...inFlight.values()].reduce((sum, value) => sum + value, 0);
    onProgress({ bytes: Math.min(bytes, total), total, speed: Math.max(0, bytes - initial) / Math.max((clock() - started) / 1000, 1) });
  };
  function* pendingParts() {
    for (let index = 0; index < remoteFiles.length; index++) {
      const remote = remoteFiles[index];
      const chunkSize = remote.partSize || partSize;
      const completed = new Set(remote.parts.map((part) => part.partNumber));
      for (let part = 1; part <= Math.ceil(remote.size / chunkSize); part++) {
        if (!completed.has(part)) yield { index, remote, part, chunkSize, key: `${index}:${part}` };
      }
    }
  }
  const jobs = pendingParts();
  let failure;
  async function worker() {
    while (true) {
      controller.signal.throwIfAborted();
      const next = jobs.next();
      if (next.done) return;
      const { index, remote, part, chunkSize, key } = next.value;
      const blob = files[index].slice((part - 1) * chunkSize, part * chunkSize);
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        inFlight.set(key, 0);
        update();
        try {
          const url = await sign(remote.id, part, controller.signal);
          await send(url, blob, controller.signal, (loaded) => {
            inFlight.set(key, Math.min(blob.size, Math.max(0, loaded)));
            update();
          });
          break;
        } catch (error) {
          inFlight.set(key, 0);
          update();
          if (controller.signal.aborted || attempt >= 4 ||
              (error.status && error.status < 500 && ![409, 429].includes(error.status))) throw error;
          onRetry(attempt + 1);
          await wait(Math.min(retryDelay * 2 ** attempt, 10000), controller.signal);
        }
      }
      inFlight.delete(key);
      done += blob.size;
      update();
    }
  }
  try {
    update();
    await Promise.allSettled(Array.from({ length: concurrency }, async () => {
      try { await worker(); }
      catch (error) {
        if (!failure) failure = error;
        controller.abort(error);
      }
    }));
    signal.throwIfAborted();
    if (failure) throw failure;
    controller.signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
