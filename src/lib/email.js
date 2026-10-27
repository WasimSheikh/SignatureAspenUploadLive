import { DefaultAzureCredential } from "@azure/identity";
import { config } from "./config.js";
import { getFiles } from "./db.js";
import { escapeHtml, hashToken } from "./security.mjs";

let credential;

export function publicUrl(id) {
  return `${config().appUrl}/transfer/${id}`;
}

async function graphToken() {
  if (!credential) credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined });
  const t = await credential.getToken("https://graph.microsoft.com/.default");
  return t.token;
}

async function sendOne(to, subject, html, text, replyTo) {
  const sender = process.env.GRAPH_SENDER_EMAIL;
  if (!sender) throw new Error("GRAPH_SENDER_EMAIL is not configured");
  const msg = {
    subject,
    body: { contentType: "HTML", content: html },
    from: { emailAddress: { name: "Signature Aspen Files", address: sender } },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (replyTo) msg.replyTo = [{ emailAddress: { address: replyTo } }];
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, saveToSentItems: false }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Graph API ${response.status}: ${err?.error?.message || "send failed"}`);
  }
}

function fmtSize(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function receiptNum(transferId) {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `SA-${yy}${mm}${dd}-${transferId.slice(-4).toUpperCase()}`;
}

function parseMessage(raw) {
  const lines = (raw || "").split("\n");
  let name = "", phone = "", notes = [];
  for (const line of lines) {
    if (line.startsWith("From: ")) name = line.slice(6).trim();
    else if (line.startsWith("Phone: ")) phone = line.slice(7).trim();
    else if (line.trim()) notes.push(line.trim());
  }
  return { name, phone, notes: notes.join("\n") };
}

// ── Shared email chrome ──────────────────────────────────────────────────────

const LOGO_URL = "https://signatureaspen.com/wp-content/uploads/2023/09/logo2.png";

function emailWrap(body, footer) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;padding:0;background:#F5F7FA;font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1A1A1A}
.wrap{max-width:600px;margin:24px auto;background:#fff;border:1px solid #E2E7EE;border-radius:6px;overflow:hidden}
.em-head{padding:20px 32px 16px;border-bottom:1px solid #E2E7EE;border-top:4px solid #77C045}
.logo{height:44px;max-width:200px;display:block}
.em-body{padding:28px 32px 26px}
.em-h{font-family:Raleway,Arial,sans-serif;font-weight:700;color:#0E3760;font-size:28px;line-height:1.15;margin:0 0 12px}
.lede{font-size:17px;line-height:1.45;margin:0 0 18px;color:#1A1A1A}
.lede b{color:#0E3760}
p{margin:0 0 14px}
a{color:#0E3760}
.receipt{border:1px solid #E2E7EE;border-radius:10px;background:#F5F7FA;margin:18px 0 14px;overflow:hidden}
.rc-top{padding:14px 16px;background:#fff;border-bottom:1px solid #E2E7EE;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px}
.rc-full{grid-column:1/-1}
.lbl{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#5F6B7A}
.val{font-weight:600;color:#1A1A1A;margin-top:2px}
.mono{font-variant-numeric:tabular-nums}
.rc-files{padding:4px 16px}
.rc-row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid #E2E7EE;font-size:14px}
.rc-row:last-child{border-bottom:0;font-weight:600}
.rc-row span:last-child{color:#5F6B7A;white-space:nowrap}
.rc-row.total span:last-child{color:#1A1A1A}
.calm{background:#F0F8EA;border:1px solid #CFE6BF;border-radius:10px;padding:12px 16px;color:#2E5A18;font-size:14px;margin:0 0 22px}
.sec-h{font-family:Raleway,Arial,sans-serif;font-weight:700;color:#0E3760;font-size:17px;margin:0 0 10px}
.steps{list-style:none;margin:0 0 22px;padding:0}
.steps li{display:flex;gap:12px;align-items:flex-start;padding:7px 0;font-size:14px}
.steps .n{flex:none;width:24px;height:24px;border-radius:50%;background:#0E3760;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-top:1px}
.btn{display:inline-block;padding:13px 24px;border-radius:8px;font-weight:600;font-size:15px;line-height:1.2;text-decoration:none;text-align:center}
.btn-navy{background:#0E3760;color:#fff}
.btn-green{background:#77C045;color:#0A2847}
.okcircle{width:56px;height:56px;border-radius:50%;background:#F0F8EA;border:2px solid #77C045;color:#4E8A2A;display:flex;align-items:center;justify-content:center;margin:0 0 16px;font-size:28px;line-height:1}
.dgrid{display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px 14px;margin:0 0 18px;padding:14px 16px;background:#F5F7FA;border:1px solid #E2E7EE;border-radius:10px;font-size:14px}
.dgrid dt{color:#5F6B7A}
.dgrid dd{margin:0;font-weight:500;overflow-wrap:anywhere}
.quote{margin:0 0 18px;border-left:3px solid #0E3760;padding:4px 0 4px 14px}
.quote .lbl{margin-bottom:4px}
.quote p{margin:0;font-size:15px;color:#27324a;white-space:pre-wrap}
.frows{border-top:1px solid #E2E7EE;margin:0 0 18px}
.frow{display:grid;grid-template-columns:46px 1fr auto;gap:8px 12px;align-items:center;padding:10px 0;border-bottom:1px solid #E2E7EE;font-size:14px}
.badge{display:inline-block;min-width:40px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.04em;padding:4px 5px;border-radius:5px;background:#E3ECF7;color:#0E3760}
.badge-zip{background:#F0F8EA;color:#4E8A2A}
.badge-pdf{background:#FDEEEC;color:#9B2C1F}
.fmeta{display:flex;gap:14px;align-items:center;white-space:nowrap;color:#5F6B7A}
.fmeta a{color:#0E3760;font-weight:600;text-decoration:none;border-bottom:1px solid #B3C0D1}
.foot{padding:16px 32px 20px;border-top:1px solid #E2E7EE;background:#FAFBFD;text-align:center;font-size:12px;line-height:1.7;color:#5F6B7A}
.foot a{color:#5F6B7A}
.foot b{color:#0E3760}
.foot .why{margin-top:8px;font-size:11px}
</style></head>
<body><div style="padding:16px 0">
<div class="wrap">
  <div class="em-head">
    <img src="${LOGO_URL}" alt="Signature Aspen" class="logo" referrerpolicy="no-referrer">
  </div>
  <div class="em-body">${body}</div>
  <div class="foot">${footer}</div>
</div>
</div></body></html>`;
}

