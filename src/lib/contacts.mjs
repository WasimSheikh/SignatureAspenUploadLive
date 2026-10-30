import { fail } from "./security.mjs";

export const CONTACTS = [
  { id: "lmelchor",   email: "lmelchor@signatureaspen.com" },
  { id: "jturner",    email: "jturner@signatureaspen.com" },
  { id: "jseiford",   email: "jseiford@signatureaspen.com" },
  { id: "ccarroll",   email: "ccarroll@signatureaspen.com" },
  { id: "gemmott",    email: "gemmott@signatureaspen.com" },
  { id: "akliafas",   email: "akliafas@signatureaspen.com" },
  { id: "msimpson",   email: "msimpson@signatureaspen.com" },
  { id: "jleon",      email: "JLeon@signatureaspen.com" },
  { id: "kdasilva",   email: "kdasilva@signatureaspen.com" },
  { id: "ihoover",    email: "ihoover@signatureaspen.com" },
  { id: "marmstrong", email: "marmstrong@signatureaspen.com" },
  { id: "bhaak",      email: "bhaak@signatureaspen.com" },
  { id: "dcotlow",    email: "dcotlow@signatureaspen.com" },
  { id: "storres",    email: "storres@signatureaspen.com" },
];

export const SALES_EMAIL = "sales@signatureaspen.com";

export function resolveContactEmail(id) {
  if (id === "other") return SALES_EMAIL;
  const contact = CONTACTS.find((c) => c.id === id);
  if (!contact) fail(400, "Invalid contact.");
  return contact.email;
}
