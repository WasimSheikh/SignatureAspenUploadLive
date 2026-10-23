"use client";

import { useEffect, useState } from "react";
import Uploader from "./Uploader";

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Unable to complete your request.");
  return data;
}

const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const nasLabels = { syncing: "Syncing to NAS", available: "Available locally", failed: "NAS sync failed", pending: "Waiting for NAS" };

function Dashboard({ employee }) {
  const [tab, setTab] = useState("files");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      request(`/api/employee/transfers?q=${encodeURIComponent(query)}&page=${page}`, { signal: controller.signal })
        .then(setResult)
        .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, page, revision]);

  async function operate(key, callback) {
    setAction(key);
    setNotice("");
    setError("");
    try { await callback(); }
    catch (failure) { setError(failure.message); }
    finally { setAction(""); }
  }

  const post = (id, endpoint, body = {}) => request(`/api/employee/transfers/${id}/${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  return (
    <section className="workspace">
      <div className="workspace-heading">
        <div><p className="eyebrow">SIGNATURE ASPEN WORKSPACE</p><h1>Welcome, {employee.name || "team"}.</h1>
          <p className="muted">{employee.admin ? "Company-wide transfer access" : "Your uploads and assigned transfers"}</p></div>
        <form action="/api/auth/logout" method="post" onSubmit={(event) => {
          event.preventDefault();
          operate("logout", async () => {
            await request("/api/auth/logout", { method: "POST" });
            window.location.assign("/");
          });
        }}><button className="secondary" disabled={Boolean(action)}>Sign out</button></form>
      </div>
      <div className="tabs" aria-label="Workspace sections">
        <button className={tab === "files" ? "" : "secondary"} aria-pressed={tab === "files"} onClick={() => setTab("files")}>Files & transfers</button>
        <button className={tab === "upload" ? "" : "secondary"} aria-pressed={tab === "upload"} onClick={() => setTab("upload")}>Quick upload</button>
      </div>
      <div hidden={tab !== "upload"}>
        <Uploader employee={employee} onComplete={() => setRevision((value) => value + 1)} />
      </div>
      <section className="card dashboard" hidden={tab !== "files"}>
        <div className="card-heading"><h2>File library</h2><button className="secondary" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</button></div>
        <label>Search client, project, or filename<input type="search" value={query} maxLength={200}
          placeholder="Search your transfers…" onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
        <p className="muted fine-print">Cloud downloads work anywhere. Local downloads require the office network or VPN and an available NAS copy.</p>
        {loading && <p role="status">Loading files…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="banner" role="status">{notice}</p>}
        {!loading && !error && result?.transfers.length === 0 && <p>No matching transfers. {employee.admin ? "Client uploads will appear here once complete." : "Upload files or ask an administrator to assign a transfer to you."}</p>}
        {!loading && !error && result?.transfers.map((transfer) => (
          <article className="library-transfer" key={transfer.id}>
            <div className="library-heading"><div><h3>{transfer.title}</h3><p>{transfer.company} · {size(transfer.totalSize)}</p></div>
              {transfer.nasStatus && <span className={`badge nas-${transfer.nasStatus}`}>{nasLabels[transfer.nasStatus] || "NAS unavailable"}</span>}</div>
            <p className="muted fine-print">From {transfer.senderEmail} · Expires {new Date(transfer.expiresAt).toLocaleString()}</p>
            <ul className="file-list">{transfer.files.map((file) => (
              <li key={file.id}><span>{file.name}<small>{size(file.size)}</small></span><div className="file-actions">
                <a href={`/api/employee/transfers/${transfer.id}/download?file=${encodeURIComponent(file.id)}`}>Cloud</a>
                {transfer.nasStatus === "available" && <button className="text-button" disabled={Boolean(action)}
                  onClick={() => operate(`local-${file.id}`, async () => {
                    const data = await post(transfer.id, "local", { fileId: file.id });
                    window.location.assign(data.url);
                  })}>Local network ↓</button>}
              </div></li>
            ))}</ul>
            <div className="actions">
              <a className="button secondary" href={`/api/employee/transfers/${transfer.id}/download`}>Download all (.zip)</a>
              {transfer.canShare && <button disabled={Boolean(action)} onClick={() => operate(`share-${transfer.id}`, async () => {
                const data = await post(transfer.id, "share");
                try {
                  await navigator.clipboard.writeText(data.url);
                  setNotice(data.requiresPasscode ? "Link copied. Recipients still need the sender’s passcode." : "Share link copied. Share only with intended recipients.");
                } catch {
                  setNotice(`Copy this link: ${data.url}${data.requiresPasscode ? " (passcode required)" : ""}`);
                }
              })}>Copy share link</button>}
            </div>
            {employee.admin && <form className="assignment" onSubmit={(event) => {
              event.preventDefault();
              const employeeId = new FormData(event.currentTarget).get("employeeId");
              operate(`assign-${transfer.id}`, async () => {
                await post(transfer.id, "assign", { employeeId });
                setNotice("Transfer assigned to the employee. They must also belong to an approved Microsoft group.");
              });
            }}>
              <label>Assign access (Microsoft employee object ID)<input name="employeeId" required
                pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" placeholder="Employee object ID from Entra" /></label>
              <button className="secondary" disabled={Boolean(action)}>Assign employee</button>
            </form>}
          </article>
        ))}
        <div className="pagination">
          <button className="secondary" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <span>Page {page}</span>
          <button className="secondary" disabled={loading || !result?.hasMore} onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
      </section>
      {tab === "upload" && error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

export default function Workspace() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request("/api/auth/session", { signal: controller.signal }).then(setSession).catch((failure) => {
      if (!controller.signal.aborted) { setSession({ enabled: true, employee: null }); setError(failure.message); }
    });
    if (new URLSearchParams(window.location.search).has("error")) setError("Company sign-in was not completed. Check your tenant/group access or contact your administrator.");
    return () => controller.abort();
  }, []);
  if (session?.employee) return <Dashboard employee={session.employee} />;
  return (
    <>
      <section className="intro">
        <p className="eyebrow">SIGNATURE ASPEN · CREATIVE DELIVERY</p>
        <h1>Your vision.<br />Delivered simply.</h1>
        <p>Send large design files securely, without an account.</p>
        {session?.enabled && <a className="employee-login" href="/api/auth/login">Employee sign-in with Microsoft →</a>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <Uploader />
    </>
  );
}
