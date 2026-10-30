import { DefaultAzureCredential } from "@azure/identity";
import { config } from "./config.js";
import { getFiles } from "./db.js";
import { escapeHtml, hashToken } from "./security.mjs";

let credential;

export function publicUrl(id) {
  return `${config().appUrl}/transfer/${id}`;
}

export function isProofTransfer(transfer) {
  return transfer?.purpose === "proof";
}

export function dashboardUrl(origin = config().appUrl) {
  return `${origin}/dashboard`;
}

export function dashboardUploadsUrl(origin = config().appUrl) {
  return `${origin}/dashboard?tab=files`;
}

export function uploadRequestUrl(contact, job, origin = config().appUrl) {
  const params = new URLSearchParams({
    contact: contact.id || "",
    job: job.number || "",
    title: job.title || "",
    company: job.company || "",
  });
  return `${origin}/?${params}`;
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
    else if (line.startsWith("Purpose: ") || line.startsWith("To: ")) continue;
    else if (line.trim()) notes.push(line.trim());
  }
  return { name, phone, notes: notes.join("\n") };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const LOGO_URL = `${config().appUrl}/logo.svg`;
const FONT = "Arial,Helvetica,sans-serif";
const NAVY = "#0E3760";
const GREEN = "#77C045";
const MUTED = "#5F6B7A";
const LINE = "#E2E7EE";
const SURFACE = "#F5F7FA";

// Outlook-compatible button (table-based so bgcolor works in Word rendering engine)
function btnNavy(url, label) {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0"><tr>
<td style="border-radius:8px;background-color:${NAVY}" bgcolor="${NAVY}">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 24px;border-radius:8px;background-color:${NAVY};color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;font-family:${FONT};line-height:1.3;mso-padding-alt:13px 24px"><font color="#ffffff">${label}</font></a>
</td></tr></table>`;
}

function btnGreen(url, label) {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 0 auto"><tr>
<td style="border-radius:8px;background-color:${GREEN}" bgcolor="${GREEN}">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:16px 30px;border-radius:8px;background-color:${GREEN};color:#0A2847;font-weight:700;font-size:17px;text-decoration:none;font-family:${FONT};line-height:1.3;mso-padding-alt:16px 30px"><font color="#0A2847">${label}</font></a>
</td></tr></table>`;
}

