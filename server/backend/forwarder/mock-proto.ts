/**
 * Cursor 本地 mock 的 application/proto 编码器。
 * 本地协议实现。
 */
import {
  concatMessages,
  encodeBool,
  encodeBytes,
  encodeDouble,
  encodeInt32,
  encodeInt64,
  encodeMessage,
  encodeString,
  encodeVarintField,
  encodeVarintFieldForce,
} from "./protobuf-wire";
import {
  InjectAuthToken,
  LocalUltraDashboardUserID,
  LocalUltraPaymentID,
  LocalUltraPlanIncludedCents,
} from "../../runtime/defaults";
import { resolveCursorAvatarUrl } from "../../runtime/app-icon";
import {
  cursorDisplayNameParts,
  cursorIntegrationLabel,
  normalizeCursorIntegration,
  type CursorIntegrationConfig,
} from "../../config/store";

const THINKING_PARAM_ID = "thinking_effort";

export type AvailableModelJson = {
  name: string;
  defaultOn: boolean;
  clientDisplayName: string;
  serverModelName: string;
  inputboxShortModelName: string;
  tagline?: string;
  contextTokenLimit: number;
  contextTokenLimitForMaxMode?: number;
  supportsAgent: boolean;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsMaxMode: boolean;
  supportsNonMaxMode: boolean;
  supportsPlanMode: boolean;
  supportsSandboxing: boolean;
  namedModelSectionIndex: number;
  tooltipMarkdown?: string;
  parameterDefinitions?: ThinkingParamDef;
  variants?: ModelVariantJson[];
};

type ThinkingParamDef = {
  id: string;
  name: string;
  markdownTooltip: string;
  isCycleableByHotkey: boolean;
  values: Array<{
    value: string;
    displayName: string;
    increasesModelCost: boolean;
  }>;
};

type ModelVariantJson = {
  displayName: string;
  displayNameOutsidePicker?: string;
  isMaxMode: boolean;
  isDefaultNonMaxConfig: boolean;
  tagline?: string;
  variantStringRepresentation?: string;
  parameterValues: Array<{ id: string; value: string }>;
};

export type AvailableModelsPayload = {
  models: AvailableModelJson[];
  modelNames: string[];
  composerModelConfig: FeatureCfg;
  cmdKModelConfig: FeatureCfg;
  backgroundComposerModelConfig: FeatureCfg;
  planExecutionModelConfig: FeatureCfg;
  specModelConfig: FeatureCfg;
  deepSearchModelConfig: FeatureCfg;
  quickAgentModelConfig: FeatureCfg;
  useModelParameters: boolean;
  disableUnusedModelsAfterNHours: number;
  upgradeUnchangedModelsAfterNHours: number;
};

type FeatureCfg = {
  defaultModel: string;
  fallbackModels?: string[];
  bestOfNDefaultModels?: string[];
};

function encodeTooltipMarkdown(md: string): Buffer {
  if (!md) return Buffer.alloc(0);
  // TooltipData.markdown_content = 7
  return encodeMessage(8, encodeString(7, md));
}

function encodeEnumParamValue(v: {
  value: string;
  displayName: string;
  increasesModelCost: boolean;
}): Buffer {
  return concatMessages(
    encodeString(1, v.value),
    encodeString(2, v.displayName),
    encodeBool(3, v.increasesModelCost),
  );
}

function encodeParameterDefinition(def: ThinkingParamDef): Buffer {
  // EnumParameterDefinition { repeated values = 1 }
  const enumDef = concatMessages(
    ...def.values.map((v) => encodeMessage(1, encodeEnumParamValue(v))),
  );
  // ModelParameterType { enum_parameter = 2 }
  const paramType = encodeMessage(2, enumDef);
  return concatMessages(
    encodeString(1, def.id),
    encodeString(2, def.name),
    encodeString(3, def.markdownTooltip),
    encodeMessage(4, paramType),
    encodeBool(5, def.isCycleableByHotkey),
  );
}

