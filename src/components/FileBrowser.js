"use client";

import { useEffect, useState } from "react";

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Unable to complete your request.");
  return data;
}

const size = (bytes) => bytes < 1024 ** 2
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 ** (bytes >= 1024 ** 3 ? 3 : 2)).toFixed(1)} ${bytes >= 1024 ** 3 ? "GB" : "MB"}`;

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function fileKind(name) {
  const e = extOf(name);
  if (e === "pdf") return { label: "PDF", tone: "pdf" };
  if (["zip", "7z", "rar"].includes(e)) return { label: "ZIP", tone: "zip" };
  if (["ai", "eps", "psd", "indd"].includes(e)) return { label: e.toUpperCase(), tone: "art" };
  if (["jpg", "jpeg", "png", "tif", "tiff", "gif"].includes(e)) return { label: e.toUpperCase().slice(0, 4), tone: "img" };
  return { label: e ? e.toUpperCase().slice(0, 4) : "File", tone: "other" };
}

function formatModified(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const ICON_BG  = { pdf:"#F4CDC8", zip:"#CFE6BF", art:"#C5D4E8", img:"#F0D9A6", other:"#E2E7EE" };
const ICON_FG  = { pdf:"#9B2C1F", zip:"#2E5A18", art:"#0E3760", img:"#8A5A12", other:"#5F6B7A" };

function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ flexShrink:0, display:"block" }} aria-hidden="true">
      <rect x="1" y="6" width="18" height="12" rx="2" fill="#F6D36A"/>
      <path d="M1 8.5A2 2 0 0 1 3 6.5h4.5l1.5 1.5H17A2 2 0 0 1 19 10v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8.5Z" fill="#E2B53A"/>
      <path d="M1 10h18v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-7Z" fill="#F6D36A"/>
    </svg>
  );
}

function FileIcon({ name }) {
  const { label, tone } = fileKind(name);
  return (
    <span aria-hidden="true" style={{
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      width:20, height:20, borderRadius:4, flexShrink:0,
      background: ICON_BG[tone]||ICON_BG.other,
      color: ICON_FG[tone]||ICON_FG.other,
      fontSize:7, fontWeight:900, letterSpacing:".05em", lineHeight:1,
    }}>{label.slice(0,4)}</span>
  );
}

function DownloadIcon() {
  return (
    <svg className="ex-action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        d="M12 4v10m0 0 4-4m-4 4-4-4M6 18h12" />
    </svg>
  );
}

function browseUrl(group, path, key, query) {
  const params = new URLSearchParams({ group });
  if (query) params.set("q", query);
  if (group === "folder") params.set("path", path || "transfers");
  else if (key) params.set("key", key);
  return `/api/employee/transfers/browse?${params}`;
}

function folderMain(folder) {
  return folder.company || folder.label;
}

function folderSub(folder) {
  if (folder.jobNumber) return `Job #${folder.jobNumber}`;
  if (folder.title && folder.title !== folder.label && folder.title !== folder.company) return folder.title;
  if (folder.fileCount) return `${folder.fileCount} file${folder.fileCount === 1 ? "" : "s"}`;
  return "";
}