function btnOutline(url, label) {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0"><tr>
<td style="border-radius:8px;border:1px solid #9FB0C5;background-color:#ffffff" bgcolor="#ffffff">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background-color:#ffffff;color:${NAVY};font-weight:700;font-size:15px;text-decoration:none;font-family:${FONT};line-height:1.3;mso-padding-alt:12px 22px"><font color="#0E3760">${label}</font></a>
</td></tr></table>`;
}

function p(text, style = "") {
  return `<p style="margin:0 0 14px 0;color:#1A1A1A;font-family:${FONT};font-size:15px;line-height:1.55;${style}">${text}</p>`;
}

// ── Email wrapper — fully table-based, no <style> block ───────────────────────

function emailWrap(body, footer) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${SURFACE};font-family:${FONT}">
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${SURFACE}">
<tr><td align="center" style="padding:24px 16px">
<table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid ${LINE};border-radius:6px">
  <tr><td style="border-top:4px solid ${GREEN};padding:20px 32px 16px;border-bottom:1px solid ${LINE}">
    <img src="${LOGO_URL}" alt="Signature Aspen" height="44" style="display:block;max-width:200px;height:44px;border:0" referrerpolicy="no-referrer">
  </td></tr>
  <tr><td style="padding:28px 32px 26px;font-family:${FONT};font-size:15px;color:#1A1A1A;line-height:1.55">
    ${body}
  </td></tr>
  <tr><td style="padding:16px 32px 20px;border-top:1px solid ${LINE};background-color:#FAFBFD;text-align:center;font-size:12px;line-height:1.7;color:${MUTED};font-family:${FONT}">
    ${footer}
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const COMMON_FOOTER = `<p style="margin:0 0 4px 0;color:${MUTED};font-family:${FONT};font-size:12px"><b style="color:${NAVY}">Signature Aspen</b> &middot; the IMAGE communications company</p>
<p style="margin:0;color:${MUTED};font-family:${FONT};font-size:12px">3300 Kingswood Ln., Houston, TX 77092<br>sales@signatureaspen.com &middot; Phone: 713.956.8555 &middot; Fax: 832.295.5795<br><a href="https://signatureaspen.com" style="color:${MUTED}">signatureaspen.com</a></p>`;

// ── Email 1: Customer confirmation ────────────────────────────────────────────

function customerHtml(transfer, files, receipt, contactName) {
  const { name } = parseMessage(transfer.message);
  const firstName = name.trim().split(/\s+/)[0] || "there";
  const url = publicUrl(transfer.id);
  const totalBytes = files.reduce((s, f) => s + Number(f.size), 0);
  const received = new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const fileRows = files.map((f) =>
    `<tr>
      <td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;font-family:${FONT};color:#1A1A1A">${escapeHtml(f.name)}</td>
      <td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;font-family:${FONT};color:${MUTED};white-space:nowrap;text-align:right">${fmtSize(Number(f.size))}</td>
    </tr>`
  ).join("");

  const body = `
    <div style="width:56px;height:56px;border-radius:50%;background-color:#F0F8EA;border:2px solid ${GREEN};color:#4E8A2A;font-size:28px;line-height:56px;text-align:center;margin:0 0 16px 0;font-family:${FONT}">✓</div>
    <h1 style="font-family:Georgia,serif;font-weight:700;color:${NAVY};font-size:28px;line-height:1.15;margin:0 0 12px 0">Your files are in.</h1>
    ${p(`Hi ${escapeHtml(firstName)}, thanks for sending these over. ${escapeHtml(contactName)} has them and will be in touch if anything needs a second look.`)}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border:1px solid ${LINE};border-radius:10px;margin:18px 0 14px 0;overflow:hidden">
      <tr><td style="background-color:#ffffff;padding:14px 16px;border-bottom:1px solid ${LINE}">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr>
            <td width="50%" style="padding:0 9px 0 0;vertical-align:top">
              <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:${MUTED};font-family:${FONT}">Receipt</div>
              <div style="font-weight:600;color:#1A1A1A;margin-top:2px;font-family:${FONT};font-size:15px">${escapeHtml(receipt)}</div>
            </td>
            <td width="50%" style="vertical-align:top">
              <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:${MUTED};font-family:${FONT}">Received</div>
              <div style="font-weight:600;color:#1A1A1A;margin-top:2px;font-family:${FONT};font-size:15px">${escapeHtml(received)}</div>
            </td>
          </tr>
          <tr><td colspan="2" style="padding-top:12px;vertical-align:top">
            <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:${MUTED};font-family:${FONT}">Job</div>
            <div style="font-weight:600;color:#1A1A1A;margin-top:2px;font-family:${FONT};font-size:15px">${escapeHtml(transfer.title || "")}</div>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:4px 16px;background-color:${SURFACE}">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          ${fileRows}
          <tr>
            <td style="padding:9px 0;font-size:14px;font-weight:700;font-family:${FONT};color:#1A1A1A">Total, ${files.length} file${files.length !== 1 ? "s" : ""}</td>
            <td style="padding:9px 0;font-size:14px;font-weight:700;font-family:${FONT};color:#1A1A1A;text-align:right">${fmtSize(totalBytes)}</td>
          </tr>
        </table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 22px 0">
    <tr><td style="background-color:#F0F8EA;border:1px solid #CFE6BF;border-radius:10px;padding:12px 16px;color:#2E5A18;font-size:14px;font-family:${FONT}" bgcolor="#F0F8EA">
      No need to send these again. We have every file listed above.
    </td></tr>
    </table>

    <h2 style="font-family:Georgia,serif;font-weight:700;color:${NAVY};font-size:17px;margin:0 0 10px 0">What happens next</h2>
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 22px 0;width:100%">
      <tr>
        <td valign="top" style="width:34px;padding:7px 0"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background-color:${NAVY};color:#ffffff;font-size:12px;font-weight:700;text-align:center;line-height:24px;font-family:${FONT}">1</span></td>
        <td style="padding:7px 0 7px 8px;font-size:14px;color:#1A1A1A;font-family:${FONT}">Prepress checks your files, usually within 2 business hours.</td>
      </tr>
      <tr>
        <td valign="top" style="width:34px;padding:7px 0"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background-color:${NAVY};color:#ffffff;font-size:12px;font-weight:700;text-align:center;line-height:24px;font-family:${FONT}">2</span></td>
        <td style="padding:7px 0 7px 8px;font-size:14px;color:#1A1A1A;font-family:${FONT}">${escapeHtml(contactName)} will be in touch if we need anything else.</td>
      </tr>
      <tr>
        <td valign="top" style="width:34px;padding:7px 0"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background-color:${NAVY};color:#ffffff;font-size:12px;font-weight:700;text-align:center;line-height:24px;font-family:${FONT}">3</span></td>
        <td style="padding:7px 0 7px 8px;font-size:14px;color:#1A1A1A;font-family:${FONT}">We move forward once everything looks good.</td>
      </tr>
    </table>

    ${btnNavy(url, "View your transfer")}
    <p style="font-size:13px;color:${MUTED};margin:14px 0 0 0;font-family:${FONT}">Questions? Just reply to this email and it goes straight to ${escapeHtml(contactName)}.</p>`;

  const footer = `${COMMON_FOOTER}
    <p style="margin:8px 0 0 0;font-size:11px;color:${MUTED};font-family:${FONT}">You got this email because you sent files to Signature Aspen${transfer.title ? ` for ${escapeHtml(transfer.title)}` : ""}.</p>`;

  return emailWrap(body, footer);
}

// ── Email 3: Internal alert ───────────────────────────────────────────────────

function internalHtml(transfer, files, receipt, contactName) {
  const { name, phone, notes } = parseMessage(transfer.message);
  const totalBytes = files.reduce((s, f) => s + Number(f.size), 0);
  const received = new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const url = publicUrl(transfer.id);

  const fileRows = files.map((f) => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const badgeBg = ext === "pdf" ? "#FDEEEC" : ["zip", "7z", "rar"].includes(ext) ? "#F0F8EA" : "#E3ECF7";
    const badgeColor = ext === "pdf" ? "#9B2C1F" : ["zip", "7z", "rar"].includes(ext) ? "#4E8A2A" : NAVY;
    return `<tr>
      <td width="52" style="padding:10px 8px 10px 0;border-bottom:1px solid ${LINE};vertical-align:middle">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background-color:${badgeBg};border-radius:5px;padding:4px 6px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.04em;color:${badgeColor};font-family:${FONT};white-space:nowrap" bgcolor="${badgeBg}"><font color="${badgeColor}">${ext.toUpperCase().slice(0, 4) || "FILE"}</font></td>
        </tr></table>
      </td>
      <td style="padding:10px 12px 10px 0;border-bottom:1px solid ${LINE};font-size:14px;font-weight:500;color:#1A1A1A;font-family:${FONT}">${escapeHtml(f.name)}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${LINE};font-size:13px;color:${MUTED};white-space:nowrap;text-align:right;font-family:${FONT}">${fmtSize(Number(f.size))}</td>
    </tr>`;
  }).join("");

  const detailRows = [
    ["From", `${escapeHtml(name || "")}${transfer.company ? `, ${escapeHtml(transfer.company)}` : ""}`],
    ["Email", `<a href="mailto:${escapeHtml(transfer.sender_email)}" style="color:${NAVY}">${escapeHtml(transfer.sender_email)}</a>`],
    ...(phone ? [["Phone", `<a href="tel:${escapeHtml(phone)}" style="color:${NAVY}">${escapeHtml(phone)}</a>`]] : []),
    ...(transfer.title ? [["Job", escapeHtml(transfer.title)]] : []),
    ["Contact", escapeHtml(contactName)],
    ["Received", escapeHtml(received)],
    ["Receipt", escapeHtml(receipt)],
  ].map(([label, value]) => `<tr>
    <td width="110" valign="top" style="padding:6px 14px 6px 16px;color:${MUTED};font-size:14px;font-family:${FONT}">${label}</td>
    <td valign="top" style="padding:6px 16px 6px 0;font-size:14px;font-weight:500;color:#1A1A1A;font-family:${FONT}">${value}</td>
  </tr>`).join("");

  const body = `
    <p style="font-size:17px;line-height:1.45;margin:0 0 18px 0;color:#1A1A1A;font-family:${FONT}"><b style="color:${NAVY}">${escapeHtml(name || transfer.sender_email)}</b> sent <b style="color:${NAVY}">${files.length} file${files.length !== 1 ? "s" : ""}</b>${transfer.title ? ` for <b style="color:${NAVY}">${escapeHtml(transfer.title)}</b>` : ""}.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 18px 0;background-color:${SURFACE};border:1px solid ${LINE};border-radius:10px" bgcolor="#F5F7FA">
      ${detailRows}
    </table>

    ${notes ? `<div style="margin:0 0 18px 0;border-left:3px solid ${NAVY};padding:4px 0 4px 14px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:${MUTED};margin-bottom:4px;font-family:${FONT}">Their note</div>
      <p style="margin:0;font-size:15px;color:#27324a;font-family:${FONT};white-space:pre-wrap">${escapeHtml(notes)}</p>
    </div>` : ""}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 4px 0">
    <tr>
      <td style="font-family:Georgia,serif;font-weight:700;color:${NAVY};font-size:17px">Files</td>
      <td style="text-align:right;font-size:13px;color:${MUTED};font-family:${FONT}">${files.length} file${files.length !== 1 ? "s" : ""}, ${fmtSize(totalBytes)}</td>
    </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-top:1px solid ${LINE};margin:0 0 18px 0">
      ${fileRows}
    </table>

    ${btnNavy(url, `Download all (${fmtSize(totalBytes)})`)}
    <p style="font-size:12px;color:${MUTED};margin:8px 0 0 0;font-family:${FONT}">Files keep their original names.</p>`;

  return emailWrap(body, COMMON_FOOTER);
}

// ── Employee → customer design proof ──────────────────────────────────────────

function proofHtml(transfer, files, receipt, employeeName) {
  const { notes } = parseMessage(transfer.message);
  const url = publicUrl(transfer.id);
  const totalBytes = files.reduce((s, f) => s + Number(f.size), 0);
  const fileRows = files.map((f) =>
    `<tr>
      <td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;font-family:${FONT};color:#1A1A1A">${escapeHtml(f.name)}</td>
      <td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;font-family:${FONT};color:${MUTED};white-space:nowrap;text-align:right">${fmtSize(Number(f.size))}</td>
    </tr>`
  ).join("");

  const body = `
    <h1 style="font-family:Georgia,serif;font-weight:700;color:${NAVY};font-size:28px;line-height:1.15;margin:0 0 12px 0">Your design proof is ready.</h1>
    ${p(`${escapeHtml(employeeName)} at Signature Aspen sent ${files.length} file${files.length !== 1 ? "s" : ""}${transfer.title ? ` for <b>${escapeHtml(transfer.title)}</b>` : ""}.`)}
    ${notes ? `<div style="margin:0 0 18px 0;border-left:3px solid ${GREEN};padding:4px 0 4px 14px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:${MUTED};margin-bottom:4px;font-family:${FONT}">A note from ${escapeHtml(employeeName)}</div>
      <p style="margin:0;font-size:15px;color:#27324a;font-family:${FONT};white-space:pre-wrap">${escapeHtml(notes)}</p>
    </div>` : ""}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border:1px solid ${LINE};border-radius:10px;margin:0 0 20px 0">
    <tr><td style="padding:2px 16px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
        ${fileRows}
        <tr>
          <td style="padding:9px 0;font-size:14px;font-weight:700;font-family:${FONT};color:#1A1A1A">Total, ${files.length} file${files.length !== 1 ? "s" : ""}</td>
          <td style="padding:9px 0;font-size:14px;font-weight:700;font-family:${FONT};color:#1A1A1A;text-align:right">${fmtSize(totalBytes)}</td>
        </tr>
      </table>
    </td></tr>
    </table>

    ${btnGreen(url, "Open your proof")}
    <p style="font-size:13px;color:${MUTED};margin:14px 0 0 0;font-family:${FONT}">Receipt ${escapeHtml(receipt)}. Questions? Reply to this email and it goes to ${escapeHtml(employeeName)}.</p>`;

  const footer = `${COMMON_FOOTER}
    <p style="margin:8px 0 0 0;font-size:11px;color:${MUTED};font-family:${FONT}">You got this email because Signature Aspen sent you a design proof${transfer.company ? ` for ${escapeHtml(transfer.company)}` : ""}.</p>`;

  return emailWrap(body, footer);
}

// ── Email 2: Upload request link ──────────────────────────────────────────────

function uploadRequestHtml(contact, customer, job, appUrl) {
  const initials = contact.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const prefilledUrl = uploadRequestUrl(contact, job, appUrl);
  const expiryStr = job.expiresAt ? new Date(job.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

  const body = `
    ${p(`Hi ${escapeHtml(customer.firstName || customer.name || "there")},`)}
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 20px 0;border-left:3px solid ${GREEN};background-color:${SURFACE};border-radius:0 10px 10px 0" bgcolor="#F5F7FA">
    <tr>
      <td valign="top" style="padding:16px 0 16px 18px;width:54px">
        <span style="display:inline-block;width:40px;height:40px;border-radius:50%;background-color:${NAVY};color:#ffffff;font-weight:600;font-size:14px;text-align:center;line-height:40px;font-family:${FONT}">${escapeHtml(initials)}</span>
      </td>
      <td valign="top" style="padding:16px 18px 16px 14px">
        <p style="margin:0 0 10px 0;font-size:15px;color:#1A1A1A;font-family:${FONT}">${escapeHtml(job.message || "Please send your files using the link below.")}</p>
        <div style="font-size:13px;color:${MUTED};line-height:1.45;font-family:${FONT}"><b style="color:#1A1A1A">${escapeHtml(contact.name)}</b><br>${escapeHtml(contact.role || "Signature Aspen")}</div>
      </td>
    </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px 0;border:1px solid ${LINE};border-radius:10px;background-color:#ffffff" bgcolor="#ffffff">
    <tr>
      <td valign="top" style="padding:16px 0 16px 16px;width:54px">
        <span style="display:inline-block;width:40px;height:40px;border-radius:8px;background-color:#E3ECF7;color:${NAVY};text-align:center;line-height:40px;font-size:20px">📁</span>
      </td>
      <td valign="top" style="padding:16px 16px 16px 14px">
        ${job.number ? `<div style="font-size:12px;font-weight:600;color:${MUTED};letter-spacing:.04em;font-family:${FONT}">JOB #${escapeHtml(job.number)}</div>` : ""}
        <div style="font-family:Georgia,serif;font-weight:700;color:${NAVY};font-size:19px;line-height:1.25;margin:2px 0 8px 0">${escapeHtml(job.title)}</div>
        ${expiryStr ? `<div style="font-size:13px;color:#1A1A1A;font-family:${FONT}"><span style="color:#4E8A2A">✓</span> Link active until ${escapeHtml(expiryStr)}</div>` : ""}
      </td>
    </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td align="center">
      ${btnGreen(prefilledUrl, "Send your files")}
    </td></tr></table>
    <p style="font-size:12.5px;color:${MUTED};text-align:center;margin:12px 0 0 0;font-family:${FONT}">This link only sends files for this job. You don't need an account.</p>
    <p style="font-size:12.5px;color:${MUTED};text-align:center;margin:6px 0 0 0;font-family:${FONT}">Up to 100 files and 20 GiB per send. PDF, AI, EPS, PSD, INDD, TIF, JPG, PNG or ZIP.</p>`;

  const footer = `${COMMON_FOOTER}
    <p style="margin:8px 0 0 0;font-size:11px;color:${MUTED};font-family:${FONT}">${escapeHtml(contact.name)} created this link for you. Reply to this email if you have questions.</p>`;

  return emailWrap(body, footer);
}

// ── Email 4: Nobody has opened these ─────────────────────────────────────────

function unopenedAlertHtml(transfer, files, receipt, contactName, sentAt) {
  const { name } = parseMessage(transfer.message);
  const totalBytes = files.reduce((s, f) => s + Number(f.size), 0);
  const url = publicUrl(transfer.id);

  const fileRows = files.map((f) =>
    `<tr>
      <td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;font-family:${FONT};color:#1A1A1A">${escapeHtml(f.name)}</td>
      <td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;font-family:${FONT};color:${MUTED};white-space:nowrap;text-align:right">${fmtSize(Number(f.size))}</td>
    </tr>`
  ).join("");

  const body = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:-28px -32px 20px -32px;width:calc(100% + 64px)" bgcolor="#FFF7E6">
    <tr><td style="background-color:#FFF7E6;border-bottom:1px solid #F0D9A6;padding:14px 32px" bgcolor="#FFF7E6">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
        <td valign="middle" style="padding-right:12px;font-size:20px">&#9200;</td>
        <td valign="middle">
          <b style="display:block;font-weight:600;font-size:15px;color:#6F470C;font-family:${FONT}">Not opened yet</b>
          <span style="font-size:13px;color:#6F470C;font-family:${FONT}">Sent 2 hours ago, at ${escapeHtml(sentAt)}</span>
        </td>
      </tr></table>
    </td></tr>
    </table>

    <p style="font-size:17px;line-height:1.45;margin:0 0 18px 0;color:#1A1A1A;font-family:${FONT}">Files from <b style="color:${NAVY}">${escapeHtml(name || transfer.sender_email)}</b>${transfer.title ? ` for <b style="color:${NAVY}">${escapeHtml(transfer.title)}</b>` : ""} were sent at ${escapeHtml(sentAt)} and nobody has opened them yet. <b style="color:${NAVY}">${escapeHtml(contactName)}</b> was the contact.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border:1px solid ${LINE};border-radius:10px;margin:0 0 20px 0">
    <tr><td style="padding:2px 16px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
        ${fileRows}
        <tr>
          <td style="padding:9px 0;font-size:14px;font-weight:700;font-family:${FONT};color:#1A1A1A">Total, ${files.length} file${files.length !== 1 ? "s" : ""}</td>
          <td style="padding:9px 0;font-size:14px;font-weight:700;font-family:${FONT};color:#1A1A1A;text-align:right">${fmtSize(totalBytes)}</td>
        </tr>
      </table>
    </td></tr>
    </table>

    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 16px 0">
    <tr>
      <td style="padding-right:10px">${btnNavy(url, "Open the files")}</td>
      <td>${btnOutline(url, "View transfer")}</td>
    </tr>
    </table>
    <p style="font-size:12.5px;color:${MUTED};font-family:${FONT};margin:0">Sent once, and only if no one opens the files within 2 business hours. The customer already has a confirmation.</p>`;

  const footer = `${COMMON_FOOTER}
    <p style="margin:8px 0 0 0;font-size:11px;color:${MUTED};font-family:${FONT}">You got this because you lead Customer Service.</p>`;

  return emailWrap(body, footer);
}

