import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Boxes,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  Github,
  HeartHandshake,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Power,
  PowerOff,
  RefreshCw,
  Server,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { toast } from "@/components/ui/app-notice";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  getApi,
  type AppConfig,
  type HomeMetrics,
  type ServiceState,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  APP_RELEASE,
  isReleasePromotionActive,
  type ReleaseCheckResult,
  type ReleaseControl,
  type ReleasePromotion,
  type ReleaseUpdate,
} from "@/lib/release";
import { useConfirm } from "@/components/ui/confirm";

type HomeDestination =
  | "providers"
  | "usage"
  | "prompts"
  | "mcp"
  | "sessions"
  | "config";

function formatCompact(value?: number | null): string {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1_000) return Math.round(number).toLocaleString("zh-CN");
  if (number < 1_000_000) {
    return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
}

function formatCost(value?: number | null): string {
  const number = Math.max(0, Number(value) || 0);
  if (number === 0) return "$0.00";
  if (number < 0.01) return "<$0.01";
  return `$${number.toFixed(number < 1 ? 2 : 1)}`;
}

function formatUpdatedAt(value?: string): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚更新";
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚更新";
  if (elapsed >= 0 && elapsed < 60 * 60_000) {
    return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  }
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HomePage({
  config,
  onConfigChange,
  onNavigate,
  releaseControl,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onNavigate: (view: HomeDestination) => void;
  releaseControl?: ReleaseControl;
}) {
  const api = getApi();
  const { confirm, ConfirmDialog } = useConfirm();
  const [state, setState] = useState<ServiceState | null>(null);
  const [metrics, setMetrics] = useState<HomeMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [serviceLoading, setServiceLoading] = useState(true);
  const [homeLoadError, setHomeLoadError] = useState<string | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<ReleaseUpdate | null>(null);
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [cacheMotionProgress, setCacheMotionProgress] = useState(0);
  const [cacheMotionSettled, setCacheMotionSettled] = useState(false);
  const metricsLoadedRef = useRef(false);
  const cacheMotionStartedRef = useRef(false);
  const promptedReleaseVersionRef = useRef<string | null>(null);

  const refreshService = async () => {
    try {
      setState(await api.serviceState());
    } finally {
      setServiceLoading(false);
    }
  };

  const refreshMetrics = async () => {
    const isInitialLoad = !metricsLoadedRef.current;
    if (isInitialLoad) setMetricsLoading(true);
    try {
      const nextMetrics = await api.getHomeMetrics();
      setMetrics(nextMetrics);
      metricsLoadedRef.current = true;
    } finally {
      if (isInitialLoad) setMetricsLoading(false);
    }
  };

  const refreshAll = async (showActivity = false) => {
    const startedAt = showActivity ? performance.now() : 0;
    if (showActivity) setRefreshing(true);
    try {
      await Promise.all([refreshService(), refreshMetrics()]);
      setHomeLoadError(null);
    } catch {
      setHomeLoadError("暂时未能加载概览数据");
    } finally {
      if (showActivity) {
        const remaining = 300 - (performance.now() - startedAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
        }
        setRefreshing(false);
      }
    }
  };

  const openExternal = async (url: string) => {
    try {
      await api.openExternal(url);
    } catch {
      toast.error("暂时无法打开链接，请稍后再试");
    }
  };

  const checkForUpdates = async () => {
    if (!releaseControl) {
      toast.message("更新服务正在准备中");
      return;
    }

    setUpdateCheckBusy(true);
    try {
      const result: ReleaseCheckResult = await releaseControl.checkForUpdates();
      if (result.status === "available") {
        promptedReleaseVersionRef.current = result.update.version;
        setPendingUpdate(result.update);
        return;
      }
      if (result.status === "unavailable") {
        toast.error(result.message || "暂时无法检查更新");
        return;
      }
      toast.success("当前已是最新版本");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "暂时无法检查更新");
    } finally {
      setUpdateCheckBusy(false);
    }
  };

  const installUpdate = async () => {
    if (!pendingUpdate || !releaseControl) return;

    setUpdateInstalling(true);
    try {
      await releaseControl.installUpdate(pendingUpdate);
      toast.message("正在下载更新并准备重新启动");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新暂时未完成，请稍后重试");
      setUpdateInstalling(false);
    }
  };

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => void refreshAll(), 4_000);
    return () => window.clearInterval(timer);
  }, []);

  const availableUpdate = releaseControl?.state?.availableUpdate ?? null;
  const availableUpdateVersion = availableUpdate?.version ?? null;

  useEffect(() => {
    if (!availableUpdate || promptedReleaseVersionRef.current === availableUpdate.version) return;
    promptedReleaseVersionRef.current = availableUpdate.version;
    setPendingUpdate(availableUpdate);
  }, [availableUpdate, availableUpdateVersion]);

  useEffect(() => {
    if (metricsLoading || !metrics || cacheMotionStartedRef.current) return;

    let prepareFrame: number | null = null;
    let animationFrame: number | null = null;
    const duration = 720;

    prepareFrame = window.requestAnimationFrame(() => {
      const startedAt = performance.now();
      const animate = (now: number) => {
        const elapsed = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - elapsed, 3);
        setCacheMotionProgress(eased);

        if (elapsed < 1) {
          animationFrame = window.requestAnimationFrame(animate);
          return;
        }

        cacheMotionStartedRef.current = true;
        setCacheMotionProgress(1);
        setCacheMotionSettled(true);
      };

      animationFrame = window.requestAnimationFrame(animate);
    });

    return () => {
      if (prepareFrame !== null) window.cancelAnimationFrame(prepareFrame);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [metrics, metricsLoading]);

  const toggleService = async () => {
    if (serviceLoading || busy) return;
    setBusy(true);
    try {
      if (state?.running) {
        const accepted = await confirm({
          title: "停止服务？",
          description: "停止后，Cursor 将暂时停止使用已配置的模型服务。",
          confirmText: "停止服务",
          danger: true,
        });
        if (!accepted) return;
        setState(await api.stopService());
        toast.success("服务已停止");
      } else {
        setState(await api.startService());
        toast.success("服务已开启");
      }
      onConfigChange(await api.getConfig());
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const running = Boolean(state?.running);
  const proxyStats = state?.proxyStats;
  const forwarded =
    Number(proxyStats?.httpRelay || 0) +
    Number(proxyStats?.mitmRelay || 0) +
    Number(proxyStats?.tunnelPass || 0);
  const errorCount = Number(proxyStats?.errors || 0);
  const providers = config.providers || [];
  const promotions = (releaseControl?.state?.promotions ?? [])
    .filter((promotion) => isReleasePromotionActive(promotion))
    .slice()
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  const enabledProviders = providers.filter((provider) => provider.enabled).length;
  const turns = Number(metrics?.turnsTotal || 0);
  const validTurns = Number(metrics?.validTurnsTotal || 0);
  const successRate = turns > 0 ? `${Math.round((validTurns / turns) * 100)}%` : "—";
  const cacheReadTokens = Math.max(0, Number(metrics?.cacheReadTokens || 0));
  const cacheWriteTokens = Math.max(0, Number(metrics?.cacheWriteTokens || 0));
  const promptTokens = Math.max(0, Number(metrics?.promptTokensTotal || 0));
  const uncachedPromptTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const cacheHitBase =
    cacheReadTokens +
    uncachedPromptTokens +
    (metrics?.includeCacheWriteInHitRate ? cacheWriteTokens : 0);
  const cacheHitRate = cacheHitBase > 0 ? cacheReadTokens / cacheHitBase : 0;
  const cacheHitPercent = Math.min(100, Math.max(0, cacheHitRate * 100));
  const cacheRingLength = 100;
  const hasCacheData = cacheHitBase > 0;
  const cacheHitLabel = hasCacheData ? `${cacheHitPercent.toFixed(1)}%` : "—";
  const cacheCompositionTotal = cacheReadTokens + uncachedPromptTokens + cacheWriteTokens;
  const cacheReadProgress = cacheCompositionTotal > 0 ? (cacheReadTokens / cacheCompositionTotal) * 100 : 0;
  const directInputProgress = cacheCompositionTotal > 0 ? (uncachedPromptTokens / cacheCompositionTotal) * 100 : 0;
  const cacheWriteProgress = cacheCompositionTotal > 0 ? (cacheWriteTokens / cacheCompositionTotal) * 100 : 0;
  const displayedCacheHitPercent = cacheHitPercent * cacheMotionProgress;
  const displayedCacheHitLabel = hasCacheData ? `${displayedCacheHitPercent.toFixed(1)}%` : "—";
  const displayedCacheReadProgress = cacheReadProgress * cacheMotionProgress;
  const displayedDirectInputProgress = directInputProgress * cacheMotionProgress;
  const displayedCacheWriteProgress = cacheWriteProgress * cacheMotionProgress;
  const isInitialMetricsLoad = metricsLoading && metrics === null;
  const isInitialLoadError = Boolean(homeLoadError && metrics === null && !metricsLoading);

  if (isInitialMetricsLoad) {
    return (
      <div className="cs-page home-page home-product-home home-loading-layout" aria-busy="true" aria-label="正在加载概览数据">
        {ConfirmDialog}
        <HomeSupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
        <HomeUpdateDialog
          update={pendingUpdate}
          installing={updateInstalling}
          onOpenChange={(open) => !open && !updateInstalling && setPendingUpdate(null)}
          onInstall={() => void installUpdate()}
        />
        <HomeSupportPanel
          onJoinGroup={() => void openExternal("https://qm.qq.com/q/Vaok2TJ9GG")}
          onContactAuthor={() => void openExternal("https://qm.qq.com/q/uYwWVLfnvc")}
          onSponsor={() => setSupportOpen(true)}
          onOpenRepository={() => void openExternal(releaseControl?.repositoryUrl || APP_RELEASE.repositoryUrl)}
          onCheckForUpdates={() => void checkForUpdates()}
          checkingUpdates={updateCheckBusy || Boolean(releaseControl?.state?.checking)}
        />
        <HomeInitialSkeleton />
        <HomePromotionSpotlight promotions={promotions} onOpen={(url) => void openExternal(url)} />
      </div>
    );
  }

  if (isInitialLoadError) {
    return (
      <div className="cs-page home-page home-product-home home-loading-layout home-error-layout" role="alert">
        {ConfirmDialog}
        <HomeUpdateDialog
          update={pendingUpdate}
          installing={updateInstalling}
          onOpenChange={(open) => !open && !updateInstalling && setPendingUpdate(null)}
          onInstall={() => void installUpdate()}
        />
        <HomeLoadError refreshing={refreshing} onRetry={() => void refreshAll(true)} />
      </div>
    );
  }

  return (
    <div className="cs-page home-page home-product-home">
      {ConfirmDialog}
      <HomeSupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
      <HomeUpdateDialog
        update={pendingUpdate}
        installing={updateInstalling}
        onOpenChange={(open) => !open && !updateInstalling && setPendingUpdate(null)}
        onInstall={() => void installUpdate()}
      />
      <HomeSupportPanel
        onJoinGroup={() => void openExternal("https://qm.qq.com/q/Vaok2TJ9GG")}
        onContactAuthor={() => void openExternal("https://qm.qq.com/q/uYwWVLfnvc")}
        onSponsor={() => setSupportOpen(true)}
        onOpenRepository={() => void openExternal(releaseControl?.repositoryUrl || APP_RELEASE.repositoryUrl)}
        onCheckForUpdates={() => void checkForUpdates()}
        checkingUpdates={updateCheckBusy || Boolean(releaseControl?.state?.checking)}
      />

      <section className="home-analytics-panel home-product-surface workspace-layer-enter" aria-label="缓存与 Token 使用数据">
        <div className="home-cache-visual">
          <div className="home-insight-heading">
            <span>缓存命中率</span>
            <strong>{displayedCacheHitLabel}</strong>
          </div>
          <div className="home-cache-content">
            <div className="home-cache-ring" role="img" aria-label={`缓存命中率 ${cacheHitLabel}`}>
              <svg viewBox="0 0 112 112" aria-hidden="true">
                <circle className="home-cache-ring-track" cx="56" cy="56" r="43" pathLength={cacheRingLength} />
                {hasCacheData ? (
                  <circle
                    className={cn("home-cache-ring-value", cacheMotionSettled && "is-settled")}
                    cx="56"
                    cy="56"
                    r="43"
                    pathLength={cacheRingLength}
                    strokeDasharray={`${displayedCacheHitPercent} ${cacheRingLength}`}
                    transform="rotate(-90 56 56)"
                  />
                ) : null}
              </svg>
              <span>
                <strong>{hasCacheData ? `${displayedCacheHitPercent.toFixed(0)}%` : "—"}</strong>
                <small>{hasCacheData ? "命中" : "暂无数据"}</small>
              </span>
            </div>
            <dl className="home-cache-breakdown">
              <div className="is-cache-read">
                <div className="home-cache-breakdown-line">
                  <dt>缓存读取</dt>
                  <dd>{formatCompact(cacheReadTokens)}</dd>
                </div>
                <span className="home-cache-progress" aria-hidden="true">
                  <span
                    className={cn(cacheMotionSettled && "is-settled")}
                    style={{ width: `${displayedCacheReadProgress}%` }}
                  />
                </span>
              </div>
              <div className="is-direct-input">
                <div className="home-cache-breakdown-line">
                  <dt>直接输入</dt>
                  <dd>{formatCompact(uncachedPromptTokens)}</dd>
                </div>
                <span className="home-cache-progress" aria-hidden="true">
                  <span
                    className={cn(cacheMotionSettled && "is-settled")}
                    style={{ width: `${displayedDirectInputProgress}%` }}
                  />
                </span>
              </div>
              <div className="is-cache-write">
                <div className="home-cache-breakdown-line">
                  <dt>缓存写入</dt>
                  <dd>{formatCompact(cacheWriteTokens)}</dd>
                </div>
                <span className="home-cache-progress" aria-hidden="true">
                  <span
                    className={cn(cacheMotionSettled && "is-settled")}
                    style={{ width: `${displayedCacheWriteProgress}%` }}
                  />
                </span>
              </div>
            </dl>
          </div>
        </div>

        <button
          type="button"
          className={cn("home-service-toggle", running ? "is-stop" : "is-start")}
          disabled={busy || serviceLoading}
          onClick={() => void toggleService()}
        >
          {busy || serviceLoading ? (
            <RefreshCw className="animate-spin" />
          ) : running ? (
            <PowerOff />
          ) : (
            <Power />
          )}
          <span>{busy ? "处理中" : serviceLoading ? "加载中" : running ? "停止服务" : "开启服务"}</span>
        </button>
      </section>

      <section className="home-health-panel home-product-surface workspace-layer-enter workspace-layer-enter--delay-1" aria-labelledby="health-title">
        <header className="home-product-panel-head">
          <div>
            <span className="home-panel-icon is-blue">
              <Activity />
            </span>
            <h2 id="health-title">运行概况</h2>
          </div>
          <button
            type="button"
            className="home-icon-command"
            onClick={() => void refreshAll(true)}
            disabled={metricsLoading || serviceLoading || refreshing}
            title="刷新状态"
          >
            <RefreshCw
              className={cn(
                "workspace-refresh-icon",
                "home-refresh-icon",
                refreshing && "is-spinning animate-spin",
              )}
            />
          </button>
        </header>

        <div className="home-health-metrics">
          <div className="home-health-metric">
            <span>服务状态</span>
            <strong className={cn(running ? "is-green" : "is-muted")}>
              {serviceLoading ? "检查中" : running ? "正常" : "未开启"}
            </strong>
            <small>{running ? "随时可用" : "点击左侧开启"}</small>
          </div>
          <div className="home-health-metric">
            <span>累计对话</span>
            <strong>{formatCompact(turns)}</strong>
            <small>{validTurns > 0 ? `${formatCompact(validTurns)} 次成功` : "暂无记录"}</small>
          </div>
          <div className="home-health-metric">
            <span>成功率</span>
            <strong className={cn(errorCount > 0 ? "is-orange" : "is-green")}>
              {successRate}
            </strong>
            <small>{turns > 0 ? "全部对话" : "等待数据"}</small>
          </div>
        </div>
      </section>

      <div className="home-compact-grid workspace-layer-enter workspace-layer-enter--delay-2">
        <button
          type="button"
          className="home-compact-panel home-product-surface"
          onClick={() => onNavigate("providers")}
        >
          <span className="home-panel-icon is-violet">
            <Boxes />
          </span>
          <span className="home-compact-copy">
            <small>模型供应商</small>
            <strong>{enabledProviders} 个已启用</strong>
          </span>
          <ChevronRight />
        </button>
        <button
          type="button"
          className="home-compact-panel home-product-surface"
          onClick={() => onNavigate("usage")}
        >
          <span className="home-panel-icon is-green">
            <BarChart3 />
          </span>
          <span className="home-compact-copy">
            <small>本次请求</small>
            <strong>{formatCompact(forwarded)} 次</strong>
          </span>
          <ChevronRight />
        </button>
      </div>

      <section className="home-usage-summary home-product-surface workspace-layer-enter workspace-layer-enter--delay-2" aria-labelledby="usage-title">
        <header className="home-product-panel-head">
          <div>
            <span className="home-panel-icon is-orange">
              <Gauge />
            </span>
            <h2 id="usage-title">使用概览</h2>
          </div>
          <button
            type="button"
            className="home-text-command"
            onClick={() => onNavigate("usage")}
          >
            查看详情
            <ChevronRight />
          </button>
        </header>
        <div className="home-summary-rows">
          <div>
            <span>Token 用量</span>
            <strong>{formatCompact(metrics?.requestTokensTotal)}</strong>
          </div>
          <div>
            <span>费用估算</span>
            <strong>{formatCost(metrics?.estimatedCostUsd)}</strong>
          </div>
          <div>
            <span>最近更新</span>
            <strong>{formatUpdatedAt(metrics?.updatedAt)}</strong>
          </div>
        </div>
      </section>

      <section className="home-tools-panel home-product-surface workspace-layer-enter workspace-layer-enter--delay-3" aria-label="常用功能">
        <button type="button" onClick={() => onNavigate("providers")}>
          <span className="is-blue">
            <Boxes />
          </span>
          供应商
        </button>
        <button type="button" onClick={() => onNavigate("usage")}>
          <span className="is-green">
            <BarChart3 />
          </span>
          用量
        </button>
        <button type="button" onClick={() => onNavigate("prompts")}>
          <span className="is-violet">
            <FileText />
          </span>
          提示词
        </button>
        <button type="button" onClick={() => onNavigate("mcp")}>
          <span className="is-orange">
            <Server />
          </span>
          MCP
        </button>
        <button type="button" onClick={() => onNavigate("sessions")}>
          <span className="is-slate">
            <MessagesSquare />
          </span>
          会话
        </button>
      </section>
      <HomePromotionSpotlight promotions={promotions} onOpen={(url) => void openExternal(url)} />
    </div>
  );
}

function HomePromotionSpotlight({
  promotions,
  onOpen,
}: {
  promotions: readonly ReleasePromotion[];
  onOpen: (url: string) => void;
}) {
  const [promotionIndex, setPromotionIndex] = useState(0);
  const promotionCount = promotions.length;
  const safeIndex = Math.min(promotionIndex, Math.max(0, promotionCount - 1));
  const promotion = promotions[safeIndex];

  useEffect(() => {
    if (promotionCount < 2) return;
    const timer = window.setInterval(() => {
      setPromotionIndex((current) => (current + 1) % promotionCount);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [promotionCount]);

  if (!promotion) return null;

  const isVacancy = promotion.kind === "vacancy";
  const movePromotion = (offset: number) => {
    setPromotionIndex((current) => (current + offset + promotionCount) % promotionCount);
  };

  return (
    <section className="home-promotion-spotlight home-product-surface workspace-layer-enter workspace-layer-enter--delay-3" aria-label="精选服务">
      <div
        key={promotion.id}
        className="home-promotion-spotlight__content"
      >
        <span className={cn("home-promotion-spotlight__icon", isVacancy && "is-vacancy")} aria-hidden="true">
          {isVacancy ? <Megaphone /> : <Sparkles />}
        </span>
        <span className="home-promotion-spotlight__copy">
          <small className="home-promotion-spotlight__label">{promotion.label}</small>
          <strong className="home-promotion-spotlight__title">{promotion.title}</strong>
          <span className="home-promotion-spotlight__description">{promotion.description}</span>
        </span>
        <button
          type="button"
          className="home-promotion-spotlight__action"
          onClick={() => onOpen(promotion.href)}
          title={promotion.action}
        >
          <span>{promotion.action}</span>
          <ChevronRight />
        </button>
      </div>

      {promotionCount > 1 ? (
        <nav className="home-promotion-spotlight__controls" aria-label="切换精选服务">
          <button type="button" onClick={() => movePromotion(-1)} title="上一条">
            <ChevronLeft aria-hidden="true" />
          </button>
          <span className="home-promotion-spotlight__count">
            {safeIndex + 1} / {promotionCount}
          </span>
          <button type="button" onClick={() => movePromotion(1)} title="下一条">
            <ChevronRight aria-hidden="true" />
          </button>
        </nav>
      ) : null}

    </section>
  );
}

function HomeSupportPanel({
  onJoinGroup,
  onContactAuthor,
  onSponsor,
  onOpenRepository,
  onCheckForUpdates,
  checkingUpdates,
}: {
  onJoinGroup: () => void;
  onContactAuthor: () => void;
  onSponsor: () => void;
  onOpenRepository: () => void;
  onCheckForUpdates: () => void;
  checkingUpdates: boolean;
}) {
  return (
    <section className="home-support-panel home-product-surface workspace-layer-enter" aria-label="社区与支持">
      <div className="home-support-panel__title">
        <span className="home-panel-icon is-violet" aria-hidden="true">
          <HeartHandshake />
        </span>
        <span>社区与支持</span>
      </div>
      <div className="home-support-panel__actions">
        <button type="button" className="home-support-action is-group" onClick={onJoinGroup}>
          <span className="home-support-action__icon" aria-hidden="true">
            <UsersRound />
          </span>
          加入交流群
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" className="home-support-action is-contact" onClick={onContactAuthor}>
          <span className="home-support-action__icon" aria-hidden="true">
            <MessageCircle />
          </span>
          联系作者
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" className="home-support-action is-github" onClick={onOpenRepository}>
          <span className="home-support-action__icon" aria-hidden="true">
            <Github />
          </span>
          GitHub 仓库
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" className="home-support-action is-sponsor" onClick={onSponsor}>
          <span className="home-support-action__icon" aria-hidden="true">
            <HeartHandshake />
          </span>
          打赏作者
        </button>
        <button
          type="button"
          className="home-support-action is-update"
          onClick={onCheckForUpdates}
          disabled={checkingUpdates}
        >
          <span className="home-support-action__icon" aria-hidden="true">
            <RefreshCw className={cn("workspace-refresh-icon", checkingUpdates && "is-spinning")} />
          </span>
          {checkingUpdates ? "正在检查" : "检查更新"}
        </button>
      </div>
    </section>
  );
}

function HomeUpdateDialog({
  update,
  installing,
  onOpenChange,
  onInstall,
}: {
  update: ReleaseUpdate | null;
  installing: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
}) {
  return (
    <Dialog open={Boolean(update)} onOpenChange={onOpenChange}>
      <DialogContent size="sm" className="home-update-dialog" showClose={!installing}>
        <DialogHeader>
          <DialogTitle>发现新版本</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="home-update-dialog__version">
            <span>新版本</span>
            <strong>{update?.version}</strong>
          </div>
          <p className="home-update-dialog__summary">
            {update?.title || "Cursor Studio 已准备好新的功能与体验优化。"}
          </p>
          {update?.notes ? <p className="home-update-dialog__notes">{update.notes}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
            稍后再说
          </Button>
          <Button onClick={onInstall} disabled={installing}>
            <RefreshCw className={cn("h-3.5 w-3.5", installing && "workspace-refresh-icon is-spinning")} />
            {installing ? "正在更新" : "立即更新"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HomeSupportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="home-support-dialog">
        <DialogHeader>
          <DialogTitle>打赏作者</DialogTitle>
        </DialogHeader>
        <DialogBody className="home-support-dialog__body">
          <figure className="home-support-qr">
            <img src="/support-wechat-qr.png" alt="微信二维码" />
            <figcaption>微信</figcaption>
          </figure>
          <figure className="home-support-qr">
            <img src="/support-alipay-qr.png" alt="支付宝二维码" />
            <figcaption>支付宝</figcaption>
          </figure>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function HomeInitialSkeleton() {
  return (
    <>
      <section className="home-analytics-panel home-product-surface home-skeleton home-skeleton--analytics workspace-layer-enter" aria-hidden="true">
        <div className="home-skeleton__analytics-content">
          <span className="home-skeleton__line home-skeleton__line--heading" />
          <span className="home-skeleton__ring" />
          <div className="home-skeleton__rows">
            <span />
            <span />
            <span />
          </div>
        </div>
        <span className="home-skeleton__button" />
      </section>

      <section className="home-health-panel home-product-surface home-skeleton home-skeleton--health workspace-layer-enter workspace-layer-enter--delay-1" aria-hidden="true">
        <span className="home-skeleton__line home-skeleton__line--heading" />
        <div className="home-skeleton__metrics">
          <span />
          <span />
          <span />
        </div>
      </section>

      <div className="home-compact-grid workspace-layer-enter workspace-layer-enter--delay-2" aria-hidden="true">
        <div className="home-compact-panel home-product-surface home-skeleton home-skeleton--compact" />
        <div className="home-compact-panel home-product-surface home-skeleton home-skeleton--compact" />
      </div>

      <section className="home-usage-summary home-product-surface home-skeleton home-skeleton--summary workspace-layer-enter workspace-layer-enter--delay-2" aria-hidden="true">
        <span className="home-skeleton__line home-skeleton__line--heading" />
        <div className="home-skeleton__summary-rows">
          <span />
          <span />
          <span />
        </div>
      </section>

      <section className="home-tools-panel home-product-surface home-skeleton home-skeleton--tools workspace-layer-enter workspace-layer-enter--delay-3" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </section>
    </>
  );
}

function HomeLoadError({
  refreshing,
  onRetry,
}: {
  refreshing: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="home-load-error workspace-layer-enter">
      <Activity aria-hidden="true" />
      <div>
        <strong>暂时未能加载概览</strong>
        <p>请确认本地服务已启动后重新加载。</p>
      </div>
      <button type="button" className="home-load-error__retry" onClick={onRetry} disabled={refreshing}>
        <RefreshCw className={cn("workspace-refresh-icon", refreshing && "is-spinning")} />
        重新加载
      </button>
    </section>
  );
}
