// file: frontend/src/views/commands/CommandMobileList.tsx

import { ChevronDown } from "lucide-react";
import { Badge, CodeText, IconButton, Toggle, UserText } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { CommandItem } from "../../types";
import { cn } from "../../utils/cn";
import { CommandDetails } from "./CommandDetails";
import { type CommandActions, commandDomId, commandId, useCommandLabels } from "./shared";

/**
 * Under 768px: one dense row per command — name, enable switch, disclosure — and
 * the details expand inline underneath without reflowing the rest of the list.
 */
export function CommandMobileList({
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
    <ul className="divide-y divide-line/50">
      {commands.map((command) => {
        const id = commandId(command);
        const open = expanded === id;
        const panelId = commandDomId(command);
        const description = describe(command);
        const commandText = `${prefix}${command.name}`;
        return (
          <li key={id}>
            <div className="flex items-start gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <CodeText
                    copy
                    copyLabel={t("copyCommand")}
                    className="text-sm font-bold text-brand-cyan"
                  >
                    {commandText}
                  </CodeText>
                  {description && (
                    <UserText lines={2} className="text-xs text-muted">
                      {description}
                    </UserText>
                  )}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge
                    tone="neutral"
                    className="min-w-0 max-w-full whitespace-normal break-words text-start"
                  >
                    {permissionLabel(command.permission)}
                  </Badge>
                  <Badge tone={command.enabled ? "ok" : "neutral"} className="whitespace-normal">
                    {command.enabled ? t("statusEnabled") : t("statusDisabled")}
                  </Badge>
                </div>
              </div>
              <Toggle
                checked={command.enabled}
                aria-label={`${t("thStatus")}: ${commandText}`}
                onChange={(enabled) => actions.onToggleEnabled(command, enabled)}
              />
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
            </div>
            {open && (
              <div id={panelId} className="border-t border-line/40 bg-panel-raised/40 px-4 py-4">
                <CommandDetails
                  command={command}
                  prefix={prefix}
                  levels={levels}
                  actions={actions}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
