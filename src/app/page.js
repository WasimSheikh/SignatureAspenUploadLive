import Workspace from "@/components/Workspace";
import { currentEmployee } from "@/lib/current-employee";

export const dynamic = "force-dynamic";

export default async function Home() {
  const employee = await currentEmployee();
  return (
    <main>
      <Workspace employee={employee} />
      <footer>713.830.9500 · 3300 Kingswood St, Houston TX 77092 · Private links · Direct-to-cloud uploads · Automatic expiration</footer>
    </main>
  );
}
