/**
 * Cursor Studio 控制面：HTTP API（Electron IPC 旁路 / 浏览器开发共用）。
 * 默认 127.0.0.1:28191，绝不自动写 Cursor 代理。
 */
import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { URL, fileURLToPath } from "node:url";
import { shellOpenPath } from "./shell";
import {
  loadConfig,
  saveConfig,
  newProvider,
  type AppConfig,
  type ModelProvider,
  type AppearanceConfig,
} from "../config/store";
import {
  clearConfigBackups,
  createConfigBackup,
  importConfig,
  listConfigBackups,
  removeConfigBackup,
  restoreConfigBackup,
} from "../config/backups";
import {
  startService,
  stopService,
  getServiceState,
  injectProxyToCursor,
  detachProxyFromCursor,
  getProxyCaInfo,
  installProxyCa,
} from "../proxy/service";
import { syncCursorUserInfoIfChanged } from "../cursor/state-db";
import {
  clearProxySettings,
  getCursorStatus,
  resolveCursorSettingsPath,
  clearLegacyBackgroundCoverKeys,
  dryRunProxyInject,
  restoreLatestSettingsBackup,
  backupCursorSettings,
} from "../cursor/settings";
import {
  applyWorkbenchBackground,
  clearWorkbenchBackground,
  refreshWorkbenchCss,
  getInjectStatus,
  dryRunInject,
  forceRestoreWorkbench,
  configureBackgroundAutoRotation,
  pickRandomImage,
} from "../cursor/workbench-inject";
import { fetchProviderModels } from "../providers/fetch-models";
import { fetchAndSaveProviderModels } from "../providers/save-models";
import {
  listProviderHealth,
  probeProvider,
  resetProviderHealth,
} from "../providers/provider-health";
import { pickAvatarFile, pickFolder, pickImageFile } from "../native/dialog";
import {
  getHomeMetricsSummary,
  setIncludeCacheWriteInHitRate,
  resetUsage,
  listRequestLogs,
  queryUsage,
  exportUsageCsv,
  refreshUsagePricing,
} from "../metrics/usage-store";
import {
  collectDiagnostics,
  writeDiagnosticsPackage,
} from "../diagnostics/collect";
import {
  listMcpServers,
  upsertMcpServer,
  upsertMcpFromJson,
  removeMcpServer,
  probeMcp,
  getMcpProbeHistory,
  getMcpLatestProbes,
  type McpServerSpec,
} from "../workspace/mcp-store";
import {
  listSkills,
  createSkill,
  removeSkill,
  readSkillContent,
  resolveKnownSkillPath,
  updateSkillContent,
} from "../workspace/skills-store";
import {
  listSkillRepos,
  addSkillRepo,
  removeSkillRepo,
  discoverSkills,
  installSkillFromRepo,
  type DiscoverableSkill,
} from "../workspace/skills-repo";
import {
  clearAllSessions,
  clearEmptySessions,
  listSessions,
  readSessionDetail,
  removeSessions,
} from "../workspace/sessions-store";
import { clearAllHistory } from "../backend/forwarder/history";
import {
  probeConfiguredBalances,
  probeConfiguredProviderBalances,
  probeProviderBalance,
  listBalanceAccounts,
  upsertBalanceAccount,
  removeBalanceAccount,
  newBalanceAccount,
  type BalanceAccount,
} from "../providers/balance";
import {
  listProfiles,
  upsertProfile,
  removeProfile,
  setActiveProfile,
  applyProfile,
  newWorkspaceProfile,
} from "../workspace/profiles-store";
import {
  listProbeHistory,
  clearProbeHistory,
} from "../providers/probe-history";
import { getPromotions, startPromotionsRefresh } from "../runtime/promotions";

import {
  listPrompts,
  setPromptEnabled,
  setInjectionMode,
  setMasterEnabled,
  upsertPrompt,
  removePrompt,
  openPromptsDir,
  syncCursorInjection,
  detectPromptConflict,
  type PromptInjectionMode,
} from "../workspace/prompts-store";

export const CONTROL_PORT = Number(process.env.STUDIO_CONTROL_PORT || 28191);
export const CONTROL_HOST = process.env.STUDIO_CONTROL_HOST || "127.0.0.1";

type Json = unknown;

