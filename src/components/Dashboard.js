"use client";

import { useEffect, useState } from "react";
import Uploader from "./Uploader";
import FileBrowser from "./FileBrowser";
import EmployeeHeader from "./EmployeeHeader";
import TransferCalendar from "./TransferCalendar";

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Unable to complete your request.");
  return data;
}

const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const nasLabels = { syncing: "Syncing to NAS", available: "Available locally", failed: "NAS sync failed", pending: "Waiting for NAS" };
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
  { id: "ihoover", name: "Ida Hoover", role: "Account Manager", email: "ihoover@signatureaspen.com" },
  { id: "marmstrong", name: "Michelle Armstrong", role: "Account Manager", email: "marmstrong@signatureaspen.com" },
  { id: "sflores",   name: "Sandy Flores",      role: "Account Manager", email: "sflores@signatureaspen.com" },
];

function formatWhen(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function TransferList({ transfers, action, onShare, employee, onAssign, onLocal, empty = "No transfers to show." }) {
  if (!transfers?.length) return empty ? <p className="job-empty">{empty}</p> : null;
  return transfers.map((transfer) => (
    <article className="library-transfer" key={transfer.id}>
      <div className="library-heading">
        <div>
          <h3>{transfer.title}</h3>
          <p>{transfer.company} · {size(transfer.totalSize)}</p>
        </div>
        {transfer.nasStatus && <span className={`badge nas-${transfer.nasStatus}`}>{nasLabels[transfer.nasStatus] || "NAS unavailable"}</span>}
      </div>
      <p className="muted fine-print">From {transfer.senderEmail}{transfer.completedAt ? ` · Received ${formatWhen(transfer.completedAt)}` : ""}</p>
      <ul className="file-list">{transfer.files.map((file) => (
        <li key={file.id}><span>{file.name}<small>{size(file.size)}</small></span>
          <div className="file-actions">
            <a href={`/api/employee/transfers/${transfer.id}/download?file=${encodeURIComponent(file.id)}`}>Cloud</a>
            {transfer.nasStatus === "available" && onLocal && (
              <button type="button" className="text-button" disabled={Boolean(action)}
                onClick={() => onLocal(transfer, file)}>Local network ↓</button>
            )}
          </div>
        </li>
      ))}</ul>
      <div className="actions">
        <a className="button secondary" href={`/api/employee/transfers/${transfer.id}/download`}>Download all (.zip)</a>
        {transfer.canShare && (
          <button type="button" className="secondary" disabled={Boolean(action)} onClick={() => onShare(transfer)}>Copy share link</button>
        )}
      </div>
      {employee?.admin && onAssign && (
        <form className="assignment" onSubmit={(event) => {
          event.preventDefault();
          onAssign(transfer, new FormData(event.currentTarget).get("employeeId"));
        }}>
          <label>Assign access (Microsoft employee object ID)
            <input name="employeeId" required
              pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
              placeholder="Employee object ID from Entra" />
          </label>
          <button className="secondary" disabled={Boolean(action)} type="submit">Assign employee</button>
        </form>
      )}
    </article>
  ));
}

const DASHBOARD_TABS = new Set(["overview", "calendar", "files", "browse", "upload", "proof"]);

function WorkspaceBody({ employee, initialTab = "overview" }) {
  const [tab, setTab] = useState(DASHBOARD_TABS.has(initialTab) ? initialTab : "overview");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [overview, setOverview] = useState(null);
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [dayResult, setDayResult] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [dayLoading, setDayLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState("");
  const [reqModal, setReqModal] = useState(false);
  const [reqSending, setReqSending] = useState(false);
  const [reqSuccess, setReqSuccess] = useState(false);
  const [reqError, setReqError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    request(`/api/employee/dashboard${month ? `?month=${encodeURIComponent(month)}` : ""}`, { signal: controller.signal })
      .then((data) => {
        setOverview(data);
        if (!month) setMonth(data.month.key);
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [month, revision]);

  useEffect(() => {
    if (!day) { setDayResult(null); return undefined; }
    const controller = new AbortController();
    setDayLoading(true);
    request(`/api/employee/transfers/calendar?date=${encodeURIComponent(day)}`, { signal: controller.signal })
      .then(setDayResult)
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setDayLoading(false); });
    return () => controller.abort();
  }, [day]);

  useEffect(() => {
    if (tab !== "files") return undefined;
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
  }, [tab, query, page, revision]);

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

  function share(transfer) {
    return operate(`share-${transfer.id}`, async () => {
      const data = await post(transfer.id, "share");
      try {
        await navigator.clipboard.writeText(data.url);
        setNotice(data.requiresPasscode
          ? "Link copied. Recipients still need the sender’s passcode."
          : "Share link copied. Share only with intended recipients.");
      } catch {
        setNotice(`Copy this link: ${data.url}${data.requiresPasscode ? " (passcode required)" : ""}`);
      }
    });
  }

  function openDay(date) {
    setDay(date);
    setDayResult(null);
    setDayLoading(true);
    setTab("calendar");
  }

  const stats = overview?.stats;

  return (
    <section className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">SIGNATURE ASPEN WORKSPACE</p>
          <h1>Dashboard</h1>
          <p className="muted">All live transfers</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="btn-proof" onClick={() => setTab("proof")}>
            Send design proof
          </button>
          <button type="button" className="btn-request" onClick={() => { setReqModal(true); setReqSuccess(false); setReqError(""); }}>
            Request files from customer
          </button>
        </div>
      </div>
      <div className="tabs" aria-label="Workspace sections">
        <button type="button" className={tab === "overview" ? "" : "secondary"} aria-pressed={tab === "overview"} onClick={() => setTab("overview")}>Overview</button>
        <button type="button" className={tab === "calendar" ? "" : "secondary"} aria-pressed={tab === "calendar"} onClick={() => setTab("calendar")}>Calendar</button>
        <button type="button" className={tab === "files" ? "" : "secondary"} aria-pressed={tab === "files"} onClick={() => setTab("files")}>Job list</button>
        <button type="button" className={tab === "browse" ? "" : "secondary"} aria-pressed={tab === "browse"} onClick={() => setTab("browse")}>File explorer</button>
        <button type="button" className={tab === "proof" ? "" : "secondary"} aria-pressed={tab === "proof"} onClick={() => setTab("proof")}>Send proof</button>
        <button type="button" className={tab === "upload" ? "" : "secondary"} aria-pressed={tab === "upload"} onClick={() => setTab("upload")}>Quick upload</button>
      </div>

      {reqModal && (
        <div className="modal-scrim" onClick={(event) => { if (event.target === event.currentTarget) setReqModal(false); }}>
          <div className="card modal-card">
            <div className="card-heading">
              <h2>Request files from customer</h2>
              <button type="button" className="secondary" onClick={() => setReqModal(false)}>✕</button>
            </div>
            {reqSuccess ? (
              <div>
                <p className="ok-line">✓ Upload request sent successfully.</p>
                <button type="button" className="secondary" onClick={() => { setReqModal(false); setReqSuccess(false); }}>Close</button>
              </div>
            ) : (
              <form onSubmit={async (event) => {
                event.preventDefault();
                setReqSending(true); setReqError("");
                const fields = Object.fromEntries(new FormData(event.currentTarget));
                const contact = CONTACTS_FOR_REQUEST.find((item) => item.id === fields.contactId);
                try {
                  await request("/api/employee/request-files", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      customerEmail: fields.customerEmail, customerName: fields.customerName,
                      company: fields.company, jobNumber: fields.jobNumber, jobTitle: fields.jobTitle,
                      message: fields.message,
                      contactId: contact?.id, contactName: contact?.name,
                      contactRole: contact?.role, contactEmail: contact?.email,
                    }),
                  });
                  setReqSuccess(true);
                } catch (failure) { setReqError(failure.message); }
                finally { setReqSending(false); }
              }}>
                <div className="row2">
                  <div className="field"><label>Customer name<input className="in" name="customerName" type="text" placeholder="Jordan Ellis" maxLength={200} /></label></div>
                  <div className="field"><label>Customer email<span className="req">*</span><input className="in" name="customerEmail" type="email" required maxLength={254} placeholder="jordan@company.com" /></label></div>
                </div>
                <div className="row2">
                  <div className="field"><label>Company<input className="in" name="company" type="text" maxLength={200} placeholder="Bayou City Credit Union" /></label></div>
                  <div className="field"><label>Job or quote number<input className="in" name="jobNumber" type="text" maxLength={100} placeholder="130912" /></label></div>
                </div>
                <div className="field"><label>Job title<span className="req">*</span><input className="in" name="jobTitle" type="text" required maxLength={200} placeholder="Fall Member Mailer" /></label></div>
                <div className="field">
                  <label>Aspen contact<span className="req">*</span>
                    <select className="in" name="contactId" required defaultValue="">
                      <option value="" disabled>Choose contact</option>
                      {CONTACTS_FOR_REQUEST.map((contact) => (
                        <option key={contact.id} value={contact.id}>{contact.name} — {contact.role}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="field"><label>Message to customer <span className="opt">(optional)</span><textarea className="in" name="message" rows={3} maxLength={1000} placeholder="Please send the print-ready PDFs for your fall mailer." /></label></div>
                {reqError && <p className="error">{reqError}</p>}
                <div className="actions">
                  <button type="submit" className="btn-primary" disabled={reqSending}>{reqSending ? "Sending…" : "Send upload request"}</button>
                  <button type="button" className="secondary" onClick={() => setReqModal(false)}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="banner" role="status">{notice}</p>}

      {tab === "overview" && (
        <section className="card dashboard">
          <div className="card-heading">
            <h2>Overview</h2>
            <button type="button" className="secondary" onClick={() => setRevision((value) => value + 1)}>Refresh</button>
          </div>
          <p className="cal-lead muted">Live transfers only. Dates use Houston time.</p>
          <div className="stat-grid">
            <div className="stat-card"><strong>{stats?.transfers ?? "—"}</strong><span>Live transfers</span></div>
            <div className="stat-card"><strong>{stats?.files ?? "—"}</strong><span>Files</span></div>
            <div className="stat-card"><strong>{stats ? size(stats.totalSize) : "—"}</strong><span>Total size</span></div>
            <div className="stat-card"><strong>{stats?.companies ?? "—"}</strong><span>Companies</span></div>
            <div className="stat-card"><strong>{stats?.thisMonth ?? "—"}</strong><span>This month</span></div>
            <div className="stat-card"><strong>{stats?.today ?? "—"}</strong><span>Today</span></div>
          </div>
          <div className="dash-split">
            <div>
              <h3 className="col-title">Calendar</h3>
              <TransferCalendar data={overview} selected={day} onSelect={openDay} onMonth={setMonth} compact />
            </div>
            <div>
              <h3 className="col-title">Top companies</h3>
              {!overview?.companies?.length && <p className="muted">No companies yet.</p>}
              <ul className="dash-companies">
                {overview?.companies?.map((row) => (
                  <li key={row.company}><span>{row.company}</span><strong>{row.transfers}</strong></li>
                ))}
              </ul>
            </div>
          </div>
          <h3 className="col-title">Recent transfers</h3>
          <TransferList transfers={overview?.recent || []} action={action} employee={employee}
            empty="No recent transfers."
            onShare={share}
            onAssign={(transfer, employeeId) => operate(`assign-${transfer.id}`, async () => {
              await post(transfer.id, "assign", { employeeId });
              setNotice("Transfer assigned to the employee. They must also belong to an approved Microsoft group.");
            })} />
        </section>
      )}

      {tab === "calendar" && (
        <section className="card dashboard">
          <div className="card-heading">
            <h2>Calendar</h2>
            <button type="button" className="secondary" onClick={() => setRevision((value) => value + 1)}>Refresh</button>
          </div>
          <p className="cal-lead muted">Open a day to download or share every transfer received that Houston date.</p>
          <TransferCalendar data={overview} selected={day} onSelect={(date) => { setDayResult(null); setDayLoading(true); setDay(date); }} onMonth={setMonth} />
          {day && (
            <div className="cal-day-panel">
              <div className="card-heading">
                <h3>{dayResult?.label || day}</h3>
                <button type="button" className="text-button" onClick={() => { setDay(""); setDayResult(null); }}>Clear day</button>
              </div>
              {dayLoading && <p role="status">Loading transfers…</p>}
              {!dayLoading && dayResult && <TransferList transfers={dayResult.transfers} action={action} onShare={share} empty="No transfers on this day." />}
            </div>
          )}
        </section>
      )}

      {tab === "browse" && <FileBrowser />}
      <div hidden={tab !== "proof"}>
        <section className="card dashboard" style={{ marginBottom: 0, boxShadow: "none", border: 0, padding: 0 }}>
          <div className="card-heading">
            <div>
              <h2>Send design proof</h2>
              <p className="muted cal-lead">Same upload form. Files go to the customer with a private download link.</p>
            </div>
          </div>
        </section>
        <Uploader employee={employee} mode="proof" showHero={false} onComplete={() => setRevision((value) => value + 1)} />
      </div>
      <div hidden={tab !== "upload"}>
        <Uploader employee={employee} showHero={false} onComplete={() => setRevision((value) => value + 1)} />
      </div>
      <section className="card dashboard job-list" hidden={tab !== "files"}>
        <div className="card-heading">
          <h2>Job list</h2>
          <button type="button" className="secondary" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</button>
        </div>
        <div className="field library-search">
          <label>Search client, project, or filename
            <input className="in" type="search" value={query} maxLength={200}
              placeholder="Search your transfers…"
              onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
          </label>
        </div>
        <p className="muted fine-print">Cloud downloads work anywhere. Local copies need the office network or VPN.</p>
        {loading && <p role="status">Loading files…</p>}
        {!loading && !error && result?.transfers.length === 0 && (
          <p className="job-empty">
            {query
              ? "No transfers match that search."
              : "No live transfers yet. Client uploads will appear here once complete."}
          </p>
        )}
        {!loading && !error && result?.transfers.length > 0 && (
          <TransferList
            transfers={result.transfers}
            action={action}
            employee={employee}
            empty=""
            onShare={share}
            onLocal={(transfer, file) => operate(`local-${file.id}`, async () => {
              const data = await post(transfer.id, "local", { fileId: file.id });
              window.location.assign(data.url);
            })}
            onAssign={(transfer, employeeId) => operate(`assign-${transfer.id}`, async () => {
              await post(transfer.id, "assign", { employeeId });
              setNotice("Transfer assigned to the employee. They must also belong to an approved Microsoft group.");
            })}
          />
        )}
        <div className="pagination">
          <button type="button" className="secondary" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <span>Page {page}</span>
          <button type="button" className="secondary" disabled={loading || !result?.hasMore} onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
      </section>
    </section>
  );
}

export default function Dashboard({ employee = null, initialTab = "overview" }) {
  const [session, setSession] = useState(employee ? { enabled: true, employee } : { enabled: true, employee: null });
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request("/api/auth/session", { signal: controller.signal }).then(setSession).catch((failure) => {
      if (!controller.signal.aborted) { setSession({ enabled: true, employee: null }); setError(failure.message); }
    });
    return () => controller.abort();
  }, []);

  if (!session.employee) {
    return (
      <>
        <header className="slim-header">
          <a href="/" className="employee-login">← Upload Art</a>
          <a className="employee-login" href="/api/auth/login">Employee sign-in →</a>
        </header>
        <section className="card">
          <h1>Employee dashboard</h1>
          <p className="muted">Sign in with your company Microsoft account to view transfer statistics, the calendar, and the file explorer.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <a className="button btn-primary" href="/api/auth/login">Employee sign-in</a>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <EmployeeHeader employee={session.employee} current="dashboard" />
      <WorkspaceBody employee={session.employee} initialTab={initialTab} />
    </>
  );
}
