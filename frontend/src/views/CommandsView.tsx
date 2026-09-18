// file: frontend/src/views/CommandsView.tsx

import { Edit3, Plus, Search, Tag, X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";
import type { CommandItem } from "../types";

export const CommandsView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [commands, setCommands] = useState<CommandItem[]>([]);
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
      toast(
        language === "ar"
          ? `تم ${enabled ? "تفعيل" : "تعطيل"} الأمر '${cmd.name}'`
          : `Command '${cmd.name}' ${enabled ? "enabled" : "disabled"}`,
        "success",
      );
    } catch (err: any) {
      toast(err.message, "error");
      loadCommands();
    }
  };

  const handlePermissionChange = async (cmd: CommandItem, permission: any) => {
    setCommands((prev) =>
      prev.map((c) => (c.name === cmd.name ? { ...c, permission, overridden: true } : c)),
    );
    try {
      await api.updateCommand(cmd.name, { permission });
      toast(
        language === "ar" ? `تم تحديث رتبة '${cmd.name}'` : `Permission for '${cmd.name}' updated`,
        "success",
      );
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
      toast(
        language === "ar" ? "هذا الاسم المستعار مضاف بالفعل" : "Alias already added",
        "warning",
      );
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

  const filtered = commands.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.description.toLowerCase().includes(search.toLowerCase()) ||
      c.aliases.some((a) => a.toLowerCase().includes(search.toLowerCase())),
  );

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
                  title={language === "ar" ? "اضغط لتعديل البادئة" : "Click to change prefix"}
                >
                  {prefix}
                </button>
              )}
            </div>
          </div>
          <p className="text-xs md:text-sm text-muted mt-1">
            {language === "ar"
              ? "إدارة رتب الأوامر والأسماء المستعارة وتفعيلها أو تعطيلها مباشرة"
              : "Manage role permissions, edit aliases, or enable/disable bot commands live"}
          </p>
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
                        cmd.aliases.map((a) => (
                          <span
                            key={a}
                            className="inline-flex items-center font-mono text-[11px] px-2 py-0.5 rounded-md bg-panel-raised border border-line text-muted"
                          >
                            <bdi>
                              {prefix}
                              {a}
                            </bdi>
                          </span>
                        ))
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
                    {cmd.description}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="inline-flex px-2.5 py-0.5 rounded-lg bg-brand-blue/10 text-brand-cyan text-xs font-semibold">
                      {cmd.chat === "all"
                        ? language === "ar"
                          ? "الكل"
                          : "All"
                        : cmd.chat === "group"
                          ? language === "ar"
                            ? "المجموعات"
                            : "Group"
                          : language === "ar"
                            ? "خاص"
                            : "Private"}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <select
                      className="h-9 px-2.5 rounded-lg border border-line bg-panel-raised text-text-main text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                      value={cmd.permission}
                      onChange={(e) => handlePermissionChange(cmd, e.target.value)}
                    >
                      <option value="MEMBERS">
                        {language === "ar" ? "الجميع (الأعضاء)" : "Members (Everyone)"}
                      </option>
                      <option value="ADMIN_ONLY">
                        {language === "ar" ? "مشرفو المجموعة" : "Group Admins"}
                      </option>
                      <option value="OWNER_ONLY">
                        {language === "ar" ? "مالك البوت فقط" : "Bot Owner Only"}
                      </option>
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
          <p className="text-xs sm:text-sm text-muted">
            {language === "ar"
              ? "الأسماء المستعارة تتيح استدعاء هذا الأمر بأسماء بديلة (مثل: p بدلاً من ping)."
              : "Aliases allow invoking this command using alternative names."}
          </p>

          {/* Existing Aliases Chips */}
          <div className="space-y-1.5">
            <span className="text-xs font-bold text-muted block">{t("thAliases")}</span>
            <div className="flex items-center gap-2 flex-wrap min-h-[42px] p-2 rounded-xl border border-line bg-panel-raised">
              {tempAliases.length > 0 ? (
                tempAliases.map((a) => (
                  <span
                    key={a}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-panel border border-line text-xs font-mono font-bold text-text-main"
                  >
                    <span>
                      {prefix}
                      {a}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAlias(a)}
                      className="text-muted hover:text-danger p-0.5 rounded transition-colors"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))
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
