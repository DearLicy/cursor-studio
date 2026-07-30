import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  BarChart3,
  Boxes,
  FileText,
  Home,
  Languages,
  MessagesSquare,
  Plus,
  Save,
  Server,
  Settings2,
  Sparkles,
} from "lucide-react";
import {
  appearanceMediaType,
  appearanceMediaUrl,
  getApi,
  waitForApi,
  type AppearanceConfig,
  type AppUpdateInfo,
  type AppConfig,
  type HomePromotion,
  type SizeModel,
  type UpdateCheckResult,
  type UpdateProgress,
} from "@/lib/api";
import { HomePage } from "@/pages/HomePage";
import { ProvidersPage } from "@/pages/ProvidersPage";
import { SettingsPage, type SettingsTab } from "@/pages/SettingsPage";
import { UsagePage } from "@/pages/UsagePage";
import { McpPage } from "@/pages/McpPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { SessionsPage } from "@/pages/SessionsPage";
import { PromptsPage } from "@/pages/PromptsPage";
import { cn } from "@/lib/utils";
import { appIconUrl } from "@/lib/app-icon";
import flagChina from "@/assets/flag-cn.svg";
import flagUnitedStates from "@/assets/flag-us.svg";
import { resolveLocale, setI18nLocale, type AppLocale } from "@/lib/i18n";
import { translateUpdateMessage, updateMessageDetail } from "@/lib/update-message";
import { AppNoticeProvider } from "@/components/ui/app-notice";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { WindowControls } from "@/components/ui/window-controls";
import {
  APP_RELEASE,
  APP_VERSION,
  type ReleaseCheckResult,
  type ReleaseControl,
  type ReleasePromotion,
  type ReleaseUpdate,
} from "@/lib/release";

type View =
  | "home"
  | "usage"
  | "providers"
  | "prompts"
  | "mcp"
  | "skills"
  | "sessions"
  | "config";

type NavItem = { id: View; label: string; icon: ReactNode };

const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "概览", icon: <Home className="h-4 w-4" /> },
  { id: "usage", label: "用量", icon: <BarChart3 className="h-4 w-4" /> },
  { id: "providers", label: "供应商", icon: <Boxes className="h-4 w-4" /> },
  { id: "sessions", label: "会话", icon: <MessagesSquare className="h-4 w-4" /> },
  { id: "prompts", label: "提示词", icon: <FileText className="h-4 w-4" /> },
  { id: "mcp", label: "MCP", icon: <Server className="h-4 w-4" /> },
  { id: "skills", label: "Skills", icon: <Sparkles className="h-4 w-4" /> },
  { id: "config", label: "设置", icon: <Settings2 className="h-4 w-4" /> },
];

const ALL_NAV = NAV_ITEMS;

function viewTitle(view: View): string {
  return ALL_NAV.find((item) => item.id === view)?.label || "Cursor Studio";
}

function formatReleaseVersion(version: string): string {
  const value = String(version || "").trim();
  return value ? (value.startsWith("v") || value.startsWith("V") ? value : `v${value}`) : APP_VERSION;
}

function toReleaseUpdate(update?: AppUpdateInfo): ReleaseUpdate | null {
  if (!update) return null;
  return {
    version: formatReleaseVersion(update.version),
    title: update.title,
    notes: update.notes,
    publishedAt: update.publishedAt,
    downloadUrl: update.downloadUrl,
    sizeBytes: update.size,
    sha256: update.sha256,
  };
}

function toReleasePromotions(promotions: HomePromotion[]): ReleasePromotion[] {
  return promotions.map((promotion) => ({
    id: promotion.id,
    label: promotion.label,
    title: promotion.title,
    description: promotion.description,
    action: promotion.action,
    href: promotion.href,
    kind: promotion.kind,
  }));
}

