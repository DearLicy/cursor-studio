/**
 * 供应商模型：拉取 + 持久化到 config.providers[].models
 */
import {
  loadConfig,
  saveConfig,
  newProvider,
  type ModelProvider,
} from "../config/store";
import {
  fetchProviderModels,
  type FetchedModel,
  type ProviderType,
} from "./fetch-models";

export type FetchAndSaveInput = {
  id?: string;
  displayName?: string;
  type: ProviderType;
  baseURL: string;
  apiKey: string;
  enabled?: boolean;
  modelID?: string;
  openAIEndpoint?: ModelProvider["openAIEndpoint"];
  reasoningEffort?: string;
  /** Present even when undefined when the caller wants to clear balance probing. */
  balance?: ModelProvider["balance"];
};

export type FetchAndSaveResult = {
  provider: ModelProvider;
  providers: ModelProvider[];
  models: FetchedModel[];
  endpoint: string;
  count: number;
};

export async function fetchAndSaveProviderModels(
  input: FetchAndSaveInput,
): Promise<FetchAndSaveResult> {
  const hasBalance = Object.prototype.hasOwnProperty.call(input, "balance");
  const fetched = await fetchProviderModels({
    type: input.type,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
  });
  const ids = fetched.models.map((m) => m.id);
  const cfg = await loadConfig();
  const keepDefault =
    input.modelID && ids.includes(input.modelID)
      ? input.modelID
      : ids[0] || input.modelID || "";

  let next: ModelProvider;
  const existingIdx = input.id
    ? cfg.providers.findIndex((p) => p.id === input.id)
    : -1;

  if (existingIdx >= 0) {
    next = {
      ...cfg.providers[existingIdx],
      type: input.type,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      displayName:
        input.displayName?.trim() || cfg.providers[existingIdx].displayName,
      enabled:
        input.enabled !== undefined
          ? input.enabled
          : cfg.providers[existingIdx].enabled,
      models: ids,
      modelSettings: cfg.providers[existingIdx].modelSettings || {},
      modelID: keepDefault,
      openAIEndpoint:
        input.type === "openai"
          ? input.openAIEndpoint ||
            cfg.providers[existingIdx].openAIEndpoint ||
            "/v1/chat/completions"
          : undefined,
      reasoningEffort:
        input.reasoningEffort ||
        cfg.providers[existingIdx].reasoningEffort ||
        "high",
      ...(hasBalance ? { balance: input.balance } : {}),
    };
    cfg.providers[existingIdx] = next;
  } else {
    next = newProvider({
      type: input.type,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      displayName: input.displayName?.trim() || "Provider",
      enabled: input.enabled !== false,
      models: ids,
      modelID: keepDefault,
      openAIEndpoint: input.openAIEndpoint,
      reasoningEffort: input.reasoningEffort || "high",
      balance: input.balance,
    });
    cfg.providers.push(next);
  }

  await saveConfig(cfg);
  return {
    provider: next,
    providers: cfg.providers,
    models: fetched.models,
    endpoint: fetched.endpoint,
    count: ids.length,
  };
}
