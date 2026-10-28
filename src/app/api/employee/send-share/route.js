import { employeeEndpoint, requireEmployee, employeeOrigin } from "@/lib/employee-auth";
import { json, readJson } from "@/lib/http";
import { requireEmployeeTransfer } from "@/lib/employee-auth";
import { escapeHtml } from "@/lib/security.mjs";
import { config } from "@/lib/config";

async function sendGraphEmail(to, subject, html, replyTo) {
  const { DefaultAzureCredential } = await import("@azure/identity");
  const sender = process.env.GRAPH_SENDER_EMAIL;
  if (!sender) throw new Error("GRAPH_SENDER_EMAIL not configured");
  const cred = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined });
  const token = (await cred.getToken("https://graph.microsoft.com/.default")).token;
  const msg = {
    subject,
    body: { contentType: "HTML", content: html },
    from: { emailAddress: { name: "Signature Aspen Files", address: sender } },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (replyTo) msg.replyTo = [{ emailAddress: { address: replyTo } }];
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg, saveToSentItems: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Graph API ${r.status}: ${err?.error?.message || "send failed"}`);
  }
}

export const POST = employeeEndpoint(async (request) => {
  employeeOrigin(request);
  const employee = await requireEmployee(request);
  const { transferId, toEmail, message } = await readJson(request);

  if (!transferId || !toEmail) return json({ error: "transferId and toEmail are required." }, 400);

  const { transfer } = await requireEmployeeTransfer(request, transferId);
  const cfg = config();
  const url = `${cfg.appUrl}/transfer/${transfer.id}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:20px;font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1A1A1A;background:#F5F7FA">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #E2E7EE;border-radius:6px;overflow:hidden">
  <div style="padding:20px 32px 16px;border-bottom:1px solid #E2E7EE;border-top:4px solid #77C045">
    <img src="https://signatureaspen.com/wp-content/uploads/2023/09/logo2.png" alt="Signature Aspen" height="44" style="display:block;max-width:200px" referrerpolicy="no-referrer">
  </div>
  <div style="padding:28px 32px">
    <p style="white-space:pre-wrap;font-size:15px;line-height:1.6;color:#1A1A1A;margin:0 0 24px">${escapeHtml(message || "")}</p>
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>
      <td style="background-color:#0E3760;border-radius:8px" bgcolor="#0E3760">
        <a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 24px;border-radius:8px;background-color:#0E3760;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;font-family:Arial,sans-serif"><font color="#ffffff">View and download files</font></a>
      </td>
    </tr></table>
    <p style="font-size:12px;color:#5F6B7A;margin:0">Questions? Reply to this email and ${escapeHtml(employee.name || "your Aspen contact")} will get back to you.</p>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #E2E7EE;background:#FAFBFD;text-align:center;font-size:12px;color:#5F6B7A;font-family:Arial,sans-serif">
    <p style="margin:0"><strong style="color:#0E3760">Signature Aspen</strong> &middot; the IMAGE communications company</p>
    <p style="margin:4px 0 0">3300 Kingswood St, Houston, Texas 77092 &middot; 713.830.9500</p>
  </div>
</div></body></html>`;

  try {
    await sendGraphEmail(toEmail, `Your files from Signature Aspen — ${transfer.company || transfer.title || ""}`.trim().replace(/—\s*$/, ""), html, employee.email || undefined);
  } catch {
    console.error("send-share email failed");
    // Don't fail the request — the link is still valid
  }

  return json({ sent: true });
});
