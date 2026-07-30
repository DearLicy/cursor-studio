import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  ImagePlus,
  MessageSquareText,
  RotateCcw,
  Save,
  UserRound,
} from "lucide-react";
import { toast } from "@/components/ui/app-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/layout";
import { cn } from "@/lib/utils";
import { RawText } from "@/lib/i18n-raw";
import { appIconUrl } from "@/lib/app-icon";
import {
  appearanceMediaUrl,
  getApi,
  type AppConfig,
  type CursorIntegrationConfig,
} from "@/lib/api";
import "@/styles/cursor-settings-workspace.css";

type CursorIntegrationDraft = Omit<
  CursorIntegrationConfig,
  | "defaultContextWindowTokens"
  | "avatarUrl"
  | "profileHandle"
  | "website"
> & {
  defaultContextWindowTokens: string;
  avatarUrl: string;
  profileHandle: string;
  website: string;
};

const DEFAULT_CURSOR_INTEGRATION: CursorIntegrationConfig = {
  displayName: "李初一",
  contactEmail: "82719519@qq.com",
  planName: "豆包Pro",
  defaultContextWindowTokens: 200_000,
  avatarUrl: "",
  profileHandle: "",
  website: "https://www.akucb.com",
};

const CONTEXT_PRESETS = [
  { label: "64K", value: 64_000 },
  { label: "128K", value: 128_000 },
  { label: "200K", value: 200_000 },
  { label: "300K", value: 300_000 },
  { label: "500K", value: 500_000 },
  { label: "1M", value: 1_000_000 },
] as const;

const MIN_CONTEXT_TOKENS = 1_024;
const MAX_CONTEXT_TOKENS = 2_147_483_647;

function readCursorIntegration(
  config: AppConfig,
  fallback: CursorIntegrationConfig = DEFAULT_CURSOR_INTEGRATION,
): CursorIntegrationConfig {
  const value = config.cursorIntegration;
  const contextLimit = Number(value?.defaultContextWindowTokens);
  const text = (candidate: unknown, fallbackValue = "") =>
    typeof candidate === "string" ? candidate.trim() : fallbackValue;

  return {
    displayName: String(value?.displayName || fallback.displayName).trim() || fallback.displayName,
    contactEmail: text(value?.contactEmail, fallback.contactEmail),
    planName: String(value?.planName || fallback.planName).trim() || fallback.planName,
    defaultContextWindowTokens: isValidContextTokens(contextLimit)
      ? contextLimit
      : fallback.defaultContextWindowTokens,
    avatarUrl: text(value?.avatarUrl, fallback.avatarUrl ?? ""),
    profileHandle: text(value?.profileHandle, fallback.profileHandle ?? ""),
    website: text(value?.website, fallback.website ?? ""),
  };
}

function draftFromConfig(config: AppConfig): CursorIntegrationDraft {
  const value = readCursorIntegration(config);
  return {
    ...value,
    defaultContextWindowTokens: String(value.defaultContextWindowTokens),
    avatarUrl: value.avatarUrl ?? "",
    profileHandle: value.profileHandle ?? "",
    website: value.website ?? "",
  };
}

function parseContextTokens(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return isValidContextTokens(parsed) ? parsed : null;
}

function isValidContextTokens(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_CONTEXT_TOKENS && value <= MAX_CONTEXT_TOKENS;
}

