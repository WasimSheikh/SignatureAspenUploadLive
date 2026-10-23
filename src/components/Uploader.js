"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "design-delivery-upload";
const ALLOWED = /\.(psd|ai|pdf|zip|tiff?)$/i;
const formatSize = (bytes) => `${(bytes / 1024 ** (bytes >= 1024 ** 3 ? 3 : 2)).toFixed(1)} ${bytes >= 1024 ** 3 ? "GB" : "MB"}`;

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

function putPart(url, blob, signal, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", url);
    xhr.timeout = 180000;
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error("Storage upload failed. Check the bucket CORS policy exposes ETag."));
    };
    xhr.onerror = () => reject(new Error("Connection interrupted. Please resume your upload."));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Please resume."));
    xhr.onabort = () => reject(new DOMException("Upload paused", "AbortError"));
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) reject(new DOMException("Upload paused", "AbortError"));
    else xhr.send(blob);
  });
}

export default function Uploader() {
  const [files, setFiles] = useState([]);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState({ bytes: 0, total: 0, speed: 0 });
  const [receipt, setReceipt] = useState(null);
  const [dragging, setDragging] = useState(false);
  const controller = useRef(null);
  const form = useRef(null);
  const active = useRef(null);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored?.id && stored?.uploadToken && Array.isArray(stored.fingerprints)) {
        setSaved(stored);
        active.current = stored;
      }
    } catch { /* Storage may be unavailable in private browsing. */ }
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
    if (selected.some((file) => !ALLOWED.test(file.name) || file.size === 0)) {
      setError("Choose non-empty PSD, AI, PDF, ZIP, TIF or TIFF files.");
      return;
    }
    if (selected.length > 100) { setError("Please select at most 100 files."); return; }
    setFiles(selected);
    setError("");
  }

  function remember(value) {
    active.current = value;
    setSaved(value);
    try {
      if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      if (value) setNotice("Browser storage is unavailable. Keep this page open to retain upload progress.");
    }
  }

  async function upload(event) {
    event.preventDefault();
    if (!files.length) { setError("Select the files you want to send."); return; }
    setBusy(true);
    setError("");
    setNotice("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const fingerprints = await Promise.all(files.map(fingerprint));
      let session = active.current;
      if (session && JSON.stringify(session.fingerprints) !== JSON.stringify(fingerprints)) {
        throw new Error("To resume, reselect the same files in the same order, or cancel this transfer to start a new one.");
      }
      if (!session) {
        const fields = Object.fromEntries(new FormData(form.current));
        const created = await api("/api/transfers", {
          method: "POST",
          body: JSON.stringify({
            ...fields,
            retentionDays: Number(fields.retentionDays),
            files: files.map(({ name, size, type }) => ({ name, size, type })),
          }),
        });
        session = { ...created, fingerprints };
        remember(session);
      }
      const path = `/api/transfers/${session.id}`;
      const state = await api(`${path}/upload`, { token: session.uploadToken });
      const total = files.reduce((sum, file) => sum + file.size, 0);
      let done = state.files.reduce((sum, file) => sum + file.parts.reduce((bytes, part) => bytes + Math.min(file.partSize || state.partSize, file.size - (part.partNumber - 1) * (file.partSize || state.partSize)), 0), 0);
      const started = Date.now();
      const initial = done;
      const update = (current = 0) => setProgress({ bytes: done + current, total, speed: (done + current - initial) / Math.max((Date.now() - started) / 1000, 1) });
      update();
      for (let index = 0; index < state.files.length; index++) {
        const remote = state.files[index];
        const local = files[index];
        const partSize = remote.partSize || state.partSize || session.partSize;
        const completed = new Set(remote.parts.map((part) => part.partNumber));
        for (let part = 1; part <= Math.ceil(local.size / partSize); part++) {
          if (completed.has(part)) continue;
          const blob = local.slice((part - 1) * partSize, part * partSize);
          for (let attempt = 0; ; attempt++) {
            abort.signal.throwIfAborted();
            try {
              const { url } = await api(`${path}/parts`, {
                token: session.uploadToken, method: "POST", signal: abort.signal,
                body: JSON.stringify({ fileId: remote.id, partNumber: part }),
              });
              await putPart(url, blob, abort.signal, update);
              break;
            } catch (failure) {
              if (abort.signal.aborted || attempt >= 4) throw failure;
              setNotice(`Connection interrupted. Retrying chunk (${attempt + 1}/4)…`);
              await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 10000)));
            }
          }
          done += blob.size;
          update();
          setNotice("");
        }
      }
      abort.signal.throwIfAborted();
      setNotice("Verifying your files and sending notifications…");
      const result = await api(`${path}/complete`, { token: session.uploadToken, method: "POST", body: "{}" });
      setReceipt({ ...result, url: result.url || `${window.location.origin}/transfer/${session.id}` });
      remember(null);
      setNotice("");
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

  if (receipt) return (
    <section className="card receipt">
      <div className="success-icon" aria-hidden="true">✓</div>
      <h2>Your files are ready.</h2>
      <p>Anyone with this link can access the transfer{receipt.requiresPasscode ? " using your passcode" : ""}. Share it only with your intended recipients.</p>
      <label>Private download link<input readOnly value={receipt.url} onFocus={(event) => event.target.select()} /></label>
      <button onClick={async () => {
        try { await navigator.clipboard.writeText(receipt.url); setNotice("Link copied."); }
        catch { setNotice("Select and copy the link above."); }
      }}>Copy link</button>
      <a className="button secondary" href={receipt.url}>View transfer</a>
      <p role="status">{notice}</p>
      <p className="muted">{receipt.emailStatus === "sent" ? "Confirmation emails sent." : "Files are ready. If notifications are delayed, share the link directly."}</p>
      <button className="text-button" onClick={() => { setReceipt(null); setFiles([]); setNotice(""); }}>Send another transfer</button>
    </section>
  );

  const percent = progress.total ? Math.min(100, progress.bytes / progress.total * 100) : 0;
  return (
    <form className="card" ref={form} onSubmit={upload}>
      <div className="card-heading"><h2>Send your files</h2><span className="badge">No account needed</span></div>
      {saved && <p className="banner">An unfinished upload is saved on this browser. Reselect the original files to resume, or cancel it below.</p>}
      <label className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFiles(event.dataTransfer.files); }}>
        <span className="upload-icon" aria-hidden="true">↑</span>
        <strong>Drop your design files here</strong>
        <span>or click to browse · PSD, AI, PDF, ZIP, TIF</span>
        <small>5 GB+ supported · Default transfer limit: 20 GiB</small>
        <input aria-label="Choose design files" type="file" multiple accept=".psd,.ai,.pdf,.zip,.tif,.tiff" disabled={busy}
          onChange={(event) => chooseFiles(event.target.files)} />
      </label>
      {files.length > 0 && <ul className="file-list">{files.map((file, index) => <li key={index}><span>{file.name}</span><small>{formatSize(file.size)}</small></li>)}</ul>}
      <fieldset disabled={busy || Boolean(saved)}>
        <div className="grid">
          <label>Your email<input name="senderEmail" type="email" required maxLength={254} placeholder="you@studio.com" /></label>
          <label>Recipient emails<input name="recipientEmails" type="email" multiple required maxLength={2540} placeholder="team@company.com" /></label>
          <label>Client / company<input name="company" required maxLength={200} placeholder="Signature Aspen" /></label>
          <label>Title / order ID<input name="title" required maxLength={200} placeholder="Spring campaign artwork" /></label>
        </div>
        <label>Message <span className="muted">(optional)</span><textarea name="message" rows={3} maxLength={2000} placeholder="Anything the team should know?" /></label>
        <div className="grid">
          <label>Link expires after<select name="retentionDays" defaultValue="7"><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
          <label>Passcode <span className="muted">(optional, 8+ characters)</span><input name="passcode" type="password" minLength={8} maxLength={128} autoComplete="new-password" /></label>
        </div>
      </fieldset>
      {progress.total > 0 && <div className="progress-area" aria-live="polite">
        <div><strong>{percent.toFixed(1)}%</strong><span>{formatSize(progress.bytes)} / {formatSize(progress.total)} · {formatSize(progress.speed)}/s</span></div>
        <progress value={progress.bytes} max={progress.total} aria-label="Upload progress" />
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="banner" role="status">{notice}</p>}
      <div className="actions">
        <button type="submit" disabled={busy || !files.length}>{busy ? "Uploading…" : saved ? "Resume upload" : "Upload & create link"}</button>
        {busy && <button type="button" className="secondary" onClick={() => controller.current?.abort()}>Pause</button>}
        {saved && !busy && <button type="button" className="secondary" onClick={cancel}>Cancel transfer</button>}
      </div>
      <p className="muted fine-print">Keep this tab open during upload. Interrupted uploads can be resumed on this browser by reselecting the same files. Passcodes must be shared separately.</p>
    </form>
  );
}
