import Dashboard from "@/components/Dashboard";
import { currentEmployee } from "@/lib/current-employee";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const employee = await currentEmployee();
  return (
    <main>
      <Dashboard employee={employee} />
      <footer>713.830.9500 · 3300 Kingswood St, Houston TX 77092 · Private links · Direct-to-cloud uploads · Automatic expiration</footer>
    </main>
  );
}
