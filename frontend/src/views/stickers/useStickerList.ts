import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { explainError } from "../../utils/stickerErrors";

export const STUDIO_PAGE_SIZE = 24;

export type StickerSort = "newest" | "oldest" | "name" | "recent";
export type StickerFilter = "all" | "favorites" | "recent" | "animated" | "static";

export function useStickerList(preset: StickerFilter) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<StickerSort>(preset === "recent" ? "recent" : "newest");
  const [filter, setFilter] = useState<StickerFilter>(preset);
  const [pack, setPack] = useState("");
  const [page, setPageState] = useState(1);
  const [items, setItems] = useState<Sticker[]>([]);
  const [total, setTotal] = useState(0);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    setFilter(preset);
  }, [preset]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const loadPacks = useCallback(() => {
    api
      .getPacks()
      .then((res) => setPacks(res.packs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadPacks();
  }, [loadPacks]);

  const load = useCallback(
    async (targetPage: number) => {
      const ticket = ++seq.current;
      setLoading(true);
      setError(null);
      const offset = Math.max(0, (targetPage - 1) * STUDIO_PAGE_SIZE);
      try {
        const res = await api.getStickers({
          q: debounced || undefined,
          sort,
          filter,
          pack: pack || undefined,
          offset,
          limit: STUDIO_PAGE_SIZE,
        });
        if (ticket !== seq.current) return;
        const newTotal = res.total;
        const newPageCount = Math.max(1, Math.ceil(newTotal / STUDIO_PAGE_SIZE));
        if (targetPage > newPageCount) {
          setPageState(newPageCount);
          return;
        }
        setItems(res.items);
        setTotal(newTotal);
      } catch (err) {
        if (ticket !== seq.current) return;
        const message = explainError(t, err);
        setError(message);
        toast(message, "error");
      } finally {
        if (ticket === seq.current) {
          setLoading(false);
        }
      }
    },
    [debounced, sort, filter, pack, t, toast],
  );

  const filterKey = `${debounced}|${filter}|${sort}|${pack}`;
  const prevFilterKey = useRef(filterKey);

  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey;
      if (page !== 1) {
        setPageState(1);
        return;
      }
    }
    void load(page);
  }, [filterKey, page, load]);

  const reload = useCallback(() => {
    loadPacks();
    void load(page);
  }, [load, loadPacks, page]);

  const setPage = useCallback((nextPage: number) => {
    setPageState(Math.max(1, Math.floor(nextPage) || 1));
  }, []);

  return {
    q,
    setQ,
    sort,
    setSort,
    filter,
    setFilter,
    pack,
    setPack,
    page,
    setPage,
    pageCount: Math.max(1, Math.ceil(total / STUDIO_PAGE_SIZE)),
    pageSize: STUDIO_PAGE_SIZE,
    items,
    total,
    packs,
    loading,
    error,
    reload,
    loadPacks,
    lockedFilter: preset !== "all",
  };
}
