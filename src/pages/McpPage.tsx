import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Eye,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";
import { toast } from "@/components/ui/app-notice";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/layout";
import { SimpleSelect } from "@/components/ui/select";
import {
  getApi,
  type McpListResult,
  type McpProbeResult,
  type McpServerSpec,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const SAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users"]
    }
  }
}`;

type McpServer = McpListResult["servers"][number];
type McpFilter = "all" | "ready" | "unchecked" | "issue";
type EditorMode = "new" | "edit";

function npxServer(packageName: string, extraArgs: string[] = []): McpServerSpec {
  return {
    command: "cmd",
    args: ["/c", "npx", "-y", packageName, ...extraArgs],
  };
}

const MCP_PRESETS: Array<{ id: string; label: string; spec: McpServerSpec }> = [
  {
    id: "filesystem",
    label: "文件系统",
    spec: npxServer("@modelcontextprotocol/server-filesystem", ["C:\\Users"]),
  },
  { id: "memory", label: "记忆", spec: npxServer("@modelcontextprotocol/server-memory") },
  {
    id: "sequential-thinking",
    label: "顺序思考",
    spec: npxServer("@modelcontextprotocol/server-sequential-thinking"),
  },
  { id: "time", label: "时间", spec: npxServer("@modelcontextprotocol/server-time") },
  { id: "context7", label: "Context7", spec: npxServer("@upstash/context7-mcp") },
  { id: "playwright", label: "Playwright", spec: npxServer("@playwright/mcp@latest") },
];

export function McpPage() {
  const api = useMemo(() => getApi(), []);
  const { confirm, ConfirmDialog } = useConfirm();
  const [data, setData] = useState<McpListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [probingAll, setProbingAll] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("new");
  const [jsonText, setJsonText] = useState(SAMPLE);
  const [lastProbe, setLastProbe] = useState<McpProbeResult | null>(null);
  const [detail, setDetail] = useState<McpServer | null>(null);
  const [presetId, setPresetId] = useState("custom");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<McpFilter>("all");

  const refresh = useCallback(
    async ({ initial = false, probe = false }: { initial?: boolean; probe?: boolean } = {}) => {
      const startedAt = initial ? 0 : performance.now();
      if (initial) setLoading(true);
      else if (probe) setProbingAll(true);
      else setRefreshing(true);

      try {
        setLoadError(null);
        setData(await api.listMcp({ probe }));
      } catch {
        setLoadError("MCP 服务加载失败，请稍后重试。");
        if (!initial) toast.error("刷新失败", { description: "请稍后重试。" });
      } finally {
        if (initial) {
          setLoading(false);
        } else {
          const remaining = 300 - (performance.now() - startedAt);
          if (remaining > 0) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
          }
          if (probe) setProbingAll(false);
          else setRefreshing(false);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    void refresh({ initial: true });
  }, [refresh]);

  const servers = data?.servers || [];
  const readyCount = servers.filter((server) => server.probe?.ok).length;
  const filtered = useMemo(() => {
    const search = q.trim().toLowerCase();
    return servers.filter((server) => {
      const status = mcpStatus(server.probe).id;
      const matchesFilter = filter === "all" || filter === status;
      const toolNames = server.probe?.tools.map((tool) => tool.name) || [];
      const matchesSearch = !search || [server.id, server.probe?.serverName, ...toolNames]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(search));
      return matchesFilter && matchesSearch;
    });
  }, [filter, q, servers]);

  const openNew = () => {
    setEditorMode("new");
    setJsonText(SAMPLE);
    setLastProbe(null);
    setPresetId("custom");
    setEditing(true);
  };

  const openEdit = (server: McpServer) => {
    setEditorMode("edit");
    setJsonText(JSON.stringify({ mcpServers: { [server.id]: server.spec } }, null, 2));
    setLastProbe(server.probe || null);
    setPresetId("custom");
    setEditing(true);
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = MCP_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setJsonText(JSON.stringify({ mcpServers: { [preset.id]: preset.spec } }, null, 2));
    setLastProbe(null);
  };

  const save = async () => {
    setSaving(true);
    setLastProbe(null);
    try {
      const result = await api.upsertMcpJson(jsonText, undefined, true);
      setData({ path: result.path, servers: result.servers });
      setLastProbe(result.probe || null);
      setEditing(false);
      toast.success("MCP 服务已保存", {
        description: result.probe?.ok ? `已识别 ${result.probe.toolCount} 个工具。` : undefined,
      });
    } catch {
      toast.error("保存失败", { description: "请检查连接信息后重试。" });
    } finally {
      setSaving(false);
    }
  };

  const testOnly = async () => {
    setTesting(true);
    setLastProbe(null);
    try {
      const parsed = parseMcpInput(jsonText);
      const probe = await api.probeMcp(parsed.spec, parsed.id);
      setLastProbe(probe);
      if (probe.ok) {
        toast.success("连接正常", { description: `已识别 ${probe.toolCount} 个工具。` });
      } else {
        toast.error("连接未通过", { description: "请检查连接信息后重试。" });
      }
    } catch {
      toast.error("检测失败", { description: "请检查连接信息后重试。" });
    } finally {
      setTesting(false);
    }
  };

  const probeServer = async (server: McpServer) => {
    setPendingItemId(server.id);
    try {
      const probe = await api.probeMcp(server.spec, server.id);
      setData((current) =>
        current
          ? {
              ...current,
              servers: current.servers.map((item) =>
                item.id === server.id ? { ...item, probe } : item,
              ),
            }
          : current,
      );
      toast[probe.ok ? "success" : "error"](probe.ok ? "服务连接正常" : "服务连接未通过", {
        description: probe.ok ? `已识别 ${probe.toolCount} 个工具。` : "请检查连接信息后重试。",
      });
    } catch {
      toast.error("检测失败", { description: "请稍后重试。" });
    } finally {
      setPendingItemId(null);
    }
  };

  const remove = async (server: McpServer) => {
    const accepted = await confirm({
      title: `移除「${server.id}」？`,
      description: "移除后，该服务将不再出现在当前列表中。",
      confirmText: "移除",
      danger: true,
    });
    if (!accepted) return;

    setPendingItemId(server.id);
    try {
      setData(await api.removeMcp(server.id));
      if (detail?.id === server.id) setDetail(null);
      toast.success("服务已移除");
    } catch {
      toast.error("移除失败", { description: "请稍后重试。" });
    } finally {
      setPendingItemId(null);
    }
  };

  const openMcpFile = async () => {
    setOpeningFile(true);
    try {
      await api.openMcpFile();
      toast.success("已打开所在位置");
      await refresh();
    } catch {
      toast.error("打开失败", { description: "请稍后重试。" });
    } finally {
      setOpeningFile(false);
    }
  };

  const controlsBusy = probingAll || saving || testing || pendingItemId !== null;
  const editorTitle = editorMode === "edit" ? "管理 MCP 服务" : "新增 MCP 服务";

  return (
    <div className="cs-page tools-workspace mcp-workspace">
      {ConfirmDialog}

      <header className="tools-workspace__toolbar workspace-layer-enter">
        <div className="tools-workspace__context">
          <span className="tools-workspace__context-icon" aria-hidden="true">
            <Server />
          </span>
          <div className="tools-workspace__context-copy">
            <h1>MCP</h1>
            <p>管理可连接的工具服务</p>
          </div>
        </div>

        <div className="tools-workspace__actions" data-no-drag>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="tools-workspace__icon-action"
            title="刷新服务列表"
            aria-label="刷新服务列表"
            onClick={() => void refresh()}
            disabled={loading || refreshing || controlsBusy}
          >
            <RefreshCw className={cn("workspace-refresh-icon", refreshing && "is-spinning animate-spin")} />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="tools-workspace__text-action"
            onClick={() => void refresh({ probe: true })}
            disabled={loading || controlsBusy}
          >
            <Activity className={cn("workspace-refresh-icon", probingAll && "is-spinning animate-spin")} />
            检测全部
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="tools-workspace__icon-action"
            title="查看服务位置"
            aria-label="查看服务位置"
            onClick={() => void openMcpFile()}
            disabled={openingFile}
          >
            <FolderOpen />
          </Button>
          <Button type="button" className="tools-workspace__primary-action" onClick={openNew} disabled={controlsBusy}>
            <Plus />
            新增 MCP
          </Button>
        </div>
      </header>

      {loading ? (
        <section className="tools-workspace__skeleton-grid workspace-layer-enter workspace-layer-enter--delay-1" aria-label="正在加载 MCP 服务">
          {Array.from({ length: 6 }, (_, index) => <div className="tools-workspace__skeleton" key={index} />)}
        </section>
      ) : loadError ? (
        <section className="tools-workspace__error workspace-layer-enter workspace-layer-enter--delay-1" role="alert">
          <CircleAlert aria-hidden="true" />
          <strong>MCP 服务加载失败</strong>
          <p>{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="tools-workspace__text-action" onClick={() => void refresh()}>
            重试
          </Button>
        </section>
      ) : (
        <>
          <section className="tools-workspace__control-panel workspace-layer-enter workspace-layer-enter--delay-1" aria-label="MCP 服务筛选">
            <div className="tools-workspace__control-grid">
              <label className="tools-workspace__field">
                <span className="tools-workspace__field-label">连接状态</span>
                <SimpleSelect
                  className="tools-workspace__mode-select"
                  value={filter}
                  onValueChange={setFilter}
                  options={[
                    { value: "all", label: "全部服务" },
                    { value: "ready", label: "连接正常" },
                    { value: "unchecked", label: "等待检测" },
                    { value: "issue", label: "需要处理" },
                  ]}
                />
              </label>
              <label className="tools-workspace__field">
                <span className="tools-workspace__field-label">搜索</span>
                <span className="tools-workspace__search">
                  <Search aria-hidden="true" />
                  <input
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                    placeholder="搜索服务或工具"
                    aria-label="搜索 MCP 服务"
                  />
                </span>
              </label>
            </div>
            <div className="tools-workspace__summary">
              <SlidersHorizontal aria-hidden="true" />
              <span>
                共 <strong>{servers.length}</strong> 个 MCP 服务，已确认 <strong>{readyCount}</strong> 个连接正常。
              </span>
            </div>
          </section>

          {filtered.length ? (
            <section className="tools-workspace__grid workspace-layer-enter workspace-layer-enter--delay-2" aria-label="MCP 服务列表">
              {filtered.map((server, index) => {
                const status = mcpStatus(server.probe);
                const isPending = pendingItemId === server.id;
                return (
                  <article
                    key={server.id}
                    className={cn("tools-workspace__card", status.className)}
                    style={{ animationDelay: `${80 + Math.min(index, 4) * 40}ms` }}
                  >
                    <div className="tools-workspace__card-head">
                      <div className="tools-workspace__identity">
                        <span className="tools-workspace__icon" aria-hidden="true">
                          <Server />
                        </span>
                        <div className="tools-workspace__title-wrap">
                          <strong className="tools-workspace__title" title={server.id}>{server.id}</strong>
                          <span className="tools-workspace__meta">{mcpMeta(server)}</span>
                        </div>
                      </div>
                      <span className={cn("tools-workspace__status", status.className)}>{status.label}</span>
                    </div>

                    <p className="tools-workspace__preview">{mcpPreview(server)}</p>
                    {server.probe?.ok ? (
                      <div className="tools-workspace__current">
                        <Wrench aria-hidden="true" />
                        已识别 {server.probe.toolCount} 个工具
                      </div>
                    ) : null}

                    <footer className="tools-workspace__card-footer">
                      <div className="tools-workspace__card-actions">
                        <Button type="button" variant="outline" size="sm" className="tools-workspace__card-action" onClick={() => setDetail(server)}>
                          <Eye />
                          查看
                        </Button>
                        <Button type="button" variant="outline" size="sm" className="tools-workspace__card-action" onClick={() => openEdit(server)}>
                          <Pencil />
                          管理
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="tools-workspace__card-action tools-workspace__card-icon-action"
                          title={`检测 ${server.id}`}
                          aria-label={`检测 ${server.id}`}
                          onClick={() => void probeServer(server)}
                          disabled={controlsBusy || isPending}
                        >
                          <Activity className={cn("workspace-refresh-icon", isPending && "is-spinning animate-spin")} />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="tools-workspace__card-action tools-workspace__card-icon-action is-danger"
                        title={`移除 ${server.id}`}
                        aria-label={`移除 ${server.id}`}
                        onClick={() => void remove(server)}
                        disabled={controlsBusy || isPending}
                      >
                        <Trash2 />
                      </Button>
                    </footer>
                  </article>
                );
              })}
            </section>
          ) : (
            <section className="tools-workspace__empty workspace-layer-enter workspace-layer-enter--delay-2">
              <Server aria-hidden="true" />
              <strong>{q || filter !== "all" ? "没有匹配的 MCP 服务" : "还没有 MCP 服务"}</strong>
              <p>{q || filter !== "all" ? "调整搜索或筛选条件后再试。" : "新增 MCP 服务后，可以在这里统一查看、检测和管理。"}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="tools-workspace__text-action"
                onClick={q || filter !== "all" ? () => { setQ(""); setFilter("all"); } : openNew}
              >
                {q || filter !== "all" ? "清除筛选" : "新增 MCP"}
              </Button>
            </section>
          )}
        </>
      )}

      <Dialog open={editing} onOpenChange={(open) => { if (!open && !saving && !testing) setEditing(false); }}>
        <DialogContent size="lg" className="tools-workspace__dialog">
          <DialogHeader>
            <DialogTitle>{editorTitle}</DialogTitle>
          <DialogDescription>选择常用服务或粘贴连接信息。保存前会先检查连接。</DialogDescription>
          </DialogHeader>
          <DialogBody className="tools-workspace__dialog-body">
            <div className="tools-workspace__dialog-fields">
              <Field label="快捷预设">
                <SimpleSelect
                  className="tools-workspace__mode-select"
                  value={presetId}
                  onValueChange={applyPreset}
                  options={[
                    ...MCP_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
                    { value: "custom", label: "自定义连接" },
                  ]}
                />
              </Field>
              <Field label="连接信息">
                <Textarea
                  className="tools-workspace__editor"
                  value={jsonText}
                  onChange={(event) => setJsonText(event.target.value)}
                  spellCheck={false}
                />
              </Field>
              {lastProbe ? <ProbeResult probe={lastProbe} /> : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving || testing}>取消</Button>
            <Button type="button" variant="outline" className="tools-workspace__dialog-secondary" disabled={saving || testing} onClick={() => void testOnly()}>
              <RefreshCw className={cn("workspace-refresh-icon", testing && "is-spinning animate-spin")} />
              {testing ? "检测中" : "仅检测"}
            </Button>
            <Button type="button" className="tools-workspace__dialog-save" disabled={saving || testing} onClick={() => void save()}>
              <Save />
              {saving ? "保存中" : "检测并保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="tools-workspace__dialog" size="lg">
          <DialogHeader>
            <DialogTitle>{detail?.id}</DialogTitle>
            <DialogDescription>{detail ? detailDescription(detail) : ""}</DialogDescription>
          </DialogHeader>
          <DialogBody className="tools-workspace__dialog-body">
            {detail?.probe?.ok && detail.probe.tools.length ? (
              <div className="tools-workspace__tool-list">
                {detail.probe.tools.map((tool) => (
                  <article key={tool.name} className="tools-workspace__tool-item">
                    <Wrench aria-hidden="true" />
                    <div>
                      <strong>{tool.name}</strong>
                      {tool.description ? <p>{tool.description}</p> : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="tools-workspace__dialog-empty">
                <Activity aria-hidden="true" />
                <strong>{detail?.probe?.ok === false ? "当前连接未通过" : "尚未获取工具列表"}</strong>
                <p>{detail?.probe?.ok === false ? "检查连接信息后重新检测。" : "检测服务后，这里会显示可用工具。"}</p>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDetail(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function parseMcpInput(input: string): { id: string; spec: McpServerSpec } {
  const parsed = JSON.parse(input) as {
    mcpServers?: Record<string, McpServerSpec>;
    id?: string;
    command?: string;
    url?: string;
  };
  if (parsed.mcpServers) {
    const entries = Object.entries(parsed.mcpServers);
    if (entries.length !== 1) throw new Error("invalid-service-count");
    const [id, spec] = entries[0];
    return { id, spec };
  }
  if (parsed.id) {
    const { id, ...spec } = parsed;
    return { id, spec };
  }
  throw new Error("invalid-service-config");
}

function mcpStatus(probe?: McpProbeResult) {
  if (!probe) return { id: "unchecked" as const, label: "等待检测", className: "is-neutral" };
  if (probe.ok) return { id: "ready" as const, label: "连接正常", className: "is-success" };
  return { id: "issue" as const, label: "需要处理", className: "is-danger" };
}

function mcpMeta(server: McpServer) {
  if (server.probe?.serverName) return server.probe.serverName;
  return "已添加服务";
}

function mcpPreview(server: McpServer) {
  if (server.probe?.ok) {
    return `连接响应 ${server.probe.latencyMs}ms，可使用 ${server.probe.toolCount} 个工具。`;
  }
  if (server.probe) return "连接检测未通过，请进入管理后检查连接信息。";
  return "尚未检测连接状态，可先运行检测确认服务是否可用。";
}

function detailDescription(server: McpServer) {
  if (server.probe?.ok) return `连接正常，已识别 ${server.probe.toolCount} 个工具。`;
  if (server.probe) return "连接未通过，请检查连接信息后重新检测。";
  return "尚未检测该服务。";
}

function ProbeResult({ probe }: { probe: McpProbeResult }) {
  return (
    <div className={cn("tools-workspace__probe-result", probe.ok ? "is-success" : "is-danger")}>
      {probe.ok ? <CheckCircle2 aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <div>
        <strong>{probe.ok ? "连接正常" : "连接未通过"}</strong>
        <p>
          {probe.ok
            ? `已识别 ${probe.toolCount} 个工具${probe.latencyMs ? `，响应 ${probe.latencyMs}ms。` : "。"}`
            : "请检查连接信息后重试。"}
        </p>
      </div>
    </div>
  );
}
