// file: frontend/src/views/CommandsView.tsx

import { Search, Terminal } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";
import type { CommandItem } from "../types";

export const CommandsView: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const loadCommands = async () => {
    try {
      const res = await api.getCommands();
      if (res?.commands) setCommands(res.commands);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCommands();
  }, []);

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
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="card-glass">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
          }}
        >
          <div>
            <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t("commands")}</h2>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "4px" }}>
              Manage and override role permissions or enable/disable bot commands live
            </p>
          </div>

          <div style={{ position: "relative", width: "100%", maxWidth: "300px" }}>
            <Search
              size={16}
              color="var(--muted)"
              style={{ position: "absolute", top: "12px", insetInlineStart: "12px" }}
            />
            <input
              type="text"
              className="form-input"
              style={{ paddingInlineStart: "36px" }}
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("thCommand")}</th>
              <th>{t("thAliases")}</th>
              <th>{t("thDescription")}</th>
              <th>{t("thScope")}</th>
              <th>{t("thRequiredRole")}</th>
              <th style={{ textAlign: "center" }}>{t("thStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={6}
                  style={{ textAlign: "center", padding: "30px", color: "var(--muted)" }}
                >
                  ...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  style={{ textAlign: "center", padding: "30px", color: "var(--muted)" }}
                >
                  ...
                </td>
              </tr>
            ) : (
              filtered.map((cmd) => (
                <tr key={cmd.name}>
                  <td style={{ fontWeight: 700, color: "var(--cyan)" }}>
                    <bdi className="input-technical">!{cmd.name}</bdi>
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
                    <bdi className="input-technical">
                      {cmd.aliases?.length ? cmd.aliases.map((a) => `!${a}`).join(", ") : "—"}
                    </bdi>
                  </td>
                  <td style={{ maxWidth: "320px", color: "var(--text)" }}>{cmd.description}</td>
                  <td>
                    <span className="badge badge-info">{cmd.chat}</span>
                  </td>
                  <td>
                    <select
                      className="form-select"
                      style={{ padding: "6px 10px", fontSize: "0.82rem", width: "auto" }}
                      value={cmd.permission}
                      onChange={(e) => handlePermissionChange(cmd, e.target.value)}
                    >
                      <option value="MEMBERS">Members (Everyone)</option>
                      <option value="ADMIN_ONLY">Group Admins</option>
                      <option value="OWNER_ONLY">Bot Owner Only</option>
                    </select>
                  </td>
                  <td style={{ textAlign: "center" }}>
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
