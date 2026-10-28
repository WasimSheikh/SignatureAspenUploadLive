"use client";

import { useEffect, useRef, useState } from "react";
import { putPart, uploadParts } from "@/lib/upload-client.mjs";
import ShareLink from "./ShareLink";

const STORAGE_UPLOAD = "design-delivery-upload";
const STORAGE_PROOF = "design-delivery-proof";
const ALLOWED = /\.(psd|ai|pdf|zip|tiff?)$/i;
const MAX_BYTES = 20 * 1024 ** 3;

const CONTACTS = [
  { id: "lmelchor",  name: "Louis Melchor",   role: "Account Manager", email: "lmelchor@signatureaspen.com" },
  { id: "jturner",   name: "Jeff Turner",      role: "Account Manager", email: "jturner@signatureaspen.com" },
  { id: "jseiford",  name: "Jimmy Seiford",    role: "Account Manager", email: "jseiford@signatureaspen.com" },
  { id: "ccarroll",  name: "Colton Carroll",   role: "Account Manager", email: "ccarroll@signatureaspen.com" },
  { id: "gemmott",   name: "Gary Emmott",      role: "Account Manager", email: "gemmott@signatureaspen.com" },
  { id: "akliafas",  name: "Alex Kliafas",     role: "Account Manager", email: "akliafas@signatureaspen.com" },
  { id: "msimpson",  name: "Mike Simpson",     role: "Account Manager", email: "msimpson@signatureaspen.com" },
  { id: "jleon",     name: "Joel Leon",        role: "Account Manager", email: "JLeon@signatureaspen.com" },
  { id: "kdasilva",  name: "Kris Da Silva",    role: "Account Manager", email: "kdasilva@signatureaspen.com" },
  { id: "ihoover",   name: "Ida Hoover",       role: "Account Manager", email: "ihoover@signatureaspen.com" },
  { id: "marmstrong", name: "Michelle Armstrong", role: "Account Manager", email: "marmstrong@signatureaspen.com" },
  { id: "other",     name: "Other",            label: "Other — I'll type their name below", role: "", email: "sales@signatureaspen.com" },
];
const SALES_CONTACT = { id: "sales", name: "Signature Aspen", email: "sales@signatureaspen.com" };

const formatSize = (bytes) => bytes < 1024 ** 2
  ? `${(bytes / 1024).toFixed(0)} KB`
  : `${(bytes / 1024 ** (bytes >= 1024 ** 3 ? 3 : 2)).toFixed(1)} ${bytes >= 1024 ** 3 ? "GB" : "MB"}`;

const formatEta = (bytes, total, speed) => {
  if (!speed || bytes >= total) return null;
  const secs = Math.ceil((total - bytes) / speed);
  if (secs < 60) return `${secs}s left`;
  if (secs < 3600) return `${Math.ceil(secs / 60)}m left`;
  return `${(secs / 3600).toFixed(1)}h left`;
};

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

