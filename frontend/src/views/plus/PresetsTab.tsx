// file: frontend/src/views/plus/PresetsTab.tsx
import { RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  UserText,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import { plusErrorCode, plusErrorKey, plusGet, plusPost } from "./plusApi";
import type { PlusPreset, PlusPresetsResponse } from "./types";

export function PresetsTab({ onInactive }: { onInactive: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<PlusPresetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PlusPreset | null>(null);
  const [overwriteManual, setOverwriteManual] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    plusGet<PlusPresetsResponse>("/presets")
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

  async function apply() {
    if (!pending) return;
    setApplying(true);
    setError(null);
    setApplied(null);
    try {
      const result = await plusPost<{ ok: boolean; applied: number }>(
        `/presets/${encodeURIComponent(pending.id)}/apply`,
        { overwriteManual },
      );
      setApplied(result.applied);
      setPending(null);
      setOverwriteManual(false);
      setReloadToken((value) => value + 1);
    } catch (err) {
      const code = plusErrorCode(err);
      if (code === "inactive") onInactive();
      setError(t(plusErrorKey(code)));
    } finally {
      setApplying(false);
    }
  }

  if (loading && !data) return <LoadingState text={t("loading")} />;
  if (error && !data) {
    return (
      <EmptyState
        kind="error"
        icon={<Sparkles size={28} />}
        description={error}
        action={
          <Button
            variant="secondary"
            icon={<RotateCcw size={16} />}
            onClick={() => setReloadToken((value) => value + 1)}
          >
            {t("retry")}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("plusPresetsIntro")}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {applied !== null && (
        <p role="status" className="text-sm text-ok">
          {fill(t("plusPresetApplied"), { n: applied })}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(data?.presets ?? []).map((preset) => (
          <Card key={preset.id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <UserText as="strong" className="min-w-0 flex-1 text-sm font-bold text-text-main">
                {preset.name}
              </UserText>
              {data?.active === preset.id && <Badge tone="ok">{t("plusPresetActive")}</Badge>}
            </div>
            <UserText as="p" className="text-sm text-muted">
              {preset.description}
            </UserText>
            <ul className="flex flex-col gap-2">
              {preset.preview.slice(0, 3).map((line) => (
                <li key={line.key}>
                  <UserText as="p" lines={2} className="text-sm text-text-main">
                    {line.text}
                  </UserText>
                  <p dir="ltr" className="mt-0.5 truncate font-mono text-[11px] text-faint">
                    {line.key}
                  </p>
                </li>
              ))}
            </ul>
            <Button
              variant="secondary"
              className="mt-auto self-start"
              onClick={() => {
                setPending(preset);
                setOverwriteManual(false);
              }}
            >
              {t("plusPresetApply")}
            </Button>
          </Card>
        ))}
      </div>
      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void apply()}
        title={fill(t("plusPresetConfirmTitle"), { name: pending?.name ?? "" })}
        description={t("plusPresetConfirmBody")}
        confirmLabel={t("plusPresetApply")}
        cancelLabel={t("cancel")}
        variant="primary"
        loading={applying}
      >
        <Checkbox
          label={t("plusPresetOverwriteManual")}
          checked={overwriteManual}
          onChange={(event) => setOverwriteManual(event.target.checked)}
        />
      </ConfirmDialog>
    </div>
  );
}