const COMMON_FOOTER = `<p><b>Signature Aspen</b> &middot; the IMAGE communications company</p>
<p>3300 Kingswood St, Houston, Texas 77092 &middot; 713.830.9500 &middot; <a href="https://signatureaspen.com">signatureaspen.com</a></p>`;

// ── Customer confirmation email ───────────────────────────────────────────────

function customerHtml(transfer, files, receipt, contactName) {
  const { name, notes } = parseMessage(transfer.message);
  const firstName = name.trim().split(/\s+/)[0] || "there";
  const url = publicUrl(transfer.id);
  const totalBytes = files.reduce((s, f) => s + Number(f.size), 0);
  const received = new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const fileRows = files.map((f) => {
    return `<div class="rc-row"><span>${escapeHtml(f.name)}</span><span>${fmtSize(Number(f.size))}</span></div>`;
  }).join("");

  const body = `
    <div class="okcircle" aria-hidden="true">✓</div>
    <div class="em-h">Your files are in.</div>
    <p>Hi ${escapeHtml(firstName)}, thanks for sending these over. ${escapeHtml(contactName)} has them and will be in touch if anything needs a second look.</p>

    <div class="receipt">
      <div class="rc-top">
        <div><div class="lbl">Receipt</div><div class="val mono">${escapeHtml(receipt)}</div></div>
        <div><div class="lbl">Received</div><div class="val">${escapeHtml(received)}</div></div>
        <div class="rc-full"><div class="lbl">Job</div><div class="val">${escapeHtml(transfer.title || "")}</div></div>
      </div>
      <div class="rc-files">
        ${fileRows}
        <div class="rc-row total"><span>Total, ${files.length} file${files.length !== 1 ? "s" : ""}</span><span>${fmtSize(totalBytes)}</span></div>
      </div>
    </div>

    <div class="calm">No need to send these again. We have every file listed above.</div>

    <div class="sec-h">What happens next</div>
    <ol class="steps">
      <li><span class="n">1</span><span>Prepress checks your files, usually within 2 business hours.</span></li>
      <li><span class="n">2</span><span>${escapeHtml(contactName)} will be in touch if we need anything else.</span></li>
      <li><span class="n">3</span><span>We move forward once everything looks good.</span></li>
    </ol>

    <p style="margin-top:8px"><a class="btn btn-navy" href="${escapeHtml(url)}">View your transfer</a></p>
    <p class="small" style="font-size:13px;color:#5F6B7A;margin-top:14px">Questions? Just reply to this email and it goes straight to ${escapeHtml(contactName)}.</p>`;

  const footer = `${COMMON_FOOTER}
    <p class="why">You got this email because you sent files to Signature Aspen${transfer.title ? ` for ${escapeHtml(transfer.title)}` : ""}.</p>`;

  return emailWrap(body, footer);
}

