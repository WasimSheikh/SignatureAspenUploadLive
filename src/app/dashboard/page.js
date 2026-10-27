import Dashboard from "@/components/Dashboard";
import { currentEmployee } from "@/lib/current-employee";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }) {
  const employee = await currentEmployee();
  const params = await searchParams;
  return (
    <main>
      <Dashboard employee={employee} initialTab={params?.tab} />
      <footer>713.830.9500 · 3300 Kingswood St, Houston TX 77092 · Private links · Direct-to-cloud uploads · Automatic expiration</footer>
    </main>
  );
}
