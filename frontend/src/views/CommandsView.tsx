// file: frontend/src/views/CommandsView.tsx

import { Search } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
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
      toast(`Command '${cmd.name}' ${enabled ? "enabled" : "disabled"}`, "success");
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
      toast(`Permission for '${cmd.name}' set to ${permission}`, "success");
    } catch (err: any) {
      toast(err.message, "error");
      loadCommands();
    }
  };

  const filtered = commands.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.description.toLowerCase().includes(search.toLowerCase()) ||
      c.aliases.some((a) => a.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
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
              ? "إدارة رتب الأوامر وتفعيلها أو تعطيلها مباشرة مع دعم البادئة المخصصة"
              : "Manage and override role permissions or enable/disable bot commands live"}
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

      <div className="rounded-2xl border border-line bg-panel overflow-hidden shadow-sm overflow-x-auto">
        <table className="w-full text-start border-collapse text-sm">
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
                <td colSpan={6} className="text-center py-12 text-muted text-xs">
                  {language === "ar"
                    ? "لم يتم العثور على أوامر مطابقة"
                    : "No matching commands found."}
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
                  <td className="px-4 py-3.5 font-mono text-xs text-muted">
                    <bdi>
                      {cmd.aliases?.length
                        ? cmd.aliases.map((a) => `${prefix}${a}`).join(", ")
                        : "—"}
                    </bdi>
                  </td>
                  <td className="px-4 py-3.5 max-w-xs text-text-main text-xs md:text-sm">
                    {cmd.description}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="inline-flex px-2.5 py-0.5 rounded-lg bg-brand-blue/10 text-brand-cyan text-xs font-semibold">
                      {cmd.chat}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <select
                      className="h-9 px-2.5 rounded-lg border border-line bg-panel-raised text-text-main text-xs focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                      value={cmd.permission}
                      onChange={(e) => handlePermissionChange(cmd, e.target.value)}
                    >
                      <option value="MEMBERS">Members (Everyone)</option>
                      <option value="ADMIN_ONLY">Group Admins</option>
                      <option value="OWNER_ONLY">Bot Owner Only</option>
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
    </div>
  );
};