// ── Internal alert email ──────────────────────────────────────────────────────

function internalHtml(transfer, files, receipt, contactName) {
  const { name, phone, notes } = parseMessage(transfer.message);
  const totalBytes = files.reduce((s, f) => s + Number(f.size), 0);
  const received = new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const url = publicUrl(transfer.id);

  const fileRows = files.map((f) => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const cls = ext === "pdf" ? "badge-pdf" : ["zip", "7z", "rar"].includes(ext) ? "badge-zip" : "";
    return `<div class="frow">
      <span class="badge ${cls}">${ext.toUpperCase().slice(0, 4) || "FILE"}</span>
      <span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</span>
      <span class="fmeta"><span>${fmtSize(Number(f.size))}</span></span>
    </div>`;
  }).join("");

  const body = `
    <p class="lede"><b>${escapeHtml(name || transfer.sender_email)}</b> sent <b>${files.length} file${files.length !== 1 ? "s" : ""}</b>${transfer.title ? ` for <b>${escapeHtml(transfer.title)}</b>` : ""}.</p>

    <dl class="dgrid">
      <dt>From</dt><dd>${escapeHtml(name || "")}${transfer.company ? `, ${escapeHtml(transfer.company)}` : ""}</dd>
      <dt>Email</dt><dd><a href="mailto:${escapeHtml(transfer.sender_email)}">${escapeHtml(transfer.sender_email)}</a></dd>
      ${phone ? `<dt>Phone</dt><dd><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></dd>` : ""}
      ${transfer.title ? `<dt>Job</dt><dd>${escapeHtml(transfer.title)}</dd>` : ""}
      <dt>Contact</dt><dd>${escapeHtml(contactName)}</dd>
      <dt>Received</dt><dd>${escapeHtml(received)}</dd>
      <dt>Receipt</dt><dd class="mono">${escapeHtml(receipt)}</dd>
    </dl>

    ${notes ? `<div class="quote"><div class="lbl">Their note</div><p>${escapeHtml(notes)}</p></div>` : ""}

    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:0 0 4px">
      <span class="sec-h">Files</span>
      <span style="font-size:13px;color:#5F6B7A">${files.length} file${files.length !== 1 ? "s" : ""}, ${fmtSize(totalBytes)}</span>
    </div>
    <div class="frows">${fileRows}</div>

    <p><a class="btn btn-navy" href="${escapeHtml(url)}">Download all (${fmtSize(totalBytes)})</a></p>
    <p style="font-size:12px;color:#5F6B7A;margin-top:8px">Files keep their original names. Click the link above to view and download.</p>`;

  const footer = `${COMMON_FOOTER}`;

  return emailWrap(body, footer);
}

