import { type ReactNode, useState } from "react";

/** A fixed-size image with a local name initial when no picture is available. */
export function Avatar({
  src,
  name,
  icon,
}: {
  src?: string | null;
  name: string;
  /** Shown when there is no name to take an initial from. */
  icon?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const initial = Array.from(name.trim())[0]?.toUpperCase();
  return (
    <span className="relative inline-flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-blue/10 text-lg font-bold text-brand-cyan">
      <span aria-hidden>{initial || icon}</span>
      {src && !failed && (
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
