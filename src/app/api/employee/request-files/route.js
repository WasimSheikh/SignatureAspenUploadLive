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

  // Reply-To is the employee who is sending the request (their own email),
  // falling back to the contact email if the employee has no email on record.
  const replyToEmail = employee.email || contactEmail;

  let emailSent = true;
  try {
    await sendUploadRequest({
      contact: {
        id: contactId || "other",
        name: contactName || employee.name || "Aspen Team",
        role: contactRole || "Account Manager",
        email: replyToEmail,
      },
      customer: {
        email: customerEmail,
        name: customerName || "",
        firstName: (customerName || "").trim().split(/\s+/)[0] || "",
      },
      job: { number: jobNumber || "", title: jobTitle, company: company || "", message: message || "", expiresAt },
    });
  } catch {
    emailSent = false;
    console.error("Upload request email failed — email service may not be configured locally.");
  }

  return json({ sent: true, emailSent });
});
