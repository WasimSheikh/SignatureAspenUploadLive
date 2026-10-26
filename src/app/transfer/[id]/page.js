import Transfer from "@/components/Transfer";
import Brand from "@/components/Brand";
import { Suspense } from "react";

async function TransferContent({ params }) {
  const { id } = await params;
  return <Transfer id={id} />;
}

export default function TransferPage({ params }) {
  return (
    <main>
      <header className="slim-header">
        <Brand />
      </header>
      <Suspense fallback={<div className="card" style={{ marginTop: 28 }}><p role="status">Loading your files…</p></div>}>
        <TransferContent params={params} />
      </Suspense>
      <footer>Download only files you trust. Links expire automatically.</footer>
    </main>
  );
}
