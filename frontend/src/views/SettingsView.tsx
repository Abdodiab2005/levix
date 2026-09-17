// file: frontend/src/views/SettingsView.tsx

import { AlertCircle, Globe, HardDrive, Key, Save, Shield, Sliders } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";

type SettingsTab = "general" | "security" | "proxy" | "storage";

export const SettingsView: React.FC = () => {
  const { t, language, setLanguage } = useI18n();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);

  // Security password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPass, setChangingPass] = useState(false);

  const loadSettings = async () => {
    try {
      const res = await api.getSettings();
      if (res?.settings) {
        const map: Record<string, any> = {};
        res.settings.forEach((s) => {
          map[s.key] = s.value;
        });
        setSettings(map);
      }
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const updateSetting = async (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      await api.updateSetting(key, value);
      toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast("New passwords do not match", "error");
      return;
    }
    if (newPassword.length < 8) {
      toast("Password must be at least 8 characters long", "error");
      return;
    }

    setChangingPass(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      toast("Dashboard password changed successfully!", "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setChangingPass(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Tab Navigation Header */}
      <div className="card-glass" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
          <button
            onClick={() => setActiveTab("general")}
            className={`btn ${activeTab === "general" ? "btn-primary" : "btn-secondary"}`}
          >
            <Sliders size={16} />
            <span>{t("tabGeneral")}</span>
          </button>
          <button
            onClick={() => setActiveTab("security")}
            className={`btn ${activeTab === "security" ? "btn-primary" : "btn-secondary"}`}
          >
            <Shield size={16} />
            <span>{t("tabSecurity")}</span>
          </button>
          <button
            onClick={() => setActiveTab("proxy")}
            className={`btn ${activeTab === "proxy" ? "btn-primary" : "btn-secondary"}`}
          >
            <Globe size={16} />
            <span>{t("tabProxy")}</span>
          </button>
          <button
            onClick={() => setActiveTab("storage")}
            className={`btn ${activeTab === "storage" ? "btn-primary" : "btn-secondary"}`}
          >
            <HardDrive size={16} />
            <span>{t("tabStorage")}</span>
          </button>
        </div>
      </div>

      {/* General Settings Tab */}
      {activeTab === "general" && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>{t("tabGeneral")}</h3>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "20px",
            }}
          >
            {/* Interface Language */}
            <div className="form-group">
              <label className="form-label">{t("interfaceLanguage")}</label>
              <select
                className="form-select"
                style={{ maxWidth: "260px" }}
                value={language}
                onChange={(e) => setLanguage(e.target.value as any)}
              >
                <option value="ar">العربية (RTL - اليمين لليسار)</option>
                <option value="en">English (LTR - Left to Right)</option>
              </select>
              <span style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "4px" }}>
                {t("interfaceLanguageDesc")}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">{t("prefix")}</label>
              <input
                type="text"
                className="form-input"
                style={{ fontFamily: "var(--font-mono)", maxWidth: "120px" }}
                value={settings["prefix"] || "!"}
                onChange={(e) => setSettings({ ...settings, prefix: e.target.value })}
                onBlur={(e) => updateSetting("prefix", e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t("botMinDelay")}</label>
              <input
                type="number"
                className="form-input"
                style={{ maxWidth: "200px" }}
                value={settings["bot_min_delay_ms"] || 700}
                onChange={(e) =>
                  setSettings({ ...settings, bot_min_delay_ms: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("bot_min_delay_ms", Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t("botPort")}</label>
              <input
                type="number"
                className="form-input"
                style={{ maxWidth: "200px" }}
                value={settings["port"] || 3001}
                onChange={(e) => setSettings({ ...settings, port: Number(e.target.value) })}
                onBlur={(e) => updateSetting("port", Number(e.target.value))}
              />
              <span style={{ fontSize: "0.78rem", color: "var(--warn)", marginTop: "4px" }}>
                {t("botPortHint")}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Security Tab */}
      {activeTab === "security" && (
        <div className="card" style={{ maxWidth: "560px" }}>
          <h3 style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "16px" }}>
            {t("changePassword")}
          </h3>

          <form
            onSubmit={handlePasswordChange}
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div className="form-group">
              <label className="form-label">{t("currentPassword")}</label>
              <input
                type="password"
                className="form-input"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t("newPassword")}</label>
              <input
                type="password"
                className="form-input"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t("confirmPassword")}</label>
              <input
                type="password"
                className="form-input"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            <button
              type="submit"
              disabled={changingPass}
              className="btn btn-primary"
              style={{ alignSelf: "flex-start", marginTop: "10px" }}
            >
              <Save size={16} />
              <span>{changingPass ? t("saving") : t("save")}</span>
            </button>
          </form>
        </div>
      )}

      {/* WhatsApp Proxy Tab */}
      {activeTab === "proxy" && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Outbound WhatsApp Proxy</h3>
              <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "4px" }}>
                Route Baileys WhatsApp traffic through an HTTP or SOCKS5 proxy
              </p>
            </div>
            <Toggle
              checked={Boolean(settings["proxy_enabled"])}
              onChange={(val) => updateSetting("proxy_enabled", val)}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "20px",
              marginTop: "10px",
            }}
          >
            <div className="form-group">
              <label className="form-label">Proxy Protocol</label>
              <select
                className="form-select"
                value={settings["proxy_type"] || "http"}
                onChange={(e) => updateSetting("proxy_type", e.target.value)}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Proxy Host / IP</label>
              <input
                type="text"
                className="form-input"
                placeholder="127.0.0.1 or proxy.example.com"
                value={settings["proxy_host"] || ""}
                onChange={(e) => setSettings({ ...settings, proxy_host: e.target.value })}
                onBlur={(e) => updateSetting("proxy_host", e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Proxy Port</label>
              <input
                type="number"
                className="form-input"
                placeholder="1080"
                value={settings["proxy_port"] || ""}
                onChange={(e) => setSettings({ ...settings, proxy_port: Number(e.target.value) })}
                onBlur={(e) => updateSetting("proxy_port", Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Username (Optional)</label>
              <input
                type="text"
                className="form-input"
                value={settings["proxy_username"] || ""}
                onChange={(e) => setSettings({ ...settings, proxy_username: e.target.value })}
                onBlur={(e) => updateSetting("proxy_username", e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password (Optional)</label>
              <input
                type="password"
                className="form-input"
                value={settings["proxy_password"] || ""}
                onChange={(e) => setSettings({ ...settings, proxy_password: e.target.value })}
                onBlur={(e) => updateSetting("proxy_password", e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Storage Tab */}
      {activeTab === "storage" && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Data Retention &amp; Limits</h3>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "20px",
            }}
          >
            <div className="form-group">
              <label className="form-label">Forward Score Expiry (Days)</label>
              <input
                type="number"
                className="form-input"
                value={settings["forward_score_ttl_days"] || 30}
                onChange={(e) =>
                  setSettings({ ...settings, forward_score_ttl_days: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("forward_score_ttl_days", Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Web Fetch Byte Limit</label>
              <input
                type="number"
                className="form-input"
                value={settings["max_fetch_bytes"] || 524288}
                onChange={(e) =>
                  setSettings({ ...settings, max_fetch_bytes: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("max_fetch_bytes", Number(e.target.value))}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