function encodeVariant(v: ModelVariantJson): Buffer {
  const params = v.parameterValues.map((pv) =>
    encodeMessage(
      1,
      concatMessages(encodeString(1, pv.id), encodeString(2, pv.value)),
    ),
  );
  return concatMessages(
    ...params,
    encodeString(2, v.displayName),
    encodeBool(3, v.isMaxMode),
    encodeBool(5, v.isDefaultNonMaxConfig),
    v.tagline ? encodeString(7, v.tagline) : Buffer.alloc(0),
    v.displayNameOutsidePicker
      ? encodeString(8, v.displayNameOutsidePicker)
      : Buffer.alloc(0),
    v.variantStringRepresentation
      ? encodeString(9, v.variantStringRepresentation)
      : Buffer.alloc(0),
  );
}

function encodeAvailableModel(m: AvailableModelJson): Buffer {
  const parts: Buffer[] = [
    encodeString(1, m.name),
    encodeBool(2, m.defaultOn),
    encodeBool(5, m.supportsAgent),
    // degradation_status = 6 UNSPECIFIED → omit
    m.tooltipMarkdown ? encodeTooltipMarkdown(m.tooltipMarkdown) : Buffer.alloc(0),
    encodeBool(9, m.supportsThinking),
    encodeBool(10, m.supportsImages),
    encodeBool(14, m.supportsMaxMode),
    encodeBool(19, m.supportsNonMaxMode),
    encodeInt32(15, m.contextTokenLimit || 0),
    encodeInt32(16, m.contextTokenLimitForMaxMode || m.contextTokenLimit || 0),
    encodeString(17, m.clientDisplayName),
    encodeString(18, m.serverModelName),
    encodeBool(22, m.supportsPlanMode),
    encodeBool(25, m.supportsSandboxing),
    encodeString(24, m.inputboxShortModelName),
  ];
  if (m.parameterDefinitions) {
    parts.push(
      encodeMessage(29, encodeParameterDefinition(m.parameterDefinitions)),
    );
  }
  for (const v of m.variants || []) {
    parts.push(encodeMessage(30, encodeVariant(v)));
  }
  parts.push(encodeInt32(38, m.namedModelSectionIndex || 1));
  if (m.tagline) parts.push(encodeString(39, m.tagline));
  return concatMessages(...parts);
}

function encodeFeatureCfg(cfg: FeatureCfg): Buffer {
  return concatMessages(
    encodeString(1, cfg.defaultModel || ""),
    ...(cfg.fallbackModels || []).map((n) => encodeString(2, n)),
    ...(cfg.bestOfNDefaultModels || []).map((n) => encodeString(3, n)),
  );
}

