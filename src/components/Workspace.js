"use client";

import { useEffect, useState } from "react";
import Uploader from "./Uploader";
import Brand from "./Brand";

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Unable to complete your request.");
  return data;
}

const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const nasLabels = { syncing: "Syncing to NAS", available: "Available locally", failed: "NAS sync failed", pending: "Waiting for NAS" };

// Contact list mirrored here for the request-files modal
const CONTACTS_FOR_REQUEST = [
  { id: "lmelchor", name: "Louis Melchor",  role: "Account Manager", email: "lmelchor@signatureaspen.com" },
  { id: "jturner",  name: "Jeff Turner",    role: "Account Manager", email: "jturner@signatureaspen.com" },
  { id: "jseiford", name: "Jimmy Seiford",  role: "Account Manager", email: "jseiford@signatureaspen.com" },
  { id: "ccarroll", name: "Colton Carroll", role: "Account Manager", email: "ccarroll@signatureaspen.com" },
  { id: "gemmott",  name: "Gary Emmott",    role: "Account Manager", email: "gemmott@signatureaspen.com" },
  { id: "akliafas", name: "Alex Kliafas",   role: "Account Manager", email: "akliafas@signatureaspen.com" },
  { id: "msimpson", name: "Mike Simpson",   role: "Account Manager", email: "msimpson@signatureaspen.com" },
  { id: "jleon",    name: "Joel Leon",      role: "Account Manager", email: "JLeon@signatureaspen.com" },
  { id: "kdasilva", name: "Kris Da Silva",  role: "Account Manager", email: "kdasilva@signatureaspen.com" },
];

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
  const [reqModal, setReqModal] = useState(false);
  const [reqSending, setReqSending] = useState(false);
  const [reqSuccess, setReqSuccess] = useState(false);
  const [reqError, setReqError] = useState("");

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
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div className="tabs" aria-label="Workspace sections" style={{ flex: 1 }}>
          <button className={tab === "files" ? "" : "secondary"} aria-pressed={tab === "files"} onClick={() => setTab("files")}>Files & transfers</button>
          <button className={tab === "upload" ? "" : "secondary"} aria-pressed={tab === "upload"} onClick={() => setTab("upload")}>Quick upload</button>
        </div>
        <button className="secondary" style={{ fontSize: 13, padding: "7px 14px", whiteSpace: "nowrap" }}
          onClick={() => { setReqModal(true); setReqSuccess(false); setReqError(""); }}>
          Request files from customer
        </button>
      </div>

      {reqModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,40,71,.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={(e) => { if (e.target === e.currentTarget) setReqModal(false); }}>
          <div className="card" style={{ width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", margin: 0 }}>
            <div className="card-heading">
              <h2>Request files from customer</h2>
              <button className="secondary" style={{ fontSize: 13, padding: "4px 10px" }} onClick={() => setReqModal(false)}>✕</button>
            </div>
            {reqSuccess ? (
              <div>
                <p style={{ color: "var(--green-700)", marginBottom: 16 }}>✓ Upload request sent successfully.</p>
                <button className="secondary" onClick={() => { setReqModal(false); setReqSuccess(false); }}>Close</button>
              </div>
            ) : (
              <form onSubmit={async (e) => {
                e.preventDefault();
                setReqSending(true); setReqError("");
                const f = Object.fromEntries(new FormData(e.currentTarget));
                const contact = CONTACTS_FOR_REQUEST.find((c) => c.id === f.contactId);
                try {
                  const resp = await request("/api/employee/request-files", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      customerEmail: f.customerEmail, customerName: f.customerName,
                      company: f.company, jobNumber: f.jobNumber, jobTitle: f.jobTitle,
                      message: f.message,
                      contactId: contact?.id, contactName: contact?.name,
                      contactRole: contact?.role, contactEmail: contact?.email,
                    }),
                  });
                  setReqSuccess(true);
                } catch (err) { setReqError(err.message); }
                finally { setReqSending(false); }
              }}>
                <div className="row2">
                  <div className="field">
                    <label>Customer name
                      <input className="in" name="customerName" type="text" placeholder="Jordan Ellis" maxLength={200} />
                    </label>
                  </div>
                  <div className="field">
                    <label>Customer email<span className="req">*</span>
                      <input className="in" name="customerEmail" type="email" required maxLength={254} placeholder="jordan@company.com" />
                    </label>
                  </div>
                </div>
                <div className="row2">
                  <div className="field">
                    <label>Company
                      <input className="in" name="company" type="text" maxLength={200} placeholder="Bayou City Credit Union" />
                    </label>
                  </div>
                  <div className="field">
                    <label>Job or quote number
                      <input className="in" name="jobNumber" type="text" maxLength={100} placeholder="130912" />
                    </label>
                  </div>
                </div>
                <div className="field">
                  <label>Job title<span className="req">*</span>
                    <input className="in" name="jobTitle" type="text" required maxLength={200} placeholder="Fall Member Mailer" />
                  </label>
                </div>
                <div className="field">
                  <label>Aspen contact<span className="req">*</span>
                    <select className="in" name="contactId" required defaultValue="">
                      <option value="" disabled>Choose contact</option>
                      {CONTACTS_FOR_REQUEST.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} — {c.role}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="field">
                  <label>Message to customer <span className="opt">(optional)</span>
                    <textarea className="in" name="message" rows={3} maxLength={1000} placeholder="Please send the print-ready PDFs for your fall mailer." />
                  </label>
                </div>
                {reqError && <p className="error" style={{ marginBottom: 12 }}>{reqError}</p>}
                <div className="actions">
                  <button type="submit" className="btn-primary" disabled={reqSending}>
                    {reqSending ? "Sending…" : "Send upload request"}
                  </button>
                  <button type="button" className="secondary" onClick={() => setReqModal(false)}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
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
  if (session?.employee) return (
    <>
      <header className="slim-header">
        <Brand />
        <form action="/api/auth/logout" method="post" onSubmit={(event) => {
          event.preventDefault();
          request("/api/auth/logout", { method: "POST" }).then(() => window.location.assign("/")).catch(() => window.location.assign("/"));
        }}><button className="secondary">Sign out</button></form>
      </header>
      <Dashboard employee={session.employee} />
    </>
  );
  return (
    <>
      <header className="slim-header">
        <Brand />
        <nav className="site-nav" aria-label="Site">
          <a href="https://signatureaspen.com">Services</a>
          <a href="https://signatureaspen.com/request-a-quote/">Request a Quote</a>
          <a href="/" className="on" aria-current="page">Upload Art</a>
          <a href="https://signatureaspen.com/contact">Contact Us</a>
        </nav>
        <a className="employee-login" href="/api/auth/login">Employee sign-in →</a>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      <Uploader />
    </>
  );
}
