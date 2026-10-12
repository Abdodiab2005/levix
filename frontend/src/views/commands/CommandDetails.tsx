// file: frontend/src/views/commands/CommandDetails.tsx

import { Copy, Edit3, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, IconButton, SaveField, Select, useSavedValue } from "../../components/ui";
import type { CommandItem, PermissionLevel } from "../../types";
import { AliasToken } from "./AliasToken";
import { type CommandActions, useCommandLabels } from "./shared";

/**
 * Editable permission for one command. A locked command (`userAdminRequired`)
 * performs a real WhatsApp admin action, so the level is fixed and shown as a
 * badge with the reason instead of a control the server would refuse anyway.
 */
export function CommandPermissionControl({
  command,
  levels,
  actions,
}: {
  command: CommandItem;
  levels: string[];
  actions: CommandActions;
}) {
  const { t, permissionLabel } = useCommandLabels();
  const field = useSavedValue(command.permission);

  if (command.permissionLocked) {
    return (
      <Badge tone="neutral">
        <Lock size={12} aria-hidden />
        {permissionLabel(command.permission)}
      </Badge>
    );
  }

  return (
    <SaveField
      dirty={field.dirty}
      saving={field.status === "saving"}
      justSaved={field.status === "saved"}
      error={field.error}
      onSave={() => field.save((next) => actions.onSavePermission(command, next))}
      onRevert={field.revert}
      saveLabel={t("save")}
      savedLabel={t("saved")}
    >
      <Select
        aria-label={`${t("thRequiredRole")}: ${command.name}`}
        value={field.value}
        onChange={(event) => field.setValue(event.target.value as PermissionLevel)}
      >
        {levels.map((level) => (
          <option key={level} value={level}>
            {permissionLabel(level)}
          </option>
        ))}
      </Select>
    </SaveField>
  );
}

function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-bold text-muted">{label}</p>
      {children}
    </section>
  );
}

/**
 * The panel under a command row. Same markup on mobile and desktop; shows the
 * description, aliases, permission, scope, the override marker and the usage
 * lines, each with a copy button that copies the command with the live prefix.
 */
export function CommandDetails({
  command,
  prefix,
  levels,
  actions,
}: {
  command: CommandItem;
  prefix: string;
  levels: string[];
  actions: CommandActions;
}) {
  const { t, describe, scopeLabel, permissionLabel, usageLines } = useCommandLabels();
  const description = describe(command);
  const usages = usageLines(command, prefix);

  return (
    <div className="flex flex-col gap-4">
      {description && (
        <p dir="auto" className="min-w-0 break-words text-sm text-muted">
          {description}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DetailSection label={t("thAliases")}>
          <div className="flex flex-wrap items-center gap-1.5">
            {command.aliases?.length ? (
              command.aliases.map((alias) => (
                <AliasToken key={alias} alias={alias} prefix={prefix} />
              ))
            ) : (
              <span className="text-xs text-faint">{t("noAliases")}</span>
            )}
            <IconButton
              label={t("editAliases")}
              icon={<Edit3 size={16} />}
              onClick={() => actions.onEditAliases(command)}
            />
          </div>
        </DetailSection>

        <DetailSection label={t("thRequiredRole")}>
          <CommandPermissionControl command={command} levels={levels} actions={actions} />
          {command.permissionLocked && (
            <p className="text-xs text-muted">{t("permissionLockedReason")}</p>
          )}
        </DetailSection>

        <DetailSection label={t("thScope")}>
          <div>
            <Badge tone="info">{scopeLabel(command.chat)}</Badge>
          </div>
        </DetailSection>

        <DetailSection label={t("thStatus")}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={command.enabled ? "ok" : "neutral"}>
              {command.enabled ? t("statusEnabled") : t("statusDisabled")}
            </Badge>
            {command.overridden && <Badge tone="info">{t("overridden")}</Badge>}
          </div>
          <p className="text-xs text-muted">
            {t("defaultLabel")}: {permissionLabel(command.defaultPermission)}
          </p>
        </DetailSection>
      </div>

      {usages.length > 0 && (
        <DetailSection label={t("usage")}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {usages.map((line) => (
              <li key={line} className="flex items-center gap-1.5">
                <code
                  dir="ltr"
                  title={line}
                  className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border border-line bg-panel-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
                >
                  {line}
                </code>
                <IconButton
                  label={t("copyCommand")}
                  icon={<Copy size={16} />}
                  onClick={() => actions.onCopy(line)}
                />
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
    </div>
  );
}
