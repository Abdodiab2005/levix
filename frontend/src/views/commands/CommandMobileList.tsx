// file: frontend/src/views/commands/CommandMobileList.tsx

import { ChevronDown } from "lucide-react";
import { IconButton, Toggle } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { CommandItem } from "../../types";
import { cn } from "../../utils/cn";
import { CommandDetails } from "./CommandDetails";
import { type CommandActions, commandDomId, commandId } from "./shared";

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
  expanded: ReadonlySet<string>;
  onToggleDetails: (id: string) => void;
  actions: CommandActions;
}) {
  const { t } = useI18n();
  return (
    <ul className="divide-y divide-line/50">
      {commands.map((command) => {
        const id = commandId(command);
        const open = expanded.has(id);
        const panelId = commandDomId(command);
        return (
          <li key={id}>
            <div className="flex min-h-12 items-center gap-2 px-4">
              <span
                dir="ltr"
                className="min-w-0 flex-1 truncate font-mono text-sm font-bold text-brand-cyan"
              >
                {prefix}
                {command.name}
              </span>
              <Toggle
                checked={command.enabled}
                aria-label={`${t("thStatus")}: ${prefix}${command.name}`}
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
