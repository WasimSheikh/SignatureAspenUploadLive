"use client";

import { useEffect, useState } from "react";
import Uploader from "./Uploader";
import Brand from "./Brand";
import EmployeeHeader from "./EmployeeHeader";

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Unable to complete your request.");
  return data;
}

export default function Workspace({ employee = null }) {
  const [session, setSession] = useState(employee ? { enabled: true, employee } : { enabled: true, employee: null });
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request("/api/auth/session", { signal: controller.signal }).then(setSession).catch((failure) => {
      if (!controller.signal.aborted) { setSession({ enabled: true, employee: null }); setError(failure.message); }
    });
    if (new URLSearchParams(window.location.search).has("error")) {
      setError("Company sign-in was not completed. Check your tenant/group access or contact your administrator.");
    }
    return () => controller.abort();
  }, []);

  if (session?.employee) {
    return (
      <>
        <EmployeeHeader employee={session.employee} current="home" />
        {error && <p className="error" role="alert">{error}</p>}
        <Uploader employee={session.employee} slimHero />
      </>
    );
  }

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
