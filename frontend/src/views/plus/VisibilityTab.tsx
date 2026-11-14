// file: frontend/src/views/plus/VisibilityTab.tsx
import { EyeOff, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  FormActions,
  Input,
  LoadingState,
  Select,
  Toggle,
  useDirtyForm,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import { withPlus, plusErrorCode, plusErrorKey, plusGet, plusPut } from "./plusApi";
import { createWriteQueue } from "./plusUiLogic";
import type { PlusVisibility } from "./types";

export function VisibilityTab({ onInactive }: { onInactive: () => void }) {
  const { t } = useI18n();
  const [visibility, setVisibility] = useState<PlusVisibility | null>(null);
  const [commands, setCommands] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      plusGet<PlusVisibility>("/visibility"),
      api.get<{ commands: Array<{ name: string }> }>("/commands"),
    ])
      .then(([next, catalog]) => {
        if (!live) return;
        setVisibility(next);
        setCommands(catalog.commands.map((command) => command.name));
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

  if (loading && !visibility) return <LoadingState text={t("loading")} />;
  if (error && !visibility) {
    return (
      <EmptyState
        kind="error"
        icon={<EyeOff size={28} />}
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
  if (!visibility) return null;

  return (
    <VisibilityForm
      visibility={visibility}
      commands={commands}
      onSaved={setVisibility}
      onInactive={onInactive}
    />
  );
}

type ProgressFormData = {
  hideProgress: PlusVisibility["hideProgress"];
  commands: string[];
};

function VisibilityForm({
  visibility,
  commands,
  onSaved,
  onInactive,
}: {
  visibility: PlusVisibility;
  commands: string[];
  onSaved: (next: PlusVisibility) => void;
  onInactive: () => void;
}) {
  const { t } = useI18n();
  const commandsKey = useMemo(() => visibility.commands.join(","), [visibility.commands]);
  const savedBaseline = useMemo<ProgressFormData>(
    () => ({
      hideProgress: visibility.hideProgress,
      commands: visibility.commands,
    }),
    [visibility.hideProgress, commandsKey],
  );
  const form = useDirtyForm<ProgressFormData>(savedBaseline);
  const prevBaselineRef = useRef(savedBaseline);

  useEffect(() => {
    if (prevBaselineRef.current !== savedBaseline) {
      const prev = prevBaselineRef.current;
      prevBaselineRef.current = savedBaseline;
      const userEditedProgress = form.draft.hideProgress !== prev.hideProgress;
      const userEditedCommands = form.draft.commands.join(",") !== prev.commands.join(",");
      if (userEditedProgress || userEditedCommands) {
        form.setDraft({
          hideProgress: userEditedProgress ? form.draft.hideProgress : savedBaseline.hideProgress,
          commands: userEditedCommands ? form.draft.commands : savedBaseline.commands,
        });
      }
    }
  }, [savedBaseline, form.draft.hideProgress, form.draft.commands, form.setDraft]);

  const writeQueueRef = useRef(createWriteQueue());
  const savedRef = useRef(visibility);
  savedRef.current = visibility;

  const [savingWatermark, setSavingWatermark] = useState(false);
  const [watermarkError, setWatermarkError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const visibleCommands = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((name) => name.toLowerCase().includes(needle));
  }, [commands, search]);

  async function setWatermark(hide: boolean) {
    setSavingWatermark(true);
    setWatermarkError(null);
    try {
      const next = await writeQueueRef.current.enqueue(async () => {
        const current = savedRef.current;
        return withPlus(
          () =>
            plusPut<PlusVisibility>("/visibility", {
              hideWatermark: hide,
              hideProgress: current.hideProgress,
              commands: current.commands,
            }),
          onInactive,
        );
      });
      savedRef.current = next;
      onSaved(next);
    } catch (err) {
      const code = plusErrorCode(err);
      if (code !== "inactive") setWatermarkError(t(plusErrorKey(code)));
    } finally {
      setSavingWatermark(false);
    }
  }

  function toggleCommand(name: string, checked: boolean) {
    form.setField(
      "commands",
      checked
        ? [...form.draft.commands, name]
        : form.draft.commands.filter((item) => item !== name),
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Toggle
          checked={visibility.hideWatermark}
          disabled={savingWatermark}
          label={t("plusVisibilityWatermark")}
          description={t("plusVisibilityWatermarkHint")}
          onChange={(value) => void setWatermark(value)}
        />
        {watermarkError && (
          <p role="alert" className="text-xs text-danger">
            {watermarkError}
          </p>
        )}
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.save(async (draft) => {
            const next = await writeQueueRef.current.enqueue(async () => {
              const current = savedRef.current;
              return withPlus(
                () =>
                  plusPut<PlusVisibility>("/visibility", {
                    hideWatermark: current.hideWatermark,
                    hideProgress: draft.hideProgress,
                    commands: draft.commands,
                  }),
                onInactive,
              );
            });
            savedRef.current = next;
            onSaved(next);
          });
        }}
      >
        <Field label={t("plusVisibilityProgress")} htmlFor="plus-hide-progress">
          <Select
            id="plus-hide-progress"
            value={form.draft.hideProgress}
            onChange={(event) =>
              form.setField("hideProgress", event.target.value as PlusVisibility["hideProgress"])
            }
          >
            <option value="none">{t("plusProgressNone")}</option>
            <option value="all">{t("plusProgressAll")}</option>
            <option value="selected">{t("plusProgressSelected")}</option>
          </Select>
        </Field>

        {form.draft.hideProgress === "selected" && (
          <Field
            label={t("plusVisibilityCommands")}
            description={fill(t("plusVisibilitySelectedCount"), {
              n: form.draft.commands.length,
              max: commands.length,
            })}
          >
            <p className="text-xs text-muted">{t("plusVisibilityCommandsHint")}</p>
            <Input
              type="search"
              value={search}
              placeholder={t("plusMessagesSearch")}
              aria-label={t("plusVisibilityCommands")}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-panel-raised/40 p-3">
              {visibleCommands.map((name) => (
                <Checkbox
                  key={name}
                  checked={form.draft.commands.includes(name)}
                  onChange={(event) => toggleCommand(name, event.target.checked)}
                  label={
                    <span dir="ltr" className="font-mono text-sm">
                      {name}
                    </span>
                  }
                />
              ))}
            </div>
          </Field>
        )}

        <FormActions
          dirty={form.dirty}
          saving={form.status === "saving"}
          justSaved={form.status === "saved"}
          error={form.error ? t(plusErrorKey(form.error)) : null}
          onDiscard={form.revert}
          saveLabel={t("save")}
          discardLabel={t("discard")}
          unsavedLabel={t("unsavedChanges")}
          savedLabel={t("saved")}
        />
      </form>
    </Card>
  );
}
