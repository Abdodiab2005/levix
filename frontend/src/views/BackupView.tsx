import { Download, HardDrive, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { ApiError, api } from "../api/client";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  Disclosure,
  Field,
  IconButton,
  PasswordInput,
  Spinner,
  UserText,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import { intlLocale } from "../i18n/locale";
import { translations } from "../i18n/translations";
import { fill } from "../utils/fill";
import {
  canHostBackupSave,
  canHostBackupUpload,
  hasHostBridge,
  pickHostBackupFile,
  saveHostBackup,
  uploadHostBackup,
} from "../utils/hostBridge";

type Key = keyof typeof translations.en;
type Counts = Record<string, number>;
type Contents = {
  counts: Counts;
  apiKeys: string[];
  paired: boolean;
  maskedAccount: string | null;
};
type PlanSection = {
  added: string[];
  replaced: string[];
  removed: string[];
  unchanged: number;
  kept: string[];
};
type Plan = {
  exact: boolean;
  destructive: boolean;
  settings: PlanSection;
  apiKeys: PlanSection;
  persona: "added" | "replaced" | "unchanged" | "kept" | "none";
  accountData: { replacesCurrent: boolean; replacesWaiting: string | null } | null;
};
type Preview = {
  created: string;
  app: string;
  schema: number;
  platform: string;
  counts: Counts;
  apiKeys: string[];
  account: { masked: string | null; status: "match" | "different" | "target-unpaired" | "none" };
  accountData: "waits" | "none";
  plan: Plan;
};
type RestoreResult = {
  applied: string[];
  skipped: Array<{ key: string; reason: string }>;
  restartNeeded: string[];
  accountData: "waits" | "none";
};
type Job = {
  id: string;
  kind: "backup" | "restore";
  phase: string;
  bytes: number;
  totalBytes: number;
  done: boolean;
  error: { code: string; plan?: Plan } | null;
  result: unknown;
};
type ExportResult = { token: string; fileName: string; size: number; expiresAt: string };
type Pending = {
  waiting: boolean;
  account?: string;
  backupCreated?: string;
  counts?: Counts;
  lastActivation?: { status: "activated" | "waiting" | "failed"; at: string } | null;
  lastOutcome?: { outcome: string; at: string } | null;
};

const countKeys = [
  "settings",
  "apiKeys",
  "schedules",
  "groups",
  "roles",
  "conversations",
  "memoryFiles",
  "stickers",
  "packs",
] as const;
const errors: Record<string, Key> = {
  WRONG_PASSWORD: "backupErrWrongPassword",
  DAMAGED: "backupErrDamaged",
  NOT_A_BACKUP: "backupErrNotBackup",
  UNSUPPORTED_VERSION: "backupErrVersion",
  BAD_HEADER: "backupErrHeader",
  BAD_MANIFEST: "backupErrManifest",
  KDF_LIMIT: "backupErrKdf",
  SCHEMA_NEWER: "backupErrSchemaNewer",
  SCHEMA_MISMATCH: "backupErrSchemaMismatch",
  NO_SPACE: "backupErrSpace",
  BUSY: "backupErrBusy",
  LIMIT: "backupErrLimit",
  BAD_PASSWORD: "backupErrPassword",
  wrong_password: "backupErrPanelPassword",
  too_many_attempts: "backupErrAttempts",
  UNCLASSIFIED_TABLE: "backupErrTable",
  SECRET_FOUND: "backupErrSecret",
  RESTORE_INCOMPLETE: "backupErrIncomplete",
  CONFIRM_REQUIRED: "backupErrConfirmRequired",
  UNSUPPORTED_MEDIA_TYPE: "backupErrMedia",
  LENGTH_REQUIRED: "backupErrLength",
  BAD_LENGTH: "backupErrLength",
  NOT_FOUND: "backupErrNotFound",
  IO: "backupErrUnknown",
};
const maxBytes = 16 * 1024 ** 3;
const bytes = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MiB`;
const date = (value: string, locale: string) => new Date(value).toLocaleString(locale);

export function BackupView() {
  const { t, language } = useI18n();
  const stampLocale = intlLocale(language);
  const [contents, setContents] = useState<Contents | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [uploadId, setUploadId] = useState("");
  const [fileName, setFileName] = useState("");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [restored, setRestored] = useState<RestoreResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const exportPass = useRef<HTMLInputElement>(null);
  const exportConfirm = useRef<HTMLInputElement>(null);
  const exportCurrent = useRef<HTMLInputElement>(null);
  const restorePass = useRef<HTMLInputElement>(null);
  const restoreCurrent = useRef<HTMLInputElement>(null);
  const discardCurrent = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const hostAbort = useRef<AbortController | null>(null);
  const uploadGeneration = useRef(0);
  const restoreRequestPending = useRef(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const password = (ref: RefObject<HTMLInputElement | null>) => ref.current?.value ?? "";
  const clear = (...refs: Array<RefObject<HTMLInputElement | null>>) =>
    refs.forEach((ref) => {
      if (ref.current) ref.current.value = "";
    });
  const message = (err: unknown) => {
    const data = err instanceof ApiError ? err.data : null;
    const code = (err instanceof ApiError ? err.code : undefined) || data?.code;
    if (code === "throttled")
      return fill(t("backupErrThrottled"), { n: Number(data?.retryAfter) || 60 });
    return t(
      errors[code] ||
        ((err instanceof ApiError && err.status === 0) || err instanceof TypeError
          ? "backupErrNetwork"
          : "backupErrUnknown"),
    );
  };
  const load = async () => {
    try {
      const [c, p] = await Promise.all([
        api.get<Contents>("/backup/contents"),
        api.get<Pending>("/backup/pending"),
      ]);
      if (alive.current) {
        setContents(c);
        setPending(p);
      }
    } catch (err) {
      if (alive.current) setError(message(err));
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    alive.current = true;
    void loadRef.current();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      xhrRef.current?.abort();
      hostAbort.current?.abort();
    };
  }, []);
  const poll = async (id: string, kind: "backup" | "restore", generation?: number) => {
    try {
      const next = await api.get<Job>(`/backup/jobs/${id}`);
      if (!alive.current || (generation !== undefined && generation !== uploadGeneration.current))
        return;
      setJob(next);
      if (!next.done) {
        timer.current = setTimeout(() => void poll(id, kind, generation), 1000);
        return;
      }
      setBusy(false);
      if (next.error) {
        const refusedPlan = next.error.code === "CONFIRM_REQUIRED" ? next.error.plan : undefined;
        // The job found more to overwrite than the preview showed: show its plan
        // and ask for the confirmation again.
        if (refusedPlan) {
          setConfirmed(false);
          setPreview((current) => (current ? { ...current, plan: refusedPlan } : current));
        }
        setError(message(new ApiError(0, next.error.code, next.error)));
        return;
      }
      if (kind === "backup") setExported(next.result as ExportResult);
      else {
        setRestored(next.result as RestoreResult);
        void loadRef.current();
      }
    } catch (err) {
      if (alive.current && (generation === undefined || generation === uploadGeneration.current)) {
        setBusy(false);
        setError(message(err));
      }
    }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const value = password(exportPass);
    if (Array.from(value.normalize("NFC")).length < 12) {
      setError(t("backupErrPassword"));
      clear(exportPass, exportConfirm, exportCurrent);
      return;
    }
    if (value !== password(exportConfirm)) {
      setError(t("backupErrConfirm"));
      clear(exportPass, exportConfirm, exportCurrent);
      return;
    }
    setBusy(true);
    setExported(null);
    setJob(null);
    try {
      const r = await api.post<{ jobId: string }>("/backup/exports", {
        password: value,
        confirm: password(exportConfirm),
        current: password(exportCurrent),
      });
      void poll(r.jobId, "backup");
    } catch (err) {
      setBusy(false);
      setError(message(err));
    } finally {
      clear(exportPass, exportConfirm, exportCurrent);
    }
  };
  const browserPick = () => fileInput.current?.click();
  const beginUpload = () => {
    const generation = ++uploadGeneration.current;
    xhrRef.current?.abort();
    hostAbort.current?.abort();
    setError("");
    setPreview(null);
    setConfirmed(false);
    setRestored(null);
    setUploadId("");
    setFileName("");
    setUploadPercent(null);
    return generation;
  };
  const uploadBrowser = (file: File) => {
    if (restoreRequestPending.current) return;
    const generation = beginUpload();
    if (file.size > maxBytes || file.size < 1) {
      setError(t("backupErrLimit"));
      return;
    }
    setFileName(file.name);
    setUploadPercent(0);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/dashboard/api/backup/restore/uploads");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (alive.current && generation === uploadGeneration.current && event.lengthComputable)
        setUploadPercent(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (!alive.current || generation !== uploadGeneration.current) return;
      xhrRef.current = null;
      setUploadPercent(null);
      if (xhr.status === 401) {
        window.location.href = "/login";
        return;
      }
      const body = xhr.response as { uploadId?: string; code?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.uploadId) setUploadId(body.uploadId);
      else setError(message(new ApiError(xhr.status, "", body)));
    };
    xhr.onerror = () => {
      if (!alive.current || generation !== uploadGeneration.current) return;
      xhrRef.current = null;
      setUploadPercent(null);
      setError(t("backupErrNetwork"));
    };
    xhr.onabort = () => {
      if (!alive.current || generation !== uploadGeneration.current) return;
      xhrRef.current = null;
      setUploadPercent(null);
    };
    xhr.send(file);
  };
  const choose = async () => {
    if (busy || restoreRequestPending.current) return;
    if (!canHostBackupUpload()) {
      if (hasHostBridge()) setError(t("backupHostUpdate"));
      else browserPick();
      return;
    }
    const generation = beginUpload();
    try {
      const picked = await pickHostBackupFile();
      if (!alive.current || generation !== uploadGeneration.current) return;
      if (!picked) return;
      if (picked.size > maxBytes) {
        setError(t("backupErrLimit"));
        return;
      }
      setFileName(picked.name);
      setUploadPercent(0);
      const controller = new AbortController();
      hostAbort.current = controller;
      const result = await uploadHostBackup(
        picked.token,
        maxBytes,
        controller.signal,
        (done, total) => {
          if (alive.current && generation === uploadGeneration.current && total > 0)
            setUploadPercent(Math.round((done / total) * 100));
        },
      );
      if (!alive.current || generation !== uploadGeneration.current) return;
      if (result === "UNAVAILABLE") setError(t("backupHostUpdate"));
      else if (result !== "CANCELLED") setUploadId(result.uploadId);
    } catch (err) {
      if (!alive.current || generation !== uploadGeneration.current) return;
      if (err instanceof ApiError && err.code === "STORAGE_UNAVAILABLE")
        setError(t("backupHostUpdate"));
      else setError(message(err));
    } finally {
      if (alive.current && generation === uploadGeneration.current) {
        hostAbort.current = null;
        setUploadPercent(null);
      }
    }
  };
  const cancelUpload = () => {
    xhrRef.current?.abort();
    hostAbort.current?.abort();
  };
  const showPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (restoreRequestPending.current) return;
    restoreRequestPending.current = true;
    const generation = uploadGeneration.current;
    const id = uploadId;
    const passwordInput = restorePass.current;
    setBusy(true);
    setError("");
    try {
      const next = await api.post<Preview>(`/backup/restore/uploads/${id}/preview`, {
        password: passwordInput?.value ?? "",
      });
      if (alive.current && generation === uploadGeneration.current) {
        setConfirmed(false);
        setPreview(next);
      }
    } catch (err) {
      if (alive.current && generation === uploadGeneration.current) setError(message(err));
    } finally {
      if (passwordInput) passwordInput.value = "";
      restoreRequestPending.current = false;
      if (alive.current && generation === uploadGeneration.current) setBusy(false);
    }
  };
  const restore = async (event: FormEvent) => {
    event.preventDefault();
    if (restoreRequestPending.current) return;
    restoreRequestPending.current = true;
    const generation = uploadGeneration.current;
    const id = uploadId;
    const passwordInput = restorePass.current;
    const currentInput = restoreCurrent.current;
    setBusy(true);
    setError("");
    setJob(null);
    try {
      const r = await api.post<{ jobId: string }>(`/backup/restore/uploads/${id}/restore`, {
        password: passwordInput?.value ?? "",
        current: currentInput?.value ?? "",
        confirmDestructive: confirmed,
      });
      if (alive.current && generation === uploadGeneration.current)
        void poll(r.jobId, "restore", generation);
    } catch (err) {
      if (alive.current && generation === uploadGeneration.current) {
        setBusy(false);
        setError(message(err));
      }
    } finally {
      if (passwordInput) passwordInput.value = "";
      if (currentInput) currentInput.value = "";
      restoreRequestPending.current = false;
    }
  };
  const download = async () => {
    if (!exported) return;
    try {
      if (hasHostBridge() && !canHostBackupSave()) {
        setError(t("backupHostUpdate"));
        return;
      }
      if (canHostBackupSave()) {
        const result = await saveHostBackup(exported.token, exported.fileName);
        if (result === "UNAVAILABLE") setError(t("backupHostUpdate"));
        return;
      }
      const link = document.createElement("a");
      link.href = `/dashboard/api/backup/exports/${exported.token}`;
      link.download = exported.fileName;
      link.click();
    } catch (err) {
      if (err instanceof ApiError && err.code === "STORAGE_UNAVAILABLE")
        setError(t("backupHostUpdate"));
      else setError(message(err));
    }
  };
  const removeExport = async () => {
    if (!exported) return;
    try {
      await api.delete(`/backup/exports/${exported.token}`);
      setExported(null);
    } catch (err) {
      setError(message(err));
    }
  };
  const discard = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deleteWithBody("/backup/pending", { current: password(discardCurrent) });
      setDiscardOpen(false);
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      clear(discardCurrent);
      setBusy(false);
    }
  };
  const countList = (counts: Counts) => (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {countKeys.map((key) => (
        <div key={key}>
          <dt className="text-sm text-muted">
            {t(`backupCount${key[0].toUpperCase()}${key.slice(1)}` as Key)}
          </dt>
          <dd className="font-semibold tabular-nums">{counts[key] ?? 0}</dd>
        </div>
      ))}
    </dl>
  );
  const keyList = (keys: string[]) => (
    <p className="text-sm text-muted">
      {t("backupKeyNames")}:{" "}
      {keys.length
        ? keys.map((key, i) => (
            <span key={key}>
              {i ? ", " : ""}
              <UserText as="span">{key}</UserText>
            </span>
          ))
        : t("backupNone")}
    </p>
  );
  const nameList = (names: string[]) =>
    names.map((name, i) => (
      <span key={name}>
        {i ? ", " : ""}
        <UserText as="span">{name}</UserText>
      </span>
    ));
  const planNames = (label: Key, names: string[]) =>
    names.length > 0 && (
      <p className="text-sm">
        <span className="font-semibold">{t(label)}:</span> {nameList(names)}
      </p>
    );
  const planSection = (title: Key, part: PlanSection) => (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">{t(title)}</h4>
      {planNames("backupPlanAdded", part.added)}
      {planNames("backupPlanReplaced", part.replaced)}
      {planNames("backupPlanRemoved", part.removed)}
      {part.unchanged > 0 && (
        <p className="text-sm text-muted">{fill(t("backupPlanUnchanged"), { n: part.unchanged })}</p>
      )}
      {part.kept.length > 0 && (
        <Disclosure summary={fill(t("backupPlanKept"), { n: part.kept.length })}>
          <p className="text-sm text-muted">{nameList(part.kept)}</p>
        </Disclosure>
      )}
    </div>
  );
  const planView = (plan: Plan) => (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold">{t("backupPlanTitle")}</h3>
      {!plan.exact && <p className="text-sm text-warn">{t("backupPlanUnknown")}</p>}
      {planSection("backupPlanSettings", plan.settings)}
      {planSection("backupPlanApiKeys", plan.apiKeys)}
      <p className="text-sm">{t(`backupPersona${plan.persona}` as Key)}</p>
      {plan.accountData?.replacesCurrent && (
        <p className="text-sm text-warn">{t("backupPlanReplacesCurrent")}</p>
      )}
      {plan.accountData?.replacesWaiting && (
        <p className="text-sm text-warn">
          {fill(t("backupPlanReplacesWaiting"), { account: plan.accountData.replacesWaiting })}
        </p>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Card className="flex flex-col gap-4">
        <CardHeader
          icon={<HardDrive size={22} />}
          title={t("backupContents")}
          description={t("backupEncryptionNotice")}
          actions={
            <IconButton
              label={t("refresh")}
              icon={<RefreshCw size={18} />}
              onClick={() => void load()}
            />
          }
        />
        {contents ? (
          <>
            {countList(contents.counts)}
            {keyList(contents.apiKeys)}
            <p className="text-sm">
              {contents.paired
                ? fill(t("backupPaired"), { account: contents.maskedAccount || "" })
                : t("backupUnpaired")}
            </p>
            <p className="text-sm text-muted">
              {t("backupNeverIncludes")}: {t("backupExclusions")}
            </p>
          </>
        ) : (
          <Spinner label={t("loading")} />
        )}
      </Card>
      <Card className="flex flex-col gap-4">
        <CardHeader title={t("backupCreateTitle")} description={t("backupPasswordRule")} />
        <form onSubmit={create} className="flex flex-col gap-3">
          <Field label={t("backupPassword")} htmlFor="backup-export-password">
            <PasswordInput
              id="backup-export-password"
              ref={exportPass}
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label={t("backupConfirmPassword")} htmlFor="backup-export-confirm">
            <PasswordInput
              id="backup-export-confirm"
              ref={exportConfirm}
              required
              autoComplete="new-password"
            />
          </Field>
          <Field label={t("backupPanelPassword")} htmlFor="backup-export-current">
            <PasswordInput
              id="backup-export-current"
              ref={exportCurrent}
              required
              autoComplete="current-password"
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("backupCreate")}
          </Button>
        </form>
        {job && job.kind === "backup" && (
          <p role="status" className="text-sm">
            {fill(t("backupJobProgress"), {
              phase: t(
                (`backupPhase${job.phase}` in translations.en
                  ? `backupPhase${job.phase}`
                  : "backupPhaseWorking") as Key,
              ),
              percent: job.totalBytes ? Math.round((job.bytes / job.totalBytes) * 100) : 0,
            })}
          </p>
        )}
        {exported && (
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-sm">
              <UserText as="span">{exported.fileName}</UserText> · {bytes(exported.size)} ·{" "}
              {fill(t("backupExpires"), { date: date(exported.expiresAt, stampLocale) })}
            </p>
            <IconButton
              label={t("backupDownload")}
              icon={<Download size={18} />}
              onClick={() => void download()}
            />
            <IconButton
              label={t("backupDeleteNow")}
              icon={<Trash2 size={18} />}
              onClick={() => void removeExport()}
            />
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-4">
        <CardHeader
          icon={<Upload size={22} />}
          title={t("backupRestoreTitle")}
          description={t("backupRestoreIntro")}
        />
        <input
          ref={fileInput}
          type="file"
          accept=".levixbak"
          className="sr-only"
          aria-label={t("backupChooseFile")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) uploadBrowser(file);
            event.target.value = "";
          }}
        />
        <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void choose()}>
            {t("backupChooseFile")}
          </Button>
          {fileName && (
            <UserText as="span" className="min-w-0 text-sm">
              {fileName}
            </UserText>
          )}
        </div>
        {uploadPercent !== null && (
          <div className="flex items-center gap-2">
            <p role="status" className="flex-1 text-sm">
              {fill(t("backupUploadProgress"), { percent: uploadPercent })}
            </p>
            <IconButton label={t("cancel")} icon={<X size={18} />} onClick={cancelUpload} />
          </div>
        )}
        {uploadId && !preview && (
          <form onSubmit={showPreview} className="flex flex-col gap-3">
            <Field label={t("backupPassword")} htmlFor="backup-preview-password">
              <PasswordInput id="backup-preview-password" ref={restorePass} required />
            </Field>
            <Button type="submit" variant="primary" disabled={busy}>
              {t("backupPreview")}
            </Button>
          </form>
        )}
        {preview && (
          <div className="flex flex-col gap-3">
            <h3 className="font-semibold">{t("backupPreviewTitle")}</h3>
            <p className="text-sm">
              {fill(t("backupPreviewMeta"), {
                date: date(preview.created, stampLocale),
                version: preview.app,
                platform: preview.platform,
              })}
            </p>
            {countList(preview.counts)}
            {keyList(preview.apiKeys)}
            <p className="text-sm">
              {t(
                (
                  {
                    match: "backupAccountmatch",
                    different: "backupAccountdifferent",
                    "target-unpaired": "backupAccounttargetunpaired",
                    none: "backupAccountnone",
                  } as const
                )[preview.account.status],
              )}{" "}
              {preview.account.masked && <UserText as="span">{preview.account.masked}</UserText>}
            </p>
            {planView(preview.plan)}
            <p className="text-sm text-muted">{t("backupRestoreEffects")}</p>
            <form onSubmit={restore} className="flex flex-col gap-3">
              {preview.plan.destructive && (
                <Checkbox
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  label={t("backupConfirmDestructive")}
                />
              )}
              <Field label={t("backupPassword")} htmlFor="backup-restore-password">
                <PasswordInput id="backup-restore-password" ref={restorePass} required />
              </Field>
              <Field label={t("backupPanelPassword")} htmlFor="backup-restore-current">
                <PasswordInput id="backup-restore-current" ref={restoreCurrent} required />
              </Field>
              <Button
                type="submit"
                variant="danger"
                disabled={busy || (preview.plan.destructive && !confirmed)}
              >
                {t("backupConfirmRestore")}
              </Button>
            </form>
          </div>
        )}
        {job && job.kind === "restore" && (
          <p role="status" className="text-sm">
            {fill(t("backupJobProgress"), {
              phase: t(
                (`backupPhase${job.phase}` in translations.en
                  ? `backupPhase${job.phase}`
                  : "backupPhaseWorking") as Key,
              ),
              percent: job.totalBytes ? Math.round((job.bytes / job.totalBytes) * 100) : 0,
            })}
          </p>
        )}
        {restored && (
          <div className="flex flex-col gap-2 text-sm">
            <h3 className="font-semibold">{t("backupRestoreDone")}</h3>
            <p>{fill(t("backupApplied"), { n: restored.applied.length })}</p>
            <p>
              {t("backupAccountData")}:{" "}
              {t(restored.accountData === "waits" ? "backupAccountWaits" : "backupNone")}
            </p>
            {restored.skipped.length > 0 && (
              <div>
                <h4 className="font-semibold">{t("backupSkipped")}</h4>
                {restored.skipped.map((item) => (
                  <p key={item.key}>
                    <UserText as="span">{item.key}</UserText>:{" "}
                    <UserText as="span">{item.reason}</UserText>
                  </p>
                ))}
              </div>
            )}
            {restored.restartNeeded.length > 0 && (
              <p>
                {t("backupRestartNeeded")}: {restored.restartNeeded.join(", ")}
              </p>
            )}
          </div>
        )}
      </Card>
      {pending?.waiting && (
        <Card className="flex flex-col gap-3">
          <CardHeader
            title={t("backupPendingTitle")}
            description={fill(t("backupPendingDescription"), {
              account: pending.account || "",
              date: date(pending.backupCreated || "", stampLocale),
            })}
            actions={
              <IconButton
                label={t("backupDiscard")}
                icon={<Trash2 size={18} />}
                onClick={() => setDiscardOpen(true)}
              />
            }
          />
          {pending.counts && countList(pending.counts)}
          {pending.lastActivation && (
            <p className="text-sm">
              {t("backupActivation")}:{" "}
              {t(`backupActivation${pending.lastActivation.status}` as Key)} ·{" "}
              {date(pending.lastActivation.at, stampLocale)}
            </p>
          )}
        </Card>
      )}
      {pending?.lastOutcome?.outcome && pending.lastOutcome.outcome !== "restored" && (
        <p role="status" className="text-sm text-warn">
          {fill(t("backupLastOutcome"), {
            outcome: t(
              pending.lastOutcome.outcome === "completed-after-restart"
                ? "backupOutcomeCompleted"
                : "backupOutcomeUnchanged",
            ),
            date: date(pending.lastOutcome.at, stampLocale),
          })}
        </p>
      )}
      <ConfirmDialog
        isOpen={discardOpen}
        onClose={() => {
          clear(discardCurrent);
          setDiscardOpen(false);
        }}
        onConfirm={() => void discard()}
        title={t("backupDiscardTitle")}
        confirmLabel={t("backupDiscard")}
        cancelLabel={t("cancel")}
        loading={busy}
      >
        <Field label={t("backupPanelPassword")} htmlFor="backup-discard-current">
          <PasswordInput id="backup-discard-current" ref={discardCurrent} required />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
