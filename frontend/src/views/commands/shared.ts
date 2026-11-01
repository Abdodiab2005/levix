// file: frontend/src/views/commands/shared.ts

import { useI18n } from "../../context/I18nContext";
import { pickLocalized } from "../../i18n/locale";
import type { CommandItem, PermissionLevel } from "../../types";

/** What a row can ask the screen to do. The screen owns the API call and the state. */
export interface CommandActions {
  onToggleEnabled: (command: CommandItem, enabled: boolean) => void;
  onEditAliases: (command: CommandItem) => void;
  onSavePermission: (command: CommandItem, permission: PermissionLevel) => Promise<void>;
  onCopy: (text: string) => void;
}

/**
 * Arabic letters. An alias written in them is still a literal keyword the command
 * answers to — `!حساب` is exactly as much a name as `!calc` — so it stays visible
 * and editable in either language. The panel only says WHICH script it is in.
 */
export const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** The identity a row is keyed by: the permissions key for a group sub-command, else the name. */
export function commandId(command: CommandItem): string {
  return command.key ?? command.name;
}

/** Stable DOM id for a row's details panel, referenced by `aria-controls`. */
export function commandDomId(command: CommandItem): string {
  return `cmd-details-${commandId(command).replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

const PERMISSION_KEY: Record<
  string,
  "permMembers" | "permAdminsOnly" | "permAdminsOwner" | "permOwnerOnly"
> = {
  MEMBERS: "permMembers",
  // `ALL` is accepted by the evaluator but is not a stored level; keep a label so
  // an old override renders as words, not as a raw key.
  ALL: "permMembers",
  ADMINS_ONLY: "permAdminsOnly",
  ADMINS_OWNER: "permAdminsOwner",
  OWNER_ONLY: "permOwnerOnly",
};

const SCOPE_KEY: Record<string, "scopeAll" | "scopeGroup" | "scopePrivate"> = {
  all: "scopeAll",
  group: "scopeGroup",
  private: "scopePrivate",
};

/** The wording the catalog shows for a command, in the panel's language. */
export function useCommandLabels() {
  const { t, language } = useI18n();

  const permissionLabel = (level: string) => {
    const key = PERMISSION_KEY[level];
    return key ? t(key) : level;
  };

  const scopeLabel = (chat: string) => {
    const key = SCOPE_KEY[chat];
    return key ? t(key) : chat;
  };

  // Panel language, then English, then Arabic, then the flat field.
  const describe = (command: CommandItem) =>
    pickLocalized(command.descriptions, language) || command.description || "";

  const usageOf = (command: CommandItem) =>
    pickLocalized(command.usages, language) || command.usage || "";

  /** One prefixed line per usage variant, the way the bot prints them. */
  const usageLines = (command: CommandItem, prefix: string) =>
    usageOf(command)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `${prefix}${line}`);

  return { t, language, permissionLabel, scopeLabel, describe, usageOf, usageLines };
}
