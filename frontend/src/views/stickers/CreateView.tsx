import { Download, Plus, Share2, Upload } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { Button, IconButton, LoadingState, MenuItem, OverflowMenu } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type {
  Capabilities,
  EditOptions,
  Pack,
  Sticker,
  StickerJobSource,
  StickerUpload,
} from "../../types";
import { fill } from "../../utils/fill";
import { canPickHostSource, pickHostSource, uploadHostSource } from "../../utils/hostBridge";
import { markUsed, saveOne, shareOne } from "../../utils/stickerDelivery";
import { explainError, jobStageMessage, stickerErrorMessage } from "../../utils/stickerErrors";
import type { Delivered } from "../../utils/stickerFiles";
import { STICKER_NAME_MAX } from "../../utils/stickerLimits";
import { uploadBlockReason } from "../../utils/uploadCheck";
import { CreateControls, TrimControls } from "./CreateControls";
import { CreateStage } from "./CreateStage";
import type { CreateSeed } from "./hostHandoff";
import { LayerEditor } from "./LayerEditor";
import { type OverlayLayer, overlayDataUrl } from "./overlay";
import { PackPicker } from "./PackPicker";
import { RecipientPicker } from "./RecipientPicker";
import { useStickerJob } from "./useStickerJob";

const DEFAULT_OPTIONS: EditOptions = {
  fit: "contain",
  zoom: 1,
  panX: 0,
  panY: 0,
  rotate: 0,
  background: "transparent",
  removeBackground: null,
  trim: null,
};

interface CreateViewProps {
  capabilities: Capabilities | null;
  capsError: string | null;
  onRetryCaps: () => void;
  incoming: CreateSeed | null;
  onConsumedIncoming: () => void;
  isConnected: boolean;
  onGoLibrary: () => void;
  onCreated: () => void;
}

function kindLabel(
  t: (
    key: "stickerKindImage" | "stickerKindGif" | "stickerKindVideo" | "stickerKindWebp",
  ) => string,
  kind: string,
) {
  if (kind === "gif") return t("stickerKindGif");
  if (kind === "video") return t("stickerKindVideo");
  if (kind === "webp") return t("stickerKindWebp");
  return t("stickerKindImage");
}

