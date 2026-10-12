// file: frontend/src/views/commands/CommandAliasDialog.tsx

import { Plus, Tag } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { Button, Dialog, Field, Input } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { CommandItem } from "../../types";
import { AliasToken } from "./AliasToken";

/**
 * The alias editor. Validation is unchanged: a leading prefix (or slash) is
 * stripped, the token is lowercased, duplicates are refused, and Save replaces
 * the whole list on the server before the row updates.
 */
export function CommandAliasDialog({
  command,
  prefix,
  onClose,
  onSaved,
}: {
  command: CommandItem | null;
  prefix: string;
  onClose: () => void;
  onSaved: (command: CommandItem, aliases: string[]) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [tempAliases, setTempAliases] = useState<string[]>([]);
  const [newAliasText, setNewAliasText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!command) return;
    setTempAliases(Array.isArray(command.aliases) ? [...command.aliases] : []);
    setNewAliasText("");
    setSaving(false);
  }, [command]);

  const addAlias = () => {
    const clean = newAliasText
      .trim()
      .replace(/^[!/#.?$]+/, "")
      .toLowerCase();
    if (!clean) return;
    if (tempAliases.includes(clean)) {
      toast(t("aliasAlreadyAdded"), "warning");
      return;
    }
    setTempAliases([...tempAliases, clean]);
    setNewAliasText("");
  };

  const removeAlias = (alias: string) => {
    setTempAliases(tempAliases.filter((value) => value !== alias));
  };

  const saveAliases = async () => {
    if (!command) return;
    setSaving(true);
    try {
      await api.updateCommand(command.name, { aliases: tempAliases });
      onSaved(command, tempAliases);
      toast(t("savedSuccessfully"), "success");
      onClose();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      isOpen={Boolean(command)}
      onClose={onClose}
      title={
        command ? (
          <>
            {t("aliasesFor")}{" "}
            <span dir="ltr" className="font-mono">
              {prefix}
              {command.name}
            </span>
          </>
        ) : (
          t("aliasesFor")
        )
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" onClick={saveAliases} loading={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 py-1">
        <p className="text-xs text-muted sm:text-sm">{t("aliasesHelp")}</p>

        <div className="space-y-1.5">
          <span className="block text-xs font-bold text-muted">{t("thAliases")}</span>
          <div className="flex min-h-[42px] flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-raised p-2">
            {tempAliases.length > 0 ? (
              tempAliases.map((alias) => (
                <AliasToken
                  key={alias}
                  alias={alias}
                  prefix={prefix}
                  removeLabel={t("delete")}
                  onRemove={() => removeAlias(alias)}
                />
              ))
            ) : (
              <span className="px-1 text-xs text-faint">{t("noAliases")}</span>
            )}
          </div>
        </div>

        <Field label={t("addAlias")} htmlFor="new-alias-input">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Tag size={16} className="pointer-events-none absolute start-3 top-3 text-muted" />
              <Input
                id="new-alias-input"
                type="text"
                value={newAliasText}
                onChange={(event) => setNewAliasText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addAlias();
                  }
                }}
                placeholder={t("newAliasPlaceholder")}
                className="ps-10"
              />
            </div>
            <Button
              variant="secondary"
              icon={<Plus size={16} />}
              onClick={addAlias}
              className="shrink-0"
            >
              {t("add")}
            </Button>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
