import { useEffect, useRef, useState } from "react";

export function useSelection(ids: string[], resetKey?: unknown) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const prevResetKey = useRef(resetKey);

  useEffect(() => {
    if (prevResetKey.current !== resetKey) {
      prevResetKey.current = resetKey;
      setSelected(new Set());
      anchor.current = null;
    }
  }, [resetKey]);

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

  const selectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (id) next.add(id);
      }
      return next;
    });
  };

  const clear = () => {
    anchor.current = null;
    setSelected(new Set());
  };

  return { selected, toggle, selectAll, clear };
}
