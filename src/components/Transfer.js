"use client";

import { useEffect, useState } from "react";

const formatSize = (bytes) => bytes < 1024 ** 2
  ? `${(bytes / 1024).toFixed(0)} KB`
  : `${(bytes / 1024 ** (bytes >= 1024 ** 3 ? 3 : 2)).toFixed(1)} ${bytes >= 1024 ** 3 ? "GB" : "MB"}`;

function extOf(name) { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; }
function badgeLabel(name) { const e = extOf(name); return e ? e.toUpperCase().slice(0, 4) : "FILE"; }
function badgeClass(name) {
  const e = extOf(name);
  if (e === "pdf") return "b-pdf";
  if (["zip", "7z", "rar"].includes(e)) return "b-zip";
  if (["ai", "eps", "psd", "indd"].includes(e)) return "b-art";
  if (["jpg", "jpeg", "png", "tif", "tiff", "gif"].includes(e)) return "b-img";
  return "b-other";
}

export default function Transfer({ id }) {
  const [transfer, setTransfer] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/api/transfers/${encodeURIComponent(id)}`;

  useEffect(() => {
    const abort = new AbortController();
    fetch(path, { signal: abort.signal }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "This transfer is unavailable or has expired.");
      setTransfer(data);
    }).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [path]);

  async function unlock(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${path}/unlock`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: new FormData(event.currentTarget).get("passcode") }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Unable to unlock this transfer.");
      const r2 = await fetch(path);
      const meta = await r2.json();
      if (!r2.ok) throw new Error(meta.error || "Unable to load transfer.");
      setTransfer(meta);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const totalSize = transfer?.files?.reduce((s, f) => s + f.size, 0) || 0;
  const expiresStr = transfer?.expiresAt
    ? new Date(transfer.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";

  if (!transfer && !error) return (
    <div className="card" style={{ marginTop: 28 }}>
      <p role="status" style={{ color: "var(--muted)" }}>Loading your files…</p>
    </div>
  );

  if (error && !transfer) return (
    <div className="card" style={{ maxWidth: 520, margin: "28px auto", textAlign: "center", padding: "40px 28px" }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--danger-50)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--danger)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
        </svg>
      </div>
      <h2 style={{ fontSize: 22, marginBottom: 8 }}>Link unavailable</h2>
      <p style={{ color: "var(--muted)", marginBottom: 20 }}>{error}</p>
      <a className="button secondary" href="/">Send a new transfer</a>
    </div>
  );

  if (transfer?.requiresPasscode && !transfer.files) return (
    <div className="card" style={{ maxWidth: 480, margin: "28px auto", textAlign: "center" }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--surface)", border: "1px solid var(--line)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="var(--navy)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>
        </svg>
      </div>
      <p className="eyebrow" style={{ marginBottom: 8 }}>PROTECTED TRANSFER</p>
      <h1 style={{ fontSize: "clamp(20px,3vw,26px)", marginBottom: 8 }}>This transfer is protected</h1>
      <p style={{ color: "var(--muted)", marginBottom: 24, fontSize: 15 }}>Enter the passcode shared by the sender.</p>
      <form onSubmit={unlock} style={{ textAlign: "left" }}>
        <div className="field">
          <label>Passcode<span className="req" aria-hidden="true">*</span>
            <input className="in" name="passcode" type="password" required maxLength={128} autoComplete="current-password" placeholder="••••••••" />
          </label>
        </div>
        {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}
        <button className="button btn-primary" style={{ width: "100%", marginTop: 4 }} disabled={busy}>
          {busy ? "Unlocking…" : "Unlock transfer"}
        </button>
      </form>
    </div>
  );

  if (!transfer?.files) return null;

  return (
    <>
      {/* Page heading */}
      <div style={{ paddingTop: 32, paddingBottom: 20 }}>
        <p className="eyebrow" style={{ marginBottom: 6 }}>SIGNATURE ASPEN · DESIGN DELIVERY</p>
        <h1 style={{ fontSize: "clamp(24px,4vw,36px)", marginBottom: 10, letterSpacing: "-0.5px" }}>
          {transfer.title || "Your design files are ready"}
        </h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 20px", color: "var(--muted)", fontSize: 14 }}>
          <span>From <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{transfer.company}</strong></span>
          <span>{transfer.senderEmail}</span>
          {expiresStr && <span>Expires {expiresStr}</span>}
        </div>
      </div>

      {/* Message */}
      {transfer.message && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderLeft: "3px solid var(--green)", borderRadius: 8, padding: "14px 18px", marginBottom: 20, fontSize: 14, whiteSpace: "pre-wrap", lineHeight: 1.6, color: "var(--ink)" }}>
          {transfer.message}
        </div>
      )}

      {/* File list card */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {/* Card header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 15, color: "var(--navy)" }}>
            {transfer.files.length} file{transfer.files.length !== 1 ? "s" : ""} · {formatSize(totalSize)}
          </span>
          <a className="button secondary" href={`${path}/download`}
            style={{ padding: "8px 16px", fontSize: 13 }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3M7 11l5 5 5-5M12 4v12"/>
            </svg>
            Download all (.zip)
          </a>
        </div>

        {/* File rows */}
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {transfer.files.map((file) => (
            <li key={file.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: "10px 14px", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--line)" }}>
              <span className={`badge ${badgeClass(file.name)}`}>{badgeLabel(file.name)}</span>
              <span style={{ fontWeight: 500, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{file.name}</span>
              <span style={{ color: "var(--muted)", fontSize: 13, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{formatSize(file.size)}</span>
              <a className="button secondary" href={`${path}/download?file=${encodeURIComponent(file.id)}`}
                style={{ padding: "7px 14px", fontSize: 13, flexShrink: 0 }}>
                Download
              </a>
            </li>
          ))}
        </ul>
      </div>

      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 10 }}>
        ZIP downloads stream as they package — large transfers may take a moment to start.
      </p>
      <a href="/" style={{ display: "inline-block", marginTop: 24, fontSize: 13, color: "var(--navy)", fontWeight: 600, textDecoration: "none" }}>
        Send files to Signature Aspen →
      </a>
    </>
  );
}
