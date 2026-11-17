// file: frontend/src/views/commands/CommandTable.tsx

import { ChevronDown } from "lucide-react";
import { Fragment } from "react";
import { Badge, CodeText, IconButton, Toggle, UserText } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { CommandItem } from "../../types";
import { cn } from "../../utils/cn";
import { AliasToken } from "./AliasToken";
import { CommandDetails, CommandPermissionControl } from "./CommandDetails";
import { type CommandActions, commandDomId, commandId, useCommandLabels } from "./shared";

const ALIAS_PREVIEW = 2;

function AliasPreview({ command, prefix }: { command: CommandItem; prefix: string }) {
  const aliases = command.aliases || [];
  if (aliases.length === 0) {
    return <span className="text-xs text-faint">—</span>;
  }
  const extra = aliases.length - ALIAS_PREVIEW;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {aliases.slice(0, ALIAS_PREVIEW).map((alias) => (
        <AliasToken key={alias} alias={alias} prefix={prefix} />
      ))}
      {extra > 0 && <Badge tone="neutral">+{extra}</Badge>}
    </div>
  );
}

/**
 * 768px and up: a compact table. `table-fixed` plus truncating cells keeps it
 * inside the content width — the aliases column collapses below `lg` instead of
 * forcing a horizontal scroll, and the same inline details panel is reused.
 */
export function CommandTable({
  commands,
  prefix,
  levels,
  expanded,
  onToggleDetails,
  actions,
}: {
  commands: CommandItem[];
  prefix: string;
  levels: string[];
  expanded: string | null;
  onToggleDetails: (id: string) => void;
  actions: CommandActions;
}) {
  const { t } = useI18n();
  const { describe, permissionLabel } = useCommandLabels();

  return (
    <div className="overflow-hidden">
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-panel-raised text-xs font-bold uppercase tracking-wider text-muted">
            <th className="w-[26%] px-3 py-3 text-start">{t("thCommand")}</th>
            <th className="px-3 py-3 text-start">{t("thDescription")}</th>
            <th className="hidden px-3 py-3 text-start lg:table-cell lg:w-[16%]">
              {t("thAliases")}
            </th>
            <th className="hidden px-3 py-3 text-start sm:table-cell sm:w-[26%] md:table-cell">
              {t("thRequiredRole")}
            </th>
            <th className="px-3 py-3 text-center">{t("thStatus")}</th>
            <th className="w-14 px-3 py-3 text-end">
              <span className="sr-only">{t("details")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/40">
          {commands.map((command) => {
            const id = commandId(command);
            const open = expanded === id;
            const panelId = commandDomId(command);
            const commandText = `${prefix}${command.name}`;
            return (
              <Fragment key={id}>
                <tr className="hover:bg-panel-hover/40">
                  <td className="min-w-0 px-3 py-2.5">
                    <CodeText
                      copy
                      copyLabel={t("copyCommand")}
                      className="font-bold text-brand-cyan"
                    >
                      {commandText}
                    </CodeText>
                  </td>
                  <td className="min-w-0 px-3 py-2.5">
                    <UserText as="p" lines={1} className="text-xs text-text-main md:text-sm">
                      {describe(command)}
                    </UserText>
                  </td>
                  <td className="hidden min-w-0 px-3 py-2.5 lg:table-cell">
                    <AliasPreview command={command} prefix={prefix} />
                  </td>
                  <td className="min-w-0 px-3 py-2.5 whitespace-normal">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Badge
                        tone="neutral"
                        className="min-w-0 max-w-full whitespace-normal break-words text-start"
                      >
                        {permissionLabel(command.permission)}
                      </Badge>
                      <CommandPermissionControl
                        command={command}
                        levels={levels}
                        actions={actions}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col items-center gap-1">
                      <Badge
                        tone={command.enabled ? "ok" : "neutral"}
                        className="whitespace-normal text-center"
                      >
                        {command.enabled ? t("statusEnabled") : t("statusDisabled")}
                      </Badge>
                      <Toggle
                        checked={command.enabled}
                        aria-label={`${t("thStatus")}: ${commandText}`}
                        onChange={(enabled) => actions.onToggleEnabled(command, enabled)}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-end">
                    <IconButton
                      size="md"
                      variant="ghost"
                      label={open ? t("hideDetails") : t("details")}
                      aria-expanded={open}
                      aria-controls={panelId}
                      icon={
                        <ChevronDown
                          size={18}
                          className={cn("transition-transform", open && "rotate-180")}
                        />
                      }
                      onClick={() => onToggleDetails(id)}
                    />
                  </td>
                </tr>
                {open && (
                  <tr className="bg-panel-raised/40">
                    <td colSpan={6} className="border-t border-line/40 px-3 py-4">
                      <CommandDetails
                        command={command}
                        prefix={prefix}
                        levels={levels}
                        actions={actions}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
