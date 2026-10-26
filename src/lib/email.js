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

// ── Main send function ────────────────────────────────────────────────────────

export async function sendTransferEmails(client, transfer, reminder = false) {
  const settings = config();
  const files = await getFiles(client, transfer.id);
  const results = { ...transfer.email_results };
  const receipt = receiptNum(transfer.id);

  // Derive contact name from recipient email list
  const recipientEmails = Array.isArray(transfer.recipient_emails) ? transfer.recipient_emails : JSON.parse(transfer.recipient_emails || "[]");
  const contactEmail = recipientEmails[0] || settings.internalEmails[0] || "";
  // Try to get a friendly name from the email local part
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
