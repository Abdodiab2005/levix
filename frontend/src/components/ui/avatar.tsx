import { useState } from "react";

/** A fixed-size image with a local name initial when no picture is available. */
export function Avatar({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative inline-flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-blue/10 text-lg font-bold text-brand-cyan">
      <span aria-hidden>{Array.from(name)[0]?.toUpperCase()}</span>
      {!failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