/** AvailableModelsResponse → application/proto body */
export function encodeAvailableModelsProto(
  payload: AvailableModelsPayload,
): Buffer {
  const parts: Buffer[] = [];
  for (const name of payload.modelNames) {
    parts.push(encodeString(1, name));
  }
  for (const m of payload.models) {
    parts.push(encodeMessage(2, encodeAvailableModel(m)));
  }
  parts.push(encodeMessage(4, encodeFeatureCfg(payload.composerModelConfig)));
  parts.push(encodeMessage(5, encodeFeatureCfg(payload.cmdKModelConfig)));
  parts.push(
    encodeMessage(6, encodeFeatureCfg(payload.backgroundComposerModelConfig)),
  );
  parts.push(
    encodeMessage(7, encodeFeatureCfg(payload.planExecutionModelConfig)),
  );
  parts.push(encodeMessage(8, encodeFeatureCfg(payload.specModelConfig)));
  parts.push(encodeMessage(9, encodeFeatureCfg(payload.deepSearchModelConfig)));
  parts.push(
    encodeMessage(10, encodeFeatureCfg(payload.quickAgentModelConfig)),
  );
  parts.push(encodeBool(11, payload.useModelParameters));
  if (payload.disableUnusedModelsAfterNHours) {
    parts.push(encodeInt32(12, payload.disableUnusedModelsAfterNHours));
  }
  if (payload.upgradeUnchangedModelsAfterNHours) {
    parts.push(encodeInt32(13, payload.upgradeUnchangedModelsAfterNHours));
  }
  return concatMessages(...parts);
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

/** GetMeResponse */
export function encodeGetMeProto(
  cursorIntegration?: CursorIntegrationConfig,
  avatarUrl?: string,
): Buffer {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const name = cursorDisplayNameParts(integration);
  const authId = authIdFromJwt(InjectAuthToken) || LocalUltraPaymentID;
  const resolvedAvatarUrl = avatarUrl || resolveCursorAvatarUrl(integration.avatarUrl);
  return concatMessages(
    encodeString(1, authId),
    encodeVarintFieldForce(2, LocalUltraDashboardUserID),
    encodeString(3, integration.contactEmail),
    encodeString(4, name.firstName),
    encodeString(5, name.lastName),
    encodeString(6, authId),
    encodeString(8, new Date().toISOString()),
    // is_enterprise_user false omit
    encodeString(11, "personal"),
    encodeString(12, "US"),
    encodeString(13, resolvedAvatarUrl),
  );
}

/** map<string, string>; protobuf map entries are message { key = 1, value = 2 }. */
function encodeStringMap(field: number, values: Record<string, string>): Buffer {
  return concatMessages(
    ...Object.entries(values)
      .filter(([key, value]) => Boolean(key) && Boolean(value))
      .map(([key, value]) =>
        encodeMessage(field, concatMessages(encodeString(1, key), encodeString(2, value))),
      ),
  );
}

/** GetUserProfileResponse { UserProfile profile = 1 }. */
export function encodeGetUserProfileProto(
  cursorIntegration?: CursorIntegrationConfig,
  avatarUrl?: string,
): Buffer {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const now = new Date().toISOString();
  const resolvedAvatarUrl = avatarUrl || resolveCursorAvatarUrl(integration.avatarUrl);
  const profile = concatMessages(
    encodeString(1, integration.profileHandle || ""),
    encodeString(2, "PRIVATE"),
    encodeStringMap(3, integration.website ? { website: integration.website } : {}),
    encodeString(4, now),
    encodeString(5, now),
    encodeString(6, integration.displayName),
    encodeString(7, resolvedAvatarUrl),
  );
  return encodeMessage(1, profile);
}

/** GetPlanInfoResponse */
export function encodePlanInfoProto(cursorIntegration?: CursorIntegrationConfig): Buffer {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const plan = concatMessages(
    encodeString(1, integration.planName),
    encodeVarintFieldForce(2, LocalUltraPlanIncludedCents),
    encodeString(3, "$200/mo"),
    encodeInt64(4, Date.now() + 10 * 365 * 24 * 3600 * 1000),
  );
  return encodeMessage(1, plan);
}

/** GetDefaultModelNudgeDataResponse: models_with_no_default_switch=1, nudge_date=2 */
/**
 * GetDefaultModelNudgeDataResponse.
 *
 * Cursor 3.13 uses nudge_date=1, should_default_switch_on_new_chat=2 and
 * models_with_no_default_switch=3. Keeping these wire types exact matters:
 * writing a string to field 2 makes the desktop client's protobuf decoder
 * reject the entire model-picker response.
 */
export function encodeDefaultModelNudgeProto(
  modelNames: string[],
  nudgeDate = "0",
  shouldDefaultSwitchOnNewChat = false,
): Buffer {
  return concatMessages(
    encodeString(1, nudgeDate),
    encodeBool(2, shouldDefaultSwitchOnNewChat),
    ...modelNames.map((n) => encodeString(3, n)),
  );
}

/** GetDefaultModelResponse. */
export function encodeDefaultModelProto(
  model: string,
  thinkingModel = model,
  maxMode = false,
): Buffer {
  return concatMessages(
    encodeString(1, model),
    encodeString(2, thinkingModel),
    encodeBool(3, maxMode),
  );
}

/** CountTokensResponse. Token details are optional for the local estimator. */
export function encodeCountTokensProto(count: number): Buffer {
  return encodeInt32(1, Math.max(0, Math.min(0x7fffffff, Math.round(count))));
}

/** Dashboard GetTokenUsageResponse. */
export function encodeTokenUsageProto(
  inputTokens: number,
  outputTokens: number,
): Buffer {
  return concatMessages(
    encodeInt32(1, Math.max(0, Math.min(0x7fffffff, Math.round(inputTokens)))),
    encodeInt32(2, Math.max(0, Math.min(0x7fffffff, Math.round(outputTokens)))),
  );
}

export function encodeServerTimeProto(): Buffer {
  const now = Date.now();
  return concatMessages(encodeDouble(1, now), encodeDouble(2, now));
}

export function encodeGetServerConfigProto(): Buffer {
  return concatMessages(
    encodeString(6, "local_cli_sandbox_defaults_disabled_v2"),
    encodeBool(28, true),
  );
}

export function encodeCurrentPeriodUsageProto(
  cursorIntegration?: CursorIntegrationConfig,
): Buffer {
  const label = cursorIntegrationLabel(cursorIntegration);
  const planUsage = concatMessages(
    encodeInt32(2, 99_999_999), // included_spend
    encodeInt32(4, 99_999_999), // remaining
    encodeInt32(5, 99_999_999), // limit
    encodeString(7, label),
  );
  const spendLimitUsage = encodeString(8, "user");
  return concatMessages(
    encodeInt64(1, Date.now() - 365 * 24 * 3600 * 1000),
    encodeInt64(2, Date.now() + 10 * 365 * 24 * 3600 * 1000),
    encodeMessage(3, planUsage),
    encodeMessage(4, spendLimitUsage),
    encodeInt32(5, 99_999_999),
    encodeBool(6, true),
    encodeString(7, label),
    encodeString(11, label),
    encodeString(12, label),
  );
}

export function encodeUserPrivacyModeProto(): Buffer {
  return concatMessages(
    encodeVarintFieldForce(1, 1),
    encodeBool(6, true),
  );
}

export function encodeUsageLimitStatusProto(): Buffer {
  const policy = concatMessages(
    encodeBool(6, true),
    encodeString(7, "user"),
  );
  return encodeMessage(1, policy);
}

export function encodeIsOnNewPricingProto(): Buffer {
  return concatMessages(
    encodeBool(1, true),
    encodeBool(3, true),
    encodeVarintFieldForce(4, LocalUltraDashboardUserID),
  );
}

export function encodeGlassEarlyPreviewEnrollmentProto(): Buffer {
  return concatMessages(encodeBool(1, true), encodeBool(2, true), encodeBool(3, true));
}

export function encodeBootstrapStatsigProto(
  cursorIntegration?: CursorIntegrationConfig,
): Buffer {
  const integration = normalizeCursorIntegration(cursorIntegration);
  const now = Date.now();
  const gate = (name: string, value: boolean, rule: string) => ({
    name,
    value,
    rule_id: rule,
    ruleID: rule,
    group_name: rule,
    groupName: rule,
    secondary_exposures: [],
    secondaryExposures: [],
    undelegated_secondary_exposures: [],
    undelegatedSecondaryExposures: [],
    is_device_based: false,
    isDeviceBased: false,
    id_type: "userID",
    idType: "userID",
  });
  const config = JSON.stringify({
    feature_gates: {
      nal_agent_retries: gate("nal_agent_retries", true, "local_enabled"),
      nal_fresh_retry_ids: gate("nal_fresh_retry_ids", true, "local_enabled"),
      use_model_parameters: gate("use_model_parameters", true, "local_enabled"),
      use_react_model_picker: gate("use_react_model_picker", true, "local_enabled"),
      decompose_always_local_ext_host: gate("decompose_always_local_ext_host", false, "local_disabled"),
      cursor_extensions_isolation_v2: gate("cursor_extensions_isolation_v2", false, "local_disabled"),
      enable_cursor_agent_worker_extension: gate("enable_cursor_agent_worker_extension", false, "local_disabled"),
    },
    dynamic_configs: {
      free_user_model_picker: {
        name: "free_user_model_picker",
        value: { variant: "control" },
        rule_id: "local_default",
        ruleID: "local_default",
        group_name: "local_default",
        groupName: "local_default",
        secondary_exposures: [],
        secondaryExposures: [],
        undelegated_secondary_exposures: [],
        undelegatedSecondaryExposures: [],
        is_device_based: false,
        isDeviceBased: false,
        is_experiment_active: false,
        isExperimentActive: false,
        is_user_in_experiment: false,
        isUserInExperiment: false,
      },
    },
    layer_configs: {},
    user: {
      userID: authIdFromJwt(InjectAuthToken) || LocalUltraPaymentID,
      email: integration.contactEmail,
    },
    has_updates: true,
    hash_used: "none",
    sdkParams: {},
    time: now,
  });
  return concatMessages(encodeString(1, config), encodeInt64(2, now));
}

export function encodeFirstWindowStatsigDecisionProto(): Buffer {
  return concatMessages(encodeString(1, "control"), encodeString(2, "local_default"));
}

export { THINKING_PARAM_ID };

// silence unused import if encodeBytes unused
void encodeBytes;
void encodeVarintField;
