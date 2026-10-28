import Workspace from "@/components/Workspace";
import SiteFooter from "@/components/SiteFooter";
import { currentEmployee } from "@/lib/current-employee";

export const dynamic = "force-dynamic";

export default async function Home() {
  const employee = await currentEmployee();
  return (
    <main>
      <Workspace employee={employee} />
      <SiteFooter />
    </main>
  );
}
