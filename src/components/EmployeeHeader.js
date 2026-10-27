"use client";

import Brand from "./Brand";

async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
  } catch { /* still leave the workspace */ }
  window.location.assign("/");
}

export default function EmployeeHeader({ employee, current = "dashboard" }) {
  return (
    <header className="slim-header">
      <Brand />
      <nav className="workspace-nav" aria-label="Workspace">
        <a href="/dashboard" className={current === "dashboard" ? "on" : ""} aria-current={current === "dashboard" ? "page" : undefined}>Dashboard</a>
        <a href="/" className={current === "home" ? "on" : ""} aria-current={current === "home" ? "page" : undefined}>Upload Art</a>
      </nav>
      <div className="employee-bar">
        <span>{employee?.name || employee?.email || "Employee"}</span>
        <button className="secondary" type="button" onClick={signOut}>Sign out</button>
      </div>
    </header>
  );
}
