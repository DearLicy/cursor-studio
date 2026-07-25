/**
 * 本地协议实现。
 * - 一个供应商 → 展开 models[] 全部模型给 Cursor
 * - 带 thinking_effort variants
 */
import {
  cursorDisplayNameParts,
  cursorIntegrationLabel,
  normalizeContextWindowTokens,
  normalizeCursorIntegration,
  type CursorIntegrationConfig,
  type ModelProvider,
} from "../../config/store";
import {
  InjectAuthToken,
  LocalUltraDashboardUserID,
  LocalUltraPaymentID,
  LocalUltraPlanIncludedCents,
} from "../../runtime/defaults";
import { resolveCursorAvatarUrl } from "../../runtime/app-icon";
import type {
  AvailableModelJson,
  AvailableModelsPayload,
} from "./mock-proto";
import { THINKING_PARAM_ID } from "./mock-proto";

const EFFORTS_OPENAI = [
  "disabled",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const EFFORTS_ANTHROPIC = [
  "disabled",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const RUNTIME_EFFORT_SUFFIXES = new Set<string>([
  "disabled",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function effortDisplay(v: string): string {
  switch (v) {
    case "disabled":
      return "Disabled";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
    case "max":
      return "Max";
    default:
      return v;
  }
}

function normalizeEffort(raw: string | undefined, fallback: string): string {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (
    ["disabled", "low", "medium", "high", "xhigh", "max"].includes(v)
  ) {
    return v;
  }
  if (["disable", "off", "none", "false", "no", "0"].includes(v)) {
    return "disabled";
  }
  return fallback;
}

function orderEfforts(values: string[], defaultValue: string): string[] {
  const d = defaultValue.toLowerCase();
  const head = values.filter((v) => v === d);
  const rest = values.filter((v) => v !== d);
  return [...head, ...rest];
}

function thinkingParamDef(type: string) {
  const values = (type === "anthropic" ? EFFORTS_ANTHROPIC : EFFORTS_OPENAI).map(
    (value) => ({
      value,
      displayName: effortDisplay(value),
      increasesModelCost: value === "xhigh" || value === "max",
    }),
  );
  return {
    id: THINKING_PARAM_ID,
    name: "Thinking intensity",
    markdownTooltip: "Controls the model thinking intensity for this run.",
    isCycleableByHotkey: true,
    values,
  };
}

function buildVariants(
  type: string,
  channelName: string,
  modelDisplayName: string,
  defaultEffort: string,
) {
  const values = orderEfforts(
    [...(type === "anthropic" ? EFFORTS_ANTHROPIC : EFFORTS_OPENAI)],
    defaultEffort,
  );
  return values.map((value) => {
    const effortName = effortDisplay(value);
    const displayName =
      value === "disabled"
        ? modelDisplayName
        : `${modelDisplayName} · ${effortName}`;
    return {
      displayName,
      displayNameOutsidePicker: displayName,
      isMaxMode: false,
      isDefaultNonMaxConfig: value === defaultEffort,
      tagline: value === "disabled" ? undefined : effortName,
      variantStringRepresentation: `${channelName}:${value}`,
      parameterValues: [{ id: THINKING_PARAM_ID, value }],
    };
  });
}

function activeModelIds(provider: ModelProvider): string[] {
  const raw =
    provider.models && provider.models.length > 0
      ? provider.models
      : provider.modelID
        ? [provider.modelID]
        : [];
  return [...new Set(raw)]
    .filter((id) => provider.modelSettings?.[id]?.enabled !== false)
    .sort((a, b) => {
      if (a === provider.modelID) return -1;
      if (b === provider.modelID) return 1;
      const favoriteA = provider.modelSettings?.[a]?.favorite === true;
      const favoriteB = provider.modelSettings?.[b]?.favorite === true;
      if (favoriteA !== favoriteB) return favoriteA ? -1 : 1;
      return a.localeCompare(b);
    });
}

/** Cursor 侧模型 name：单供应商多模型用 providerId:modelId */
function resolveContextWindowTokens(
  provider: ModelProvider,
  modelId: string,
  cursorIntegration: CursorIntegrationConfig,
): number {
  const candidates = [
    provider.modelSettings?.[modelId]?.contextWindowTokens,
    provider.contextWindowTokens,
    cursorIntegration.defaultContextWindowTokens,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeContextWindowTokens(candidate, 0);
    if (normalized > 0) return normalized;
  }
  return normalizeContextWindowTokens(undefined);
}

/** A selected Cursor variant is encoded as `channel:effort`; limits belong to the channel. */
function stripRuntimeEffortSuffix(modelHint: string): string {
  const parts = modelHint.trim().split(":");
  const suffix = parts.at(-1)?.toLowerCase();
  if (parts.length >= 2 && suffix && RUNTIME_EFFORT_SUFFIXES.has(suffix)) {
    return parts.slice(0, -1).join(":");
  }
  return modelHint.trim();
}

function configuredModelIds(provider: ModelProvider): string[] {
  const ids =
    provider.models && provider.models.length > 0
      ? provider.models
      : provider.modelID
        ? [provider.modelID]
        : [];
  return [...new Set(ids)].filter(Boolean);
}

function contextModelIdForHint(
  provider: ModelProvider,
  modelHint: string,
): string | undefined {
  const hint = modelHint.trim();
  if (!hint) return undefined;
  const ids = configuredModelIds(provider);

  if (hint === provider.id) return provider.modelID || ids[0];
  for (const modelId of ids) {
    if (
      hint === modelId ||
      hint === `${provider.id}:${modelId}` ||
      hint === modelChannelName(provider, modelId)
    ) {
      return modelId;
    }
  }
  return undefined;
}

/**
 * Resolve the exact limit exposed to Cursor and enforced by the local runner.
 * Keep this lookup independent of the provider router so AvailableModels,
 * GetEffectiveTokenLimit, and the active conversation never drift apart.
 */
export function resolveContextWindowTokensForModel(
  providers: ModelProvider[],
  modelHint?: string,
  cursorIntegration?: CursorIntegrationConfig,
): number {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const rawHint = String(modelHint || "").trim();
  const hints = rawHint
    ? [...new Set([rawHint, stripRuntimeEffortSuffix(rawHint)])]
    : [];
  const enabled = providers.filter((provider) => provider.enabled !== false);

  for (const hint of hints) {
    for (const provider of enabled) {
      const modelId = contextModelIdForHint(provider, hint);
      if (modelId) return resolveContextWindowTokens(provider, modelId, integration);
    }
  }

  return normalizeContextWindowTokens(integration.defaultContextWindowTokens);
}

export function modelChannelName(provider: ModelProvider, modelId: string): string {
  const ids =
    provider.models && provider.models.length > 0
      ? provider.models
      : provider.modelID
        ? [provider.modelID]
        : [];
  if (ids.length <= 1) return provider.id;
  return `${provider.id}:${modelId}`;
}

export function buildAvailableModels(
  providers: ModelProvider[],
  cursorIntegration?: CursorIntegrationConfig,
): AvailableModelsPayload {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const enabled = providers.filter((p) => p.enabled !== false);
  const models: AvailableModelJson[] = [];
  const modelNames: string[] = [];

  for (const p of enabled) {
    const ids = activeModelIds(p);
    const defaultEffort = normalizeEffort(
      p.reasoningEffort,
      p.type === "anthropic" ? "xhigh" : "high",
    );

    for (const mid of ids) {
      let channel = modelChannelName(p, mid);
      // 若 channel 已被占用，强制带 modelId 去重
      if (models.some((m) => m.name === channel)) {
        channel = `${p.id}:${mid}`;
      }
      if (models.some((m) => m.name === channel)) continue;

      modelNames.push(channel);
      const display =
        ids.length === 1 ? p.displayName || mid : `${p.displayName} · ${mid}`;
      const contextTokenLimit = resolveContextWindowTokens(p, mid, integration);
      models.push({
        name: channel,
        defaultOn: true,
        clientDisplayName: display,
        serverModelName: channel,
        inputboxShortModelName:
          ids.length === 1 ? p.displayName || mid : mid.slice(0, 24),
        tagline: effortDisplay(defaultEffort),
        contextTokenLimit,
        // Cursor also asks for the Max-mode value on newer builds. We do not
        // expose Max mode, but keeping both fields aligned prevents a stale
        // built-in 200K fallback when the client inspects this metadata.
        contextTokenLimitForMaxMode: contextTokenLimit,
        supportsAgent: true,
        supportsThinking: true,
        supportsImages: true,
        supportsMaxMode: false,
        supportsNonMaxMode: true,
        supportsPlanMode: true,
        supportsSandboxing: true,
        namedModelSectionIndex: 1,
        tooltipMarkdown: `${p.displayName} · ${mid}`,
        parameterDefinitions: thinkingParamDef(p.type),
        variants: buildVariants(p.type, channel, display, defaultEffort),
      });
    }
  }

  const defaultModel = modelNames[0] || "";
  const feature = {
    defaultModel,
    fallbackModels: [...modelNames],
    bestOfNDefaultModels: [...modelNames],
  };
  const featureSimple = { defaultModel, fallbackModels: [...modelNames] };

  return {
    models,
    modelNames,
    backgroundComposerModelConfig: feature,
    cmdKModelConfig: featureSimple,
    composerModelConfig: feature,
    deepSearchModelConfig: { defaultModel },
    planExecutionModelConfig: featureSimple,
    quickAgentModelConfig: { defaultModel },
    specModelConfig: { defaultModel },
    useModelParameters: true,
    disableUnusedModelsAfterNHours: 0,
    upgradeUnchangedModelsAfterNHours: 0,
  };
}

export function buildDefaultModelNudge(providers: ModelProvider[]) {
  const { modelNames } = buildAvailableModels(providers);
  return {
    modelsWithNoDefaultSwitch: modelNames,
    nudgeDate: "0",
  };
}

export function buildDashboardUsage(cursorIntegration?: CursorIntegrationConfig) {
  const label = cursorIntegrationLabel(cursorIntegration);
  const now = Date.now();
  const yearMs = 365 * 24 * 3600 * 1000;
  return {
    autoModelSelectedDisplayMessage: label,
    billingCycleEnd: now + 10 * yearMs,
    billingCycleStart: now - yearMs,
    displayMessage: label,
    displayThreshold: 99999999,
    enabled: true,
    namedModelSelectedDisplayMessage: label,
    planUsage: {
      apiPercentUsed: 0,
      apiSpend: 0,
      autoPercentUsed: 0,
      autoSpend: 0,
      bonusTooltip: label,
      includedSpend: 99999999,
      limit: 99999999,
      remaining: 99999999,
      remainingBonus: false,
      totalPercentUsed: 0,
      totalSpend: 0,
    },
    spendLimitUsage: { limitType: "user" },
  };
}

/** JSON 形态 GetMe（调试用）；真机走 encodeGetMeProto */
export function buildGetMe(
  cursorIntegration?: CursorIntegrationConfig,
  avatarUrl?: string,
) {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const name = cursorDisplayNameParts(integration);
  const authId = authIdFromJwt(InjectAuthToken) || LocalUltraPaymentID;
  const resolvedAvatarUrl = avatarUrl || resolveCursorAvatarUrl(integration.avatarUrl);
  return {
    authId,
    userId: LocalUltraDashboardUserID,
    email: integration.contactEmail,
    firstName: name.firstName,
    lastName: name.lastName,
    createdAt: new Date().toISOString(),
    isEnterpriseUser: false,
    emailDomainType: "personal",
    country: "US",
    profilePictureUrl: resolvedAvatarUrl,
    hardLimitDollars: 999999,
    workosId: authId,
  };
}

/**
 * Cursor's profile view is backed by a separate UserProfile RPC from GetMe.
 * Keep this payload local and deterministic so profile links and a handle
 * appear in the same places Cursor expects without inventing unrelated
 * account fields.
 */
export function buildCursorUserProfile(
  cursorIntegration?: CursorIntegrationConfig,
  avatarUrl?: string,
) {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const now = new Date().toISOString();
  const resolvedAvatarUrl = avatarUrl || resolveCursorAvatarUrl(integration.avatarUrl);
  return {
    profile: {
      handle: integration.profileHandle || undefined,
      visibility: "PRIVATE",
      links: integration.website ? { website: integration.website } : {},
      createdAt: now,
      updatedAt: now,
      displayName: integration.displayName,
      avatarUrl: resolvedAvatarUrl,
    },
  };
}

export function buildPlanInfo(cursorIntegration?: CursorIntegrationConfig) {
  const integration = normalizeCursorIntegration(cursorIntegration);
  return {
    planInfo: {
      planName: integration.planName,
      includedAmountCents: LocalUltraPlanIncludedCents,
      price: "$200/mo",
      billingCycleEnd: Date.now() + 10 * 365 * 24 * 3600 * 1000,
    },
  };
}

function authIdFromJwt(token: string): string {
  try {
    const mid = token.split(".")[1];
    if (!mid) return "";
    const json = Buffer.from(
      mid.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const payload = JSON.parse(json) as { sub?: string };
    return String(payload.sub || "").trim();
  } catch {
    return "";
  }
}
