import Transfer from "@/components/Transfer";
import { Suspense } from "react";

async function TransferContent({ params }) {
  const { id } = await params;
  return <Transfer id={id} />;
}

export default function TransferPage({ params }) {
  return (
    <main>
      <header><a href="/" className="brand">Design Delivery<span>Large files. Simple delivery.</span></a></header>
      <Suspense fallback={<section className="card" role="status">Loading transfer…</section>}>
        <TransferContent params={params} />
      </Suspense>
      <footer>Download only files you trust. Links expire automatically.</footer>
    </main>
  );
}
