import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "@/components/ui/app-notice";
import {
  Check,
  CheckCircle2,
  FolderOpen,
  Globe2,
  HardDrive,
  Image,
  Monitor,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Timer,
  Undo2,
  Video,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/layout";
import { SimpleSelect } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useConfirm } from "@/components/ui/confirm";
import {
  appearanceMediaType,
  appearanceMediaUrl,
  getApi,
  type AppearanceConfig,
  type BlendModel,
  type DryRunResult,
  type InjectStatus,
  type SizeModel,
} from "@/lib/api";

const SIZE_MODELS: { value: SizeModel; label: string }[] = [
  { value: "cover", label: "铺满窗口" },
  { value: "contain", label: "完整显示" },
  { value: "repeat", label: "平铺" },
  { value: "center", label: "原尺寸居中" },
  { value: "not_center", label: "左上偏移" },
  { value: "not_left", label: "左侧对齐" },
  { value: "not_right", label: "右侧对齐" },
  { value: "not_top", label: "顶部对齐" },
  { value: "not_bottom", label: "底部对齐" },
  { value: "not_right_bottom", label: "右下对齐" },
  { value: "not_right_top", label: "右上对齐" },
];

const BLEND_MODELS: { value: BlendModel; label: string }[] = [
  { value: "auto", label: "正常" },
  { value: "multiply", label: "正片叠底" },
  { value: "lighten", label: "变亮" },
];

function previewLayout(model: SizeModel) {
  switch (model) {
    case "contain":
      return { size: "contain", repeat: "no-repeat", position: "center" };
    case "repeat":
      return { size: "auto", repeat: "repeat", position: "0 0" };
    case "center":
      return { size: "auto", repeat: "no-repeat", position: "center" };
    case "not_left":
      return { size: "cover", repeat: "no-repeat", position: "left center" };
    case "not_right":
      return { size: "cover", repeat: "no-repeat", position: "right center" };
    case "not_top":
      return { size: "cover", repeat: "no-repeat", position: "center top" };
    case "not_bottom":
      return { size: "cover", repeat: "no-repeat", position: "center bottom" };
    case "not_right_bottom":
      return { size: "cover", repeat: "no-repeat", position: "right bottom" };
    case "not_right_top":
      return { size: "cover", repeat: "no-repeat", position: "right top" };
    case "not_center":
      return { size: "cover", repeat: "no-repeat", position: "20% 20%" };
    default:
      return { size: "cover", repeat: "no-repeat", position: "center" };
  }
}