function toReleaseCheckResult(result: UpdateCheckResult): ReleaseCheckResult {
  const update = result.state === "available" ? toReleaseUpdate(result.update) : null;
  if (update) {
    return {
      status: "available",
      currentVersion: formatReleaseVersion(result.currentVersion),
      checkedAt: result.checkedAt,
      update,
    };
  }

  if (result.state === "up-to-date") {
    return {
      status: "up-to-date",
      currentVersion: formatReleaseVersion(result.currentVersion),
      checkedAt: result.checkedAt,
    };
  }

  return {
    status: "unavailable",
    currentVersion: formatReleaseVersion(result.currentVersion),
    checkedAt: result.checkedAt,
    message: translateUpdateMessage(result.message, "check-failed"),
  };
}

function AppWindowbar({
  hasUpdate = false,
  locale,
  onLocaleChange,
}: {
  hasUpdate?: boolean;
  locale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
}) {
  const { t } = useTranslation();
  const activeLocale = resolveLocale(locale);

  return (
    <header className="app-windowbar" data-drag-region>
      <div className="app-windowbar-brand">
        <img className="app-windowbar-brand-icon" src={appIconUrl} alt="" draggable={false} />
        <span className="app-windowbar-brand-name">Cursor Studio</span>
        <span
          className={cn("app-windowbar-version-tag", hasUpdate && "has-update")}
          aria-label={hasUpdate ? `发现新版本，当前版本 ${APP_VERSION}` : `当前版本 ${APP_VERSION}`}
        >
          {APP_VERSION}
        </span>
      </div>
      <div className="app-windowbar-actions" data-no-drag>
        <Select
          value={activeLocale}
          onValueChange={(value) => onLocaleChange(value as Exclude<AppLocale, "system">)}
        >
          <SelectTrigger
            className="app-language-trigger"
            aria-label={t("language.title")}
            title={t("language.title")}
          >
            <Languages aria-hidden="true" />
          </SelectTrigger>
          <SelectContent className="app-language-content" align="end">
            <SelectItem value="en">
              <span className="app-language-option">
                <img className="app-language-flag" src={flagUnitedStates} alt="" />
                <span>{t("language.english")}</span>
              </span>
            </SelectItem>
            <SelectItem value="zh-CN">
              <span className="app-language-option">
                <img className="app-language-flag" src={flagChina} alt="" />
                <span>{t("language.chineseSimplified")}</span>
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <WindowControls />
      </div>
    </header>
  );
}

