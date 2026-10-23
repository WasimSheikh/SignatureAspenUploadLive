"use client";

import { useEffect, useState } from "react";

export default function Transfer({ id }) {
  const [transfer, setTransfer] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/api/transfers/${encodeURIComponent(id)}`;

  useEffect(() => {
    const abort = new AbortController();
    fetch(path, { signal: abort.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "This transfer is unavailable or has expired.");
      setTransfer(data);
    }).catch((failure) => { if (!abort.signal.aborted) setError(failure.message); });
    return () => abort.abort();
  }, [path]);

  async function unlock(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${path}/unlock`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: new FormData(event.currentTarget).get("passcode") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to unlock this transfer.");
      const details = await fetch(path);
      const metadata = await details.json();
      if (!details.ok) throw new Error(metadata.error || "Unable to load transfer.");
      setTransfer(metadata);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card transfer">
      {!transfer && !error && <p role="status">Loading transfer…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {transfer?.requiresPasscode && !transfer.files ? (
        <form onSubmit={unlock}>
          <p className="eyebrow">PROTECTED TRANSFER</p>
          <h1>Your files are behind a passcode.</h1>
          <p>Enter the passcode shared by the sender.</p>
          <label>Passcode<input name="passcode" type="password" required maxLength={128} autoComplete="current-password" /></label>
          <button disabled={busy}>{busy ? "Unlocking…" : "Unlock transfer"}</button>
        </form>
      ) : transfer?.files ? (
        <>
          <p className="eyebrow">YOUR DESIGN DELIVERY</p>
          <h1>{transfer.title}</h1>
          <dl><dt>Client</dt><dd>{transfer.company}</dd><dt>From</dt><dd>{transfer.senderEmail}</dd><dt>Expires</dt><dd>{new Date(transfer.expiresAt).toLocaleString()}</dd></dl>
          {transfer.message && <p className="message">{transfer.message}</p>}
          <ul className="file-list">{transfer.files.map((file) => <li key={file.id}>
            <span>{file.name}<small>{(file.size / 1024 ** 2).toFixed(1)} MB</small></span>
            <a href={`${path}/download?file=${encodeURIComponent(file.id)}`}>Download</a>
          </li>)}</ul>
          <a className="button" href={`${path}/download`}>Download all (.zip)</a>
          <p className="muted">Your ZIP is streamed as it downloads. Large transfers may take a while.</p>
        </>
      ) : null}
      <a className="back-link" href="/">Send a new transfer →</a>
    </section>
  );
}
