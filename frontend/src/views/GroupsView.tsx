// file: frontend/src/views/GroupsView.tsx

import { ShieldAlert, Users } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import { Badge, Card, EmptyState, PageHeader, Select, Spinner, Toggle } from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { GroupItem } from "../types";
import { fill } from "../utils/fill";

export const GroupsView: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(true);

  const normalizeGroup = (g: any): GroupItem => {
    const jid = g.jid || g.id || "";
    const antilinkEnabled =
      typeof g.antilink === "boolean"
        ? g.antilink
        : Boolean(g.antilinkEnabled ?? g.antilink?.enabled);
    return {
      ...g,
      jid,
      subject: g.subject || "",
      memberCount: g.memberCount ?? g.participants ?? 0,
      antilink: antilinkEnabled,
      antilinkEnabled,
      welcomeEnabled: Boolean(g.welcomeEnabled ?? g.welcome_system?.enabled),
      mediaRestriction: g.mediaRestriction || "none",
    };
  };

  const loadGroups = async () => {
    try {
      const res = await api.getGroups();
      if (res?.groups) setGroups(res.groups.map(normalizeGroup));
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
    setGroups((prev) => prev.map((g) => (g.jid === jid ? { ...g, ...updates } : g)));
    try {
      await api.updateGroup(jid, updates);
      toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
      loadGroups();
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<Users size={24} />}
        title={
          <span className="inline-flex items-center gap-2">
            {t("groups")}
            <Badge tone="info">{fill(t("groupsCount"), { n: groups.length })}</Badge>
          </span>
        }
        description={t("groupsSubtitle")}
      />

      <Card padded={false} className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-start text-sm">
          <thead>
            <tr className="border-b border-line bg-panel-raised text-xs font-bold uppercase tracking-wider text-muted">
              <th className="px-5 py-4 text-start">{t("thGroupName")}</th>
              <th className="px-5 py-4 text-start">{t("thGroupJid")}</th>
              <th className="px-5 py-4 text-start">{t("thMembers")}</th>
              <th className="px-5 py-4 text-center">{t("thAntiLink")}</th>
              <th className="px-5 py-4 text-start">{t("thMedia")}</th>
              <th className="px-5 py-4 text-center">{t("thWelcome")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {loading ? (
              <tr>
                <td colSpan={6} className="py-16 text-center">
                  <Spinner className="size-6" label={t("loading")} />
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon={<ShieldAlert size={28} />}
                    title={t("noGroupsTitle")}
                    description={t("noGroupsBody")}
                  />
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <tr key={g.jid} className="transition-colors hover:bg-panel-hover/50">
                  <td className="px-5 py-4 font-bold text-text-main">
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-blue/10 text-sm font-bold text-brand-cyan">
                        {(g.subject || "G").charAt(0).toUpperCase()}
                      </div>
                      <span className="line-clamp-1">{g.subject || t("unnamedGroup")}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted">
                    <bdi className="select-all rounded border border-line bg-panel-raised px-2 py-1">
                      {g.jid?.split("@")[0] || g.jid}
                    </bdi>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone="neutral">{g.memberCount || "—"}</Badge>
                  </td>
                  <td className="px-5 py-4 text-center">
                    <Toggle
                      checked={Boolean(g.antilink)}
                      onChange={(val) => handleUpdate(g.jid, { antilink: val })}
                    />
                  </td>
                  <td className="px-5 py-4">
                    <Select
                      aria-label={t("thMedia")}
                      value={g.mediaRestriction || "none"}
                      onChange={(e) => handleUpdate(g.jid, { mediaRestriction: e.target.value })}
                    >
                      <option value="none">{t("mediaNone")}</option>
                      <option value="block_all">{t("mediaBlockAll")}</option>
                    </Select>
                  </td>
                  <td className="px-5 py-4 text-center">
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
      </Card>
    </div>
  );
};