// ── Email 2: Upload request link ──────────────────────────────────────────────

function uploadRequestHtml(contact, customer, job, appUrl) {
  const initials = contact.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const prefilledUrl = `${appUrl}/?contact=${encodeURIComponent(contact.id)}&job=${encodeURIComponent(job.number || "")}&title=${encodeURIComponent(job.title)}&company=${encodeURIComponent(job.company || "")}`;
  const expiryStr = job.expiresAt ? new Date(job.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

  const body = `
    <p>Hi ${escapeHtml(customer.firstName || customer.name || "there")},</p>
    <div style="display:flex;gap:14px;border-left:3px solid #77C045;background:#F5F7FA;border-radius:0 10px 10px 0;padding:16px 18px;margin:0 0 20px">
      <div style="flex:none;width:40px;height:40px;border-radius:50%;background:#0E3760;color:#fff;font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:center">${escapeHtml(initials)}</div>
      <div>
        <p style="margin-bottom:10px">${escapeHtml(job.message || "Please send your files using the link below.")}</p>
        <div style="font-size:13px;color:#5F6B7A;line-height:1.45"><b style="color:#1A1A1A">${escapeHtml(contact.name)}</b><br>${escapeHtml(contact.role || "Signature Aspen")}</div>
      </div>
    </div>
    <div style="display:flex;gap:14px;align-items:flex-start;border:1px solid #E2E7EE;border-radius:10px;padding:16px;margin:0 0 24px;background:#fff">
      <div style="flex:none;width:40px;height:40px;border-radius:8px;background:#E3ECF7;color:#0E3760;display:flex;align-items:center;justify-content:center">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2.5h8.8A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/></svg>
      </div>
      <div>
        ${job.number ? `<div style="font-size:12px;font-weight:600;color:#5F6B7A;letter-spacing:.04em">JOB #${escapeHtml(job.number)}</div>` : ""}
        <div style="font-family:Georgia,serif;font-weight:700;color:#0E3760;font-size:19px;line-height:1.25;margin:2px 0 8px">${escapeHtml(job.title)}</div>
        ${expiryStr ? `<div style="display:flex;align-items:center;gap:6px;font-size:13px;color:#1A1A1A"><span style="color:#4E8A2A">✓</span>Link active until ${escapeHtml(expiryStr)}</div>` : ""}
      </div>
    </div>
    <div style="text-align:center">
      <a href="${escapeHtml(prefilledUrl)}" style="display:inline-block;padding:16px 30px;border-radius:8px;background:#77C045;color:#0A2847;font-weight:600;font-size:17px;text-decoration:none">Send your files</a>
    </div>
    <p style="font-size:12.5px;color:#5F6B7A;text-align:center;margin:12px 0 0">This link only sends files for this job. You don't need an account.</p>
    <p style="font-size:12.5px;color:#5F6B7A;text-align:center;margin:6px 0 0">Up to 100 files and 20 GiB per send. PDF, AI, EPS, PSD, INDD, TIF, JPG, PNG or ZIP.</p>`;

  const footer = `${COMMON_FOOTER}
    <p class="why">${escapeHtml(contact.name)} created this link for you. Reply to this email if you have questions.</p>`;

  return emailWrap(body, footer);
}

// ── Email 4: Nobody has opened these ─────────────────────────────────────────

function unopenedAlertHtml(transfer, files, receipt, contactName, sentAt) {
  const { name } = parseMessage(transfer.message);
  const totalBytes = files.reduce((s, f) => s + Number(f.size), 0);
  const url = publicUrl(transfer.id);

  const fileRows = files.map((f) =>
    `<div class="rc-row"><span>${escapeHtml(f.name)}</span><span>${fmtSize(Number(f.size))}</span></div>`
  ).join("");

  const body = `
    <div style="display:flex;align-items:center;gap:12px;background:#FFF7E6;border-bottom:1px solid #F0D9A6;color:#6F470C;padding:14px 32px;margin:-28px -32px 20px">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#B7791F" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg>
      <div>
        <b style="display:block;font-weight:600;font-size:15px">Not opened yet</b>
        <span style="font-size:13px">Sent 2 hours ago, at ${escapeHtml(sentAt)}</span>
      </div>
    </div>
    <p class="lede">Files from <b>${escapeHtml(name || transfer.sender_email)}</b>${transfer.title ? ` for <b>${escapeHtml(transfer.title)}</b>` : ""} were sent at ${escapeHtml(sentAt)} and nobody has opened them yet. <b>${escapeHtml(contactName)}</b> was the contact.</p>
    <div style="border:1px solid #E2E7EE;border-radius:10px;padding:2px 16px;margin:0 0 20px">
      ${fileRows}
      <div class="rc-row" style="font-weight:600;border-bottom:0"><span>Total, ${files.length} file${files.length !== 1 ? "s" : ""}</span><span style="color:#1A1A1A">${fmtSize(totalBytes)}</span></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#0E3760;color:#fff;font-weight:600;font-size:15px;text-decoration:none">Open the files</a>
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;border:1px solid #9FB0C5;color:#0E3760;font-weight:600;font-size:15px;text-decoration:none">View transfer</a>
    </div>
    <p style="font-size:12.5px;color:#5F6B7A">Sent once, and only if no one opens the files within 2 business hours. The customer already has a confirmation.</p>`;

  const footer = `${COMMON_FOOTER}
    <p class="why">You got this because you lead Customer Service.</p>`;

  return emailWrap(body, footer);
}

// ── Email 5: Daily upload summary ─────────────────────────────────────────────

function dailySummaryHtml(rows, dateStr, appUrl) {
  const total = rows.length;
  const totalFiles = rows.reduce((s, r) => s + r.fileCount, 0);
  const notOpened = rows.filter((r) => !r.opened).length;

  const tableRows = rows.map((r) => {
    const timeStr = new Date(r.completedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const statusPill = r.opened
      ? `<span style="display:inline-flex;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background:#F0F8EA;color:#4E8A2A">Opened</span>`
      : `<span style="display:inline-flex;font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid #F0D9A6;background:#FFF7E6;color:#B7791F">Not opened</span>`;
    const rowStyle = r.opened ? "" : ' style="background:#FFF7E6"';
    return `<tr${rowStyle}>
      <td style="padding:9px 6px;border-bottom:1px solid #E2E7EE;color:#5F6B7A;white-space:nowrap;font-size:12.5px">${escapeHtml(timeStr)}</td>
      <td style="padding:9px 6px;border-bottom:1px solid #E2E7EE;font-weight:600;font-size:12.5px">${escapeHtml(r.company || "")}</td>
      <td style="padding:9px 6px;border-bottom:1px solid #E2E7EE;font-size:12.5px">${escapeHtml(r.title || "")}</td>
      <td style="padding:9px 6px;border-bottom:1px solid #E2E7EE;text-align:center;font-size:12.5px">${r.fileCount}</td>
      <td style="padding:9px 6px;border-bottom:1px solid #E2E7EE;font-size:12.5px">${escapeHtml(r.contactName || "")}</td>
      <td style="padding:9px 6px;border-bottom:1px solid #E2E7EE">${statusPill}</td>
    </tr>`;
  }).join("");

  const thStyle = "text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#5F6B7A;padding:6px;border-bottom:1px solid #E2E7EE";

  const body = `
    <div class="em-h" style="font-size:24px;margin-bottom:4px">Today's file uploads</div>
    <p style="font-size:13px;color:#5F6B7A;margin:0 0 18px">${escapeHtml(dateStr)}</p>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 20px">
      <div style="border:1px solid #E2E7EE;border-radius:10px;padding:12px 14px;background:#fff">
        <div style="font-family:Georgia,serif;font-weight:700;font-size:30px;line-height:1;color:#0E3760">${total}</div>
        <div style="font-size:12.5px;color:#5F6B7A;margin-top:6px">Sends</div>
      </div>
      <div style="border:1px solid #E2E7EE;border-radius:10px;padding:12px 14px;background:#fff">
        <div style="font-family:Georgia,serif;font-weight:700;font-size:30px;line-height:1;color:#0E3760">${totalFiles}</div>
        <div style="font-size:12.5px;color:#5F6B7A;margin-top:6px">Files</div>
      </div>
      <div style="border:1px solid ${notOpened > 0 ? "#F0D9A6" : "#E2E7EE"};border-radius:10px;padding:12px 14px;background:${notOpened > 0 ? "#FFF7E6" : "#fff"}">
        <div style="font-family:Georgia,serif;font-weight:700;font-size:30px;line-height:1;color:${notOpened > 0 ? "#B7791F" : "#0E3760"}">${notOpened}</div>
        <div style="font-size:12.5px;color:#5F6B7A;margin-top:6px">Not opened</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin:0 0 20px">
      <thead><tr>
        <th style="${thStyle}">Time</th>
        <th style="${thStyle}">Customer</th>
        <th style="${thStyle}">Job</th>
        <th style="${thStyle};text-align:center">Files</th>
        <th style="${thStyle}">Contact</th>
        <th style="${thStyle}">Status</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <p style="margin:0 0 16px"><a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#0E3760;color:#fff;font-weight:600;font-size:15px;text-decoration:none">See all uploads</a></p>
    <p style="font-size:12.5px;color:#5F6B7A">Optional. Turn it off, or change who gets it, in settings.</p>`;

  const footer = `${COMMON_FOOTER}
    <p class="why">Sent at 5:00 PM on weekdays to the people on the summary list.</p>`;

  return emailWrap(body, footer);
}

// ── Main send function ────────────────────────────────────────────────────────

export async function sendTransferEmails(client, transfer, reminder = false) {
  const settings = config();
  const files = await getFiles(client, transfer.id);
  const results = { ...transfer.email_results };
  const receipt = receiptNum(transfer.id);

  const recipientEmails = Array.isArray(transfer.recipient_emails) ? transfer.recipient_emails : JSON.parse(transfer.recipient_emails || "[]");
  const contactEmail = recipientEmails[0] || settings.internalEmails[0] || "";
  const contactName = contactEmail
    ? contactEmail.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "the Aspen team";

  if (!reminder && transfer.email_attempted_at &&
      Date.now() - new Date(transfer.email_attempted_at).getTime() > 23 * 60 * 60 * 1000 &&
      transfer.email_status !== "sent") {
    await client.query("UPDATE transfers SET email_status = 'failed' WHERE id = $1", [transfer.id]);
    return "failed";
  }
  if (!reminder) {
    await client.query("UPDATE transfers SET email_attempted_at = COALESCE(email_attempted_at, now()) WHERE id = $1", [transfer.id]);
  }

  let success = true;

  // 1. Customer confirmation (to sender)
  if (!reminder) {
    const key = `delivery-customer-${hashToken(transfer.sender_email).slice(0, 32)}`;
    if (results[key] !== "sent") {
      try {
        const subject = `We got your files${transfer.title ? ` for ${transfer.title}` : ""}`;
        const html = customerHtml(transfer, files, receipt, contactName);
        const text = `Your files are in.\n\nReceipt: ${receipt}\nJob: ${transfer.title || ""}\n${files.map((f) => `- ${f.name} (${fmtSize(Number(f.size))})`).join("\n")}\n\nView transfer: ${publicUrl(transfer.id)}`;
        await sendOne(transfer.sender_email, subject, html, text, contactEmail || undefined);
        results[key] = "sent";
        await client.query("UPDATE transfers SET email_results = $2::jsonb WHERE id = $1", [transfer.id, JSON.stringify(results)]);
      } catch {
        success = false;
        console.error("Customer confirmation email failed.");
      }
    }
  }

  // 2. Internal alert (to Aspen contact + internal inbox)
  const internalRecipients = [...new Set([...recipientEmails, ...settings.internalEmails])].filter(Boolean);
  for (const recipient of internalRecipients) {
    const kind = reminder ? "reminder" : "internal";
    const key = `${kind}-${hashToken(recipient).slice(0, 32)}`;
    if (results[key] === "sent") continue;
    try {
      const subject = reminder
        ? `Reminder: files expiring soon — ${transfer.company || transfer.title || "transfer"}`
        : `New files: ${transfer.company || ""}${transfer.title ? `, ${transfer.title}` : ""} (${files.length} file${files.length !== 1 ? "s" : ""}, ${fmtSize(files.reduce((s, f) => s + Number(f.size), 0))})`;
      const html = internalHtml(transfer, files, receipt, contactName);
      const text = `New files from ${transfer.sender_email}\nJob: ${transfer.title}\n${files.map((f) => `- ${f.name} (${fmtSize(Number(f.size))})`).join("\n")}\n\nView: ${publicUrl(transfer.id)}`;
      await sendOne(recipient, subject, html, text);
      results[key] = "sent";
      await client.query("UPDATE transfers SET email_results = $2::jsonb WHERE id = $1", [transfer.id, JSON.stringify(results)]);
    } catch {
      success = false;
      console.error("Internal alert email failed.");
    }
  }

  if (reminder) {
    if (success) await client.query("UPDATE transfers SET reminder_sent_at = now() WHERE id = $1", [transfer.id]);
  } else {
    await client.query("UPDATE transfers SET email_status = $2 WHERE id = $1", [transfer.id, success ? "sent" : "failed"]);
  }
  return success ? "sent" : "failed";
}

// ── Send upload request email (Email 2) ───────────────────────────────────────

export async function sendUploadRequest({ contact, customer, job }) {
  const settings = config();
  const subject = `${contact.name.split(" ")[0]} from Signature Aspen needs files${job.title ? ` for ${job.title}` : ""}`;
  const html = uploadRequestHtml(contact, customer, job, settings.appUrl);
  const text = `Hi ${customer.firstName || customer.name || "there"},\n\n${job.message || ""}\n\nSend your files: ${settings.appUrl}/?job=${encodeURIComponent(job.number || "")}\n\nLink active until ${job.expiresAt ? new Date(job.expiresAt).toLocaleDateString() : ""}`;
  await sendOne(customer.email, subject, html, text, contact.email);
}

// ── Send unopened alert (Email 4) ─────────────────────────────────────────────

export async function sendUnopenedAlerts(database) {
  const settings = config();
  if (!settings.csLeadEmail) return 0;

  const { rows } = await database.query(`
    SELECT t.id, t.sender_email, t.company, t.title, t.completed_at, t.message, t.recipient_emails
    FROM transfers t
    WHERE t.status = 'complete'
    AND t.expires_at > now()
    AND t.completed_at < now() - interval '2 hours'
    AND NOT EXISTS (
      SELECT 1 FROM transfer_access_events e
      WHERE e.transfer_id = t.id
      AND e.event IN ('file_download', 'archive_download', 'unopened_alert_sent')
    )
    ORDER BY t.completed_at ASC LIMIT 20`);

  let sent = 0;
  for (const transfer of rows) {
    try {
      const files = await database.query(
        "SELECT name, size FROM transfer_files WHERE transfer_id = $1 ORDER BY ordinal", [transfer.id]);
      const recipientEmails = Array.isArray(transfer.recipient_emails)
        ? transfer.recipient_emails : JSON.parse(transfer.recipient_emails || "[]");
      const contactEmail = recipientEmails[0] || "";
      const contactName = contactEmail
        ? contactEmail.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : "the Aspen team";
      const sentAt = new Date(transfer.completed_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

      const subject = `Not opened yet: files from ${transfer.company || transfer.sender_email} (sent 2 hours ago)`;
      const html = unopenedAlertHtml(transfer, files.rows, receiptNum(transfer.id), contactName, sentAt);

      const sender = process.env.GRAPH_SENDER_EMAIL;
      const msg = {
        subject,
        body: { contentType: "HTML", content: html },
        from: { emailAddress: { name: "Signature Aspen Files", address: sender } },
        toRecipients: [{ emailAddress: { address: settings.csLeadEmail } }],
      };
      if (contactEmail && contactEmail !== settings.csLeadEmail) {
        msg.ccRecipients = [{ emailAddress: { address: contactEmail } }];
      }
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
        { method: "POST", headers: { Authorization: `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg, saveToSentItems: false }), signal: AbortSignal.timeout(15000) }
      );
      if (response.ok) {
        await database.query(
          "INSERT INTO transfer_access_events (transfer_id, event) VALUES ($1, 'unopened_alert_sent')", [transfer.id]);
        sent++;
      }
    } catch { console.error("Unopened alert email failed."); }
  }
  return sent;
}

