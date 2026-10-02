import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { explainError } from "../../utils/stickerErrors";
import { PAGE_SIZE } from "../../utils/stickerLimits";

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
  const [items, setItems] = useState<Sticker[]>([]);
  const [total, setTotal] = useState(0);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

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
    async (offset: number, append: boolean) => {
      const ticket = ++seq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.getStickers({
          q: debounced || undefined,
          sort,
          filter,
          pack: pack || undefined,
          offset,
          limit: PAGE_SIZE,
        });
        if (ticket !== seq.current) return;
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setTotal(res.total);
      } catch (err) {
        if (ticket !== seq.current) return;
        const message = explainError(t, err);
        setError(message);
        toast(message, "error");
      } finally {
        if (ticket === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [debounced, sort, filter, pack, t, toast],
  );

  useEffect(() => {
    void load(0, false);
  }, [load]);

  const reload = useCallback(() => {
    loadPacks();
    void load(0, false);
  }, [load, loadPacks]);

  const loadMore = useCallback(() => {
    if (loadingMore || items.length >= total) return;
    void load(items.length, true);
  }, [items.length, load, loadingMore, total]);

  return {
    q,
    setQ,
    sort,
    setSort,
    filter,
    setFilter,
    pack,
    setPack,
    items,
    total,
    packs,
    loading,
    loadingMore,
    error,
    hasMore: items.length < total,
    reload,
    loadMore,
    loadPacks,
    lockedFilter: preset !== "all",
  };
}