function AppRoot() {
  const { i18n: translationEngine } = useTranslation();
  const [view, setView] = useState<View>("home");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Provider editor commands are single-use. Keeping a completed counter here
  // would replay "new provider" whenever the directory is mounted again.
  const [addTick, setAddTick] = useState<number | null>(null);
  const [providerEditing, setProviderEditing] = useState(false);
  const [providerReturnTick, setProviderReturnTick] = useState(0);
  const [providerSaveTick, setProviderSaveTick] = useState(0);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("proxy");
  const [booting, setBooting] = useState(true);
  const [previewAppearance, setPreviewAppearance] = useState<AppearanceConfig | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckResult | null>(null);
  const [releasePromotions, setReleasePromotions] = useState<ReleasePromotion[]>([]);
  const [releaseChecking, setReleaseChecking] = useState(false);
  const [releaseInstalling, setReleaseInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await (await waitForApi(8000)).getConfig();
        if (!cancelled) {
          await setI18nLocale(cfg.locale || "system");
          setConfig(cfg);
          setPreviewAppearance(cfg.appearance);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeProgress: () => void = () => undefined;

    void (async () => {
      try {
        const api = await waitForApi(8_000);
        const [status, promotions] = await Promise.all([
          api.getUpdateStatus().catch(() => null),
          api.getHomePromotions().catch(() => null),
        ]);
        if (disposed) return;
        if (status) setUpdateStatus(status);
        if (status?.promotions) {
          setReleasePromotions(toReleasePromotions(status.promotions));
        } else if (promotions) {
          setReleasePromotions(toReleasePromotions(promotions.promotions));
        }

        unsubscribe = api.onUpdateStatus((nextStatus) => {
          if (disposed) return;
          setUpdateStatus(nextStatus);
          if (nextStatus.promotions) {
            setReleasePromotions(toReleasePromotions(nextStatus.promotions));
            return;
          }
          void api
            .getHomePromotions()
            .then((nextPromotions) => {
              if (!disposed) setReleasePromotions(toReleasePromotions(nextPromotions.promotions));
            })
            .catch(() => undefined);
        });
        unsubscribeProgress = api.onUpdateProgress((progress) => {
          if (!disposed) setUpdateProgress(progress);
        });
      } catch {
        // The rest of the app already reports a control-plane connection error.
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeProgress();
    };
  }, []);

  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [view, providerEditing]);

  const navigate = (next: View) => {
    if (next !== "providers") setProviderEditing(false);
    setView(next);
  };

  const addProvider = () => {
    setProviderEditing(false);
    setView("providers");
    setAddTick((value) => (value ?? 0) + 1);
  };

  const acknowledgeAddProvider = (requestTick: number) => {
    setAddTick((current) => (current === requestTick ? null : current));
  };

  const returnToProviderDirectory = () => {
    // The editor owns the exit boundary. Keeping this state until its short
    // leave motion completes prevents the top bar from swapping twice.
    setProviderReturnTick((value) => value + 1);
  };

  const saveProvider = () => {
    setProviderSaveTick((value) => value + 1);
  };

  const shellStyle = useMemo(
    () =>
      ({
        "--studio-window-opacity": Math.max(
          0.82,
          Number(previewAppearance?.windowOpacity ?? 0.9),
        ),
        "--studio-surface-opacity": Math.max(
          0.82,
          Number(previewAppearance?.surfaceOpacity ?? 0.92),
        ),
        "--studio-glass-blur": "18px",
      }) as CSSProperties,
    [previewAppearance],
  );

  const releaseControl = useMemo<ReleaseControl>(
    () => ({
      repositoryUrl: APP_RELEASE.repositoryUrl,
      state: {
        checking: releaseChecking,
        installing: releaseInstalling,
        lastCheckedAt: updateStatus?.checkedAt,
        promotions: releasePromotions,
        availableUpdate:
          updateStatus?.state === "available" ? toReleaseUpdate(updateStatus.update) : null,
        error:
          updateStatus?.state === "error"
            ? translateUpdateMessage(updateStatus.message, "check-failed")
            : null,
        progress: updateProgress,
      },
      checkForUpdates: async () => {
        setReleaseChecking(true);
        try {
          const api = getApi();
          const status = await api.checkForUpdates();
          setUpdateStatus(status);
          if (status.promotions) {
            setReleasePromotions(toReleasePromotions(status.promotions));
          }
          void api
            .getHomePromotions(true)
            .then((promotions) => setReleasePromotions(toReleasePromotions(promotions.promotions)))
            .catch(() => undefined);
          return toReleaseCheckResult(status);
        } finally {
          setReleaseChecking(false);
        }
      },
      installUpdate: async () => {
        setReleaseInstalling(true);
        setUpdateProgress({ phase: "downloading", receivedBytes: 0, percent: 0 });
        try {
          const result = await getApi().installUpdate();
          if (result.state !== "restarting") {
            const detail = updateMessageDetail(result.message);
            if (detail) console.error("[studio] update installation failed", detail);
            throw new Error(translateUpdateMessage(result.message, "install-failed"));
          }
        } finally {
          setReleaseInstalling(false);
          setUpdateProgress(null);
        }
      },
    }),
    [
      releaseChecking,
      releaseInstalling,
      releasePromotions,
      translationEngine.resolvedLanguage,
      updateProgress,
      updateStatus,
    ],
  );
  const hasReleaseUpdate = updateStatus?.state === "available" && Boolean(updateStatus.update);

  const renderShell = (body: ReactNode) => (
    <div
      className="app-shell appearance-active relative flex h-full flex-col text-[#111]"
      data-language={translationEngine.resolvedLanguage || translationEngine.language}
      style={shellStyle}
    >
      {previewAppearance ? <StudioBackground appearance={previewAppearance} /> : null}
      <div className="app-layout">
        <AppWindowbar
          hasUpdate={hasReleaseUpdate}
          locale={config?.locale || "system"}
          onLocaleChange={(locale) => {
            if (!config) return;
            const next: AppConfig = { ...config, locale };
            setConfig(next);
            void setI18nLocale(locale);
            void getApi().saveConfig(next).then(setConfig).catch(() => undefined);
          }}
        />
        <div className="app-workspace">
          <AppSidebar view={view} onNavigate={navigate} />
          <div className={cn("app-main", view === "home" && "is-home")}>
            <AppTopbar
              title={viewTitle(view)}
              onAddProvider={addProvider}
              showAdd={view === "home" || (view === "providers" && !providerEditing)}
              showProviderBack={view === "providers" && providerEditing}
              onReturnProvider={returnToProviderDirectory}
              onSaveProvider={saveProvider}
              settingsTab={view === "config" ? settingsTab : undefined}
              onSettingsTabChange={setSettingsTab}
            />
            <main ref={contentRef} className="app-content app-scroll min-h-0 flex-1">
              {body}
            </main>
          </div>
        </div>
      </div>
    </div>
  );

  if (booting) {
    return renderShell(
      <div className="app-center">
        <LoadingState label="启动中…" />
      </div>,
    );
  }

  if (error) {
    return renderShell(
      <div className="app-center">
        <div className="w-full max-w-md">
          <ErrorState
            title="无法连接控制面"
            description={`${error} · 请重新打开 Cursor Studio 桌面应用（或 npm run dev）`}
          />
        </div>
      </div>,
    );
  }

  if (!config) {
    return renderShell(
      <div className="app-center">
        <EmptyState title="配置为空" description="控制面已连接，但尚未读到有效配置。" />
      </div>,
    );
  }

  return renderShell(
    <div className="app-page-root app-page-enter" key={view}>
        {view === "home" && (
          <HomePage
            config={config}
            onConfigChange={setConfig}
            onNavigate={navigate}
            releaseControl={releaseControl}
          />
        )}
        {view === "usage" && <UsagePage />}
        {view === "providers" && (
          <ProvidersPage
            providers={config.providers}
            onChange={(list) => setConfig({ ...config, providers: list })}
            addTick={addTick ?? 0}
            onAddRequestHandled={acknowledgeAddProvider}
            saveTick={providerSaveTick}
            onEditingChange={setProviderEditing}
            returnToListTick={providerReturnTick}
          />
        )}
        {view === "prompts" && <PromptsPage />}
        {view === "mcp" && <McpPage />}
        {view === "skills" && <SkillsPage />}
        {view === "sessions" && <SessionsPage />}
        {view === "config" && (
          <div className="workspace-tab-panel is-active" key={`settings-${settingsTab}`}>
            <SettingsPage
              activeTab={settingsTab}
              config={config}
              onConfigChange={setConfig}
              onAppearanceChange={(appearance) => {
                setConfig((current) => (current ? { ...current, appearance } : current));
                setPreviewAppearance(appearance);
              }}
              onPreviewChange={setPreviewAppearance}
            />
          </div>
        )}
    </div>,
  );
}

function AppSidebar({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (view: View) => void;
}) {
  return (
    <aside className="app-sidebar">
      <nav className="app-sidebar-nav" data-no-drag aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={cn("app-nav-item", active && "active")}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
            >
              {active ? <span className="app-nav-item-active" aria-hidden="true" /> : null}
              <span className="app-nav-item-icon">{item.icon}</span>
              <span className="app-nav-item-label">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function AppTopbar({
  title,
  onAddProvider,
  showAdd,
  showProviderBack,
  onReturnProvider,
  onSaveProvider,
  settingsTab,
  onSettingsTabChange,
}: {
  title: string;
  onAddProvider: () => void;
  showAdd: boolean;
  showProviderBack: boolean;
  onReturnProvider: () => void;
  onSaveProvider: () => void;
  settingsTab?: SettingsTab;
  onSettingsTabChange?: (tab: SettingsTab) => void;
}) {
  return (
    <header className={cn("app-topbar", showProviderBack && "is-provider-editing")}>
      <div className="app-topbar-left">
        {showProviderBack ? (
          <button
            type="button"
            className="app-primary-btn app-topbar-back"
            onClick={onReturnProvider}
            title="返回供应商列表"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>返回供应商</span>
          </button>
        ) : null}
        {!showProviderBack ? (
          <div className="app-topbar-titles">
            <h1 className="app-topbar-title">{title}</h1>
          </div>
        ) : null}
      </div>
      <div className="app-topbar-right" data-no-drag>
        {settingsTab && onSettingsTabChange ? (
          <SettingsTabs activeTab={settingsTab} onChange={onSettingsTabChange} />
        ) : null}
        {showAdd ? (
          <button
            type="button"
            className="app-primary-btn"
            onClick={onAddProvider}
            title="新增供应商"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            <span>新增供应商</span>
          </button>
        ) : null}
        {showProviderBack ? (
          <button
            type="button"
            className="app-primary-btn app-topbar-save"
            onClick={onSaveProvider}
            title="保存供应商"
          >
            <Save className="h-3.5 w-3.5" strokeWidth={2.25} />
            <span>保存</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "proxy", label: "代理设置" },
  { id: "appearance", label: "外观" },
  { id: "cursor", label: "Cursor 设置" },
];

function SettingsTabs({
  activeTab,
  onChange,
}: {
  activeTab: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}) {
  const activeIndex = SETTINGS_TABS.findIndex((tab) => tab.id === activeTab);

  return (
    <div
      className="app-settings-tabs"
      role="tablist"
      aria-label="设置分类"
      data-active-index={activeIndex}
    >
      <span className="app-settings-tabs__indicator" aria-hidden="true" />
      {SETTINGS_TABS.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn("app-settings-tab", active && "is-active")}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function backgroundLayout(model: SizeModel): {
  size: string;
  repeat: string;
  position: string;
} {
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

function StudioBackground({ appearance }: { appearance: AppearanceConfig }) {
  const [randomSource, setRandomSource] = useState("");

  useEffect(() => {
    if (!appearance.enabled || !appearance.autoStatus || !appearance.randomImageFolder.trim()) {
      setRandomSource("");
      return;
    }

    let disposed = false;
    let current = "";
    const rotate = async () => {
      try {
        const result = await getApi().pickRandomAppearance(
          appearance.randomImageFolder,
          current,
        );
        if (!disposed && result.path) {
          current = result.path;
          setRandomSource(result.path);
        }
      } catch {
        // Keep the previous background when the folder is temporarily unavailable.
      }
    };
    void rotate();
    const timer = window.setInterval(
      () => void rotate(),
      Math.max(1, Number(appearance.autoInterval) || 10) * 1000,
    );
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    appearance.autoInterval,
    appearance.autoStatus,
    appearance.enabled,
    appearance.randomImageFolder,
  ]);

  if (!appearance.enabled) return null;
  const source =
    appearance.autoStatus && appearance.randomImageFolder.trim()
      ? randomSource || appearance.imagePath
      : appearance.imagePath;
  if (!source.trim()) return null;

  const mediaUrl = appearanceMediaUrl(source);
  const mediaType = appearanceMediaType(source);
  const layout = backgroundLayout(appearance.sizeModel || "cover");
  const opacity = Math.min(1, Math.max(0, appearance.opacity));
  const blur = Math.min(100, Math.max(0, appearance.blur || 0));
  const blendMode = appearance.blendModel === "auto" ? "normal" : appearance.blendModel;
  const commonStyle: CSSProperties = {
    opacity,
    filter: blur ? `blur(${blur}px)` : undefined,
    mixBlendMode: blendMode,
  };

  return (
    <div className="studio-background" aria-hidden="true">
      {mediaType === "video" ? (
        <video
          key={mediaUrl}
          className="studio-background-media"
          src={mediaUrl}
          autoPlay
          loop
          muted
          playsInline
          style={{
            ...commonStyle,
            objectFit: layout.size === "contain" ? "contain" : "cover",
            objectPosition: layout.position,
          }}
        />
      ) : (
        <div
          className="studio-background-media"
          style={{
            ...commonStyle,
            backgroundImage: `url("${mediaUrl.replace(/"/g, "%22")}")`,
            backgroundSize: layout.size,
            backgroundRepeat: layout.repeat,
            backgroundPosition: layout.position,
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppNoticeProvider>
      <AppRoot />
    </AppNoticeProvider>
  );
}
