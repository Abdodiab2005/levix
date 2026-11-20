// file: frontend/src/views/plus/MessagesTab.tsx
import { ChevronDown, MessageSquareHeart, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CodeText,
  EmptyState,
  Field,
  FilterButton,
  IconButton,
  Input,
  ListRow,
  LoadingState,
  Pagination,
  RadioGroup,
  Select,
  SortMenu,
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
import { type MessageSort, filterAndSortTemplateKeys, visibleTemplatePreview } from "./plusUiLogic";
import { TemplateEditor } from "./TemplateEditor";
import {
  type PlusLocale,
  type PlusTemplateKey,
  type PlusTemplatesResponse,
  isPlusLocale,
} from "./types";

export function MessagesTab({ onInactive }: { onInactive: () => void }) {
  const { t, language } = useI18n();
  const panelLocale: PlusLocale = isPlusLocale(language) ? language : "en";
  const [data, setData] = useState<PlusTemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [area, setArea] = useState("all");
  const [onlyCustomized, setOnlyCustomized] = useState(false);
  const [sort, setSort] = useState<MessageSort>("area");
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

  const filtered = useMemo(
    () =>
      filterAndSortTemplateKeys(keys, {
        search,
        area,
        onlyCustomized,
        sort,
        areaOf: templateArea,
        areaLabel: (key) => t(areaLabelKey(key)),
        commandOf: templateCommand,
        locale: language,
      }),
    [keys, area, onlyCustomized, sort, search, t, language],
  );

  const activeFilters = (area === "all" ? 0 : 1) + (onlyCustomized ? 1 : 0);

  const { page, pageCount, pageItems, setPage, total } = usePagination(
    filtered,
    20,
    `${search}|${area}|${onlyCustomized}|${sort}`,
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
            activeCount={activeFilters}
            onReset={() => {
              setArea("all");
              setOnlyCustomized(false);
            }}
          >
            <div className="flex flex-col gap-3">
              <Field label={t("plusMessagesArea")} htmlFor="plus-messages-area">
                <Select
                  id="plus-messages-area"
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
              </Field>
              <RadioGroup
                label={t("plusMessagesFilterStatus")}
                name="plus-messages-status"
                value={onlyCustomized ? "customized" : "all"}
                onChange={(value) => setOnlyCustomized(value === "customized")}
                options={[
                  { value: "all", label: t("plusMessagesFilterAll") },
                  { value: "customized", label: t("plusMessagesCustomized") },
                ]}
              />
            </div>
          </FilterButton>
          <SortMenu
            label={t("sort")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "area", label: t("plusMessagesSortArea") },
              { value: "customized", label: t("plusMessagesSortCustomized") },
              { value: "command", label: t("plusMessagesSortCommand") },
            ]}
          />
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
        <ul className="flex flex-col gap-2 p-4">
          {pageItems.map((item) => {
            const preview = visibleTemplatePreview(item, panelLocale);
            const command = templateCommand(item.key);
            const open = expanded.has(item.key);
            const long = templateIsLong(preview);
            return (
              <ListRow
                key={item.key}
                as="li"
                variant="raised"
                onClick={() => setEditingKey(item.key)}
                title={
                  <UserText
                    lines={open ? undefined : 2}
                    title={open ? undefined : preview || t("plusMessagesNoPreview")}
                    className="font-normal text-text-main"
                  >
                    {preview || t("plusMessagesNoPreview")}
                  </UserText>
                }
                meta={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{t(areaLabelKey(item.key))}</span>
                    {command && <CodeText className="text-xs">{`!${command}`}</CodeText>}
                    {item.override && <Badge tone="info">{t("plusMessagesCustomized")}</Badge>}
                  </span>
                }
                trailing={
                  <>
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
                  </>
                }
              />
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