export default function FileBrowser() {
  const [group, setGroup] = useState("folder");
  const [path, setPath] = useState("transfers");
  const [key, setKey] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), 200);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request(browseUrl(group, path, key, query), { signal: controller.signal })
      .then(setListing)
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [group, path, key, query, revision]);

  function changeGroup(next) {
    setGroup(next);
    setPath("transfers");
    setKey("");
    setNotice("");
  }

  function openFolder(folder) {
    if (group === "folder") setPath(folder.path);
    else setKey(folder.name);
  }

  function openCrumb(crumb, index) {
    if (group === "folder") setPath(crumb.path);
    else setKey(index === 0 ? "" : crumb.path);
  }

  function goParent() {
    if (group === "folder") setPath(listing.parent);
    else setKey("");
  }

  async function share(transferId) {
    setAction(`share-${transferId}`);
    setNotice("");
    setError("");
    try {
      const data = await request(`/api/employee/transfers/${transferId}/share`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      try {
        await navigator.clipboard.writeText(data.url);
        setNotice(data.requiresPasscode
          ? "Link copied. Recipients still need the sender’s passcode."
          : "Share link copied. Share only with intended recipients.");
      } catch {
        setNotice(`Copy this link: ${data.url}${data.requiresPasscode ? " (passcode required)" : ""}`);
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setAction("");
    }
  }

  const folders = listing?.folders || [];
  const files = listing?.files || [];
  const crumbs = listing?.crumbs || [{ path: "transfers", label: "Transfers" }];
  const empty = !loading && listing && folders.length === 0 && files.length === 0;

  return (
    <section className="card dashboard explorer">
      <div className="card-heading">
        <h2>File explorer</h2>
        <button className="secondary" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</button>
      </div>
      <p className="cal-lead muted">Open folders, or group by date or company.</p>

      <div className="ex-toolbar">
        <label className="ex-search">Search files, company, or job
          <input type="search" value={draft} maxLength={200} placeholder="Search this library…"
            onChange={(event) => setDraft(event.target.value)} />
        </label>
        <div className="ex-groups" role="group" aria-label="Group by">
          <button type="button" className={group === "folder" ? "" : "secondary"} aria-pressed={group === "folder"}
            onClick={() => changeGroup("folder")}>Folders</button>
          <button type="button" className={group === "date" ? "" : "secondary"} aria-pressed={group === "date"}
            onClick={() => changeGroup("date")}>Group by date</button>
          <button type="button" className={group === "company" ? "" : "secondary"} aria-pressed={group === "company"}
            onClick={() => changeGroup("company")}>Group by company</button>
        </div>
      </div>

      <nav className="ex-crumbs" aria-label="Folder path">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.path}-${index}`}>
            {index > 0 && <span className="ex-sep" aria-hidden="true">/</span>}
            {index === crumbs.length - 1
              ? <span className="ex-crumb on">{crumb.label}</span>
              : <button type="button" className="ex-crumb" onClick={() => openCrumb(crumb, index)}>{crumb.label}</button>}
          </span>
        ))}
      </nav>

      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="banner" role="status">{notice}</p>}
      {loading && <p role="status">Loading folder…</p>}
      {empty && <p className="muted">{query ? "No matching files." : "This folder is empty."}</p>}

      {!loading && listing && (folders.length > 0 || files.length > 0) && (
        <div className="ex-layout">
          <aside className="ex-tree" aria-label="Folder tree">
            {crumbs.map((crumb, index) => {
              const isActive = group === "folder" ? crumb.path === path : (index === 0 ? !key : crumb.path === key);
              const isLast = index === crumbs.length - 1;
              const indent = 8 + index * 16;
              return (
                <button key={`tree-${crumb.path}-${index}`} type="button"
                  className={`ex-tree-item${isActive ? " on" : ""}`}
                  style={{ paddingLeft: indent }}
                  onClick={() => openCrumb(crumb, index)}>
                  {index > 0 && <span className="ex-connector" style={{ left: indent - 16 }} aria-hidden="true" />}
                  <span className="ex-toggle" aria-hidden="true">{isLast ? "−" : "▾"}</span>
                  <FolderIcon />
                  <span className="ex-tree-label">{crumb.label}</span>
                </button>
              );
            })}
            {folders.map((folder) => {
              const indent = 8 + crumbs.length * 16;
              return (
                <button key={folder.path} type="button" className="ex-tree-item"
                  style={{ paddingLeft: indent }}
                  onClick={() => openFolder(folder)}>
                  <span className="ex-connector" style={{ left: indent - 16 }} aria-hidden="true" />
                  <span className="ex-toggle" aria-hidden="true">+</span>
                  <FolderIcon />
                  <span className="ex-tree-label">{folder.label}</span>
                </button>
              );
            })}

          </aside>

          <div className="ex-table-wrap">
            <table className="ex-table">
              <thead>
                <tr>
                  <th className="ex-col-name">Name</th>
                  <th className="ex-col-modified">Modified</th>
                  <th className="ex-col-size">Size</th>
                  <th className="ex-col-kind">Kind</th>
                  <th className="ex-col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(listing.parent || (group !== "folder" && key)) && (
                  <tr className="ex-row" onClick={goParent}>
                    <td>
                      <button type="button" className="ex-name" onClick={goParent}>
                        <FolderIcon />
                        <span className="ex-name-text"><span className="ex-name-main">..</span></span>
                      </button>
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td>Folder</td>
                    <td />
                  </tr>
                )}
                {folders.map((folder) => {
                  const sub = folderSub(folder);
                  return (
                    <tr key={folder.path} className="ex-row" onClick={() => openFolder(folder)}>
                      <td>
                        <button type="button" className="ex-name" onClick={() => openFolder(folder)}>
                          <FolderIcon />
                          <span className="ex-name-text">
                            <span className="ex-name-main">{folderMain(folder)}</span>
                            {sub && <small>{sub}</small>}
                          </span>
                        </button>
                      </td>
                      <td>{formatModified(folder.modified)}</td>
                      <td>{folder.totalSize ? size(folder.totalSize) : "—"}</td>
                      <td>Folder</td>
                      <td>
                        {folder.transferId && (
                          <div className="ex-actions" onClick={(event) => event.stopPropagation()}>
                            <a className="text-button" href={`/api/employee/transfers/${folder.transferId}/download`}>Download ZIP</a>
                            <button type="button" className="text-button" disabled={Boolean(action)}
                              onClick={() => share(folder.transferId)}>Share</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {files.map((file) => {
                  const kind = fileKind(file.name);
                  return (
                    <tr key={`${file.transferId}-${file.id}`} className="ex-row file">
                      <td>
                        <span className="ex-name">
                          <FileIcon name={file.name} />
                          <span className="ex-name-text">
                            <span className="ex-name-main">{file.name}</span>
                            {group !== "folder" && (file.company || file.title) && (
                              <small>{[file.company, file.title].filter(Boolean).join(" · ")}</small>
                            )}
                          </span>
                        </span>
                      </td>
                      <td>{formatModified(file.modified)}</td>
                      <td>{size(file.size)}</td>
                      <td>{kind.label}</td>
                      <td>
                        <div className="ex-actions">
                          <a className="dl-btn secondary" href={`/api/employee/transfers/${file.transferId}/download?file=${encodeURIComponent(file.id)}`}
                            aria-label={`Download ${file.name}`} title="Download">
                            <DownloadIcon />
                          </a>
                          <button type="button" className="text-button" disabled={Boolean(action)}
                            onClick={() => share(file.transferId)}>Share</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
