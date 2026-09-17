// file: frontend/src/views/GroupsView.tsx
import React, { useEffect, useState } from "react";
import { Users, Shield, Link2, Image, Sparkles } from "lucide-react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { GroupItem } from "../types";

export const GroupsView: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadGroups = async () => {
    try {
      const res = await api.getGroups();
      if (res?.groups) setGroups(res.groups);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGroups();
  }, []);

  const handleUpdate = async (jid: string, updates: Partial<GroupItem>) => {
    setGroups((prev) =>
      prev.map((g) => (g.jid === jid ? { ...g, ...updates } : g))
    );
    try {
      await api.updateGroup(jid, updates);
      toast("Group settings saved", "success");
    } catch (err: any) {
      toast(err.message, "error");
      loadGroups();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="card-glass">
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t("groups")}</h2>
          <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "4px" }}>
            WhatsApp group moderation, anti-link rules, media filtering, and welcome notifications
          </p>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Group Name</th>
              <th>Group JID</th>
              <th>Members</th>
              <th style={{ textAlign: "center" }}>Anti-Link</th>
              <th>Media Restriction</th>
              <th style={{ textAlign: "center" }}>Welcome Msg</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "30px", color: "var(--muted)" }}>
                  Loading groups...
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "30px", color: "var(--muted)" }}>
                  No groups found. Once the bot joins groups, they will appear here.
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <tr key={g.jid}>
                  <td style={{ fontWeight: 600 }}>{g.subject || "Untitled Group"}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--muted)" }}>
                    {g.jid}
                  </td>
                  <td>
                    <span className="badge badge-info">{g.memberCount ?? "—"}</span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <Toggle
                      checked={Boolean(g.antilink)}
                      onChange={(val) => handleUpdate(g.jid, { antilink: val })}
                    />
                  </td>
                  <td>
                    <select
                      className="form-select"
                      style={{ padding: "6px 10px", fontSize: "0.82rem", width: "auto" }}
                      value={g.mediaRestriction || "none"}
                      onChange={(e) => handleUpdate(g.jid, { mediaRestriction: e.target.value })}
                    >
                      <option value="none">No Restrictions</option>
                      <option value="allow_admin_only">Admins Only</option>
                      <option value="block_all">Block All Media</option>
                    </select>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <Toggle
                      checked={Boolean(g.welcomeEnabled)}
                      onChange={(val) => handleUpdate(g.jid, { welcomeEnabled: val })}
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