// ── Email 5: Daily upload summary ─────────────────────────────────────────────

function dailySummaryHtml(rows, dateStr, appUrl) {
  const total = rows.length;
  const totalFiles = rows.reduce((s, r) => s + r.fileCount, 0);
  const notOpened = rows.filter((r) => !r.opened).length;

  const statCell = (num, label, warn = false) =>
    `<td width="33%" style="padding:0 5px 0 0">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border:1px solid ${warn ? "#F0D9A6" : LINE};border-radius:10px;background-color:${warn ? "#FFF7E6" : "#ffffff"}" bgcolor="${warn ? "#FFF7E6" : "#ffffff"}">
      <tr><td style="padding:12px 14px">
        <div style="font-family:Georgia,serif;font-weight:700;font-size:30px;line-height:1;color:${warn ? "#B7791F" : NAVY}">${num}</div>
        <div style="font-size:12.5px;color:${MUTED};margin-top:6px;font-family:${FONT}">${label}</div>
      </td></tr>
      </table>
    </td>`;

  const tableRows = rows.map((r) => {
    const timeStr = new Date(r.completedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const pill = r.opened
      ? `<span style="font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;background-color:#F0F8EA;color:#4E8A2A;font-family:${FONT}" bgcolor="#F0F8EA">Opened</span>`
      : `<span style="font-size:11px;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid #F0D9A6;background-color:#FFF7E6;color:#B7791F;font-family:${FONT}" bgcolor="#FFF7E6">Not opened</span>`;
    const rowBg = r.opened ? "#ffffff" : "#FFF7E6";
    return `<tr bgcolor="${rowBg}" style="background-color:${rowBg}">
      <td style="padding:9px 6px;border-bottom:1px solid ${LINE};color:${MUTED};white-space:nowrap;font-size:12.5px;font-family:${FONT}">${escapeHtml(timeStr)}</td>
      <td style="padding:9px 6px;border-bottom:1px solid ${LINE};font-weight:600;font-size:12.5px;font-family:${FONT}">${escapeHtml(r.company || "")}</td>
      <td style="padding:9px 6px;border-bottom:1px solid ${LINE};font-size:12.5px;font-family:${FONT}">${r.id ? `<a href="${escapeHtml(`${appUrl}/transfer/${r.id}`)}" style="color:${NAVY};font-weight:600;text-decoration:none">${escapeHtml(r.title || "Open transfer")}</a>` : escapeHtml(r.title || "")}</td>
      <td style="padding:9px 6px;border-bottom:1px solid ${LINE};text-align:center;font-size:12.5px;font-family:${FONT}">${r.fileCount}</td>
      <td style="padding:9px 6px;border-bottom:1px solid ${LINE};font-size:12.5px;font-family:${FONT}">${escapeHtml(r.contactName || "")}</td>
      <td style="padding:9px 6px;border-bottom:1px solid ${LINE}">${pill}</td>
    </tr>`;
  }).join("");

  const th = `text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};padding:6px;border-bottom:1px solid ${LINE};font-family:${FONT}`;

  const body = `
    <h1 style="font-family:Georgia,serif;font-weight:700;color:${NAVY};font-size:24px;line-height:1.15;margin:0 0 4px 0">Today's file uploads</h1>
    <p style="font-size:13px;color:${MUTED};margin:0 0 18px 0;font-family:${FONT}">${escapeHtml(dateStr)}</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 20px 0">
    <tr>
      ${statCell(total, "Sends")}
      ${statCell(totalFiles, "Files")}
      ${statCell(notOpened, "Not opened", notOpened > 0)}
    </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-size:12.5px;margin:0 0 20px 0">
      <thead><tr>
        <th style="${th}">Time</th>
        <th style="${th}">Customer</th>
        <th style="${th}">Job</th>
        <th style="${th};text-align:center">Files</th>
        <th style="${th}">Contact</th>
        <th style="${th}">Status</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>

    ${btnNavy(dashboardUploadsUrl(appUrl), "See all uploads")}
    <p style="font-size:12.5px;color:${MUTED};margin:12px 0 0 0;font-family:${FONT}">Optional. Turn it off, or change who gets it, in settings.</p>`;

  const footer = `${COMMON_FOOTER}
    <p style="margin:8px 0 0 0;font-size:11px;color:${MUTED};font-family:${FONT}">Sent at 5:00 PM on weekdays to the people on the summary list.</p>`;

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
  const parsed = parseMessage(transfer.message);
  const contactName = parsed.name
    || (contactEmail ? contactEmail.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "the Aspen team");
  const proof = isProofTransfer(transfer);

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
  const employeeName = parsed.name || transfer.sender_email || "Signature Aspen";

  if (proof) {
    for (const recipient of recipientEmails.filter(Boolean)) {
      const kind = reminder ? "proof-reminder" : "proof-customer";
      const key = `${kind}-${hashToken(recipient).slice(0, 32)}`;
      if (results[key] === "sent") continue;
      try {
        const subject = reminder
          ? `Reminder: your design proof expires soon${transfer.title ? ` — ${transfer.title}` : ""}`
          : `Your design proof is ready${transfer.title ? ` — ${transfer.title}` : ""}`;
        const html = proofHtml(transfer, files, receipt, employeeName);
        const text = `${employeeName} at Signature Aspen sent a design proof.\n\nJob: ${transfer.title || ""}\n${files.map((f) => `- ${f.name} (${fmtSize(Number(f.size))})`).join("\n")}\n\nOpen your proof: ${publicUrl(transfer.id)}`;
        await sendOne(recipient, subject, html, text, transfer.sender_email || undefined);
        results[key] = "sent";
        await client.query("UPDATE transfers SET email_results = $2::jsonb WHERE id = $1", [transfer.id, JSON.stringify(results)]);
      } catch {
        success = false;
        console.error("Design proof email failed.");
      }
    }
    if (!reminder && transfer.sender_email) {
      const key = `proof-sender-${hashToken(transfer.sender_email).slice(0, 32)}`;
      if (results[key] !== "sent") {
        try {
          const subject = `Proof sent${transfer.title ? ` — ${transfer.title}` : ""}`;
          const html = internalHtml(transfer, files, receipt, employeeName);
          const text = `You sent a design proof to ${recipientEmails.join(", ")}.\n\nView: ${publicUrl(transfer.id)}`;
          await sendOne(transfer.sender_email, subject, html, text);
          results[key] = "sent";
          await client.query("UPDATE transfers SET email_results = $2::jsonb WHERE id = $1", [transfer.id, JSON.stringify(results)]);
        } catch {
          success = false;
          console.error("Design proof confirmation email failed.");
        }
      }
    }
  } else {
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
  const uploadUrl = uploadRequestUrl(contact, job, settings.appUrl);
  const html = uploadRequestHtml(contact, customer, job, settings.appUrl);
  const text = `Hi ${customer.firstName || customer.name || "there"},\n\n${job.message || ""}\n\nSend your files: ${uploadUrl}\n\nLink active until ${job.expiresAt ? new Date(job.expiresAt).toLocaleDateString() : ""}`;
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
    return { id: r.id, company: r.company, title: r.title, completedAt: r.completed_at, fileCount: r.file_count, contactName, opened: r.opened };
  });

  const totalFiles = summaryRows.reduce((s, r) => s + r.fileCount, 0);
  const dateStr = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const subject = `Today's file uploads: ${summaryRows.length} send${summaryRows.length !== 1 ? "s" : ""}, ${totalFiles} file${totalFiles !== 1 ? "s" : ""}`;
  const html = dailySummaryHtml(summaryRows, dateStr, settings.appUrl);
  const text = `Today's uploads: ${summaryRows.length} sends, ${totalFiles} files.\n\n${summaryRows.map((r) => `${r.company} — ${r.title} (${r.fileCount} files, ${r.opened ? "opened" : "NOT OPENED"})\n${publicUrl(r.id)}`).join("\n\n")}\n\nSee all uploads: ${dashboardUploadsUrl(settings.appUrl)}`;

  let sent = 0;
  for (const to of settings.summaryEmails) {
    try { await sendOne(to, subject, html, text); sent++; }
    catch { console.error("Daily summary email failed."); }
  }
  return sent > 0 ? "sent" : "failed";
}

// ── Send share link email ─────────────────────────────────────────────────────

export async function sendShareLink({ toEmail, senderName, senderEmail, transferUrl, message, company, title }) {
  const subject = `Your files from Signature Aspen${company ? ` — ${company}` : ""}`;
  const msgHtml = escapeHtml(message || "").replace(/\n/g, "<br>");

  const body = `
    ${msgHtml ? `<p style="font-size:15px;line-height:1.6;color:#1A1A1A;margin:0 0 22px 0;white-space:pre-wrap">${msgHtml}</p>` : ""}
    ${btnNavy(transferUrl, "View and download files")}
    <p style="font-size:13px;color:#5F6B7A;margin:14px 0 0">Questions? Reply to this email and ${escapeHtml(senderName || "your Aspen contact")} will get back to you.</p>`;

  const footer = `${COMMON_FOOTER}
    <p class="why">Sent to you by ${escapeHtml(senderName || "Signature Aspen")}.</p>`;

  const html = emailWrap(body, footer);
  const text = `${message || ""}\n\nView and download files: ${transferUrl}\n\nQuestions? Reply to this email.`;

  await sendOne(toEmail, subject, html, text, senderEmail || undefined);
}