// ── Send daily summary (Email 5) ──────────────────────────────────────────────

export async function sendDailySummary(database) {
  const settings = config();
  if (!settings.summaryEmails.length) return "skipped";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const { rows } = await database.query(`
    SELECT t.id, t.company, t.title, t.completed_at, t.recipient_emails,
      (SELECT COUNT(*) FROM transfer_files f WHERE f.transfer_id = t.id)::int AS file_count,
      EXISTS (
        SELECT 1 FROM transfer_access_events e
        WHERE e.transfer_id = t.id AND e.event IN ('file_download', 'archive_download')
      ) AS opened
    FROM transfers t
    WHERE t.status = 'complete'
    AND t.completed_at >= $1 AND t.completed_at < $2
    ORDER BY t.completed_at ASC`, [today.toISOString(), tomorrow.toISOString()]);

  if (!rows.length) return "nothing";

  const summaryRows = rows.map((r) => {
    const recipientEmails = Array.isArray(r.recipient_emails)
      ? r.recipient_emails : JSON.parse(r.recipient_emails || "[]");
    const contactEmail = recipientEmails[0] || "";
    const contactName = contactEmail
      ? contactEmail.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "";
    return { company: r.company, title: r.title, completedAt: r.completed_at, fileCount: r.file_count, contactName, opened: r.opened };
  });

  const totalFiles = summaryRows.reduce((s, r) => s + r.fileCount, 0);
  const dateStr = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const subject = `Today's file uploads: ${summaryRows.length} send${summaryRows.length !== 1 ? "s" : ""}, ${totalFiles} file${totalFiles !== 1 ? "s" : ""}`;
  const html = dailySummaryHtml(summaryRows, dateStr, settings.appUrl);
  const text = `Today's uploads: ${summaryRows.length} sends, ${totalFiles} files.\n\n${summaryRows.map((r) => `${r.company} — ${r.title} (${r.fileCount} files, ${r.opened ? "opened" : "NOT OPENED"})`).join("\n")}`;

  let sent = 0;
  for (const to of settings.summaryEmails) {
    try { await sendOne(to, subject, html, text); sent++; }
    catch { console.error("Daily summary email failed."); }
  }
  return sent > 0 ? "sent" : "failed";
}
