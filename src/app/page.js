import Brand from "@/components/Brand";
import Workspace from "@/components/Workspace";

export default function Home() {
  return (
    <main>
      <header><Brand /></header>
      <Workspace />
      <footer>Private links · Direct-to-cloud uploads · Automatic expiration</footer>
    </main>
  );
}
