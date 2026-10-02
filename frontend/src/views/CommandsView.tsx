// file: frontend/src/views/CommandsView.tsx

import { Edit3, Plus, Search, Tag, X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";
import type { CommandItem, PermissionLevel } from "../types";

// What the server sends in GET /commands `levels`, in case it ever grows one the
// panel doesn't have a label for yet (an unlabelled level still renders, as its
// raw key, rather than disappearing from the list).
const FALLBACK_LEVELS = ["MEMBERS", "ADMINS_ONLY", "ADMINS_OWNER", "OWNER_ONLY"];

// Arabic letters. An alias written in them is still a literal keyword the command
// answers to — `!حساب` is exactly as much a name as `!calc` — so it stays visible
// and editable in either language. The panel only says WHICH script it is in, so
// the Arabic ones never read as untranslated interface text.
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export const CommandsView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [levels, setLevels] = useState<string[]>(FALLBACK_LEVELS);
  const [prefix, setPrefix] = useState<string>("!");
  const [isEditingPrefix, setIsEditingPrefix] = useState(false);
  const [newPrefixInput, setNewPrefixInput] = useState("!");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  // Alias modal state
  const [editingAliasesCmd, setEditingAliasesCmd] = useState<CommandItem | null>(null);
  const [tempAliases, setTempAliases] = useState<string[]>([]);
  const [newAliasText, setNewAliasText] = useState("");
  const [savingAliases, setSavingAliases] = useState(false);

  const loadCommands = async () => {
    try {
      const res = await api.getCommands();
      if (res?.commands) setCommands(res.commands);
      if (res?.prefix) {
        setPrefix(res.prefix);
        setNewPrefixInput(res.prefix);
      }
      if (Array.isArray(res?.levels) && res.levels.length) setLevels(res.levels);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCommands();
  }, []);

  const handleUpdatePrefix = async () => {
    const clean = newPrefixInput.trim();
    if (!clean || clean.length > 3) {
      toast(t("prefixValidation"), "error");
      return;
    }
    try {
      await api.updatePrefix(clean);
      setPrefix(clean);
      setIsEditingPrefix(false);
      toast(`${t("prefixUpdated")} (${clean})`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleToggleEnabled = async (cmd: CommandItem, enabled: boolean) => {
    setCommands((prev) =>
      prev.map((c) => (c.name === cmd.name ? { ...c, enabled, overridden: true } : c)),
    );
    try {
      await api.updateCommand(cmd.name, { enabled });
      // `t()` puts `{name}` back in — one wording per language, no inline ternary.
      toast(
        t(enabled ? "commandEnabled" : "commandDisabled").replace("{name}", cmd.name),
        "success",
      );
    } catch (err: any) {
      toast(err.message, "error");
      loadCommands();
    }
  };

  const handlePermissionChange = async (cmd: CommandItem, permission: PermissionLevel) => {
    setCommands((prev) =>
      prev.map((c) => (c.name === cmd.name ? { ...c, permission, overridden: true } : c)),
    );
    try {
      await api.updateCommand(cmd.name, { permission });
      toast(t("permissionUpdated").replace("{name}", cmd.name), "success");
    } catch (err: any) {
      toast(err.message, "error");
      loadCommands();
    }
  };

  // Open alias editor
  const openAliasModal = (cmd: CommandItem) => {
    setEditingAliasesCmd(cmd);
    setTempAliases(Array.isArray(cmd.aliases) ? [...cmd.aliases] : []);
    setNewAliasText("");
  };

  const handleAddAlias = () => {
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

  const handleRemoveAlias = (aliasToRemove: string) => {
    setTempAliases(tempAliases.filter((a) => a !== aliasToRemove));
  };

  const handleSaveAliases = async () => {
    if (!editingAliasesCmd) return;
    setSavingAliases(true);
    try {
      await api.updateCommand(editingAliasesCmd.name, { aliases: tempAliases });
      setCommands((prev) =>
        prev.map((c) => (c.name === editingAliasesCmd.name ? { ...c, aliases: tempAliases } : c)),
      );
      toast(t("savedSuccessfully"), "success");
      setEditingAliasesCmd(null);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSavingAliases(false);
    }
  };

  // Every command documents itself in both languages; show the panel's. `usage`
  // is the English string and `usages` both languages, so the panel follows its
  // own UI language here exactly as the bot's own `!help` follows the message's.
  const describe = (c: CommandItem) => c.descriptions?.[language] || c.description || "";
  const usageOf = (c: CommandItem) => c.usages?.[language] || c.usage || "";

  /** One `!`-prefixed line per usage variant, the way the bot prints them. */
  const usageLines = (c: CommandItem) =>
    usageOf(c)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `${prefix}${line}`);

  const permissionLabel = (level: string) =>
    ({
      MEMBERS: t("permMembers"),
      // `ALL` is accepted by the evaluator but is not a stored level; keep the
      // label anyway so an old override renders as words, not as a raw key.
      ALL: t("permMembers"),
      ADMINS_ONLY: t("permAdminsOnly"),
      ADMINS_OWNER: t("permAdminsOwner"),
      OWNER_ONLY: t("permOwnerOnly"),
    })[level] || level;

  const scopeLabel = (chat: string) =>
    ({ all: t("scopeAll"), group: t("scopeGroup"), private: t("scopePrivate") })[chat] ||
    chat;

  // Search the name, every alias (either script), the description the panel is
  // showing, and both languages of the docs — so an operator searching in
  // English on an Arabic panel still finds the command.
  const query = search.trim().toLowerCase();
  const filtered = query
    ? commands.filter((c) =>
        [c.name, ...(c.aliases || []), describe(c), c.description, usageOf(c), c.usages?.en, c.usages?.ar]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : commands;

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Header and Search */}
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-lg md:text-xl font-bold text-text-main">{t("commands")}</h2>

            {/* Active Prefix Chip with Quick Edit */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-line bg-panel-raised">
              <span className="text-xs text-muted font-semibold">{t("activePrefix")}:</span>
              {isEditingPrefix ? (
                <div className="inline-flex items-center gap-1.5">
                  <input
                    type="text"
                    maxLength={3}
                    value={newPrefixInput}
                    onChange={(e) => setNewPrefixInput(e.target.value)}
                    className="w-12 h-7 px-1.5 text-center font-mono font-bold text-xs rounded-lg border border-line bg-panel text-text-main focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleUpdatePrefix();
                      if (e.key === "Escape") setIsEditingPrefix(false);
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleUpdatePrefix}
                    className="px-2 h-7 rounded-lg bg-brand-blue text-white font-bold text-xs hover:bg-brand-blue/90 transition-colors"
                  >
                    {t("save")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditingPrefix(false)}
                    className="px-2 h-7 rounded-lg border border-line bg-panel-raised text-muted font-bold text-xs hover:bg-panel-hover transition-colors"
                  >
                    {t("cancel")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setNewPrefixInput(prefix);
                    setIsEditingPrefix(true);
                  }}
                  className="px-2.5 py-0.5 rounded-lg bg-brand-cyan/15 text-brand-cyan border border-brand-cyan/30 font-mono font-bold text-xs hover:bg-brand-cyan/25 transition-colors"
                  title={t("editPrefixHint")}
                >
                  {prefix}
                </button>
              )}
            </div>
          </div>
          <p className="text-xs md:text-sm text-muted mt-1">{t("commandsSub")}</p>
        </div>

        <div className="relative w-full md:w-72 shrink-0">
          <Search size={18} className="absolute start-3.5 top-3 text-muted" />
          <input
            type="text"
            className="w-full h-11 ps-10 pe-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table Container with Mobile Horizontal Scroll */}
      <div className="rounded-2xl border border-line bg-panel overflow-hidden shadow-sm overflow-x-auto">
        <table className="w-full min-w-[760px] text-start border-collapse text-sm">
          <thead>
            <tr className="bg-panel-raised border-b border-line text-xs font-bold text-muted uppercase tracking-wider">
              <th className="px-4 py-3.5 text-start">{t("thCommand")}</th>
              <th className="px-4 py-3.5 text-start">{t("thAliases")}</th>
              <th className="px-4 py-3.5 text-start">{t("thDescription")}</th>
              <th className="px-4 py-3.5 text-start">{t("thScope")}</th>
              <th className="px-4 py-3.5 text-start">{t("thRequiredRole")}</th>
              <th className="px-4 py-3.5 text-center">{t("thStatus")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {loading ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-muted">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <div className="w-6 h-6 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs">{t("loading")}</span>
                  </div>
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-muted text-xs md:text-sm">
                  {t("noMatchingCommands")}
                </td>
              </tr>
            ) : (
              filtered.map((cmd) => (
                <tr key={cmd.name} className="hover:bg-panel-hover/50 transition-colors">
                  <td className="px-4 py-3.5 font-mono font-bold text-brand-cyan">
                    <bdi>
                      {prefix}
                      {cmd.name}
                    </bdi>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      {cmd.aliases?.length ? (
                        cmd.aliases.map((a) => {
                          const isArabic = ARABIC_SCRIPT.test(a);
                          const otherScript = isArabic !== (language === "ar");
                          return (
                            <span
                              key={a}
                              className="inline-flex items-center gap-1.5 font-mono text-[11px] px-2 py-0.5 rounded-md bg-panel-raised border border-line text-muted"
                              title={
                                otherScript
                                  ? t(isArabic ? "aliasScriptArabic" : "aliasScriptLatin")
                                  : undefined
                              }
                            >
                              <bdi>
                                {prefix}
                                {a}
                              </bdi>
                              {otherScript && (
                                <span className="font-sans font-bold text-[9px] uppercase tracking-wide text-brand-cyan/80">
                                  {isArabic ? "AR" : "EN"}
                                </span>
                              )}
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-xs text-muted/60">—</span>
                      )}
                      <button
                        type="button"
                        onClick={() => openAliasModal(cmd)}
                        className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-panel-raised hover:bg-brand-blue/15 hover:text-brand-cyan text-muted border border-line transition-colors"
                        title={t("editAliases")}
                      >
                        <Edit3 size={12} />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 max-w-xs text-text-main text-xs md:text-sm">
                    {describe(cmd)}
                    {/* The parameters are the point of a catalog — they follow the
                        panel's language too, one line per usage variant. */}
                    {usageLines(cmd).length > 0 && (
                      <ul
                        className="mt-1.5 flex flex-col gap-0.5 list-none"
                        aria-label={t("usage")}
                        title={t("usageHint")}
                      >
                        {usageLines(cmd).map((line) => (
                          <li key={line}>
                            <code className="font-mono text-[11px] text-muted bg-panel-raised border border-line rounded px-1.5 py-0.5 w-fit max-w-full overflow-x-auto">
                              <bdi>{line}</bdi>
                            </code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="inline-flex px-2.5 py-0.5 rounded-lg bg-brand-blue/10 text-brand-cyan text-xs font-semibold">
                      {scopeLabel(cmd.chat)}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <select
                      className="h-9 px-2.5 rounded-lg border border-line bg-panel-raised text-text-main text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                      value={cmd.permission}
                      onChange={(e) => handlePermissionChange(cmd, e.target.value as PermissionLevel)}
                    >
                      {levels.map((level) => (
                        <option key={level} value={level}>
                          {permissionLabel(level)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3.5 text-center">
                    <Toggle
                      checked={cmd.enabled}
                      onChange={(val) => handleToggleEnabled(cmd, val)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Alias Editor Modal */}
      <Modal
        isOpen={Boolean(editingAliasesCmd)}
        onClose={() => setEditingAliasesCmd(null)}
        title={`${t("aliasesFor")} ${prefix}${editingAliasesCmd?.name || ""}`}
        footer={
          <div className="flex items-center justify-end gap-2.5 w-full">
            <button
              type="button"
              onClick={() => setEditingAliasesCmd(null)}
              className="px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleSaveAliases}
              disabled={savingAliases}
              className="px-5 h-10 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/25 transition-colors disabled:opacity-50"
            >
              {savingAliases ? t("saving") : t("save")}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 py-1">
          <p className="text-xs sm:text-sm text-muted">{t("aliasesHelp")}</p>

          {/* Existing Aliases Chips */}
          <div className="space-y-1.5">
            <span className="text-xs font-bold text-muted block">{t("thAliases")}</span>
            <div className="flex items-center gap-2 flex-wrap min-h-[42px] p-2 rounded-xl border border-line bg-panel-raised">
              {tempAliases.length > 0 ? (
                tempAliases.map((a) => {
                  const isArabic = ARABIC_SCRIPT.test(a);
                  const otherScript = isArabic !== (language === "ar");
                  return (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-panel border border-line text-xs font-mono font-bold text-text-main"
                      title={
                        otherScript
                          ? t(isArabic ? "aliasScriptArabic" : "aliasScriptLatin")
                          : undefined
                      }
                    >
                      <bdi>
                        {prefix}
                        {a}
                      </bdi>
                      {otherScript && (
                        <span className="font-sans font-bold text-[9px] uppercase tracking-wide text-brand-cyan/80">
                          {isArabic ? "AR" : "EN"}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemoveAlias(a)}
                        className="text-muted hover:text-danger p-0.5 rounded transition-colors"
                      >
                        <X size={13} />
                      </button>
                    </span>
                  );
                })
              ) : (
                <span className="text-xs text-muted/60 px-1">{t("noAliases")}</span>
              )}
            </div>
          </div>

          {/* Add New Alias Input */}
          <div className="space-y-1.5">
            <label htmlFor="new-alias-input" className="text-xs font-bold text-muted block">{t("addAlias")}</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Tag size={16} className="absolute start-3 top-3 text-muted" />
                <input
                  id="new-alias-input"
                  type="text"
                  value={newAliasText}
                  onChange={(e) => setNewAliasText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddAlias();
                    }
                  }}
                  placeholder={t("newAliasPlaceholder")}
                  className="w-full h-11 ps-9 pe-3 rounded-xl border border-line bg-panel text-text-main font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                />
              </div>
              <button
                type="button"
                onClick={handleAddAlias}
                className="inline-flex items-center justify-center gap-1.5 px-4 h-11 rounded-xl bg-panel-raised hover:bg-panel-hover border border-line text-text-main font-bold text-xs sm:text-sm transition-colors shrink-0"
              >
                <Plus size={16} />
                <span>{t("add")}</span>
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};
