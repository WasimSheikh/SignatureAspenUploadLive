import Dashboard from "@/components/Dashboard";
import SiteFooter from "@/components/SiteFooter";
import { currentEmployee } from "@/lib/current-employee";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }) {
  const employee = await currentEmployee();
  const params = await searchParams;
  return (
    <main>
      <Dashboard employee={employee} initialTab={params?.tab} />
      <SiteFooter />
    </main>
  );
}
