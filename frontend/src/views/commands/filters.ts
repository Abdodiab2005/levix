// file: frontend/src/views/commands/filters.ts

import type { CommandItem } from "../../types";

export type CommandStatusFilter = "all" | "on" | "off";
export type CommandScopeFilter = "all" | "allChats" | "groups" | "private" | "groupSub" | "general";
/** "all", "overridden", "locked", or one of the server's permission levels. */
export type CommandPermissionFilter = string;

export interface CommandFilters {
  status: CommandStatusFilter;
  scope: CommandScopeFilter;
  permission: CommandPermissionFilter;
}

export const EMPTY_COMMAND_FILTERS: CommandFilters = {
  status: "all",
  scope: "all",
  permission: "all",
};

/** How many of the three groups differ from their default. */
export function activeCommandFilterCount(filters: CommandFilters): number {
  let count = 0;
  if (filters.status !== "all") count += 1;
  if (filters.scope !== "all") count += 1;
  if (filters.permission !== "all") count += 1;
  return count;
}

function localizedValues(map: object | null | undefined): string[] {
  if (!map) return [];
  return Object.values(map).filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
}

/**
 * Search the name, every alias (either script), and every string in the
 * description and usage maps.
 */
export function commandMatches(
  command: CommandItem,
  query: string,
  filters: CommandFilters,
): boolean {
  if (query) {
    const haystack = [
      command.name,
      ...(command.aliases || []),
      command.description,
      ...localizedValues(command.descriptions),
      command.usage,
      ...localizedValues(command.usages),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  if (filters.status === "on" && !command.enabled) return false;
  if (filters.status === "off" && command.enabled) return false;

  if (filters.scope === "allChats" && command.chat !== "all") return false;
  if (filters.scope === "groups" && command.chat !== "group") return false;
  if (filters.scope === "private" && command.chat !== "private") return false;
  if (filters.scope === "groupSub" && command.category !== "group") return false;
  if (filters.scope === "general" && command.category === "group") return false;

  if (filters.permission === "overridden" && !command.overridden) return false;
  if (filters.permission === "locked" && !command.permissionLocked) return false;
  if (
    filters.permission !== "all" &&
    filters.permission !== "overridden" &&
    filters.permission !== "locked" &&
    command.permission !== filters.permission
  ) {
    return false;
  }

  return true;
}

export type CommandSort = "name" | "status";

/** Name (localized) or status (enabled first), name as the tie-breaker. */
export function sortCommands(
  commands: CommandItem[],
  sort: CommandSort,
  collator: Intl.Collator,
): CommandItem[] {
  const byName = (a: CommandItem, b: CommandItem) => collator.compare(a.name, b.name);
  const sorted = [...commands];
  if (sort === "status") {
    sorted.sort((a, b) => (a.enabled === b.enabled ? byName(a, b) : a.enabled ? -1 : 1));
  } else {
    sorted.sort(byName);
  }
  return sorted;
}