async function api(path, { token, ...options } = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: ["Bearer", token].join(" ") } : {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function fingerprint(file) {
  const sample = new Uint8Array(await new Blob([file.slice(0, 65536), file.slice(-65536)]).arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", sample);
  return `${file.name}:${file.size}:${file.lastModified}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export default function Uploader({ employee = null, onComplete, showHero = true, slimHero = false, mode = "upload" }) {
  const proof = mode === "proof";
  const storageKey = proof ? STORAGE_PROOF : STORAGE_UPLOAD;
  const [files, setFiles] = useState([]);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState({ bytes: 0, total: 0, speed: 0 });
  const [receipt, setReceipt] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [filesDone, setFilesDone] = useState(0);
  const [otherContact, setOtherContact] = useState(false);
  const [urlPrefill, setUrlPrefill] = useState({});
  const controller = useRef(null);
  const form = useRef(null);
  const active = useRef(null);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey));
      if (stored?.id && stored?.uploadToken && Array.isArray(stored.fingerprints)) {
        setSaved(stored);
        active.current = stored;
      }
    } catch { /* Storage may be unavailable in private browsing. */ }
    try {
      const params = new URLSearchParams(window.location.search);
      const prefill = {};
      if (params.get("contact")) {
        prefill.contact = params.get("contact");
        if (params.get("contact") === "other") setOtherContact(true);
      }
      if (params.get("job")) prefill.jobNumber = params.get("job");
      if (params.get("company")) prefill.company = params.get("company");
      if (Object.keys(prefill).length) setUrlPrefill(prefill);
    } catch { /* ignore */ }
    return () => controller.current?.abort();
  }, []);

  useEffect(() => {
    if (!busy) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  function chooseFiles(incoming) {
    if (busy) return;
    const selected = Array.from(incoming);
    const invalid = selected.filter((f) => !ALLOWED.test(f.name) || f.size === 0 || /[*?"<>|]/.test(f.name));
    if (invalid.length) {
      setError(`${invalid.map((f) => f.name).join(", ")} — only PSD, AI, PDF, ZIP, TIF or TIFF files are accepted. Rename files with special characters (* ? " < > |) before uploading.`);
      return;
    }
    setError("");
    setFiles((prev) => {
      const merged = [...prev];
      let skipped = 0;
      for (const file of selected) {
        if (merged.some((f) => f.name === file.name && f.size === file.size)) { skipped++; continue; }
        if (merged.length >= 100) { setError("You can add up to 100 files. Remove some to add more."); break; }
        merged.push(file);
      }
      if (skipped && !merged.length) setError(`${skipped} file${skipped > 1 ? "s are" : " is"} already in your list.`);
      return merged;
    });
  }

  function remember(value) {
    active.current = value;
    setSaved(value);
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      if (value) setNotice("Browser storage is unavailable. Keep this page open to retain upload progress.");
    }
  }

  async function upload(event) {
    event.preventDefault();
    if (!files.length) { setError("Select the files you want to send."); return; }
    const fields = Object.fromEntries(new FormData(form.current));
    setBusy(true);
    setFilesDone(0);
    setError("");
    setNotice("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const contactBase = CONTACTS.find((c) => c.id === fields.contact) || SALES_CONTACT;
      const contact = proof
        ? { id: "customer", name: fields.name || "Customer", email: fields.customerEmail }
        : fields.contact === "other"
          ? { ...contactBase, name: fields.otherContactName || "Other" }
          : contactBase;
      const fingerprints = await Promise.all(files.map(fingerprint));
      let session = active.current;
      if (session && JSON.stringify(session.fingerprints) !== JSON.stringify(fingerprints)) {
        throw new Error("To resume, reselect the same files in the same order, or cancel this transfer to start a new one.");
      }
      if (!session) {
        const messageParts = [];
        if (proof) messageParts.push("Purpose: proof");
        if (proof && employee?.name) messageParts.push(`From: ${employee.name}`);
        else if (fields.name) messageParts.push(`From: ${fields.name}`);
        if (proof && fields.name) messageParts.push(`To: ${fields.name}`);
        if (fields.phone) messageParts.push(`Phone: ${fields.phone}`);
        if (fields.notes) messageParts.push(fields.notes);
        const created = await api("/api/transfers", {
          method: "POST",
          body: JSON.stringify({
            purpose: proof ? "proof" : "upload",
            senderEmail: proof ? (employee?.email || fields.senderEmail) : fields.senderEmail,
            recipientEmails: proof ? fields.customerEmail : contact.email,
            company: fields.company,
            title: fields.jobNumber?.trim()
              || (proof ? `Design proof for ${fields.company || "customer"}` : `File upload from ${fields.company || "client"}`),
            message: messageParts.join("\n"),
            retentionDays: 30,
            passcode: "",
            files: files.map(({ name, size, type }) => ({ name, size, type })),
          }),
        });
        session = { ...created, fingerprints };
        remember(session);
      }
      const path = `/api/transfers/${session.id}`;
      const state = await api(`${path}/upload`, { token: session.uploadToken });
      await uploadParts({
        files, remoteFiles: state.files, partSize: state.partSize || session.partSize,
        signal: abort.signal, onProgress: setProgress,
        onRetry: (attempt) => setNotice(`Connection interrupted. Retrying chunk (${attempt}/4)…`),
        sign: async (fileId, partNumber, signal) => {
          const result = await api(`${path}/parts`, {
            token: session.uploadToken, method: "POST", signal,
            body: JSON.stringify({ fileId, partNumber }),
          });
          const fileIndex = (session.files || files).findIndex((f) => (f.id || f.name) === fileId);
          const totalParts = Math.ceil((session.files?.[fileIndex]?.size || files[fileIndex]?.size || 1) / (state.partSize || session.partSize || 1));
          if (partNumber === totalParts) setFilesDone((n) => n + 1);
          return result.url;
        },
        send: putPart,
      });
      abort.signal.throwIfAborted();
      setNotice("Verifying your files and sending notifications…");
      const result = await api(`${path}/complete`, { token: session.uploadToken, method: "POST", body: "{}" });
      const transferId = session.id;
      const now = new Date();
      const dateStr = `${String(now.getFullYear()).slice(2)}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
      const receiptNum = `SA-${dateStr}-${transferId.slice(-4).toUpperCase()}`;
      const whenStr = now.toLocaleString("en-US", { weekday:"short", month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" });
      setReceipt({
        ...result,
        proof,
        url: result.url || `${window.location.origin}/transfer/${transferId}`,
        senderName: fields.name || "",
        senderEmail: proof ? (fields.customerEmail || "") : (fields.senderEmail || ""),
        contactName: proof ? (fields.name || fields.customerEmail || "the customer") : contact.name,
        jobNumber: fields.jobNumber?.trim() || "",
        uploadedFiles: files.map((f) => ({ name: f.name, size: f.size })),
        totalSize: files.reduce((s, f) => s + f.size, 0),
        receiptNum,
        whenStr,
      });
      remember(null);
      setNotice("");
      onComplete?.();
    } catch (failure) {
      if (abort.signal.aborted) setNotice("Upload paused. Keep the files selected and choose Resume upload.");
      else {
        if ([404, 410].includes(failure.status)) remember(null);
        setError(failure.message);
      }
    } finally { setBusy(false); }
  }

  async function cancel() {
    if (!saved || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/transfers/${saved.id}`, { token: saved.uploadToken, method: "DELETE" });
      remember(null);
      setProgress({ bytes: 0, total: 0, speed: 0 });
      setNotice("Transfer cancelled and uploaded data removed.");
    } catch (failure) {
      if ([404, 410].includes(failure.status)) {
        remember(null);
        setNotice("The previous transfer is no longer available. You can start a new one.");
      } else setError(failure.message);
    }
    finally { setBusy(false); }
  }

  if (receipt) {
    const firstName = (receipt.senderName || "").trim().split(/\s+/)[0] || "there";
    const n = receipt.uploadedFiles?.length || 0;
    const totalFmt = receipt.totalSize ? formatSize(receipt.totalSize) : "";
    return (
      <section className="card ok-card">
        <div className="ok-mark" aria-hidden="true">✓</div>
        <h2>{receipt.proof ? "Proof sent." : `Got them. Thanks, ${firstName}.`}</h2>
        <p className="ok-sub">
          {n} {n === 1 ? "file" : "files"}{totalFmt ? ` (${totalFmt})` : ""} {n === 1 ? "is" : "are"}{" "}
          {receipt.proof ? `on the way to ${receipt.contactName}.` : `with ${receipt.contactName}.`}
        </p>

        <div className="receipt-badge">
          <span>Receipt <strong>{receipt.receiptNum}</strong></span>
          <span>{receipt.whenStr}</span>
        </div>

        {receipt.uploadedFiles?.length > 0 && (
          <div className="ok-files">
            <ul className="flist">
              {receipt.uploadedFiles.map((f, i) => (
                <li key={i} className="frow" style={{ gridTemplateColumns: "auto 1fr auto" }}>
                  <span className={`badge ${badgeClass(f.name)}`}>{badgeLabel(f.name)}</span>
                  <span className="fname">{f.name}</span>
                  <span className="fsize">{formatSize(f.size)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="ok-line">
          {receipt.proof
            ? <>A download link is on its way to <strong>{receipt.senderEmail}</strong>.</>
            : <>A confirmation is on its way to <strong>{receipt.senderEmail}</strong>.</>}
        </p>

        {receipt.url && (
          <ShareLink url={receipt.url} label={receipt.proof ? "Share URL for the customer" : "Share URL"} />
        )}

        <div className="callout">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>
          </svg>
          <p>{receipt.proof
            ? "The customer can open the private link to review and download. Send another proof below if you need to replace a file."
            : "No need to send these again. If you need to add or replace a file for this job, use the button below."}</p>
        </div>

        <div className="ok-actions">
          <div className="ok-actions-row">
            <a className="button btn-primary" href={receipt.url} target="_blank" rel="noreferrer">View transfer</a>
            <button className="button secondary" onClick={() => {
              setReceipt(null);
              setFiles([]);
              setProgress({ bytes: 0, total: 0, speed: 0 });
              setFilesDone(0);
              setNotice("");
              setError("");
            }}>{receipt.proof ? "Send another proof" : "Send more files for this job"}</button>
          </div>
          <button className="text-button" onClick={() => {
            setReceipt(null); setFiles([]); setNotice(""); setError("");
            setProgress({ bytes: 0, total: 0, speed: 0 }); setFilesDone(0);
          }}>Start over</button>
        </div>

        {notice && <p role="status" style={{ fontSize: 13, color: "var(--muted)", marginTop: 12, textAlign: "center" }}>{notice}</p>}
      </section>
    );
  }

  const percent = progress.total ? Math.min(100, progress.bytes / progress.total * 100) : 0;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const meterPct = Math.min(100, (totalBytes / MAX_BYTES) * 100);

  return (
    <>
      {showHero && (
        <section className={`hero${slimHero ? " slim" : ""}`}>
          <div className="hero-wrap">
            <h1>{proof ? "Send a design proof" : "Send your design files"}</h1>
            <p>{proof
              ? "Upload the approved files and we email your customer a private download link."
              : "Drop your artwork here and it goes straight to your Aspen contact. Recipients get a private link and confirmation right away."}</p>
          </div>
        </section>
      )}

      <form className="card" ref={form} onSubmit={upload}>
        {saved && <p className="banner">An unfinished upload is saved on this browser. Reselect the original files to resume, or cancel it below.</p>}
        <div className="qd-grid">
          <div>
            <h2 className="col-title">Your files</h2>
            <label className={`dz ${dragging ? "dragging" : ""} ${busy ? "locked-dz" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); chooseFiles(e.dataTransfer.files); }}>
              <span className="dz-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>
                </svg>
              </span>
              <strong>Drag files here or <span className="dz-browse">browse</span></strong>
              <span>or click to browse · PSD, AI, PDF, ZIP, TIF</span>
              <span style={{ fontSize: 12, marginTop: 4 }}>Up to 100 files · 20 GiB total</span>
              <input aria-label="Choose design files" type="file" multiple accept=".psd,.ai,.pdf,.zip,.tif,.tiff" disabled={busy}
                onChange={(e) => chooseFiles(e.target.files)} />
            </label>

            {files.length > 0 && (
              <>
                <div className="flist-head">
                  <span>Your files ({files.length})</span>
                  <button type="button" className="flist-clear" onClick={() => !busy && setFiles([])}>Clear all</button>
                </div>
                <ul className="flist">
                  {files.map((file, idx) => (
                    <li key={idx} className="frow">
                      <span className={`badge ${badgeClass(file.name)}`}>{badgeLabel(file.name)}</span>
                      <span className="fname">{file.name}</span>
                      <span className="fsize">{formatSize(file.size)}</span>
                      <button type="button" className="fremove" aria-label={`Remove ${file.name}`}
                        onClick={() => !busy && setFiles((prev) => prev.filter((_, i) => i !== idx))}>×</button>
                    </li>
                  ))}
                </ul>
                <div className={`meter ${meterPct >= 90 ? "near" : ""}`}>
                  <div className="meter-top">
                    <strong>{formatSize(totalBytes)} of 20 GiB</strong>
                    <span>{files.length} of 100 files</span>
                  </div>
                  <div className="meter-bar">
                    <span className="meter-fill" style={{ width: (totalBytes > 0 ? Math.max(meterPct, 0.5) : 0) + "%" }} />
                  </div>
                </div>
              </>
            )}
          </div>

          <div>
            <h2 className="col-title">{proof ? "Customer details" : "Your details"}</h2>
            {proof && employee && (
              <p className="muted fine-print" style={{ marginBottom: 12 }}>Sending as {employee.name || employee.email}. The customer gets the download link.</p>
            )}
            {proof && !employee?.email && (
              <p className="error" role="alert">Your Microsoft account has no email on file, so a proof cannot be sent.</p>
            )}
            <fieldset disabled={busy || Boolean(saved)}>
              {proof && <input type="hidden" name="senderEmail" value={employee?.email || ""} />}
              <div className="row2">
                <div className="field">
                  <label>{proof ? "Customer name" : "Your name"}<span className="req" aria-hidden="true">*</span>
                    <input className="in" name="name" type="text" required maxLength={200} autoComplete="name" placeholder="Jordan Ellis" defaultValue={proof ? "" : (employee?.name || "")} />
                  </label>
                </div>
                <div className="field">
                  <label>{proof ? "Customer email" : "Email"}<span className="req" aria-hidden="true">*</span>
                    {proof
                      ? <input className="in" name="customerEmail" type="email" required maxLength={254} autoComplete="email" placeholder="jordan@company.com" />
                      : <input className="in" name="senderEmail" type="email" required maxLength={254} autoComplete="email" placeholder="you@company.com" defaultValue={employee?.email || ""} />}
                  </label>
                </div>
              </div>
              <div className="row2">
                <div className="field">
                  <label>Company<span className="req" aria-hidden="true">*</span>
                    <input className="in" name="company" type="text" required maxLength={200} autoComplete="organization" placeholder="Bayou City Credit Union" defaultValue={urlPrefill.company || ""} />
                  </label>
                </div>
                <div className="field">
                  <label>Phone <span className="opt">(optional)</span>
                    <input className="in" name="phone" type="tel" maxLength={30} autoComplete="tel" placeholder="713.555.0100" />
                  </label>
                </div>
              </div>
              {!proof && (
                <div className="field">
                  <label>Who at Aspen are you working with? <span className="opt">(optional)</span>
                    <select className="in" name="contact" defaultValue={urlPrefill.contact || ""}
                      onChange={(e) => setOtherContact(e.target.value === "other")}>
                      <option value="">Not sure — send to sales</option>
                      {CONTACTS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label || (c.role ? `${c.name} — ${c.role}` : c.name)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {!proof && otherContact && (
                <div className="field">
                  <label>Their name<span className="req" aria-hidden="true">*</span>
                    <input className="in" name="otherContactName" type="text" required maxLength={100}
                      placeholder="e.g. Sarah Jones" />
                  </label>
                </div>
              )}
              <div className="field">
                <label>Job or quote number <span className="opt">(optional)</span>
                  <input className="in" name="jobNumber" type="text" maxLength={100} placeholder="130912 or Q-48817" defaultValue={urlPrefill.jobNumber || ""} />
                </label>
                <p className="help">{proof ? "Shown on the customer’s download email" : "Found on your quote or proof"}</p>
              </div>
              <div className="field">
                <label>{proof ? "Note to the customer" : "Notes for our team"} <span className="opt">(optional)</span>
                  <textarea className="in" name="notes" rows={3} maxLength={2000} placeholder={proof ? "Please review pages 2 and 3 and reply with approval." : "Final art for the fall mailer. Reply card on its own page."} />
                </label>
              </div>
            </fieldset>
          </div>
        </div>

        {progress.total > 0 && (
          <div className="progress-area" aria-live="polite">
            <div className="progress-header">
              <span className="progress-pct">{percent.toFixed(0)}%</span>
              <span className="progress-eta">{formatEta(progress.bytes, progress.total, progress.speed)}</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="progress-stats">
              <span>{formatSize(progress.bytes)} of {formatSize(progress.total)}</span>
              <span>{formatSize(progress.speed)}/s</span>
            </div>
          </div>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="banner" role="status">{notice}</p>}

        <div className="qd-foot">
          <button type="submit" className="btn-primary" disabled={busy || !files.length || (proof && !employee?.email)}>
            {busy
              ? (files.length > 1 ? `Sending… ${filesDone} of ${files.length} done` : "Sending…")
              : saved
                ? "Resume upload"
                : files.length > 0
                  ? `${proof ? "Send proof" : "Send"} · ${files.length} file${files.length > 1 ? "s" : ""}`
                  : proof ? "Send design proof" : "Send files"}
          </button>
          {busy && (
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 10 }}>
              <button type="button" className="secondary" onClick={() => controller.current?.abort()}>Pause</button>
            </div>
          )}
          {saved && !busy && (
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 10 }}>
              <button type="button" className="secondary" onClick={cancel}>Cancel transfer</button>
            </div>
          )}
          <p className="send-hint" style={{ marginTop: 12 }}>Keep this tab open during upload. Interrupted uploads can be resumed.</p>
        </div>
      </form>

      <section className="tips" aria-label="Tips for sending files">
        <div className="tip">
          <span className="tip-ico">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>
            </svg>
          </span>
          <div><h3>PDFs print best</h3><p>Send a high-res PDF with 0.125 in bleed when possible.</p></div>
        </div>
        <div className="tip">
          <span className="tip-ico">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>
            </svg>
          </span>
          <div><h3>Sending InDesign or Illustrator?</h3><p>Package it with fonts and links, then zip the folder.</p></div>
        </div>
        <div className="tip">
          <span className="tip-ico">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013 6.18a2 2 0 012-2.18h3a2 2 0 012 1.72c.13.96.37 1.9.7 2.81a2 2 0 01-.45 2.11L9.09 11.91a16 16 0 005 5l1.27-1.27a2 2 0 012.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0122 16.92z"/>
            </svg>
          </span>
          <div><h3>Bigger than 20 GiB?</h3><p>Call 713.956.8555 and we will send you a special link.</p></div>
        </div>
      </section>
    </>
  );
}
