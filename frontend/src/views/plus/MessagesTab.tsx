// file: frontend/src/views/plus/MessagesTab.tsx
import { ChevronDown, MessageSquareHeart, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CodeText,
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
import {
  areaLabelKey,
  templateArea,
  templateCommand,
  templateIsLong,
} from "../../utils/templateLabels";
import { plusErrorCode, plusErrorMessage, plusGet } from "./plusApi";
import { TemplateBody, TemplateEditor } from "./TemplateEditor";
import {
  type PlusLocale,
  type PlusTemplateKey,
  type PlusTemplatesResponse,
  isPlusLocale,
} from "./types";

function filled(value: string | undefined): string {
  const text = value ?? "";
  return text.trim() ? text : "";
}

/** Panel language, then English. A saved override wins over the shipped catalog. */
function visibleTemplateText(item: PlusTemplateKey, locale: PlusLocale): string {
  const values = item.override?.values;
  const source = item.override?.source;
  const overrideText = (loc: PlusLocale) =>
    filled(values?.[loc]) || (source?.locale === loc ? filled(source.text) : "");
  return (
    overrideText(locale) ||
    filled(item.catalog[locale]) ||
    (locale === "en" ? "" : overrideText("en")) ||
    filled(item.catalog.en)
  );
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

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
        setError(plusErrorMessage(t, err));
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
    for (const item of keys) {
      const name = templateArea(item.key);
      if (name) found.add(name);
    }
    return [...found];
  }, [keys]);

  const areaOptions = useMemo(
    () =>
      areas
        .map((id) => ({ id, label: t(areaLabelKey(id)) }))
        .sort((a, b) => a.label.localeCompare(b.label, language)),
    [areas, language, t],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return keys.filter((item) => {
      if (area !== "all" && templateArea(item.key) !== area) return false;
      if (!needle) return true;
      const preview = [
        ...Object.values(item.catalog),
        ...Object.values(item.override?.values ?? {}),
        item.override?.source?.text,
      ]
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .toLowerCase();
      const command = templateCommand(item.key) ?? "";
      const areaName = t(areaLabelKey(item.key)).toLowerCase();
      return preview.includes(needle) || command.includes(needle) || areaName.includes(needle);
    });
  }, [keys, area, search, t]);

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
              {areaOptions.map((option) => (
                <option key={option.id} value={option.id} dir="auto">
                  {option.label}
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
          {pageItems.map((item) => {
            const preview = visibleTemplateText(item, panelLocale);
            const command = templateCommand(item.key);
            const open = expanded.has(item.key);
            const long = templateIsLong(preview);
            return (
              <li key={item.key} className="flex items-start gap-2 p-3 sm:gap-3 sm:p-4">
                <div className="min-w-0 flex-1">
                  <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span>{t(areaLabelKey(item.key))}</span>
                    {command && <CodeText className="text-xs">{`!${command}`}</CodeText>}
                    {item.override && <Badge tone="info">{t("plusMessagesCustomized")}</Badge>}
                  </p>
                  <UserText
                    as="p"
                    lines={open ? undefined : 2}
                    title={open ? undefined : preview || t("plusMessagesNoPreview")}
                    className="text-sm text-text-main"
                  >
                    {preview ? <TemplateBody text={preview} /> : t("plusMessagesNoPreview")}
                  </UserText>
                </div>
                {long && (
                  <IconButton
                    label={open ? t("plusMessagesShowLess") : t("plusMessagesShowFull")}
                    aria-expanded={open}
                    icon={
                      <ChevronDown
                        size={16}
                        className={
                          open ? "rotate-180 transition-transform" : "transition-transform"
                        }
                      />
                    }
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.key)) next.delete(item.key);
                        else next.add(item.key);
                        return next;
                      })
                    }
                  />
                )}
                <IconButton
                  label={t("plusMessagesEdit")}
                  icon={<Pencil size={16} />}
                  onClick={() => setEditingKey(item.key)}
                />
              </li>
            );
          })}
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
