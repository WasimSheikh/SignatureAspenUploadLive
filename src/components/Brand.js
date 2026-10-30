"use client";

import { useState } from "react";

export default function Brand() {
  const [failed, setFailed] = useState(false);
  return (
    <a href="/" className="brand" aria-label="Signature Aspen file delivery home">
      {!failed && <img
        src="/logo.svg"
        alt="Signature Aspen"
        onError={() => setFailed(true)}
        className="brand-logo"
      />}
      {failed && <strong className="brand-fallback">SIGNATURE <span>ASPEN</span></strong>}
      <span className="brand-caption">DESIGN FILE DELIVERY</span>
    </a>
  );
}
