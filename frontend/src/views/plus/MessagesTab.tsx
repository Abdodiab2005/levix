// file: frontend/src/views/plus/MessagesTab.tsx
import { MessageSquareHeart, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FilterButton,
  IconButton,
  Input,
  LoadingState,
  Pagination,
  Select,
  Toolbar,
  UserText,
  usePagination,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import { plusErrorCode, plusErrorKey, plusGet } from "./plusApi";
import { TemplateEditor } from "./TemplateEditor";
import {
  type PlusLocale,
  type PlusTemplateKey,
  type PlusTemplatesResponse,
  isPlusLocale,
} from "./types";

function areaOf(key: string): string {
  const parts = key.split(".");
  return parts.length > 2 ? parts.slice(0, 2).join(".") : parts[0];
}

export function MessagesTab({ onInactive }: { onInactive: () => void }) {
  const { t, language } = useI18n();
  const panelLocale: PlusLocale = isPlusLocale(language) ? language : "en";
  const [data, setData] = useState<PlusTemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [area, setArea] = useState("all");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    plusGet<PlusTemplatesResponse>("/templates")
      .then((result) => {
        if (!live) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (!live) return;
        const code = plusErrorCode(err);
        if (code === "inactive") onInactive();
        setError(t(plusErrorKey(code)));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloadToken, onInactive, t]);

  const keys = data?.keys ?? [];
  const areas = useMemo(() => {
    const found = new Set<string>();
    for (const item of keys) found.add(areaOf(item.key));
    return [...found].sort((a, b) => a.localeCompare(b));
  }, [keys]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return keys.filter((item) => {
      if (area !== "all" && areaOf(item.key) !== area) return false;
      if (!needle) return true;
      const catalogText = item.catalog[panelLocale] ?? item.catalog.en ?? "";
      return item.key.toLowerCase().includes(needle) || catalogText.toLowerCase().includes(needle);
    });
  }, [keys, area, search, panelLocale]);

  const { page, pageCount, pageItems, setPage, total } = usePagination(
    filtered,
    20,
    `${search}|${area}`,
  );
  const editingItem: PlusTemplateKey | null = editingKey
    ? (keys.find((item) => item.key === editingKey) ?? null)
    : null;

  const reload = () => setReloadToken((value) => value + 1);
  const saveOutcome = () => reload();

  if (loading && !data) return <LoadingState text={t("loading")} />;
  if (error && !data) {
    return (
      <EmptyState
        kind="error"
        icon={<MessageSquareHeart size={28} />}
        description={error}
        action={
          <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={reload}>
            {t("retry")}
          </Button>
        }
      />
    );
  }

  return (
    <Card padded={false} className="flex flex-col">
      <div className="flex flex-col gap-3 border-b border-line p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-text-main">{t("plusTabMessages")}</p>
          {data && (
            <p className="text-xs text-muted tabular-nums">
              {fill(t("plusMessagesUsed"), { used: data.used, limit: data.limit })}
            </p>
          )}
        </div>
        <Toolbar>
          <Input
            type="search"
            value={search}
            placeholder={t("plusMessagesSearch")}
            aria-label={t("plusMessagesSearch")}
            className="min-w-48 flex-1"
            onChange={(event) => setSearch(event.target.value)}
          />
          <FilterButton
            label={t("filter")}
            resetLabel={t("reset")}
            activeCount={area === "all" ? 0 : 1}
            onReset={() => setArea("all")}
          >
            <Select
              aria-label={t("plusMessagesArea")}
              value={area}
              onChange={(event) => setArea(event.target.value)}
            >
              <option value="all">{t("plusMessagesAreaAll")}</option>
              {areas.map((name) => (
                <option key={name} value={name} dir="auto">
                  {name}
                </option>
              ))}
            </Select>
          </FilterButton>
        </Toolbar>
      </div>

      {error && (
        <p role="alert" className="border-b border-line p-4 text-sm text-danger">
          {error}
        </p>
      )}

      {total === 0 ? (
        <EmptyState kind="no-results" title={t("plusMessagesNoResults")} />
      ) : (
        <ul className="divide-y divide-line">
          {pageItems.map((item) => (
            <li key={item.key} className="flex items-start gap-3 p-3 sm:p-4">
              <div className="min-w-0 flex-1">
                <UserText as="p" lines={2} className="text-sm text-text-main">
                  {item.catalog[panelLocale] ?? item.catalog.en ?? item.key}
                </UserText>
                <p dir="ltr" className="mt-0.5 truncate font-mono text-xs text-faint">
                  {item.key}
                </p>
              </div>
              {item.override && <Badge tone="info">{t("plusMessagesEdited")}</Badge>}
              <IconButton
                label={t("plusMessagesEdit")}
                icon={<Pencil size={16} />}
                onClick={() => setEditingKey(item.key)}
              />
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <div className="border-t border-line p-3">
          <Pagination
            page={page}
            pageCount={pageCount}
            total={total}
            onPageChange={setPage}
            label={t("plusTabMessages")}
          />
        </div>
      )}

      <TemplateEditor
        open={editingKey !== null}
        item={editingItem}
        onClose={() => setEditingKey(null)}
        onSaved={saveOutcome}
        onRefresh={reload}
        onInactive={onInactive}
      />
    </Card>
  );
}
