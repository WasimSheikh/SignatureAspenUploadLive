// Sliding-window rate limiter. State is per-process; not shared across instances.
const store = new Map();

export function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let timestamps = store.get(key) || [];
  timestamps = timestamps.filter((t) => t > cutoff);
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  store.set(key, timestamps);
  if (store.size > 10000) {
    for (const [k, ts] of store) {
      if (ts.every((t) => t <= cutoff)) store.delete(k);
    }
  }
  return true;
}

export function clientIp(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
