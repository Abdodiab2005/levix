import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";
import { IconButton } from "./button";

export interface PaginationProps {
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
  label?: string;
  className?: string;
}

export function Pagination({
  page,
  pageCount,
  total,
  onPageChange,
  label,
  className,
}: PaginationProps) {
  const { t, direction } = useI18n();
  const safeCount = Math.max(1, pageCount);
  const safePage = Math.min(Math.max(1, page), safeCount);
  const previous = direction === "rtl" ? <ChevronRight size={18} /> : <ChevronLeft size={18} />;
  const next = direction === "rtl" ? <ChevronLeft size={18} /> : <ChevronRight size={18} />;
  return (
    <nav
      aria-label={label ?? t("pagination")}
      className={cn("flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm", className)}
    >
      <span className="text-muted tabular-nums">
        {t("resultCount").replace("{n}", String(total))}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <IconButton
            label={t("previousPage")}
            icon={previous}
            disabled={safePage <= 1}
            onClick={() => onPageChange(safePage - 1)}
          />
          <span className="min-w-0 px-1 text-center text-xs font-medium text-text-main tabular-nums sm:text-sm">
            {t("pageOf").replace("{page}", String(safePage)).replace("{count}", String(safeCount))}
          </span>
          <IconButton
            label={t("nextPage")}
            icon={next}
            disabled={safePage >= safeCount}
            onClick={() => onPageChange(safePage + 1)}
          />
        </div>
      )}
    </nav>
  );
}

/** Pass already filtered and sorted items. A changed resetKey returns to page 1. */
export function usePagination<T>(items: T[], pageSize = 20, resetKey?: unknown) {
  const size = Math.max(1, Math.floor(pageSize) || 20);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const [state, setState] = useState({ page: 1, resetKey });
  const page = Object.is(state.resetKey, resetKey) ? Math.min(state.page, pageCount) : 1;

  useEffect(() => {
    if (!Object.is(state.resetKey, resetKey) || state.page !== page) {
      setState({ page, resetKey });
    }
  }, [page, resetKey, state]);

  const setPage = (next: number) => {
    setState({ page: Math.min(Math.max(1, Math.floor(next) || 1), pageCount), resetKey });
  };

  return {
    page,
    pageCount,
    pageItems: items.slice((page - 1) * size, page * size),
    setPage,
    total,
  };
}
