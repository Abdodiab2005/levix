import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "./button";
import { Card } from "./card";

/** A compact card whose detail region opens without moving keyboard focus. */
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Card padded={false} className="min-w-0 self-start overflow-hidden">
      <Button
        variant="ghost"
        className="h-auto w-full justify-between gap-3 p-4 text-start"
        aria-expanded={open}
        aria-controls={id}
        id={`${id}-trigger`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown
          size={18}
          aria-hidden
          className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </Button>
      <section
        id={id}
        aria-labelledby={`${id}-trigger`}
        aria-hidden={!open}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-line p-4">{children}</div>
        </div>
      </section>
    </Card>
  );
}
