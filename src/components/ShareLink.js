"use client";

import { useEffect, useState } from "react";

export default function ShareLink({ url, label = "Share URL" }) {
  const [copied, setCopied] = useState(false);
  const [value, setValue] = useState(url);

  useEffect(() => {
    if (url) { setValue(url); return; }
    if (typeof window !== "undefined") setValue(window.location.href.split("#")[0]);
  }, [url]);

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      try {
        const field = document.createElement("textarea");
        field.value = value;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.left = "-9999px";
        document.body.appendChild(field);
        field.select();
        document.execCommand("copy");
        document.body.removeChild(field);
        setCopied(true);
      } catch { /* Clipboard may be blocked. */ }
    }
  }

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!value) return null;

  return (
    <div className="share-box">
      <p className="share-label">{label}</p>
      <div className="share-row">
        <input className="in" type="text" readOnly value={value} aria-label={label}
          onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className={copied ? "btn-primary" : "secondary"} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
