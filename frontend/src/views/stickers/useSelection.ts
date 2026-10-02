import { useEffect, useRef, useState } from "react";

export function useSelection(ids: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const idsKey = ids.join("\n");

  useEffect(() => {
    const known = new Set(idsKey ? idsKey.split("\n") : []);
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (known.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [idsKey]);

  const toggle = (index: number, shift: boolean) => {
    const id = ids[index];
    if (!id) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor.current != null) {
        const start = Math.min(anchor.current, index);
        const end = Math.max(anchor.current, index);
        for (let i = start; i <= end; i++) {
          const rangeId = ids[i];
          if (rangeId) next.add(rangeId);
        }
        return next;
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = index;
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(ids));
  const clear = () => {
    anchor.current = null;
    setSelected(new Set());
  };

  return { selected, toggle, selectAll, clear };
}