export function AppearancePage({
  appearance,
  onChange,
  onPreviewChange,
}: {
  appearance: AppearanceConfig;
  onChange: (a: AppearanceConfig) => void;
  onPreviewChange: (a: AppearanceConfig) => void;
}) {
  const api = getApi();
  const { confirm, ConfirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<AppearanceConfig>({
    ...appearance,
    blur: appearance.blur ?? 24,
    windowOpacity: appearance.windowOpacity ?? 0.12,
    surfaceOpacity: appearance.surfaceOpacity ?? 0.46,
    sizeModel: appearance.sizeModel ?? "cover",
    blendModel: (appearance.blendModel as BlendModel) || "auto",
    randomImageFolder: appearance.randomImageFolder ?? "",
    autoStatus: appearance.autoStatus ?? false,
    autoInterval: appearance.autoInterval ?? 10,
    defaultOnlinePage: appearance.defaultOnlinePage || "",
    liveApply: appearance.liveApply ?? true,
  });
  const savedAppearance = useRef(appearance);
  const draftRef = useRef(draft);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<InjectStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [statusLoading, setStatusLoading] = useState(true);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [dry, setDry] = useState<DryRunResult | null>(null);

  useEffect(() => {
    savedAppearance.current = appearance;
  }, [appearance]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
      onPreviewChange(savedAppearance.current);
    },
    [onPreviewChange],
  );

  const refreshStatus = async (showActivity = false) => {
    const startedAt = showActivity ? performance.now() : 0;
    if (showActivity) setRefreshingStatus(true);
    try {
      setStatus(await api.injectStatus());
      setStatusError("");
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusLoading(false);
      if (showActivity) {
        const remaining = 300 - (performance.now() - startedAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
        }
        setRefreshingStatus(false);
      }
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const set = <K extends keyof AppearanceConfig>(key: K, value: AppearanceConfig[K]) => {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    onPreviewChange(next);
    if (
      next.liveApply &&
      (key === "opacity" ||
        key === "blur" ||
        key === "windowOpacity" ||
        key === "surfaceOpacity" ||
        key === "enabled" ||
        key === "sizeModel" ||
        key === "blendModel" ||
        key === "imagePath")
    ) {
      if (liveTimer.current) clearTimeout(liveTimer.current);
      liveTimer.current = setTimeout(() => {
        void api
          .applyAppearance({ ...next, realtimeOnly: true })
          .then((result) => onChange(result.appearance))
          .catch(() => undefined);
      }, 280);
    }
  };

  const saveLocal = async () => {
    setBusy(true);
    try {
      const result = await api.saveAppearance(draft);
      savedAppearance.current = result.appearance;
      onChange(result.appearance);
      toast.success("外观设置已保存");
    } catch {
      toast.error("保存未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const applyToCursor = async () => {
    const ok = await confirm({
      title: "应用外观到 Cursor？",
      description: "将把当前外观应用到 Cursor。首次应用后请完全重启 Cursor。",
      confirmText: "应用",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await api.applyAppearance({
        ...draft,
        realtimeOnly: false,
      });
      const next = result.appearance;
      savedAppearance.current = next;
      draftRef.current = next;
      setDraft(next);
      onChange(next);
      toast.success("外观效果已应用");
      await refreshStatus();
    } catch {
      toast.error("应用未完成，请检查 Cursor 后重试。");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    const ok = await confirm({
      title: "移除已应用的外观？",
      description: "将移除已应用到 Cursor 的外观，并保留当前设置供下次继续使用。",
      confirmText: "清除",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.clearAppearance();
      const next = { ...draft, enabled: false, liveApply: false };
      await api.saveAppearance(next);
      savedAppearance.current = next;
      draftRef.current = next;
      setDraft(next);
      onChange(next);
      toast.success("外观效果已清除");
      await refreshStatus();
    } catch {
      toast.error("清除未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const runDry = async () => {
    setBusy(true);
    try {
      const result = await api.dryRunAppearance(draft);
      setDry(result);
      toast.message(result.ok ? "当前外观可以应用" : "当前外观需要处理");
      await refreshStatus();
    } catch {
      toast.error("检查未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const forceRestore = async () => {
    const ok = await confirm({
      title: "恢复默认外观？",
      description: "将恢复此前可用的 Cursor 外观。建议先退出 Cursor。",
      confirmText: "恢复默认",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.forceRestoreAppearance();
      const next = { ...draft, enabled: false, liveApply: false };
      await api.saveAppearance(next);
      savedAppearance.current = next;
      draftRef.current = next;
      setDraft(next);
      onChange(next);
      toast.success("已恢复默认效果");
      await refreshStatus();
    } catch {
      toast.error("恢复未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const restoreDraft = () => {
    const next = savedAppearance.current;
    draftRef.current = next;
    setDraft(next);
    onPreviewChange(next);
    toast.message("已恢复保存的外观设置");
  };

  const mediaUrl = useMemo(
    () => appearanceMediaUrl(draft.imagePath),
    [draft.imagePath],
  );
  const mediaType = appearanceMediaType(draft.imagePath);
  const layout = previewLayout(draft.sizeModel);
  const layerStyle: CSSProperties = {
    opacity: draft.opacity,
    filter: draft.blur > 0 ? `blur(${draft.blur}px)` : undefined,
    mixBlendMode: draft.blendModel === "auto" ? "normal" : draft.blendModel,
  };
  const sourceKind = /^https?:\/\//i.test(draft.imagePath) ? "url" : "local";
  return (
    <div className="cs-page appearance-workspace">
      {ConfirmDialog}

      <header className="appearance-workspace__toolbar workspace-layer-enter">
        <div className="appearance-workspace__context">
          <span className={`appearance-workspace__context-dot ${draft.liveApply ? "is-ready" : ""}`} aria-hidden="true" />
          <span className="appearance-workspace__context-label">外观设置</span>
          <small>{draft.liveApply ? "即时更新已开启" : "保存后生效"}</small>
        </div>

        <div className="appearance-workspace__actions" data-no-drag>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="appearance-workspace__icon-action"
            onClick={() => void refreshStatus(true)}
            disabled={busy || refreshingStatus}
            title="刷新状态"
            aria-label="刷新状态"
          >
            <RefreshCw className={`workspace-refresh-icon${refreshingStatus ? " is-spinning animate-spin" : ""}`} />
          </Button>
          <Button type="button" variant="outline" className="appearance-workspace__text-action" onClick={() => void saveLocal()} disabled={busy}>
            <Save />
            {busy ? "处理中" : "保存"}
          </Button>
          <Button type="button" className="appearance-workspace__primary-action" onClick={() => void applyToCursor()} disabled={busy}>
            <Check />
            应用到 Cursor
          </Button>
        </div>
      </header>

      <section className="appearance-workspace__summary workspace-layer-enter workspace-layer-enter--delay-1" aria-label="外观概览">
        <div className="appearance-workspace__summary-main">
          <div className="appearance-workspace__summary-icon" aria-hidden="true">
            {mediaType === "video" ? <Video /> : <Image />}
          </div>
          <div>
            <strong>{draft.enabled ? (mediaUrl ? "媒体背景已启用" : "毛玻璃效果已启用") : "使用无图毛玻璃"}</strong>
            <p>在下方调整素材和透明效果，保存后可随时重新应用。</p>
          </div>
        </div>
        <div className="appearance-workspace__summary-metrics">
          <div>
            <span>背景类型</span>
            <strong>{draft.enabled && mediaUrl ? (mediaType === "video" ? "视频" : "图片") : "毛玻璃"}</strong>
          </div>
          <div>
            <span>即时更新</span>
            <strong>{draft.liveApply ? "已开启" : "已关闭"}</strong>
          </div>
          <div>
            <span>应用状态</span>
            <strong>{status?.allBundlesPatched ? "已应用" : status?.installed ? "待应用" : "待检查"}</strong>
          </div>
        </div>
      </section>

      <main className="appearance-workspace__layout workspace-layer-enter workspace-layer-enter--delay-2">
        <div className="appearance-workspace__editor-column">
          <section className="appearance-workspace__panel" aria-labelledby="appearance-media-title">
            <header className="appearance-workspace__panel-head">
              <div className="appearance-workspace__heading">
                <span className="appearance-workspace__panel-icon is-blue" aria-hidden="true">
                  <Image />
                </span>
                <div>
                  <h2 id="appearance-media-title">背景素材</h2>
                  <p>图片和视频都可以作为背景，留空时只保留毛玻璃效果。</p>
                </div>
              </div>
              <span className="appearance-workspace__state">{mediaType === "video" ? "视频" : draft.imagePath ? "图片" : "无素材"}</span>
            </header>

            <div className="appearance-workspace__panel-body appearance-workspace__media-body">
              <div className="appearance-workspace__toggle-row">
                <div>
                  <strong>启用媒体背景</strong>
                  <p>关闭后会保留当前素材，方便下次继续使用。</p>
                </div>
                <Switch checked={draft.enabled} onCheckedChange={(value) => set("enabled", value)} aria-label="启用媒体背景" />
              </div>

              <Field label="图片或视频" hint="可留空" className="appearance-workspace__field">
                <div className="appearance-workspace__input-action">
                  <Input
                    className="appearance-workspace__input"
                    value={draft.imagePath}
                    onChange={(event) => set("imagePath", event.target.value)}
                    placeholder="选择素材或粘贴网络地址"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="appearance-workspace__browse-action"
                    onClick={async () => {
                      const picked = await api.pickImage();
                      if (picked) set("imagePath", picked);
                    }}
                  >
                    <FolderOpen />
                    选择
                  </Button>
                </div>
              </Field>

              {draft.imagePath ? (
                <div className="appearance-workspace__media-info" aria-label="当前素材信息">
                  <span>
                    {sourceKind === "url" ? <Globe2 /> : <HardDrive />}
                    {sourceKind === "url" ? "网络素材" : "已选素材"}
                  </span>
                  <span>
                    {mediaType === "video" ? <Video /> : <Image />}
                    {mediaType === "video" ? "循环静音播放" : "静态背景"}
                  </span>
                </div>
              ) : null}

              <div className="appearance-workspace__separator" />

              <div className="appearance-workspace__media-options">
                <Field label="素材文件夹" hint="用于自动轮换" className="appearance-workspace__field">
                  <div className="appearance-workspace__input-action">
                    <Input
                      className="appearance-workspace__input"
                      value={draft.randomImageFolder}
                      onChange={(event) => set("randomImageFolder", event.target.value)}
                      placeholder="选择包含图片或视频的文件夹"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="appearance-workspace__browse-action"
                      onClick={async () => {
                        const picked = await api.pickFolder();
                        if (picked) set("randomImageFolder", picked);
                      }}
                    >
                      <FolderOpen />
                      选择
                    </Button>
                  </div>
                </Field>

                <div className="appearance-workspace__toggle-row appearance-workspace__toggle-row--compact">
                  <div>
                    <strong>自动轮换</strong>
                    <p>{draft.randomImageFolder.trim() ? "按设定时间切换素材。" : "先选择素材文件夹后再开启。"}</p>
                  </div>
                  <Switch
                    checked={draft.autoStatus}
                    disabled={!draft.randomImageFolder.trim()}
                    onCheckedChange={(value) => set("autoStatus", value)}
                    aria-label="自动轮换背景素材"
                  />
                </div>

                {draft.autoStatus ? (
                  <Field label="轮换间隔" hint="秒" className="appearance-workspace__interval-field">
                    <div className="appearance-workspace__interval-input">
                      <Timer aria-hidden="true" />
                      <Input
                        className="appearance-workspace__input tabular-nums"
                        type="number"
                        min={1}
                        max={86400}
                        value={draft.autoInterval}
                        onChange={(event) => set("autoInterval", Math.max(1, Number(event.target.value) || 1))}
                      />
                    </div>
                  </Field>
                ) : null}
              </div>
            </div>
          </section>

          <section className="appearance-workspace__panel" aria-labelledby="appearance-effects-title">
            <header className="appearance-workspace__panel-head">
              <div className="appearance-workspace__heading">
                <span className="appearance-workspace__panel-icon is-violet" aria-hidden="true">
                  <Monitor />
                </span>
                <div>
                  <h2 id="appearance-effects-title">透明效果</h2>
                  <p>调整素材、窗口和内容区域的显示层次。</p>
                </div>
              </div>
            </header>

            <div className="appearance-workspace__panel-body appearance-workspace__effects-body">
              <div className="appearance-workspace__range-list">
                <Field label={`媒体透明度 ${draft.opacity.toFixed(2)}`} hint="图片或视频">
                  <Slider className="appearance-workspace__slider" min={0} max={1} step={0.01} value={[draft.opacity]} onValueChange={(value) => set("opacity", value[0] ?? 0)} />
                </Field>
                <Field label={`窗口透明度 ${draft.windowOpacity.toFixed(2)}`} hint="越低越透明">
                  <Slider className="appearance-workspace__slider" min={0} max={1} step={0.01} value={[draft.windowOpacity]} onValueChange={(value) => set("windowOpacity", value[0] ?? 0)} />
                </Field>
                <Field label={`内容区透明度 ${draft.surfaceOpacity.toFixed(2)}`} hint="越低越透明">
                  <Slider className="appearance-workspace__slider" min={0} max={1} step={0.01} value={[draft.surfaceOpacity]} onValueChange={(value) => set("surfaceOpacity", value[0] ?? 0)} />
                </Field>
                <Field label={`毛玻璃模糊 ${draft.blur}px`} hint="柔化程度">
                  <Slider className="appearance-workspace__slider" min={0} max={100} step={1} value={[draft.blur]} onValueChange={(value) => set("blur", value[0] ?? 0)} />
                </Field>
              </div>

              <div className="appearance-workspace__select-grid">
                <Field label="素材位置">
                  <SimpleSelect className="appearance-workspace__select" value={draft.sizeModel} onValueChange={(value) => set("sizeModel", value)} options={SIZE_MODELS} />
                </Field>
                <Field label="显示方式">
                  <SimpleSelect className="appearance-workspace__select" value={draft.blendModel} onValueChange={(value) => set("blendModel", value)} options={BLEND_MODELS} />
                </Field>
              </div>

              <div className="appearance-workspace__toggle-row appearance-workspace__toggle-row--compact">
                <div>
                  <strong>即时更新</strong>
                  <p>应用外观后，调整参数会自动更新到 Cursor。</p>
                </div>
                <Switch checked={Boolean(draft.liveApply)} onCheckedChange={(value) => set("liveApply", value)} aria-label="即时更新到 Cursor" />
              </div>
            </div>
          </section>
        </div>

        <aside className="appearance-workspace__side-column">
          <section className="appearance-workspace__panel appearance-workspace__preview-panel" aria-labelledby="appearance-preview-title">
            <header className="appearance-workspace__panel-head">
              <div className="appearance-workspace__heading">
                <span className="appearance-workspace__panel-icon is-green" aria-hidden="true">
                  <Image />
                </span>
                <div>
                  <h2 id="appearance-preview-title">实时预览</h2>
                  <p>修改会立即反映在此处。</p>
                </div>
              </div>
              <span className="appearance-workspace__state is-ready">{draft.enabled && mediaUrl ? "已启用" : "毛玻璃"}</span>
            </header>

            <div className="appearance-workspace__panel-body">
              <div
                className="appearance-workspace__preview"
                style={{
                  backgroundColor: `rgba(238, 234, 226, ${draft.windowOpacity})`,
                  backdropFilter: `blur(${draft.blur}px) saturate(0.94)`,
                }}
              >
                {draft.enabled && mediaUrl ? (
                  mediaType === "video" ? (
                    <video
                      key={mediaUrl}
                      className="appearance-workspace__preview-media"
                      src={mediaUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      style={{
                        ...layerStyle,
                        objectFit: layout.size === "contain" ? "contain" : "cover",
                        objectPosition: layout.position,
                      }}
                    />
                  ) : (
                    <div
                      className="appearance-workspace__preview-media"
                      style={{
                        ...layerStyle,
                        backgroundImage: `url("${mediaUrl.replace(/"/g, "%22")}")`,
                        backgroundSize: layout.size,
                        backgroundRepeat: layout.repeat,
                        backgroundPosition: layout.position,
                      }}
                    />
                  )
                ) : null}
                <div
                  className="appearance-workspace__preview-bar"
                  style={{
                    backgroundColor: `rgba(255, 255, 255, ${draft.surfaceOpacity})`,
                    backdropFilter: `blur(${draft.blur}px)`,
                  }}
                >
                  <span />
                  <span />
                  <span />
                </div>
                <div className="appearance-workspace__preview-layout">
                  <div
                    className="appearance-workspace__preview-nav"
                    style={{
                      backgroundColor: `rgba(255, 255, 255, ${draft.surfaceOpacity})`,
                      backdropFilter: `blur(${draft.blur}px)`,
                    }}
                  />
                  <div
                    className="appearance-workspace__preview-content"
                    style={{
                      backgroundColor: `rgba(255, 255, 255, ${draft.surfaceOpacity})`,
                      backdropFilter: `blur(${draft.blur}px)`,
                    }}
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="appearance-workspace__panel" aria-labelledby="appearance-status-title">
            <header className="appearance-workspace__panel-head">
              <div className="appearance-workspace__heading">
                <span className="appearance-workspace__panel-icon is-orange" aria-hidden="true">
                  <CheckCircle2 />
                </span>
                <div>
                  <h2 id="appearance-status-title">应用状态</h2>
                  <p>查看当前外观是否已生效。</p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="appearance-workspace__icon-action"
                onClick={() => void refreshStatus(true)}
                disabled={busy || refreshingStatus}
                title="刷新状态"
                aria-label="刷新状态"
              >
                <RefreshCw className={`workspace-refresh-icon${refreshingStatus ? " is-spinning animate-spin" : ""}`} />
              </Button>
            </header>

            <div className="appearance-workspace__panel-body appearance-workspace__status-body">
              {statusLoading ? (
                <div className="appearance-workspace__status-skeleton" aria-label="正在读取应用状态">
                  <span />
                  <span />
                  <span />
                </div>
              ) : statusError ? (
                <div className="appearance-workspace__status-error" role="alert">
                  <XCircle aria-hidden="true" />
                  <div>
                    <strong>状态读取失败</strong>
                    <p>请稍后重新刷新状态。</p>
                  </div>
                  <Button type="button" variant="outline" size="icon" className="appearance-workspace__icon-action" onClick={() => void refreshStatus(true)} title="重试" aria-label="重试">
                    <RefreshCw />
                  </Button>
                </div>
              ) : status ? (
                <>
                  <div className="appearance-workspace__status-overview">
                    <span className={status.allBundlesPatched ? "is-ready" : "is-pending"} aria-hidden="true" />
                    <div>
                      <strong>{status.allBundlesPatched ? "外观已应用" : status.installed ? "等待应用外观" : "暂未发现 Cursor"}</strong>
                      <p>{status.allBundlesPatched ? "当前外观已在 Cursor 中生效。" : status.installed ? "完成设置后点击“应用到 Cursor”。" : "启动 Cursor 后再刷新状态。"}</p>
                    </div>
                  </div>

                  {status.backgroundCoverConflict ? (
                    <div className="appearance-workspace__status-note">检测到以前的外观效果，下次应用时会自动整理。</div>
                  ) : null}

                  <div className="appearance-workspace__status-metrics">
                    <div>
                      <span>外观效果</span>
                      <strong>{status.cssExists ? "已准备" : "待应用"}</strong>
                    </div>
                    <div>
                      <span>素材</span>
                      <strong>{draft.imagePath ? (status.assetExists ? "已准备" : "待确认") : "无需素材"}</strong>
                    </div>
                    <div>
                      <span>窗口显示</span>
                      <strong>{status.materialPatched ? "已应用" : "待应用"}</strong>
                    </div>
                  </div>
                </>
              ) : (
                <div className="appearance-workspace__status-empty">
                  <Monitor aria-hidden="true" />
                  <span>暂无应用状态。</span>
                </div>
              )}
            </div>
          </section>

          <section className="appearance-workspace__maintenance workspace-layer-enter workspace-layer-enter--delay-3" aria-label="外观操作">
            <Button type="button" variant="outline" className="appearance-workspace__maintenance-action" onClick={() => void runDry()} disabled={busy}>
              <ShieldCheck />
              检查外观
            </Button>
            <Button type="button" variant="outline" className="appearance-workspace__maintenance-action" onClick={() => void clear()} disabled={busy}>
              <RotateCcw />
              清除效果
            </Button>
            <Button type="button" variant="outline" className="appearance-workspace__maintenance-action is-danger" onClick={() => void forceRestore()} disabled={busy}>
              <RotateCcw />
              恢复默认
            </Button>
            <Button type="button" variant="outline" className="appearance-workspace__maintenance-action" onClick={restoreDraft} disabled={busy}>
              <Undo2 />
              撤销修改
            </Button>
          </section>
        </aside>
      </main>

      {dry ? (
        <section className="appearance-workspace__dry-result workspace-layer-enter workspace-layer-enter--delay-3" aria-label="外观检查结果">
          <div className="appearance-workspace__dry-icon" aria-hidden="true">
            <ShieldCheck />
          </div>
          <div className="appearance-workspace__dry-copy">
            <strong>{dry.ok ? "当前外观已准备就绪" : "当前外观还需要处理"}</strong>
            <p>{dry.ok ? "素材和显示效果已通过检查，可以应用到 Cursor。" : "请确认 Cursor 已启动并检查当前素材后再次尝试。"}</p>
          </div>
          <div className="appearance-workspace__dry-metrics">
            <span className={dry.writeOk ? "is-ready" : "is-error"}>显示效果 {dry.writeOk ? "就绪" : "待处理"}</span>
            <span className={dry.imageOk ? "is-ready" : "is-error"}>素材 {dry.imageOk ? "就绪" : "待处理"}</span>
          </div>
        </section>
      ) : null}

      <p className="appearance-workspace__footnote">Cursor 更新后，重新应用外观即可恢复当前设置。</p>
    </div>
  );
}
