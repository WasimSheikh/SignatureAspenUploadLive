import { employeeEndpoint, requireEmployee, employeeOrigin } from "@/lib/employee-auth";
import { json, readJson } from "@/lib/http";
import { requireEmployeeTransfer } from "@/lib/employee-auth";
import { sendShareLink, publicUrl } from "@/lib/email";

export const POST = employeeEndpoint(async (request) => {
  employeeOrigin(request);
  const employee = await requireEmployee(request);
  const { transferId, toEmail, message } = await readJson(request);

  if (!transferId || !toEmail) return json({ error: "transferId and toEmail are required." }, 400);

  const { transfer } = await requireEmployeeTransfer(request, transferId);
  const transferUrl = publicUrl(transfer.id);

  try {
    await sendShareLink({
      toEmail,
      senderName: employee.name || "Signature Aspen",
      senderEmail: employee.email || undefined,
      transferUrl,
      message,
      company: transfer.company,
      title: transfer.title,
    });
  } catch (err) {
    console.error("send-share email failed.", err?.message?.slice(0, 100));
    return json({ error: "Email could not be sent. The link is still valid — you can copy and share it manually." }, 500);
  }

  return json({ sent: true });
});
