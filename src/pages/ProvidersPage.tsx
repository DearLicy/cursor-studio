import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { toast } from "@/components/ui/app-notice";
import {
  Activity,
  Copy,
  Download,
  Gauge,
  Layers,
  Loader2,
  Pencil,
  Power,
  RefreshCw,
  Trash2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getApi,
  type FetchedModel,
  type ModelProvider,
  type ModelSettings,
  type ProviderBalanceResult,
  type ProviderHealth,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { EmptyState, Field } from "@/components/ui/layout";
import { useConfirm } from "@/components/ui/confirm";
import { SimpleSelect } from "@/components/ui/select";

type BalanceMode = "none" | "newapi" | "sub2api";

function initials(name: string): string {
  const normalized = name.trim();
  if (!normalized) return "?";
  const parts = normalized.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return normalized.slice(0, 2).toUpperCase();
}

function healthCopy(
  health?: ProviderHealth,
  statusUnavailable = false,
): { label: string; detail: string; state: string } {
  if (statusUnavailable) {
    return { label: "状态暂不可用", detail: "可点击测速后重试", state: "unknown" };
  }
  if (!health || health.state === "unknown") {
    return { label: "未检测", detail: "可进行测速", state: "unknown" };
  }
  if (health.state === "healthy") {
    return {
      label: "正常",
      detail: health.latencyMs != null ? `${health.latencyMs}ms` : "连接正常",
      state: "healthy",
    };
  }
  if (health.state === "degraded") {
    return {
      label: "较慢",
      detail: health.latencyMs != null ? `${health.latencyMs}ms` : "请稍后重试",
      state: "degraded",
    };
  }
  return {
    label: "不可用",
    detail: health.error || "请检查连接信息",
    state: "offline",
  };
}

export function ProvidersPage({
  providers,
  onChange,
  addTick = 0,
  saveTick = 0,
  onEditingChange,
  onAddRequestHandled,
  returnToListTick = 0,
}: {
  providers: ModelProvider[];
  onChange: (list: ModelProvider[]) => void;
  addTick?: number;
  saveTick?: number;
  onEditingChange?: (editing: boolean) => void;
  onAddRequestHandled?: (requestTick: number) => void;
  returnToListTick?: number;
}) {
  const api = getApi();
  const { confirm, ConfirmDialog } = useConfirm();
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [healthById, setHealthById] = useState<Record<string, ProviderHealth>>({});
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [refreshingModelId, setRefreshingModelId] = useState<string | null>(null);
  const [balanceResults, setBalanceResults] = useState<Record<string, ProviderBalanceResult>>({});
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [isReturningToDirectory, setIsReturningToDirectory] = useState(false);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const returnTimerRef = useRef<number | undefined>();
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;

  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => model.id.toLowerCase().includes(query));
  }, [models, modelFilter]);

  const providerSummary = useMemo(() => {
    const enabled = providers.filter((provider) => provider.enabled).length;
    const modelCount = providers.reduce((total, provider) => total + (provider.models?.length || 0), 0);
    const healthy = providers.filter((provider) => healthById[provider.id]?.state === "healthy").length;
    return { enabled, modelCount, healthy };
  }, [healthById, providers]);
  const healthStatusUnavailable = healthUnavailable && Object.keys(healthById).length === 0;

  const openNew = async () => {
    const template = await api.newProviderTemplate();
    setEditing({ ...template, models: template.models ?? [] });
    setModels([]);
    setModelFilter("");
  };

  const openEdit = (provider: ModelProvider) => {
    setEditing({
      ...provider,
      balance: provider.balance ? { ...provider.balance } : undefined,
      modelSettings: provider.modelSettings ? { ...provider.modelSettings } : undefined,
      models: provider.models ?? (provider.modelID ? [provider.modelID] : []),
    });
    setModels((provider.models ?? []).map((id) => ({ id })));
    setModelFilter("");
  };

  const clearEditing = () => {
    setEditing(null);
    setModels([]);
    setModelFilter("");
  };

  useEffect(() => {
    if (addTick <= 0) return;
    void openNew();
    onAddRequestHandled?.(addTick);
    // The tick is intentionally the command boundary from the app top bar and
    // is acknowledged immediately so it cannot replay after remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addTick]);

  useLayoutEffect(() => {
    if (returnToListTick <= 0 || !editing || isReturningToDirectory) return;

    // Keep the editor chrome in place until the short exit motion completes.
    // This prevents the top bar and page body from switching on separate frames.
    onEditingChangeRef.current?.(true);
    setIsReturningToDirectory(true);
    if (returnTimerRef.current) window.clearTimeout(returnTimerRef.current);
    returnTimerRef.current = window.setTimeout(() => {
      setIsReturningToDirectory(false);
      clearEditing();
      returnTimerRef.current = undefined;
    }, 240);
    // returnToListTick is the external command boundary; including editing here
    // would replay a completed return whenever a new provider is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnToListTick]);

  useLayoutEffect(() => {
    onEditingChangeRef.current?.(Boolean(editing));
  }, [editing]);

  useEffect(() => {
    return () => {
      if (returnTimerRef.current) window.clearTimeout(returnTimerRef.current);
      onEditingChangeRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void api
      .providerHealth()
      .then((result) => {
        if (!active) return;
        setHealthById(Object.fromEntries(result.health.map((item) => [item.providerId, item])));
        setHealthUnavailable(false);
      })
      .catch(() => {
        if (!active) return;
        setHealthUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [api, providers]);

  useEffect(() => {
    if (!editing?.balance || !providers.some((provider) => provider.id === editing.id)) return;
    let active = true;
    void api
      .listProviderBalances(editing.id)
      .then((result) => {
        if (!active) return;
        const resultForProvider = result.balances.find((item) => item.providerId === editing.id);
        if (resultForProvider) {
          setBalanceResults((current) => ({ ...current, [editing.id]: resultForProvider }));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, editing?.id]);

  const probe = async (provider: ModelProvider, event?: MouseEvent) => {
    event?.stopPropagation();
    if (probingId) return;
    setProbingId(provider.id);
    try {
      const result = await api.probeProvider(provider);
      setHealthById((current) => ({ ...current, [provider.id]: result.health }));
      setHealthUnavailable(false);
      if (result.ok) {
        toast.success(`${provider.displayName} 连接正常`, `${result.latencyMs}ms`);
      } else {
        toast.error(`${provider.displayName} 连接未通过`, result.error || "请检查服务地址和访问密钥");
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setProbingId(null);
    }
  };

  const toggleProviderEnabled = async (provider: ModelProvider, enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const list = await api.upsertProvider({ ...provider, enabled });
      onChange(list);
      toast.success(enabled ? "供应商已启用" : "供应商已停用");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const ok = await confirm({ title: "删除此供应商", confirmText: "删除", danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      const list = await api.removeProvider(id);
      onChange(list);
      if (editing?.id === id) clearEditing();
      toast.success("供应商已删除");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (id: string, event?: MouseEvent) => {
    event?.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.duplicateProvider(id);
      onChange(result.providers);
      toast.success(`已复制 ${result.provider.displayName}`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const pullModels = async () => {
    if (!editing || fetching) return;
    if (!editing.baseURL.trim() || !editing.apiKey.trim()) {
      toast.error("请先填写服务地址和 API 密钥");
      return;
    }
    setFetching(true);
    try {
      const result = await api.fetchModels({
        type: editing.type,
        baseURL: editing.baseURL,
        apiKey: editing.apiKey,
      });
      const ids = result.models.map((model) => model.id);
      const modelID = editing.modelID && ids.includes(editing.modelID) ? editing.modelID : ids[0] || "";
      setModels(result.models);
      setEditing({ ...editing, models: ids, modelID });
      toast.success(`已拉取 ${ids.length} 个模型`, "保存后生效");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setFetching(false);
    }
  };

  const refreshProviderModels = async (provider: ModelProvider, event: MouseEvent) => {
    event.stopPropagation();
    if (busy || refreshingModelId) return;
    if (!provider.baseURL.trim() || !provider.apiKey.trim()) {
      toast.error("请先完善服务地址和 API 密钥");
      return;
    }
    setRefreshingModelId(provider.id);
    try {
      const result = await api.fetchModelsAndSave({
        id: provider.id,
        displayName: provider.displayName,
        type: provider.type,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        enabled: provider.enabled,
        modelID: provider.modelID,
        openAIEndpoint: provider.openAIEndpoint,
        reasoningEffort: provider.reasoningEffort,
        balance: provider.balance,
      });
      onChange(result.providers);
      if (editing?.id === provider.id) {
        const saved = result.providers.find((item) => item.id === provider.id);
        if (saved) openEdit(saved);
      }
      toast.success(`已更新 ${result.count} 个模型`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRefreshingModelId(null);
    }
  };

  const toggleModelEnabled = (modelId: string) => {
    if (!editing) return;
    const nextEnabled = editing.modelSettings?.[modelId]?.enabled === false;
    const nextSettings = {
      ...(editing.modelSettings || {}),
      [modelId]: {
        ...(editing.modelSettings?.[modelId] || {}),
        enabled: nextEnabled,
      },
    };
    const availableModels = (editing.models || models.map((model) => model.id)).filter(
      (id) => nextSettings[id]?.enabled !== false,
    );
    setEditing({
      ...editing,
      modelSettings: nextSettings,
      modelID: availableModels.includes(editing.modelID) ? editing.modelID : availableModels[0] || "",
    });
  };

  const removeModel = (modelId: string) => {
    if (!editing) return;
    const nextModels = (editing.models || models.map((model) => model.id)).filter((id) => id !== modelId);
    const nextSettings = { ...(editing.modelSettings || {}) };
    delete nextSettings[modelId];
    setModels((current) => current.filter((model) => model.id !== modelId));
    setEditing({
      ...editing,
      models: nextModels,
      modelSettings: nextSettings,
      modelID: editing.modelID === modelId ? nextModels[0] || "" : editing.modelID,
    });
  };

  const refreshBalance = async () => {
    if (!editing || !editing.balance || balanceBusy) return;
    setBalanceBusy(true);
    try {
      const result = await api.probeProviderBalance(editing);
      setBalanceResults((current) => ({ ...current, [editing.id]: result.balance }));
      if (result.balance.ok) {
        toast.success("余额已更新");
      } else {
        toast.error("余额查询未成功", result.balance.error || "请检查相关信息");
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBalanceBusy(false);
    }
  };

  const save = async () => {
    if (!editing || busy || fetching) return;
    if (!editing.displayName.trim() || !editing.apiKey.trim() || !editing.baseURL.trim()) {
      toast.error("请填写名称、服务地址和 API 密钥");
      return;
    }
    if (editing.balance?.type === "newapi" && (!editing.balance.userId.trim() || !editing.balance.accessToken.trim())) {
      toast.error("请填写用户 ID 和访问令牌");
      return;
    }
    const modelsList =
      editing.models && editing.models.length > 0
        ? editing.models
        : models.length > 0
          ? models.map((model) => model.id)
          : editing.modelID
            ? [editing.modelID]
            : [];
    if (modelsList.length === 0 && !editing.modelID.trim()) {
      toast.error("请先拉取模型或填写默认模型");
      return;
    }
    const modelID = editing.modelID.trim() || modelsList[0];
    setBusy(true);
    try {
      const list = await api.upsertProvider({ ...editing, modelID, models: modelsList });
      onChange(list);
      const saved = list.find((provider) => provider.id === editing.id);
      if (saved) openEdit(saved);
      else setEditing({ ...editing, modelID, models: modelsList });
      toast.success("供应商已保存");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  saveRef.current = save;

  useEffect(() => {
    if (saveTick > 0) void saveRef.current();
  }, [saveTick]);

  if (editing) {
    const balanceMode: BalanceMode = editing.balance?.type || "none";
    const newApiBalance = editing.balance?.type === "newapi" ? editing.balance : null;
    const balanceResult = balanceResults[editing.id];
    const balanceText = balanceResult
      ? balanceResult.ok
        ? balanceResult.balanceText || "查询完成"
        : balanceResult.error || "查询未成功"
      : balanceMode === "none"
        ? "未启用查询"
        : "尚未查询";

    return (
      <div
        className={cn(
          "cs-page provider-editor-page provider-editor-page--enter",
          isReturningToDirectory && "is-returning",
        )}
      >
        {ConfirmDialog}
        <div className="provider-editor-shell">
          <section className="provider-editor-section provider-editor-section--connection workspace-layer-enter" aria-label="连接">
            <div className="provider-editor-section-bar">
              <div className="provider-editor-section-heading">
                <span className="provider-editor-section-icon is-blue" aria-hidden="true">
                  <Activity />
                </span>
                <span>连接</span>
              </div>
              <div className="provider-editor-section-bar__actions" data-no-drag>
                <div className="provider-editor-enabled">
                  <span>启用</span>
                  <Switch
                    checked={editing.enabled}
                    onCheckedChange={(enabled) => setEditing({ ...editing, enabled })}
                  />
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="provider-icon-command"
                  title="测试连接"
                  onClick={() => void probe(editing)}
                  disabled={Boolean(probingId) || busy || fetching}
                >
                  {probingId === editing.id ? (
                    <RefreshCw className="workspace-refresh-icon is-spinning animate-spin" />
                  ) : (
                    <Gauge />
                  )}
                </Button>
              </div>
            </div>
            <div className="provider-editor-fields">
              <Field label="预设" className="provider-editor-field provider-editor-field--wide">
                <SimpleSelect
                  value={
                    PROVIDER_PRESETS.find((preset) => preset.baseURL === editing.baseURL)?.id || "custom"
                  }
                  onValueChange={applyPresetValue(setEditing, editing, setModels)}
                  options={[
                    ...PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
                    { value: "custom", label: "自定义" },
                  ]}
                />
              </Field>
              <Field label="名称" className="provider-editor-field">
                <Input
                  value={editing.displayName}
                  onChange={(event) => setEditing({ ...editing, displayName: event.target.value })}
                />
              </Field>
              <Field label="类型" className="provider-editor-field">
                <SimpleSelect
                  value={editing.type}
                  onValueChange={(value) =>
                    setEditing({
                      ...editing,
                      type: value as ModelProvider["type"],
                      openAIEndpoint:
                        value === "openai" ? editing.openAIEndpoint || "/v1/chat/completions" : undefined,
                    })
                  }
                  options={[
                    { value: "openai", label: "OpenAI 兼容" },
                    { value: "anthropic", label: "Anthropic 兼容" },
                  ]}
                />
              </Field>
              {editing.type === "openai" ? (
                <Field label="接口" className="provider-editor-field">
                  <SimpleSelect
                    value={editing.openAIEndpoint || "/v1/chat/completions"}
                    onValueChange={(value) =>
                      setEditing({ ...editing, openAIEndpoint: value as ModelProvider["openAIEndpoint"] })
                    }
                    options={[
                      { value: "/v1/chat/completions", label: "Chat Completions" },
                      { value: "/v1/responses", label: "Responses" },
                    ]}
                  />
                </Field>
              ) : null}
              <Field label="服务地址" className="provider-editor-field provider-editor-field--wide">
                <Input
                  value={editing.baseURL}
                  onChange={(event) => setEditing({ ...editing, baseURL: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              <Field label="API 密钥" className="provider-editor-field provider-editor-field--wide">
                <Input
                  type="password"
                  value={editing.apiKey}
                  onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })}
                />
              </Field>
            </div>
          </section>

          <section className="provider-editor-section provider-editor-section--models workspace-layer-enter workspace-layer-enter--delay-1" aria-label="模型">
            <div className="provider-editor-section-bar">
              <div className="provider-editor-section-heading">
                <span className="provider-editor-section-icon is-violet" aria-hidden="true">
                  <Layers />
                </span>
                <span>模型</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="provider-inline-command"
                onClick={() => void pullModels()}
                disabled={fetching || busy}
              >
                {fetching ? <Loader2 className="workspace-refresh-icon is-spinning animate-spin" /> : <Download />}
                拉取模型
              </Button>
            </div>
            <div className="provider-editor-fields provider-model-settings">
              <Field label="默认模型" className="provider-editor-field provider-editor-field--wide">
                <Input
                  value={editing.modelID}
                  onChange={(event) => setEditing({ ...editing, modelID: event.target.value })}
                  placeholder="模型 ID"
                />
              </Field>
              <ModelCatalogEditor
                className="provider-editor-field provider-editor-field--wide"
                models={filteredModels}
                total={models.length}
                filter={modelFilter}
                onFilterChange={setModelFilter}
                defaultModel={editing.modelID}
                settings={editing.modelSettings || {}}
                onDefaultChange={(modelID) => setEditing({ ...editing, modelID })}
                onToggleEnabled={toggleModelEnabled}
                onRemove={removeModel}
              />
            </div>
          </section>

          <section className="provider-editor-section provider-editor-section--balance workspace-layer-enter workspace-layer-enter--delay-2" aria-label="余额">
            <div className="provider-editor-section-bar">
              <div className="provider-editor-section-heading">
                <span className="provider-editor-section-icon is-green" aria-hidden="true">
                  <Wallet />
                </span>
                <span>余额</span>
              </div>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="provider-icon-command"
                title="刷新余额"
                onClick={() => void refreshBalance()}
                disabled={balanceMode === "none" || balanceBusy}
              >
                <RefreshCw className={cn("workspace-refresh-icon", balanceBusy && "is-spinning animate-spin")} />
              </Button>
            </div>
            <div className="provider-editor-fields provider-balance-fields">
              <Field label="查询方式" className="provider-editor-field">
                <SimpleSelect
                  value={balanceMode}
                  onValueChange={(value) => {
                    const mode = value as BalanceMode;
                    setBalanceResults((current) => {
                      const next = { ...current };
                      delete next[editing.id];
                      return next;
                    });
                    if (mode === "newapi") {
                      setEditing({ ...editing, balance: { type: "newapi", userId: "", accessToken: "" } });
                    } else if (mode === "sub2api") {
                      setEditing({ ...editing, balance: { type: "sub2api" } });
                    } else {
                      setEditing({ ...editing, balance: undefined });
                    }
                  }}
                  options={[
                    { value: "none", label: "不查询" },
                    { value: "newapi", label: "NewAPI" },
                    { value: "sub2api", label: "Sub2API" },
                  ]}
                />
              </Field>
              {newApiBalance ? (
                <>
                  <Field label="用户 ID" className="provider-editor-field">
                    <Input
                      value={newApiBalance.userId}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          balance: {
                            type: "newapi",
                            userId: event.target.value,
                            accessToken: newApiBalance.accessToken,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="访问令牌" className="provider-editor-field provider-editor-field--wide">
                    <Input
                      type="password"
                      value={newApiBalance.accessToken}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          balance: {
                            type: "newapi",
                            userId: newApiBalance.userId,
                            accessToken: event.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                </>
              ) : null}
              {editing.balance?.type === "sub2api" ? (
                <p className="provider-balance-note provider-editor-field--wide">
                  使用此供应商的服务地址和 API 密钥
                </p>
              ) : null}
              <div className="provider-balance-result provider-editor-field--wide" aria-live="polite">
                <span className={cn("provider-balance-result__icon", balanceResult?.ok && "is-ready")} aria-hidden="true">
                  <Wallet />
                </span>
                <span>{balanceText}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="cs-page provider-directory-page">
      {ConfirmDialog}
      <section className="provider-directory__summary workspace-layer-enter" aria-label="供应商概览">
        <div className="provider-directory__summary-copy">
          <span className="provider-directory__panel-icon" aria-hidden="true">
            <Layers />
          </span>
          <div>
            <h2>供应商概览</h2>
            <p>模型服务连接状态</p>
          </div>
        </div>
        <div className="provider-directory__summary-metrics">
          <div>
            <span>已连接</span>
            <strong>{providers.length}</strong>
          </div>
          <div>
            <span>启用中</span>
            <strong>{providerSummary.enabled}</strong>
          </div>
          <div>
            <span>可用模型</span>
            <strong>{providerSummary.modelCount}</strong>
          </div>
          <div>
            <span>连接正常</span>
            <strong>{healthStatusUnavailable ? "-" : providerSummary.healthy}</strong>
          </div>
        </div>
      </section>

      <section className="provider-directory__rows" aria-label="供应商列表">
        {providers.length ? (
          providers.map((provider, index) => {
            const health = healthCopy(healthById[provider.id], healthStatusUnavailable);
            const modelCount = provider.models?.length || 0;
            return (
              <article
                className="provider-directory__row workspace-layer-enter"
                key={provider.id}
                style={{ animationDelay: `${Math.min(index + 1, 4) * 60}ms` }}
              >
                <div className="provider-directory__identity">
                  <span className={cn("provider-directory__avatar", !provider.enabled && "is-disabled")}>
                    {initials(provider.displayName)}
                  </span>
                  <div>
                    <div className="provider-directory__name-line">
                      <strong>{provider.displayName}</strong>
                      <span className={cn("provider-directory__state", provider.enabled ? "is-enabled" : "is-disabled")}>
                        {provider.enabled ? "启用" : "停用"}
                      </span>
                    </div>
                    <span title={provider.baseURL}>{provider.baseURL}</span>
                  </div>
                </div>
                <div className="provider-directory__model">
                  <strong title={provider.modelID || undefined}>{provider.modelID || "未设置默认模型"}</strong>
                  <span>{modelCount} 个模型</span>
                </div>
                <div className={cn("provider-directory__health", `is-${health.state}`)}>
                  <i aria-hidden="true" />
                  <strong>{health.label}</strong>
                  <span title={health.detail}>{health.detail}</span>
                </div>
                <div className="provider-directory__row-actions" data-no-drag>
                  <Switch
                    checked={provider.enabled}
                    onCheckedChange={(enabled) => void toggleProviderEnabled(provider, enabled)}
                    disabled={busy}
                    aria-label={`${provider.displayName}${provider.enabled ? "已启用" : "已停用"}`}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="provider-directory__edit"
                    title="编辑供应商"
                    onClick={(event) => {
                      event.stopPropagation();
                      openEdit(provider);
                    }}
                    disabled={busy}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title="测速"
                    onClick={(event) => void probe(provider, event)}
                    disabled={Boolean(probingId)}
                  >
                    {probingId === provider.id ? (
                      <RefreshCw className="workspace-refresh-icon is-spinning animate-spin" />
                    ) : (
                      <Gauge />
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title="刷新模型"
                    onClick={(event) => void refreshProviderModels(provider, event)}
                    disabled={Boolean(refreshingModelId) || busy}
                  >
                    <RefreshCw
                      className={cn(
                        "workspace-refresh-icon",
                        refreshingModelId === provider.id && "is-spinning animate-spin",
                      )}
                    />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title="复制供应商"
                    onClick={(event) => void duplicate(provider.id, event)}
                    disabled={busy}
                  >
                    <Copy />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="provider-directory__delete"
                    title="删除供应商"
                    onClick={() => void remove(provider.id)}
                    disabled={busy}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </article>
            );
          })
        ) : (
          <EmptyState
            icon={<Layers className="h-5 w-5" />}
            className="provider-directory__empty"
            title="还没有供应商"
            description="从右上角添加第一个服务连接。"
          />
        )}
      </section>
    </div>
  );
}

function applyPresetValue(
  setEditing: (provider: ModelProvider | null) => void,
  editing: ModelProvider,
  setModels: (models: FetchedModel[]) => void,
) {
  return (presetId: string) => {
    if (presetId === "custom") return;
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setEditing({
      ...editing,
      displayName: preset.displayName,
      type: preset.type,
      baseURL: preset.baseURL,
      openAIEndpoint: preset.type === "openai" ? preset.openAIEndpoint : undefined,
      modelID: "",
      models: [],
    });
    setModels([]);
  };
}

function ModelCatalogEditor({
  className,
  models,
  total,
  filter,
  onFilterChange,
  defaultModel,
  settings,
  onDefaultChange,
  onToggleEnabled,
  onRemove,
}: {
  className?: string;
  models: FetchedModel[];
  total: number;
  filter: string;
  onFilterChange: (value: string) => void;
  defaultModel: string;
  settings: Record<string, ModelSettings>;
  onDefaultChange: (modelId: string) => void;
  onToggleEnabled: (modelId: string) => void;
  onRemove: (modelId: string) => void;
}) {
  if (!total) return null;
  return (
    <div className={cn("provider-model-catalog", className)}>
      <div className="provider-model-catalog__toolbar">
        <span>{total} 个模型</span>
        <Input
          className="h-8 max-w-[200px]"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder="筛选模型"
        />
      </div>
      <div className="provider-model-catalog__list">
        {models.map((model) => {
          const enabled = settings[model.id]?.enabled !== false;
          return (
            <div
              className={cn("provider-model-catalog__item", defaultModel === model.id && "is-selected")}
              key={model.id}
            >
              <button
                type="button"
                className="provider-model-catalog__name"
                onClick={() => onDefaultChange(model.id)}
                title="设为默认模型"
              >
                {model.id}
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="provider-model-catalog__action"
                title={enabled ? "停用模型" : "启用模型"}
                onClick={() => onToggleEnabled(model.id)}
              >
                <Power className={cn(enabled && "is-active")} />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="provider-model-catalog__action is-remove"
                title="移除模型"
                onClick={() => onRemove(model.id)}
              >
                <Trash2 />
              </Button>
            </div>
          );
        })}
        {!models.length ? <p className="provider-model-catalog__empty">没有匹配的模型</p> : null}
      </div>
    </div>
  );
}

const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  displayName: string;
  type: ModelProvider["type"];
  baseURL: string;
  openAIEndpoint?: ModelProvider["openAIEndpoint"];
}> = [
  {
    id: "openai",
    label: "OpenAI",
    displayName: "OpenAI",
    type: "openai",
    baseURL: "https://api.openai.com/v1",
    openAIEndpoint: "/v1/responses",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    displayName: "Anthropic",
    type: "anthropic",
    baseURL: "https://api.anthropic.com",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    displayName: "OpenRouter",
    type: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    openAIEndpoint: "/v1/chat/completions",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    displayName: "DeepSeek",
    type: "openai",
    baseURL: "https://api.deepseek.com",
    openAIEndpoint: "/v1/chat/completions",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    displayName: "SiliconFlow",
    type: "openai",
    baseURL: "https://api.siliconflow.cn/v1",
    openAIEndpoint: "/v1/chat/completions",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    displayName: "Moonshot",
    type: "openai",
    baseURL: "https://api.moonshot.cn/v1",
    openAIEndpoint: "/v1/chat/completions",
  },
  {
    id: "zhipu",
    label: "Zhipu GLM",
    displayName: "Zhipu GLM",
    type: "openai",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    openAIEndpoint: "/v1/chat/completions",
  },
  {
    id: "minimax",
    label: "MiniMax",
    displayName: "MiniMax",
    type: "openai",
    baseURL: "https://api.minimax.chat/v1",
    openAIEndpoint: "/v1/chat/completions",
  },
  {
    id: "newapi",
    label: "NewAPI / Sub2API",
    displayName: "NewAPI",
    type: "openai",
    baseURL: "https://your-newapi.example/v1",
    openAIEndpoint: "/v1/chat/completions",
  },
];