function send(res: http.ServerResponse, status: number, body: Json) {
  if (status === 204) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

const PREVIEW_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogg": "video/ogg",
};

async function sendPreviewMedia(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  source: string,
): Promise<void> {
  let filePath = source.trim();
  if (/^file:\/\//i.test(filePath)) filePath = fileURLToPath(filePath);
  const info = await fs.stat(filePath);
  if (!info.isFile()) throw new Error("背景预览源不是文件");

  const contentType =
    PREVIEW_MEDIA_TYPES[nodePath.extname(filePath).toLowerCase()] ||
    "application/octet-stream";
  const range = req.headers.range;
  const commonHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Type": contentType,
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const requestedEnd = match[2] ? Number(match[2]) : info.size - 1;
      const end = Math.min(requestedEnd, info.size - 1);
      if (start >= 0 && start <= end) {
        res.writeHead(206, {
          ...commonHeaders,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${info.size}`,
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(416, {
      ...commonHeaders,
      "Content-Range": `bytes */${info.size}`,
    });
    res.end();
    return;
  }

  res.writeHead(200, { ...commonHeaders, "Content-Length": info.size });
  createReadStream(filePath).pipe(res);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const host = req.headers.host || `${CONTROL_HOST}:${CONTROL_PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const path = url.pathname;
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    send(res, 204, null);
    return;
  }

  try {
    if (method === "GET" && path === "/health") {
      send(res, 200, { ok: true, service: "cursor-studio-control" });
      return;
    }

    if (method === "GET" && path === "/promotions") {
      send(res, 200, await getPromotions({ refresh: url.searchParams.get("refresh") === "1" }));
      return;
    }

    if (method === "GET" && path === "/diagnostics") {
      send(res, 200, await collectDiagnostics());
      return;
    }
    if (method === "POST" && path === "/diagnostics/export") {
      send(res, 200, await writeDiagnosticsPackage());
      return;
    }

    if (method === "GET" && path === "/config") {
      send(res, 200, await loadConfig());
      return;
    }

    if (method === "GET" && path === "/config/backups") {
      send(res, 200, { backups: await listConfigBackups() });
      return;
    }

    if (method === "POST" && path === "/config/backup") {
      send(res, 200, { backup: await createConfigBackup("manual") });
      return;
    }

    if (method === "POST" && path === "/config/backups/remove") {
      const body = await readJson<{ name?: string }>(req);
      send(res, 200, await removeConfigBackup(String(body.name || "")));
      return;
    }

    if (method === "POST" && path === "/config/backups/clear") {
      send(res, 200, await clearConfigBackups());
      return;
    }

    if (method === "POST" && path === "/config") {
      const cfg = await readJson<AppConfig>(req);
      const previous = await loadConfig();
      await createConfigBackup("before-save");
      const saved = await saveConfig(cfg);
      const sync = await syncCursorUserInfoIfChanged(
        previous.cursorIntegration,
        saved.cursorIntegration,
        previous.backendListenAddr,
        saved.backendListenAddr,
      );
      if (sync.error) {
        console.warn("[control-plane] Cursor account cache sync deferred:", sync.error);
      }
      await configureBackgroundAutoRotation();
      send(res, 200, saved);
      return;
    }

    if (method === "POST" && path === "/config/import") {
      const body = await readJson<{ config?: unknown }>(req);
      const previous = await loadConfig();
      const saved = await importConfig(body.config);
      const sync = await syncCursorUserInfoIfChanged(
        previous.cursorIntegration,
        saved.cursorIntegration,
        previous.backendListenAddr,
        saved.backendListenAddr,
      );
      if (sync.error) {
        console.warn("[control-plane] Cursor account cache sync deferred:", sync.error);
      }
      await configureBackgroundAutoRotation();
      send(res, 200, saved);
      return;
    }

    if (method === "POST" && path === "/config/restore") {
      const body = await readJson<{ name?: string }>(req);
      const previous = await loadConfig();
      const saved = await restoreConfigBackup(String(body.name || ""));
      const sync = await syncCursorUserInfoIfChanged(
        previous.cursorIntegration,
        saved.cursorIntegration,
        previous.backendListenAddr,
        saved.backendListenAddr,
      );
      if (sync.error) {
        console.warn("[control-plane] Cursor account cache sync deferred:", sync.error);
      }
      await configureBackgroundAutoRotation();
      send(res, 200, saved);
      return;
    }

    if (method === "GET" && path === "/providers") {
      send(res, 200, (await loadConfig()).providers);
      return;
    }

    if (method === "GET" && path === "/providers/health") {
      send(res, 200, {
        health: listProviderHealth((await loadConfig()).providers),
      });
      return;
    }

    if (method === "POST" && path === "/providers/upsert") {
      const provider = await readJson<ModelProvider>(req);
      const cfg = await loadConfig();
      const next = { ...provider, id: provider.id || newProvider(provider).id };
      const idx = cfg.providers.findIndex((p) => p.id === next.id);
      if (idx >= 0) cfg.providers[idx] = next;
      else cfg.providers.push(next);
      await saveConfig(cfg);
      send(res, 200, cfg.providers);
      return;
    }

    if (method === "POST" && path === "/providers/remove") {
      const { id } = await readJson<{ id: string }>(req);
      const cfg = await loadConfig();
      cfg.providers = cfg.providers.filter((p) => p.id !== id);
      resetProviderHealth(id);
      await saveConfig(cfg);
      send(res, 200, cfg.providers);
      return;
    }

    if (method === "POST" && path === "/providers/newTemplate") {
      send(res, 200, newProvider());
      return;
    }

    if (method === "POST" && path === "/providers/fetchModels") {
      const input = await readJson<{
        type: "openai" | "anthropic";
        baseURL: string;
        apiKey: string;
      }>(req);
      send(res, 200, await fetchProviderModels(input));
      return;
    }

    if (method === "POST" && path === "/providers/probe") {
      const provider = await readJson<ModelProvider>(req);
      send(res, 200, await probeProvider(provider));
      return;
    }

    if (method === "POST" && path === "/providers/probeBalance") {
      const provider = await readJson<ModelProvider>(req);
      send(res, 200, { balance: await probeProviderBalance(provider) });
      return;
    }

    if (method === "GET" && path === "/providers/balance") {
      const providerId = url.searchParams.get("providerId")?.trim() || undefined;
      send(res, 200, {
        balances: await probeConfiguredProviderBalances(providerId),
      });
      return;
    }

    // 一键：拉取全部模型并写入 config（全量 models[] 持久化）
    if (method === "POST" && path === "/providers/fetchModelsAndSave") {
      const input = await readJson<{
        id?: string;
        displayName?: string;
        type: "openai" | "anthropic";
        baseURL: string;
        apiKey: string;
        enabled?: boolean;
        modelID?: string;
        openAIEndpoint?: ModelProvider["openAIEndpoint"];
        reasoningEffort?: string;
        balance?: ModelProvider["balance"];
      }>(req);
      send(res, 200, await fetchAndSaveProviderModels(input));
      return;
    }

    if (method === "POST" && path === "/providers/duplicate") {
      const body = await readJson<{ id: string }>(req);
      const cfg = await loadConfig();
      const src = cfg.providers.find((p) => p.id === body.id);
      if (!src) {
        send(res, 404, { error: "provider not found" });
        return;
      }
      const { id: _srcId, ...srcRest } = src;
      void _srcId;
      const copy = newProvider({
        ...srcRest,
        displayName: `${src.displayName} Copy`,
      });
      // newProvider regenerates id from channel; force unique display-based id
      copy.id = `${src.id}-copy-${Date.now().toString(36)}`;
      copy.displayName = `${src.displayName} Copy`;
      copy.apiKey = src.apiKey;
      copy.models = src.models ? [...src.models] : [];
      copy.modelSettings = src.modelSettings
        ? JSON.parse(JSON.stringify(src.modelSettings))
        : {};
      copy.failoverPriority = src.failoverPriority;
      cfg.providers.push(copy);
      await saveConfig(cfg);
      send(res, 200, { providers: cfg.providers, provider: copy });
      return;
    }

    if (method === "GET" && path === "/providers/probeHistory") {
      const limit = Number(url.searchParams.get("limit") || "50");
      const providerId = url.searchParams.get("providerId") || undefined;
      send(res, 200, {
        items: await listProbeHistory({ limit, providerId }),
      });
      return;
    }

    if (method === "POST" && path === "/providers/probeHistory/clear") {
      await clearProbeHistory();
      send(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && path === "/profiles") {
      send(res, 200, await listProfiles());
      return;
    }
    if (method === "POST" && path === "/profiles/upsert") {
      const body = await readJson<Record<string, unknown>>(req);
      send(res, 200, await upsertProfile(body as never));
      return;
    }
    if (method === "POST" && path === "/profiles/remove") {
      const body = await readJson<{ id: string }>(req);
      send(res, 200, await removeProfile(body.id));
      return;
    }
    if (method === "POST" && path === "/profiles/setActive") {
      const body = await readJson<{ id: string | null }>(req);
      send(res, 200, await setActiveProfile(body.id));
      return;
    }
    if (method === "POST" && path === "/profiles/apply") {
      const body = await readJson<{ id: string }>(req);
      const cfg = await applyProfile(body.id);
      send(res, 200, {
        config: cfg,
        ...(await listProfiles()),
      });
      return;
    }
    if (method === "POST" && path === "/profiles/newTemplate") {
      send(res, 200, newWorkspaceProfile());
      return;
    }

    if (method === "POST" && path === "/service/start") {
      send(res, 200, await startService());
      return;
    }
    if (method === "POST" && path === "/service/stop") {
      send(res, 200, await stopService({ clearCursor: true }));
      return;
    }
    if (method === "GET" && path === "/service/state") {
      send(res, 200, await getServiceState(await loadConfig()));
      return;
    }
    if (method === "POST" && path === "/service/injectCursor") {
      send(res, 200, await injectProxyToCursor());
      return;
    }
    if (method === "POST" && path === "/service/detachCursor") {
      send(res, 200, await detachProxyFromCursor());
      return;
    }
    if (method === "GET" && path === "/proxy/ca") {
      send(res, 200, await getProxyCaInfo());
      return;
    }
    if (method === "POST" && path === "/proxy/installCa") {
      send(res, 200, await installProxyCa());
      return;
    }
    if (method === "POST" && path === "/proxy/openCa") {
      const info = await getProxyCaInfo();
      await shellOpenPath(info.certPath);
      send(res, 200, { path: info.certPath });
      return;
    }
    if (method === "POST" && path === "/cursor/clearProxy") {
      const cfg = await loadConfig();
      send(res, 200, await clearProxySettings({ onlyIfProxyContains: cfg.proxyListenAddr }));
      return;
    }
    if (method === "POST" && path === "/cursor/dryRunProxyInject") {
      const cfg = await loadConfig();
      send(res, 200, await dryRunProxyInject(cfg.proxyListenAddr));
      return;
    }
    if (method === "POST" && path === "/cursor/backupSettings") {
      send(res, 200, await backupCursorSettings("manual"));
      return;
    }
    if (method === "POST" && path === "/cursor/restoreSettingsBackup") {
      send(res, 200, await restoreLatestSettingsBackup());
      return;
    }

    if (method === "GET" && path === "/metrics/home") {
      send(res, 200, await getHomeMetricsSummary());
      return;
    }
    if (method === "POST" && path === "/metrics/includeCacheWrite") {
      const body = await readJson<{ value: boolean }>(req);
      send(res, 200, await setIncludeCacheWriteInHitRate(Boolean(body.value)));
      return;
    }
    if (method === "POST" && path === "/metrics/pricing/refresh") {
      send(res, 200, await refreshUsagePricing());
      return;
    }
    if (method === "POST" && path === "/metrics/reset") {
      send(res, 200, await resetUsage());
      return;
    }
    if (method === "GET" && path === "/metrics/logs") {
      send(res, 200, await listRequestLogs(500));
      return;
    }

    if (method === "GET" && path === "/metrics/query") {
      const q = {
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        providerId: url.searchParams.get("providerId") || undefined,
        modelID: url.searchParams.get("modelID") || undefined,
        source: (url.searchParams.get("source") as
          | "ide"
          | "agent"
          | "unknown"
          | "all"
          | null) || undefined,
        valid: (url.searchParams.get("valid") as
          | "all"
          | "valid"
          | "invalid"
          | null) || undefined,
        q: url.searchParams.get("q") || undefined,
        limit: url.searchParams.get("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined,
      };
      send(res, 200, await queryUsage(q));
      return;
    }

    if (method === "GET" && path === "/metrics/export.csv") {
      const q = {
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        providerId: url.searchParams.get("providerId") || undefined,
        modelID: url.searchParams.get("modelID") || undefined,
        source: (url.searchParams.get("source") as
          | "ide"
          | "agent"
          | "unknown"
          | "all"
          | null) || undefined,
        valid: (url.searchParams.get("valid") as
          | "all"
          | "valid"
          | "invalid"
          | null) || undefined,
        q: url.searchParams.get("q") || undefined,
        limit: 1000,
      };
      const csv = await exportUsageCsv(q);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="cursor-studio-usage.csv"',
      });
      res.end(csv);
      return;
    }

    if (method === "GET" && path === "/providers/balances") {
      send(res, 200, { balances: await probeConfiguredBalances() });
      return;
    }
    if (method === "GET" && path === "/balance/accounts") {
      send(res, 200, { accounts: await listBalanceAccounts() });
      return;
    }
    if (method === "POST" && path === "/balance/upsert") {
      const body = await readJson<BalanceAccount>(req);
      send(res, 200, { accounts: await upsertBalanceAccount(body) });
      return;
    }
    if (method === "POST" && path === "/balance/remove") {
      const body = await readJson<{ id: string }>(req);
      send(res, 200, { accounts: await removeBalanceAccount(body.id) });
      return;
    }
    if (method === "POST" && path === "/balance/newTemplate") {
      const body = await readJson<Partial<BalanceAccount>>(req);
      send(res, 200, newBalanceAccount(body));
      return;
    }
    if (method === "POST" && path === "/balance/probe") {
      send(res, 200, { balances: await probeConfiguredBalances() });
      return;
    }

    // —— 统一管理：MCP / Skills / 会话 ——
    if (method === "GET" && path === "/mcp/list") {
      const probe = url.searchParams.get("probe") === "1";
      send(res, 200, await listMcpServers({ probe }));
      return;
    }
    if (method === "POST" && path === "/mcp/upsert") {
      const body = await readJson<{ id: string; spec: McpServerSpec; requireProbe?: boolean }>(req);
      try {
        send(
          res,
          200,
          await upsertMcpServer(body.id, body.spec || {}, {
            requireProbe: body.requireProbe !== false,
          }),
        );
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "POST" && path === "/mcp/upsertJson") {
      const body = await readJson<{ json: string; id?: string; requireProbe?: boolean }>(req);
      try {
        send(
          res,
          200,
          await upsertMcpFromJson(body.json, {
            id: body.id,
            requireProbe: body.requireProbe !== false,
          }),
        );
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "POST" && path === "/mcp/probe") {
      const body = await readJson<{ id?: string; spec: McpServerSpec }>(req);
      send(res, 200, await probeMcp(body.id, body.spec || {}));
      return;
    }

    if (method === "GET" && path === "/mcp/probeHistory") {
      const serverId = url.searchParams.get("serverId") || undefined;
      const limit = url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : 50;
      send(res, 200, await getMcpProbeHistory({ serverId, limit }));
      return;
    }
    if (method === "GET" && path === "/mcp/latestProbes") {
      send(res, 200, await getMcpLatestProbes());
      return;
    }
    if (method === "POST" && path === "/mcp/remove") {
      const body = await readJson<{ id: string }>(req);
      send(res, 200, await removeMcpServer(body.id));
      return;
    }
    if (method === "POST" && path === "/mcp/open") {
      const { path: p } = await listMcpServers();
      await shellOpenPath(p);
      send(res, 200, { path: p });
      return;
    }
    if (method === "GET" && path === "/skills/list") {
      send(res, 200, await listSkills());
      return;
    }
    if (method === "POST" && path === "/skills/create") {
      const body = await readJson<{ name: string; description?: string }>(req);
      const item = await createSkill(body);
      send(res, 200, { item, ...(await listSkills()) });
      return;
    }
    if (method === "POST" && path === "/skills/update") {
      const body = await readJson<{ path: string; content: string }>(req);
      const item = await updateSkillContent(body.path, body.content);
      send(res, 200, { item, ...(await listSkills()) });
      return;
    }
    if (method === "POST" && path === "/skills/remove") {
      const body = await readJson<{ path: string }>(req);
      await removeSkill(body.path);
      send(res, 200, await listSkills());
      return;
    }
    if (method === "POST" && path === "/skills/read") {
      const body = await readJson<{ path: string; maxChars?: number }>(req);
      send(res, 200, await readSkillContent(body.path, body.maxChars));
      return;
    }
    if (method === "POST" && path === "/skills/open") {
      const body = await readJson<{ path: string }>(req);
      const skillPath = await resolveKnownSkillPath(body.path);
      await shellOpenPath(skillPath);
      send(res, 200, { path: skillPath });
      return;
    }
    if (method === "GET" && path === "/skills/repos") {
      send(res, 200, await listSkillRepos());
      return;
    }
    if (method === "POST" && path === "/skills/addRepo") {
      const body = await readJson<{
        owner: string;
        name?: string;
        branch?: string;
        enabled?: boolean;
      }>(req);
      try {
        send(res, 200, await addSkillRepo(body));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "POST" && path === "/skills/removeRepo") {
      const body = await readJson<{ owner: string; name: string }>(req);
      send(res, 200, await removeSkillRepo(body.owner, body.name));
      return;
    }
    if (method === "POST" && path === "/skills/discover") {
      try {
        send(res, 200, await discoverSkills());
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "POST" && path === "/skills/install") {
      const body = await readJson<DiscoverableSkill>(req);
      try {
        send(res, 200, await installSkillFromRepo(body));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "GET" && path === "/sessions/list") {
      const rawLimit = url.searchParams.get("limit");
      const rawOffset = url.searchParams.get("offset");
      const limit = rawLimit == null || rawLimit === "" ? undefined : Number(rawLimit);
      const offset = rawOffset == null || rawOffset === "" ? undefined : Number(rawOffset);
      const view = url.searchParams.get("view") === "project" ? "project" : "recent";
      const q = url.searchParams.get("q") || undefined;
      const project = url.searchParams.get("project") || undefined;
      const refresh = url.searchParams.get("refresh") === "1";
      send(res, 200, await listSessions({ limit, offset, view, q, project, refresh }));
      return;
    }
    if (method === "POST" && path === "/sessions/read") {
      const body = await readJson<{ id: string }>(req);
      send(res, 200, await readSessionDetail(body.id));
      return;
    }
    if (method === "POST" && path === "/sessions/remove") {
      const body = await readJson<{ ids: string[] }>(req);
      send(res, 200, await removeSessions(body.ids || []));
      return;
    }
    if (method === "POST" && path === "/sessions/clearEmpty") {
      send(res, 200, await clearEmptySessions());
      return;
    }
    if (method === "POST" && path === "/sessions/clearAll") {
      const [sessions, forwardedHistory] = await Promise.all([
        clearAllSessions(),
        clearAllHistory(),
      ]);
      send(res, 200, { ...sessions, forwardedHistory });
      return;
    }

    // —— 提示词注入 ——
    if (method === "GET" && path === "/prompts/list") {
      send(res, 200, await listPrompts());
      return;
    }

    if (method === "GET" && path === "/prompts/conflict") {
      send(res, 200, await detectPromptConflict());
      return;
    }
    if (method === "POST" && path === "/prompts/setEnabled") {
      const body = await readJson<{ id: string; enabled: boolean }>(req);
      try {
        send(res, 200, await setPromptEnabled(body.id, Boolean(body.enabled)));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "POST" && path === "/prompts/setMode") {
      const body = await readJson<{ mode: PromptInjectionMode }>(req);
      send(res, 200, await setInjectionMode(body.mode));
      return;
    }
    if (method === "POST" && path === "/prompts/setMaster") {
      const body = await readJson<{ enabled: boolean }>(req);
      send(res, 200, await setMasterEnabled(Boolean(body.enabled)));
      return;
    }
    if (method === "POST" && path === "/prompts/upsert") {
      const body = await readJson<{
        id?: string;
        title: string;
        filename?: string;
        description?: string;
        content: string;
        enabled?: boolean;
      }>(req);
      try {
        send(res, 200, await upsertPrompt(body));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "POST" && path === "/prompts/remove") {
      const body = await readJson<{ id: string }>(req);
      try {
        send(res, 200, await removePrompt(body.id));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (method === "POST" && path === "/prompts/sync") {
      send(res, 200, await syncCursorInjection());
      return;
    }
    if (method === "POST" && path === "/prompts/openDir") {
      const p = await openPromptsDir();
      await shellOpenPath(p);
      send(res, 200, { path: p });
      return;
    }

    if (method === "POST" && path === "/appearance/save") {
      const appearance = await readJson<AppearanceConfig>(req);
      const cfg = await loadConfig();
      cfg.appearance = appearance;
      await saveConfig(cfg);
      await configureBackgroundAutoRotation();
      send(res, 200, { appearance });
      return;
    }

    if (method === "POST" && path === "/appearance/apply") {
      const body = await readJson<AppearanceConfig & { realtimeOnly?: boolean }>(req);
      const { realtimeOnly, ...appearance } = body;
      const cfg = await loadConfig();
      cfg.appearance = appearance;
      await saveConfig(cfg);
      // 清理旧 backgroundCover 扩展键，避免双轨冲突
      await clearLegacyBackgroundCoverKeys();
      const result = realtimeOnly
        ? await refreshWorkbenchCss(appearance)
        : await applyWorkbenchBackground(appearance);
      await configureBackgroundAutoRotation();
      send(res, 200, { appearance, ...result });
      return;
    }

    if (method === "POST" && path === "/appearance/clear") {
      const result = await clearWorkbenchBackground();
      await clearLegacyBackgroundCoverKeys();
      const cfg = await loadConfig();
      cfg.appearance = { ...cfg.appearance, enabled: false, liveApply: false };
      await saveConfig(cfg);
      await configureBackgroundAutoRotation();
      send(res, 200, { ...result, appearance: cfg.appearance });
      return;
    }

    if (method === "GET" && path === "/appearance/media") {
      const source = url.searchParams.get("source") || "";
      if (!source) {
        send(res, 400, { error: "缺少背景预览路径" });
        return;
      }
      await sendPreviewMedia(req, res, source);
      return;
    }

    if (method === "POST" && path === "/appearance/random") {
      const body = await readJson<{ folder: string; excludePath?: string }>(req);
      const picked = await pickRandomImage(body.folder, body.excludePath);
      if (!picked) {
        send(res, 404, { error: "随机图库中没有可用的图片或视频" });
        return;
      }
      send(res, 200, { path: picked });
      return;
    }

    if (method === "GET" && path === "/appearance/injectStatus") {
      send(res, 200, await getInjectStatus());
      return;
    }
    if (method === "POST" && path === "/appearance/dryRun") {
      const body = await readJson<Partial<AppearanceConfig>>(req);
      send(res, 200, await dryRunInject(body as AppearanceConfig));
      return;
    }
    if (method === "POST" && path === "/appearance/forceRestore") {
      send(res, 200, await forceRestoreWorkbench());
      return;
    }

    if (method === "GET" && path === "/cursor/status") {
      const st = await getCursorStatus();
      const inj = await getInjectStatus();
      send(res, 200, { ...st, inject: inj });
      return;
    }

    if (method === "POST" && path === "/cursor/openSettings") {
      const p = resolveCursorSettingsPath();
      await shellOpenPath(p);
      send(res, 200, { path: p });
      return;
    }

    if (method === "POST" && path === "/dialog/pickImage") {
      send(res, 200, { path: await pickImageFile() });
      return;
    }
    if (method === "POST" && path === "/dialog/pickAvatar") {
      send(res, 200, { path: await pickAvatarFile() });
      return;
    }
    if (method === "POST" && path === "/dialog/pickFolder") {
      send(res, 200, { path: await pickFolder() });
      return;
    }

    send(res, 404, { error: `not found: ${method} ${path}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[control]", method, path, msg);
    send(res, 500, { error: msg });
  }
}

export function startControlPlane(): http.Server {
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.warn(
        `[studio-control] http://${CONTROL_HOST}:${CONTROL_PORT} already in use; ` +
          "desktop IPC remains available",
      );
      return;
    }
    console.error("[studio-control] server error", error);
  });
  server.listen(CONTROL_PORT, CONTROL_HOST, () => {
    console.log(`[studio-control] http://${CONTROL_HOST}:${CONTROL_PORT}`);
    startPromotionsRefresh();
    void configureBackgroundAutoRotation({ rotateNow: true });
  });
  return server;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
    process.argv[1]?.includes("control-plane")) {
  startControlPlane();
}
