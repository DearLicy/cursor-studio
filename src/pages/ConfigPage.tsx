import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Archive,
  CheckCircle2,
  Download,
  FolderOpen,
  Link2,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Unplug,
  Upload,
} from "lucide-react";
import { toast } from "@/components/ui/app-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/layout";
import { SimpleSelect } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import {
  getApi,
  type AppConfig,
  type ConfigBackupInfo,
  type CursorStatus,
  type ProxyCaInfo,
  type ServiceState,
} from "@/lib/api";

function formatBackupDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBackupSize(value: number): string {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ConfigInitialSkeleton() {
  return (
    <div className="config-workspace__loading workspace-layer-enter workspace-layer-enter--delay-1" aria-hidden="true">
      <section className="config-workspace__skeleton config-workspace__skeleton--hero">
        <span />
        <span />
      </section>
      <section className="config-workspace__skeleton-grid">
        <span className="config-workspace__skeleton" />
        <span className="config-workspace__skeleton" />
      </section>
      <section className="config-workspace__skeleton config-workspace__skeleton--list" />
      <section className="config-workspace__skeleton-grid">
        <span className="config-workspace__skeleton" />
        <span className="config-workspace__skeleton" />
      </section>
    </div>
  );
}

export function ConfigPage({
  config,
  onConfigChange,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
}) {
  const api = getApi();
  const { confirm, ConfirmDialog } = useConfirm();
  const [state, setState] = useState<ServiceState | null>(null);
  const [cursor, setCursor] = useState<CursorStatus | null>(null);
  const [ca, setCa] = useState<ProxyCaInfo | null>(null);
  const [draft, setDraft] = useState(config);
  const [backups, setBackups] = useState<ConfigBackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const loadedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const refresh = async (showActivity = false) => {
    const initialLoad = !loadedRef.current;
    const startedAt = showActivity ? performance.now() : 0;
    if (initialLoad) setLoading(true);
    if (showActivity) setRefreshing(true);

    try {
      const [nextState, nextCursor, nextCa, nextBackups] = await Promise.all([
        api.serviceState(),
        api.cursorStatus(),
        api.getProxyCa(),
        api.listConfigBackups(),
      ]);
      setState(nextState);
      setCursor(nextCursor);
      setCa(nextCa);
      setBackups(nextBackups.backups);
      setLoadError("");
      loadedRef.current = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message || "暂时未能读取设置状态");
      toast.error("暂时未能读取设置状态");
    } finally {
      if (initialLoad) setLoading(false);
      if (showActivity) {
        const remaining = 300 - (performance.now() - startedAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
        }
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.saveConfig(draft);
      setDraft(next);
      onConfigChange(next);
      toast.success("设置已保存");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `cursor-studio-config-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importConfigFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const accepted = await confirm({
        title: "导入设置",
        description: "导入前会自动保留当前设置备份，导入文件中的连接和外观选项会立即替换当前内容。",
        confirmText: "导入",
      });
      if (!accepted) return;

      setBusy(true);
      const next = await api.importConfig(parsed);
      setDraft(next);
      onConfigChange(next);
      setBackups((await api.listConfigBackups()).backups);
      toast.success("设置已导入");
    } catch (error) {
      toast.error(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const createBackup = async () => {
    setBusy(true);
    try {
      await api.createConfigBackup();
      setBackups((await api.listConfigBackups()).backups);
      toast.success("已创建设置备份");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async (backup: ConfigBackupInfo) => {
    const accepted = await confirm({
      title: "恢复设置备份",
      description: `将恢复 ${formatBackupDate(backup.createdAt)} 的设置，当前内容会先自动备份。`,
      confirmText: "恢复",
    });
    if (!accepted) return;

    setBusy(true);
    try {
      const next = await api.restoreConfigBackup(backup.name);
      setDraft(next);
      onConfigChange(next);
      setBackups((await api.listConfigBackups()).backups);
      toast.success("设置已恢复");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeBackup = async (backup: ConfigBackupInfo) => {
    const accepted = await confirm({
      title: "删除设置备份",
      description: `将删除 ${formatBackupDate(backup.createdAt)} 的备份，之后无法恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (!accepted) return;

    setBusy(true);
    try {
      await api.removeConfigBackup(backup.name);
      setBackups((await api.listConfigBackups()).backups);
      toast.success("备份已删除");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const clearBackups = async () => {
    if (!backups.length) return;

    const accepted = await confirm({
      title: "清理全部备份",
      description: `将删除当前保存的 ${backups.length} 份备份，之后无法恢复。`,
      confirmText: "清理",
      danger: true,
    });
    if (!accepted) return;

    setBusy(true);
    try {
      await api.clearConfigBackups();
      setBackups((await api.listConfigBackups()).backups);
      toast.success("备份已清理");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const inject = async () => {
    const accepted = await confirm({
      title: "连接到 Cursor",
      description: "Cursor 将使用当前连接方式。开始前请确认连接服务已准备就绪。",
      confirmText: "连接",
      danger: true,
    });
    if (!accepted) return;

    setBusy(true);
    try {
      setState(await api.injectCursorProxy());
      setCursor(await api.cursorStatus());
      onConfigChange(await api.getConfig());
      toast.success("已连接到 Cursor");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const detach = async () => {
    setBusy(true);
    try {
      setState(await api.detachCursorProxy());
      setCursor(await api.cursorStatus());
      onConfigChange(await api.getConfig());
      toast.success("已移除连接");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const clearDead = async () => {
    const accepted = await confirm({
      title: "修复旧连接",
      description: "仅会清理由本应用创建、但当前已失效的连接设置。",
      confirmText: "修复",
    });
    if (!accepted) return;

    setBusy(true);
    try {
      const result = await api.clearCursorProxy();
      setCursor(await api.cursorStatus());
      if (result.cleared) toast.success("已修复旧连接");
      else toast.message(result.skippedReason || "没有需要修复的连接");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const installCa = async () => {
    const accepted = await confirm({
      title: "安装安全证书",
      description: "安装后可稳定建立需要安全验证的连接，之后可随时从系统设置中移除。",
      confirmText: "安装",
    });
    if (!accepted) return;

    setBusy(true);
    try {
      const result = await api.installProxyCa();
      setCa(await api.getProxyCa());
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const exportDiagnosticsPack = async () => {
    setBusy(true);
    try {
      await api.exportDiagnostics();
      toast.success("支持信息已导出");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const cursorConnected = Boolean(state?.running && cursor?.proxy);
  const certificateReady = Boolean(ca?.exists);
  const connectionStatus = cursorConnected ? "已连接" : state?.running ? "等待连接" : "未连接";

  return (
    <main className="cs-page config-workspace" aria-label="设置">
      {ConfirmDialog}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="config-workspace__file-input"
        onChange={(event) => void importConfigFile(event)}
      />

      <header className="config-workspace__toolbar workspace-layer-enter">
        <div className="config-workspace__context">
          <span className={`config-workspace__context-dot ${cursorConnected ? "is-ready" : state?.running ? "is-pending" : ""}`} aria-hidden="true" />
          <span className="config-workspace__context-label">连接状态</span>
          <small>{loading ? "正在检查" : connectionStatus}</small>
        </div>

        <div className="config-workspace__actions">
          <Button
            type="button"
            variant="outline"
            className="config-workspace__icon-action"
            onClick={() => void refresh(true)}
            disabled={busy || refreshing}
            title="刷新状态"
            aria-label="刷新状态"
          >
            <RefreshCw className={refreshing ? "workspace-refresh-icon is-spinning" : "workspace-refresh-icon"} />
          </Button>
          <Button
            type="button"
            className="config-workspace__primary-action"
            onClick={() => void save()}
            disabled={busy}
          >
            <Save /> 保存设置
          </Button>
        </div>
      </header>

      {loading ? (
        <ConfigInitialSkeleton />
      ) : loadError ? (
        <section className="config-workspace__error workspace-layer-enter workspace-layer-enter--delay-1" role="alert">
          <ShieldAlert />
          <div>
            <strong>暂时未能加载设置状态</strong>
            <p>请检查连接状态后重新加载。</p>
          </div>
          <Button type="button" variant="outline" className="config-workspace__text-action" onClick={() => void refresh(true)}>
            <RefreshCw /> 重试
          </Button>
        </section>
      ) : (
        <>
          <section className="config-workspace__settings-grid workspace-layer-enter workspace-layer-enter--delay-1" aria-label="连接和运行设置">
            <section className="config-workspace__panel">
              <div className="config-workspace__panel-head">
                <div>
                  <h2>连接选项</h2>
                  <p>通常无需修改，遇到连接问题时再调整。</p>
                </div>
                <span className="config-workspace__panel-marker" aria-hidden="true">
                  <Link2 />
                </span>
              </div>
              <div className="config-workspace__panel-body config-workspace__address-grid">
                <Field label="应用地址" hint="通常无需修改">
                  <Input
                    className="config-workspace__field-input"
                    value={draft.proxyListenAddr}
                    onChange={(event) => setDraft((current) => ({ ...current, proxyListenAddr: event.target.value }))}
                  />
                </Field>
                <Field label="管理地址" hint="通常无需修改">
                  <Input
                    className="config-workspace__field-input"
                    value={draft.backendListenAddr}
                    onChange={(event) => setDraft((current) => ({ ...current, backendListenAddr: event.target.value }))}
                  />
                </Field>
              </div>
            </section>

            <section className="config-workspace__panel">
              <div className="config-workspace__panel-head">
                <div>
                  <h2>连接方式</h2>
                  <p>选择 Cursor 使用的连接方式。</p>
                </div>
                <span className="config-workspace__panel-marker" aria-hidden="true">
                  <ShieldCheck />
                </span>
              </div>
              <div className="config-workspace__panel-body">
                <Field label="连接选项">
                  <SimpleSelect
                    className="config-workspace__field-input"
                    value={draft.routingMode}
                    onValueChange={(value) => setDraft((current) => ({ ...current, routingMode: value }))}
                    options={[
                      { value: "local", label: "使用 Studio（推荐）" },
                      { value: "upstream", label: "使用 Cursor 默认连接" },
                    ]}
                  />
                </Field>
                <p className="config-workspace__field-note">保存后会在下次连接时生效。</p>
              </div>
            </section>
          </section>

          <section className="config-workspace__panel config-workspace__backup-panel workspace-layer-enter workspace-layer-enter--delay-2" aria-label="备份与恢复">
            <div className="config-workspace__panel-head">
              <div>
                <h2>备份与恢复</h2>
                <p>保存当前设置，也可以导入、导出或恢复已保存的内容。最多保留最近三份备份。</p>
              </div>
              <div className="config-workspace__panel-actions">
                <Button type="button" variant="outline" className="config-workspace__icon-action" onClick={exportConfig} title="导出设置" aria-label="导出设置">
                  <Download />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="config-workspace__icon-action"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  title="导入设置"
                  aria-label="导入设置"
                >
                  <Upload />
                </Button>
                <Button type="button" variant="outline" className="config-workspace__text-action" onClick={() => void createBackup()} disabled={busy}>
                  <Archive /> 创建备份
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="config-workspace__text-action is-danger"
                  onClick={() => void clearBackups()}
                  disabled={busy || !backups.length}
                >
                  <Trash2 /> 清理备份
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="config-workspace__icon-action"
                  onClick={() => void exportDiagnosticsPack()}
                  disabled={busy}
                  title="导出支持信息"
                  aria-label="导出支持信息"
                >
                  <Stethoscope />
                </Button>
              </div>
            </div>
            <div className="config-workspace__backup-list">
              {backups.length ? (
                backups.slice(0, 3).map((backup) => (
                  <div className="config-workspace__backup-row" key={backup.name}>
                    <span className="config-workspace__backup-icon" aria-hidden="true">
                      <Archive />
                    </span>
                    <div className="config-workspace__backup-copy">
                      <strong>{formatBackupDate(backup.createdAt)}</strong>
                      <span>{formatBackupSize(backup.size)}</span>
                    </div>
                    <div className="config-workspace__backup-actions">
                      <Button
                        type="button"
                        variant="outline"
                        className="config-workspace__icon-action"
                        title="恢复此备份"
                        aria-label="恢复此备份"
                        onClick={() => void restoreBackup(backup)}
                        disabled={busy}
                      >
                        <RotateCcw />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="config-workspace__icon-action is-danger"
                        title="删除此备份"
                        aria-label="删除此备份"
                        onClick={() => void removeBackup(backup)}
                        disabled={busy}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="config-workspace__backup-empty">
                  <Archive />
                  <div>
                    <strong>还没有设置备份</strong>
                    <p>创建备份后可以在这里恢复。</p>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="config-workspace__maintenance-grid workspace-layer-enter workspace-layer-enter--delay-3" aria-label="连接和安全维护">
            <section className="config-workspace__panel config-workspace__maintenance-card">
              <div className="config-workspace__panel-head">
                <div>
                  <h2>Cursor 连接</h2>
                  <p>{cursorConnected ? "Cursor 正在使用当前连接方式。" : state?.running ? "连接服务已准备，等待 Cursor 连接。" : "准备好连接服务后可在这里连接。"}</p>
                </div>
                <span className={`config-workspace__status ${cursorConnected ? "is-success" : ""}`}>
                  {cursorConnected ? "已连接" : "未连接"}
                </span>
              </div>
              <div className="config-workspace__maintenance-body">
                {state?.lastError ? (
                  <div className="config-workspace__notice is-warning">
                    <ShieldAlert />
                    <span>上一次连接未完成，请检查连接状态后再试。</span>
                  </div>
                ) : null}
                <div className="config-workspace__maintenance-actions">
                  <Button type="button" className="config-workspace__primary-action" onClick={() => void inject()} disabled={busy || !state?.running}>
                    <Link2 /> 连接 Cursor
                  </Button>
                  <Button type="button" variant="outline" className="config-workspace__text-action" onClick={() => void detach()} disabled={busy}>
                    <Unplug /> 移除连接
                  </Button>
                  <Button type="button" variant="outline" className="config-workspace__text-action" onClick={() => void clearDead()} disabled={busy}>
                    修复连接
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="config-workspace__icon-action"
                    onClick={() => void api.openCursorSettings()}
                    title="打开 Cursor 设置"
                    aria-label="打开 Cursor 设置"
                  >
                    <FolderOpen />
                  </Button>
                </div>
              </div>
            </section>

            <section className="config-workspace__panel config-workspace__maintenance-card">
              <div className="config-workspace__panel-head">
                <div>
                  <h2>安全证书</h2>
                  <p>{certificateReady ? "证书已准备，可用于安全连接。" : "安装后可稳定处理安全连接请求。"}</p>
                </div>
                <span className={`config-workspace__status ${certificateReady ? "is-success" : ""}`}>
                  {certificateReady ? "已准备" : "未准备"}
                </span>
              </div>
              <div className="config-workspace__maintenance-body">
                <div className="config-workspace__notice">
                  <CheckCircle2 />
                  <span>安全证书只会安装到当前 Windows 账户。</span>
                </div>
                <div className="config-workspace__maintenance-actions">
                  <Button type="button" className="config-workspace__primary-action" onClick={() => void installCa()} disabled={busy}>
                    <ShieldCheck /> 安装证书
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="config-workspace__text-action"
                    onClick={() => void api.openProxyCa()}
                    disabled={busy}
                  >
                    <FolderOpen /> 查看证书
                  </Button>
                </div>
              </div>
            </section>
          </section>
        </>
      )}
    </main>
  );
}
