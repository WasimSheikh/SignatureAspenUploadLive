import { cookies } from "next/headers";
import { readEmployeeSession } from "./employee-auth.js";
import { SESSION_COOKIE } from "./employee-security.mjs";

export async function currentEmployee() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const request = new Request("https://employee.local/", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  try {
    const employee = await readEmployeeSession(request);
    if (!employee) return null;
    return { id: employee.id, name: employee.name, email: employee.email, admin: employee.admin === true };
  } catch {
    return null;
  }
}