export const CreateView: React.FC<CreateViewProps> = ({
  capabilities,
  capsError,
  onRetryCaps,
  incoming,
  onConsumedIncoming,
  isConnected,
  onGoLibrary,
  onCreated,
}) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const job = useStickerJob();
  const [upload, setUpload] = useState<StickerUpload | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [source, setSource] = useState<StickerJobSource>("PANEL_UPLOAD");
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);
  const [options, setOptions] = useState<EditOptions>(DEFAULT_OPTIONS);
  const [layers, setLayers] = useState<OverlayLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [packId, setPackId] = useState("");
  const [packs, setPacks] = useState<Pack[]>([]);
  const [sendOpen, setSendOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const urlRef = useRef<string | null>(null);
  const consumed = useRef<CreateSeed | null>(null);
  const beginRef = useRef<
    (
      blob: Blob,
      fileName: string,
      nextSource: StickerJobSource,
      token?: string,
      existingId?: string,
    ) => Promise<void>
  >(async () => {});

  useEffect(() => {
    api
      .getPacks()
      .then((res) => setPacks(res.packs))
      .catch(() => {});
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const replaceUrl = (blob: Blob) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    setMediaUrl(url);
  };

  const beginUpload = async (
    blob: Blob,
    fileName: string,
    nextSource: StickerJobSource,
    token?: string,
    existingId?: string,
  ) => {
    if (!capabilities?.webp) return;
    const file = blob instanceof File ? blob : new File([blob], fileName, { type: blob.type });
    const blocked = await uploadBlockReason(file, capabilities.limits);
    if (blocked) {
      toast(t(blocked), "error");
      return;
    }
    setUploading(true);
    setSource(nextSource);
    try {
      const result = token
        ? await uploadHostSource(token, fileName, capabilities.limits.uploadBytes)
        : existingId
          ? await api.uploadExistingStickerSource(existingId)
          : await api.uploadStickerSource(file, fileName);
      replaceUrl(file);
      setUpload(result);
      setOptions(DEFAULT_OPTIONS);
      toast(t("uploadReady"), "success");
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      setUploading(false);
    }
  };
  beginRef.current = beginUpload;

  useEffect(() => {
    if (!incoming || !capabilities || incoming === consumed.current) return;
    consumed.current = incoming;
    onConsumedIncoming();
    void Promise.resolve(incoming.blob)
      .then((blob) =>
        beginRef.current(blob, incoming.name, incoming.source, incoming.token, incoming.existingId),
      )
      .catch((err) => toast(explainError(t, err), "error"));
  }, [incoming, capabilities, onConsumedIncoming]);

  const reset = () => {
    job.reset();
    setUpload(null);
    setName("");
    setPackId("");
    setLayers([]);
    setSelectedId(null);
    setOptions(DEFAULT_OPTIONS);
    setSource("PANEL_UPLOAD");
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setMediaUrl(null);
    consumed.current = null;
  };

  const payload = () => {
    if (!upload) return null;
    const trimmed = name.trim();
    if ([...trimmed].length > STICKER_NAME_MAX) {
      toast(t("stickerNameTooLong"), "warning");
      return null;
    }
    const overlay = overlayDataUrl(layers);
    return {
      uploadId: upload.uploadId,
      options,
      ...(overlay ? { overlay } : {}),
      ...(trimmed ? { name: trimmed } : {}),
      ...(packId ? { packId } : {}),
      source,
    };
  };

  const create = () => {
    const body = payload();
    if (!body) return;
    void job.start(body);
  };

  const announce = async (result: Delivered, sticker: Sticker) => {
    if (!result.ok) return;
    if (result.via === "host") toast(fill(t("stickerShareSaved"), { dir: result.dir }), "success");
    else if (result.via === "share") toast(t("shareDone"), "success");
    else toast(t("downloaded"), "success");
    await markUsed([sticker.id]);
    onCreated();
  };

  if (capsError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-danger">{capsError}</p>
        <Button onClick={onRetryCaps}>{t("retryLoad")}</Button>
      </div>
    );
  }
  if (!capabilities) return <LoadingState text={t("loading")} />;
  if (!capabilities.webp) {
    return <p className="p-6 text-sm text-warn text-center">{t("stickerErr_ENCODER_MISSING")}</p>;
  }

  const done = job.job?.state === "done" ? job.job.sticker : null;
  if (done) {
    return (
      <div className="flex flex-col gap-4 max-w-md mx-auto">
        <div className="aspect-square overflow-hidden rounded-2xl border border-line bg-[repeating-conic-gradient(var(--panel-raised)_0%_25%,var(--bg)_0%_50%)] bg-[length:20px_20px]">
          <img
            src={done.url}
            alt={done.name || t("stickerPreview")}
            className="w-full h-full object-contain"
          />
        </div>
        {job.job?.created === false && <p className="text-sm text-ok">{t("alreadyInLibrary")}</p>}
        {job.job?.qualityReduced && <p className="text-sm text-warn">{t("qualityReduced")}</p>}
        {job.job?.created !== false && <p className="text-sm text-ok">{t("stickerCreated")}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <IconButton
            label={t("downloadWebp")}
            icon={<Download size={18} />}
            onClick={() => {
              void saveOne(done, "webp")
                .then((result) => announce(result, done))
                .catch((err) => toast(explainError(t, err), "error"));
            }}
          />
          <IconButton
            label={t("shareSticker")}
            icon={<Share2 size={18} />}
            onClick={() => {
              void shareOne(done, "webp")
                .then((result) => announce(result, done))
                .catch((err) => toast(explainError(t, err), "error"));
            }}
          />
          <Button
            disabled={!isConnected}
            title={isConnected ? undefined : t("notConnectedHint")}
            onClick={() => setSendOpen(true)}
          >
            {t("sendViaWhatsapp")}
          </Button>
          <Button onClick={() => setPackOpen(true)}>{t("addToPack")}</Button>
          <Button variant="primary" onClick={reset}>
            {t("createAnother")}
          </Button>
          <Button onClick={onGoLibrary}>{t("goToLibrary")}</Button>
          <OverflowMenu label={t("moreActions")}>
            <MenuItem
              onSelect={() => {
                if (done.animated) toast(t("firstFrameHint"), "info");
                void saveOne(done, "png")
                  .then((result) => announce(result, done))
                  .catch((err) => toast(explainError(t, err), "error"));
              }}
            >
              {t("downloadPng")}
            </MenuItem>
            {done.animated && (
              <MenuItem
                disabled={!capabilities.gif}
                title={t("gifOnlyAnimated")}
                onSelect={() => {
                  void saveOne(done, "gif")
                    .then((result) => announce(result, done))
                    .catch((err) => toast(explainError(t, err), "error"));
                }}
              >
                {t("downloadGif")}
              </MenuItem>
            )}
          </OverflowMenu>
        </div>
        {!isConnected && <p className="text-xs text-muted">{t("notConnectedHint")}</p>}
        <RecipientPicker
          open={sendOpen}
          busy={false}
          onClose={() => setSendOpen(false)}
          onPick={(jid) => {
            void api
              .sendStickers({ ids: [done.id], jid })
              .then((res) => {
                if (res.sent > 0) {
                  toast(t("stickerSent"), "success");
                  setSendOpen(false);
                  onCreated();
                } else toast(t("stickerErr_NOT_CONNECTED"), "error");
              })
              .catch((err) => toast(explainError(t, err), "error"));
          }}
        />
        <PackPicker
          open={packOpen}
          title={t("addToPack")}
          packs={packs}
          onClose={() => setPackOpen(false)}
          onCreated={(pack) => setPacks((prev) => [...prev, pack])}
          onPick={(id) => {
            void api
              .bulkStickers({ action: "addToPack", ids: [done.id], packId: id })
              .then(() => {
                toast(t("addedToPack"), "success");
                setPackOpen(false);
                onCreated();
              })
              .catch((err) => toast(explainError(t, err), "error"));
          }}
        />
      </div>
    );
  }

  const failed = job.submitError || job.job?.state === "failed";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
      <div className="flex flex-col gap-3">
        {!upload && (
          <label
            className={`flex flex-col items-center justify-center gap-2 min-h-64 rounded-2xl border border-dashed ${over ? "border-brand-blue bg-brand-blue/10" : "border-line bg-panel"} p-6 cursor-pointer`}
            onClick={(event) => {
              if (!canPickHostSource()) return;
              event.preventDefault();
              void pickHostSource()
                .then(async (picked) => {
                  if (!picked) return;
                  const response = await fetch(picked.url);
                  if (!response.ok) throw new Error("source unavailable");
                  await beginUpload(
                    await response.blob(),
                    picked.name,
                    "PANEL_UPLOAD",
                    picked.token,
                  );
                })
                .catch((err) => toast(explainError(t, err), "error"));
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              if (canPickHostSource()) return;
              const file = event.dataTransfer.files[0];
              if (file) void beginUpload(file, file.name, "PANEL_UPLOAD");
            }}
          >
            <Upload size={28} className="text-muted" />
            <span className="text-sm font-bold text-text-main">{t("stickerDrag")}</span>
            <span className="text-xs text-muted">{t("uploadHint")}</span>
            <input
              type="file"
              accept="image/*,video/*,.webp,.gif"
              className="sr-only"
              disabled={canPickHostSource()}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void beginUpload(file, file.name, "PANEL_UPLOAD");
              }}
            />
          </label>
        )}
        {uploading && <LoadingState text={t("loading")} />}
        {upload && mediaUrl && (
          <>
            <p className="text-xs text-muted">
              {fill(t("stickerUploadInfo"), {
                kind: kindLabel(t, upload.kind),
                size: Math.max(1, Math.round(upload.size / 1024)),
              })}
            </p>
            <CreateStage
              mediaUrl={mediaUrl}
              kind={upload.kind}
              width={upload.width}
              height={upload.height}
              options={options}
              layers={layers}
              selectedId={selectedId}
              label={t("previewStage")}
              onPan={(panX, panY) => setOptions((prev) => ({ ...prev, panX, panY }))}
              onSelect={setSelectedId}
              onMoveLayer={(id, x, y) =>
                setLayers((prev) =>
                  prev.map((layer) => (layer.id === id ? { ...layer, x, y } : layer)),
                )
              }
            />
            <TrimControls
              options={options}
              onChange={(patch) => setOptions((prev) => ({ ...prev, ...patch }))}
              kind={upload.kind}
              durationMs={upload.durationMs}
              limits={capabilities.limits}
              animatedOk={capabilities.animated}
            />
          </>
        )}
        {(job.running || job.job?.state === "queued" || job.job?.state === "running") && (
          <div>
            <div className="h-2 rounded-full bg-line overflow-hidden">
              <div
                className="h-full bg-brand-blue"
                style={{ width: `${Math.round((job.job?.progress || 0) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted mt-1">
              {jobStageMessage(t, job.job?.state === "queued" ? "queued" : job.job?.stage)}
            </p>
          </div>
        )}
        {failed && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-danger">
              {job.submitError
                ? explainError(t, job.submitError)
                : stickerErrorMessage(t, job.job?.error?.code)}
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={create}>
                {t("tryAgain")}
              </Button>
              <Button onClick={reset}>{t("clearLbl")}</Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {upload && (
          <CreateControls
            options={options}
            onChange={(patch) => setOptions((prev) => ({ ...prev, ...patch }))}
            canRemoveBackground={capabilities.backgroundRemoval.includes("plain")}
            name={name}
            onName={setName}
            packId={packId}
            onPack={setPackId}
            packs={packs}
          />
        )}
        {upload && (
          <LayerEditor
            layers={layers}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={(id, patch) =>
              setLayers((prev) =>
                prev.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
              )
            }
            onDelete={(id) => {
              setLayers((prev) => prev.filter((layer) => layer.id !== id));
              setSelectedId((current) => (current === id ? null : current));
            }}
            onAddText={() => {
              const id = crypto.randomUUID();
              setLayers((prev) => [
                ...prev,
                {
                  id,
                  text: t("textPlaceholder"),
                  x: 256,
                  y: 256,
                  fontSize: 64,
                  color: "#ffffff",
                  align: "center",
                  rotate: 0,
                  outline: true,
                  background: false,
                },
              ]);
              setSelectedId(id);
            }}
            onAddEmoji={(emoji) => {
              const id = crypto.randomUUID();
              setLayers((prev) => [
                ...prev,
                {
                  id,
                  text: emoji,
                  x: 256,
                  y: 240,
                  fontSize: 96,
                  color: "#ffffff",
                  align: "center",
                  rotate: 0,
                  outline: false,
                  background: false,
                },
              ]);
              setSelectedId(id);
            }}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!upload || job.running || uploading}
            onClick={create}
            icon={<Plus size={16} />}
          >
            {t("createBtn")}
          </Button>
          {upload && (
            <Button onClick={reset} disabled={job.running}>
              {t("clearLbl")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
