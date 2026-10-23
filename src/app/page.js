import Uploader from "@/components/Uploader";

export default function Home() {
  return (
    <main>
      <header><a href="/" className="brand">Design Delivery<span>Large files. Simple delivery.</span></a></header>
      <section className="intro">
        <p className="eyebrow">FROM YOUR STUDIO TO OUR TEAM</p>
        <h1>Big ideas deserve<br />a simple send.</h1>
        <p>Share your design assets without creating an account.<br />Upload, copy your private link, and get back to creating.</p>
      </section>
      <Uploader />
      <footer>Private links · Direct-to-cloud uploads · Automatic expiration</footer>
    </main>
  );
}
