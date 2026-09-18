// file: frontend/src/views/GroupsView.tsx

import { ShieldAlert, Users } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";
import type { GroupItem } from "../types";

export const GroupsView: React.FC = () => {
  const { t, language } = useI18n();
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
      {/* Header Card */}
      <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-brand-blue/10 text-brand-blue flex items-center justify-center shrink-0">
            <Users size={24} />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg md:text-xl font-bold text-text-main">{t("groups")}</h2>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-blue/10 text-brand-cyan border border-brand-cyan/20">
                {groups.length} {language === "ar" ? "مجموعة" : "groups"}
              </span>
            </div>
            <p className="text-xs md:text-sm text-muted mt-1">
              {language === "ar"
                ? "إدارة مجموعات واتساب، الحماية من الروابط، تقييد الوسائط، ورسائل الترحيب التلقائية"
                : "WhatsApp group moderation, anti-link defense, media filtering, and automated greetings"}
            </p>
          </div>
        </div>
      </div>

      {/* Table Container */}
      <div className="rounded-2xl border border-line bg-panel overflow-hidden shadow-sm overflow-x-auto">
        <table className="w-full text-start border-collapse text-sm">
          <thead>
            <tr className="bg-panel-raised border-b border-line text-xs font-bold text-muted uppercase tracking-wider">
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
                <td colSpan={6} className="text-center py-16 text-muted">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <div className="w-6 h-6 border-2 border-brand-blue border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs">{t("loading")}</span>
                  </div>
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-16 px-4">
                  <div className="max-w-md mx-auto flex flex-col items-center gap-3">
                    <div className="w-14 h-14 rounded-2xl bg-panel-raised flex items-center justify-center text-muted">
                      <ShieldAlert size={28} />
                    </div>
                    <h4 className="text-base font-bold text-text-main">
                      {language === "ar" ? "لا توجد مجموعات حتى الآن" : "No active groups found"}
                    </h4>
                    <p className="text-xs text-muted leading-relaxed">
                      {language === "ar"
                        ? "بمجرد إضافة البوت إلى مجموعات واتساب، ستظهر تلقائياً هنا مع خيارات الإشراف والحماية."
                        : "Once the bot is added to WhatsApp groups, they will automatically appear here with full moderation and anti-link controls."}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <tr key={g.jid} className="hover:bg-panel-hover/50 transition-colors">
                  <td className="px-5 py-4 font-bold text-text-main">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-brand-blue/10 text-brand-cyan flex items-center justify-center font-bold text-sm shrink-0">
                        {(g.subject || "G").charAt(0).toUpperCase()}
                      </div>
                      <span className="line-clamp-1">{g.subject || "Untitled Group"}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-muted">
                    <bdi className="px-2 py-1 rounded bg-bg-soft border border-line select-all">
                      {g.jid}
                    </bdi>
                  </td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-panel-raised border border-line text-xs font-semibold text-text-main">
                      {g.memberCount ?? "—"}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-center">
                    <Toggle
                      checked={Boolean(g.antilink)}
                      onChange={(val) => handleUpdate(g.jid, { antilink: val })}
                    />
                  </td>
                  <td className="px-5 py-4">
                    <select
                      className="h-9 px-3 rounded-xl border border-line bg-panel-raised text-text-main text-xs focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                      value={g.mediaRestriction || "none"}
                      onChange={(e) => handleUpdate(g.jid, { mediaRestriction: e.target.value })}
                    >
                      <option value="none">
                        {language === "ar" ? "بلا قيود (الكل)" : "No Restrictions"}
                      </option>
                      <option value="allow_admin_only">
                        {language === "ar" ? "المشرفون فقط" : "Admins Only"}
                      </option>
                      <option value="block_all">
                        {language === "ar" ? "حظر كافة الوسائط" : "Block All Media"}
                      </option>
                    </select>
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
      </div>
    </div>
  );
};