function contextLabel(value: number | null): string {
  if (!value) return "待填写";
  if (value % 1_000 === 0 && value >= 1_000) return `${value / 1_000}K`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

function isImageFile(source: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i.test(source.trim());
}

function isHttpsImageUrl(source: string): boolean {
  try {
    const url = new URL(source.trim());
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function CursorSettingsPage({
  config,
  onConfigChange,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
}) {
  const api = getApi();
  const [draft, setDraft] = useState<CursorIntegrationDraft>(() => draftFromConfig(config));
  const [saving, setSaving] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setDraft(draftFromConfig(config));
  }, [config]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [draft.avatarUrl]);

  const saved = useMemo(() => readCursorIntegration(config), [config]);
  const contextTokens = parseContextTokens(draft.defaultContextWindowTokens);
  const contextValid = contextTokens !== null;
  const appliedContextLabel = contextLabel(saved.defaultContextWindowTokens);
  const dirty =
    draft.displayName.trim() !== saved.displayName ||
    draft.contactEmail.trim() !== saved.contactEmail ||
    draft.planName.trim() !== saved.planName ||
    draft.avatarUrl.trim() !== (saved.avatarUrl ?? "") ||
    draft.profileHandle.trim() !== (saved.profileHandle ?? "") ||
    draft.website.trim() !== (saved.website ?? "") ||
    contextTokens !== saved.defaultContextWindowTokens;
  const avatarSource = draft.avatarUrl.trim();
  const avatarPreviewUrl = avatarSource ? appearanceMediaUrl(avatarSource) : appIconUrl;
  const usesDefaultAvatar = !avatarSource || avatarFailed;

  const update = <K extends keyof CursorIntegrationDraft>(
    key: K,
    value: CursorIntegrationDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const selectAvatar = async () => {
    try {
      const picked = await api.pickAvatar();
      if (!picked) return;
      if (!isImageFile(picked)) {
        toast.error("请选择图片文件作为头像");
        return;
      }
      update("avatarUrl", picked);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "头像选择未完成，请稍后重试");
    }
  };

  const save = async () => {
    if (!contextValid || contextTokens === null) {
      toast.error("请输入 1,024 到 2,147,483,647 之间的整数");
      return;
    }
    if (avatarSource && !isImageFile(avatarSource) && !isHttpsImageUrl(avatarSource)) {
      toast.error("头像请使用 HTTPS 图片地址或本地图片文件");
      return;
    }
    const nextIntegration: CursorIntegrationConfig = {
      displayName: draft.displayName.trim() || DEFAULT_CURSOR_INTEGRATION.displayName,
      contactEmail: draft.contactEmail.trim(),
      planName: draft.planName.trim() || DEFAULT_CURSOR_INTEGRATION.planName,
      defaultContextWindowTokens: contextTokens,
      avatarUrl: draft.avatarUrl.trim(),
      profileHandle: draft.profileHandle.trim(),
      website: draft.website.trim(),
    };

    setSaving(true);
    try {
      const nextConfig = {
        ...config,
        cursorIntegration: nextIntegration,
      } satisfies AppConfig;
      let savedConfig = await api.saveConfig(nextConfig);

      // it in sync with the newly saved presentation values.
      try {
        const state = await api.serviceState();
        if (state.running && state.cursorSettingsApplied) {
          await api.injectCursorProxy();
          savedConfig = await api.getConfig();
        }
      } catch {
        // Saving remains valid. The next Cursor connection will read this config.
      }

      const persistedIntegration = readCursorIntegration(savedConfig, nextIntegration);
      const result = {
        ...savedConfig,
        cursorIntegration: persistedIntegration,
      } satisfies AppConfig;

      setDraft({
        ...persistedIntegration,
        defaultContextWindowTokens: String(persistedIntegration.defaultContextWindowTokens),
        avatarUrl: persistedIntegration.avatarUrl ?? "",
        profileHandle: persistedIntegration.profileHandle ?? "",
        website: persistedIntegration.website ?? "",
      });
      onConfigChange(result);
      toast.success("Cursor 设置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存未完成，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="cs-page cursor-settings-workspace" aria-label="Cursor 设置">
      <header className="cursor-settings-workspace__toolbar workspace-layer-enter">
        <div className="cursor-settings-workspace__status" role="status" aria-live="polite">
          <span
            className={cn(
              "cursor-settings-workspace__status-dot",
              saving ? "is-saving" : dirty ? "is-dirty" : "is-ready",
            )}
            aria-hidden="true"
          />
          <span className="cursor-settings-workspace__status-label">设置状态</span>
          <small>{saving ? "正在保存" : dirty ? "有未保存修改" : "已保存"}</small>
        </div>

        <Button
          type="button"
          className="cursor-settings-workspace__primary-action"
          onClick={() => void save()}
          disabled={saving || !contextValid}
        >
          <Save />
          {saving ? "保存中" : "保存设置"}
        </Button>
      </header>

      <form
        className="cursor-settings-workspace__grid workspace-layer-enter workspace-layer-enter--delay-1"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <section className="cursor-settings-workspace__panel" aria-labelledby="cursor-display-title">
          <header className="cursor-settings-workspace__panel-head">
            <div className="cursor-settings-workspace__heading">
              <span className="cursor-settings-workspace__panel-icon is-blue" aria-hidden="true">
                <UserRound />
              </span>
              <div>
                <h2 id="cursor-display-title">账户资料</h2>
                <p>调整 Cursor 内显示的头像、名称、邮箱和套餐。</p>
              </div>
            </div>
          </header>

          <div className="cursor-settings-workspace__panel-body cursor-settings-workspace__identity-fields">
            <div className="cursor-settings-workspace__avatar-row">
              <span className="cursor-settings-workspace__avatar" aria-hidden="true">
                <img
                  src={avatarFailed ? appIconUrl : avatarPreviewUrl}
                  alt=""
                  onError={() => setAvatarFailed(true)}
                />
              </span>
              <div className="cursor-settings-workspace__avatar-copy">
                <strong><RawText>{draft.displayName.trim() || DEFAULT_CURSOR_INTEGRATION.displayName}</RawText></strong>
                <span>{usesDefaultAvatar ? "使用默认头像" : "头像已设置"}</span>
              </div>
              <div className="cursor-settings-workspace__avatar-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="cursor-settings-workspace__avatar-action"
                  onClick={() => void selectAvatar()}
                  title="选择头像"
                  aria-label="选择头像"
                >
                  <ImagePlus />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="cursor-settings-workspace__avatar-action"
                  onClick={() => update("avatarUrl", "")}
                  disabled={!avatarSource}
                  title="恢复默认头像"
                  aria-label="恢复默认头像"
                >
                  <RotateCcw />
                </Button>
              </div>
            </div>
            <Field
              className="cursor-settings-workspace__avatar-url"
              label="头像地址"
              hint="支持 HTTPS 图片地址或本地图片"
            >
              <Input
                className="cursor-settings-workspace__input"
                type="url"
                value={draft.avatarUrl}
                maxLength={2048}
                onChange={(event) => update("avatarUrl", event.target.value)}
                placeholder="https://example.com/avatar.jpg"
              />
            </Field>
            <Field label="显示名称" hint="建议使用容易识别的名称">
              <Input
                className="cursor-settings-workspace__input"
                value={draft.displayName}
                maxLength={48}
                onChange={(event) => update("displayName", event.target.value)}
                placeholder="例如 Cursor Studio"
              />
            </Field>
            <Field label="邮箱" hint="可留空">
              <Input
                className="cursor-settings-workspace__input"
                value={draft.contactEmail}
                maxLength={96}
                onChange={(event) => update("contactEmail", event.target.value)}
                placeholder="例如 support@example.com"
              />
            </Field>
            <Field label="套餐名称">
              <Input
                className="cursor-settings-workspace__input"
                value={draft.planName}
                maxLength={48}
                onChange={(event) => update("planName", event.target.value)}
                placeholder="例如 专业版"
              />
            </Field>
          </div>
        </section>

        <section className="cursor-settings-workspace__panel" aria-labelledby="cursor-context-title">
          <header className="cursor-settings-workspace__panel-head">
            <div className="cursor-settings-workspace__heading">
              <span className="cursor-settings-workspace__panel-icon is-teal" aria-hidden="true">
                <MessageSquareText />
              </span>
              <div>
                <h2 id="cursor-context-title">对话容量</h2>
                <p>未单独设置的模型会使用该容量，继续对话时会按对应长度保留历史内容。</p>
              </div>
            </div>
            <span className="cursor-settings-workspace__context-value" aria-label="当前设置的对话容量">
              {contextLabel(contextTokens)}
            </span>
          </header>

          <div className="cursor-settings-workspace__panel-body cursor-settings-workspace__context-fields">
            <Field label="默认对话容量" hint="1,024 - 2,147,483,647">
              <Input
                className={cn(
                  "cursor-settings-workspace__input cursor-settings-workspace__context-input tabular-nums",
                  !contextValid && "is-invalid",
                )}
                value={draft.defaultContextWindowTokens}
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                aria-invalid={!contextValid}
                aria-describedby="cursor-context-help"
                onChange={(event) =>
                  update(
                    "defaultContextWindowTokens",
                    event.target.value.replace(/[^0-9]/g, ""),
                  )
                }
                placeholder="例如 200000"
              />
            </Field>

            <div className="cursor-settings-workspace__preset-row" role="group" aria-label="常用上下文长度">
              {CONTEXT_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={cn(
                    "cursor-settings-workspace__preset",
                    contextTokens === preset.value && "is-active",
                  )}
                  onClick={() => update("defaultContextWindowTokens", String(preset.value))}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <p
              id="cursor-context-help"
              className={cn(
                "cursor-settings-workspace__context-help",
                !contextValid && "is-error",
              )}
            >
              {!contextValid ? (
                <>
                  <CircleAlert aria-hidden="true" /> 请输入 1,024 到 2,147,483,647 之间的整数。
                </>
              ) : (
                <>
                  <CheckCircle2 aria-hidden="true" />
                  {dirty
                    ? `保存后将应用 ${contextLabel(contextTokens)} 的默认容量。`
                    : `默认容量已应用：${appliedContextLabel}。具体模型可单独设置。`}
                </>
              )}
            </p>
          </div>
        </section>

        <section
          className="cursor-settings-workspace__panel cursor-settings-workspace__details-panel"
          aria-labelledby="cursor-details-title"
        >
          <header className="cursor-settings-workspace__panel-head">
            <div className="cursor-settings-workspace__heading">
              <span className="cursor-settings-workspace__panel-icon is-blue" aria-hidden="true">
                <BadgeCheck />
              </span>
              <div>
                <h2 id="cursor-details-title">补充资料</h2>
                <p>这些信息会同步到 Cursor 的个人资料中。</p>
              </div>
            </div>
          </header>

          <div className="cursor-settings-workspace__panel-body cursor-settings-workspace__details-fields">
            <Field label="个人标识" hint="可留空">
              <Input
                className="cursor-settings-workspace__input"
                value={draft.profileHandle}
                maxLength={64}
                autoComplete="off"
                onChange={(event) => update("profileHandle", event.target.value)}
                placeholder="例如 cursor-studio"
              />
            </Field>
            <Field label="个人主页" hint="可留空">
              <Input
                className="cursor-settings-workspace__input"
                value={draft.website}
                maxLength={240}
                inputMode="url"
                autoComplete="url"
                onChange={(event) => update("website", event.target.value)}
                placeholder="https://example.com"
              />
            </Field>
          </div>
        </section>
      </form>
    </main>
  );
}
