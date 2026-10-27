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
function badgeLabel(name) {
  const e = extOf(name);
  return e ? e.toUpperCase().slice(0, 4) : "FILE";
}
function badgeClass(name) {
  const e = extOf(name);
  if (e === "pdf") return "b-pdf";
  if (["zip", "7z", "rar"].includes(e)) return "b-zip";
  if (["ai", "eps", "psd", "indd"].includes(e)) return "b-art";
  if (["jpg", "jpeg", "png", "tif", "tiff", "gif"].includes(e)) return "b-img";
  return "b-other";
}
function formatModified(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function FolderIcon() {
  return (
    <svg className="ex-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#C9A227" d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v10A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />
      <path fill="#E8C547" d="M3 9h18v9.5A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5V9Z" />
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
  const crumbs = listing?.crumbs || [{ path: "transfers", label: "transfers" }];
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
            {crumbs.map((crumb, index) => (
              <button
                key={`tree-${crumb.path}-${index}`}
                type="button"
                className={`ex-tree-item${(group === "folder" ? crumb.path === path : (index === 0 ? !key : crumb.path === key)) ? " on" : ""}`}
                style={{ paddingLeft: 10 + index * 14 }}
                onClick={() => openCrumb(crumb, index)}
              >
                <FolderIcon />
                <span>{crumb.label}</span>
              </button>
            ))}
            {folders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                className="ex-tree-item"
                style={{ paddingLeft: 10 + crumbs.length * 14 }}
                onClick={() => openFolder(folder)}
              >
                <FolderIcon />
                <span>{folder.label}</span>
              </button>
            ))}
          </aside>

          <div className="ex-table-wrap">
            <table className="ex-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Modified</th>
                  <th>Size</th>
                  <th>Kind</th>
                  <th><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {(listing.parent || (group !== "folder" && key)) && (
                  <tr className="ex-row" onClick={goParent}>
                    <td>
                      <button type="button" className="ex-name" onClick={goParent}>
                        <FolderIcon />
                        <span>..</span>
                      </button>
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td>Folder</td>
                    <td />
                  </tr>
                )}
                {folders.map((folder) => (
                  <tr key={folder.path} className="ex-row" onClick={() => openFolder(folder)}>
                    <td>
                      <button type="button" className="ex-name" onClick={() => openFolder(folder)}>
                        <FolderIcon />
                        <span>
                          {folder.label}
                          {folder.title && folder.company && folder.title !== folder.label && (
                            <small> · {folder.title}</small>
                          )}
                        </span>
                      </button>
                    </td>
                    <td>{formatModified(folder.modified)}</td>
                    <td>{folder.totalSize ? size(folder.totalSize) : "—"}</td>
                    <td>{folder.fileCount} item{folder.fileCount === 1 ? "" : "s"}</td>
                    <td>
                      {folder.transferId && (
                        <div className="ex-actions" onClick={(event) => event.stopPropagation()}>
                          <a className="text-button" href={`/api/employee/transfers/${folder.transferId}/download`}>ZIP all</a>
                          <button type="button" className="text-button" disabled={Boolean(action)}
                            onClick={() => share(folder.transferId)}>Share</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {files.map((file) => (
                  <tr key={`${file.transferId}-${file.id}`} className="ex-row file">
                    <td>
                      <span className="ex-name">
                        <span className={`badge ${badgeClass(file.name)}`}>{badgeLabel(file.name)}</span>
                        <span>
                          {file.name}
                          {group !== "folder" && (file.company || file.title) && (
                            <small> · {file.company || file.title}</small>
                          )}
                        </span>
                      </span>
                    </td>
                    <td>{formatModified(file.modified)}</td>
                    <td>{size(file.size)}</td>
                    <td>{badgeLabel(file.name)}</td>
                    <td>
                      <div className="ex-actions">
                        <a className="dl-btn secondary" href={`/api/employee/transfers/${file.transferId}/download?file=${encodeURIComponent(file.id)}`}
                          aria-label={`Download ${file.name}`} title="Download">↓</a>
                        <button type="button" className="text-button" disabled={Boolean(action)}
                          onClick={() => share(file.transferId)}>Share</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
