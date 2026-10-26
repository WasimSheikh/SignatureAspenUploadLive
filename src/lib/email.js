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

async function sendOne(to, subject, html, text) {
  const sender = process.env.GRAPH_SENDER_EMAIL;
  if (!sender) throw new Error("GRAPH_SENDER_EMAIL is not configured");
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          from: { emailAddress: { name: "Signature Aspen", address: sender } },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Graph API ${response.status}: ${err?.error?.message || "send failed"}`);
  }
}

export async function sendTransferEmails(client, transfer, reminder = false) {
  const settings = config();
  const kind = reminder ? "reminder" : "delivery";
  const recipients = [...new Set([
    transfer.sender_email, ...transfer.recipient_emails, ...settings.internalEmails,
  ])];
  const files = await getFiles(client, transfer.id);
  const inventoryHtml = `<h2>Files (${files.length})</h2><ul>${files.map((f) =>
    `<li>${escapeHtml(f.name)} — ${Number(f.size).toLocaleString("en-US")} bytes</li>`).join("")}</ul>`;
  const inventoryText = `Files (${files.length}):\n${files.map((f) =>
    `- ${f.name} — ${Number(f.size).toLocaleString("en-US")} bytes`).join("\n")}`;
  const results = { ...transfer.email_results };

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
  for (const recipient of recipients) {
    const key = `${kind}-${hashToken(recipient).slice(0, 32)}`;
    if (results[key] === "sent") continue;
    try {
      const url = publicUrl(transfer.id);
      const subject = reminder ? "Your design transfer expires soon" : "Your design files are ready";
      const html = `<h1>${escapeHtml(transfer.title)}</h1>
        ${transfer.company ? `<p>${escapeHtml(transfer.company)}</p>` : ""}
        <p>From: ${escapeHtml(transfer.sender_email)}</p>
        ${transfer.message ? `<p>${escapeHtml(transfer.message).replace(/\n/g, "<br>")}</p>` : ""}
        ${inventoryHtml}
        <p>${reminder ? "These files expire within 24 hours." : "Your design files are ready to download."}</p>
        <p><a href="${escapeHtml(url)}">View and download files</a></p>
        <p>Expires: ${escapeHtml(new Date(transfer.expires_at).toISOString())}</p>
        ${transfer.passcode_hash ? "<p>This transfer requires a passcode. Ask the sender for it separately.</p>" : ""}`;
      const text = `${transfer.title}\nFrom: ${transfer.sender_email}\n${transfer.company}\n${transfer.message}\n${inventoryText}\n${url}\nExpires: ${new Date(transfer.expires_at).toISOString()}${transfer.passcode_hash ? "\nAsk the sender for the passcode." : ""}`;
      await sendOne(recipient, subject, html, text);
      results[key] = "sent";
      await client.query("UPDATE transfers SET email_results = $2::jsonb WHERE id = $1", [transfer.id, JSON.stringify(results)]);
    } catch {
      success = false;
      console.error("Transfer email delivery failed.");
    }
  }

  if (reminder) {
    if (success) await client.query("UPDATE transfers SET reminder_sent_at = now() WHERE id = $1", [transfer.id]);
  } else {
    await client.query("UPDATE transfers SET email_status = $2 WHERE id = $1", [transfer.id, success ? "sent" : "failed"]);
  }
  return success ? "sent" : "failed";
}
