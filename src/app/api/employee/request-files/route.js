import { employeeEndpoint, requireEmployee, employeeOrigin } from "@/lib/employee-auth";
import { json, readJson } from "@/lib/http";
import { sendUploadRequest } from "@/lib/email";
import { config } from "@/lib/config";

export const POST = employeeEndpoint(async (request) => {
  employeeOrigin(request);
  const employee = await requireEmployee(request);
  const { customerEmail, customerName, company, jobNumber, jobTitle, message,
    contactId, contactName, contactRole, contactEmail } = await readJson(request);

  if (!customerEmail || !jobTitle || !contactEmail) {
    return json({ error: "customerEmail, jobTitle, and contactEmail are required." }, 400);
  }

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await sendUploadRequest({
    contact: {
      id: contactId || "other",
      name: contactName || employee.name || "Aspen Team",
      role: contactRole || "Account Manager",
      email: contactEmail,
    },
    customer: {
      email: customerEmail,
      name: customerName || "",
      firstName: (customerName || "").trim().split(/\s+/)[0] || "",
    },
    job: { number: jobNumber || "", title: jobTitle, company: company || "", message: message || "", expiresAt },
  });

  return json({ sent: true });
});
