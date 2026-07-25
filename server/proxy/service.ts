/**
 * 服务生命周期：内置 Backend + MITM 代理（纯 TypeScript）。
 * 本地协议实现。
 * - 打开软件后在后台自动 Start
 * - 启动服务 = 起 Backend/MITM + 自动写入 Cursor http.proxy
 * - 停止服务 = 关监听 + 自动拆除 Studio 代理
 * 本地协议实现。
 */
import { loadConfig, saveConfig, type AppConfig } from "../config/store";
import {
  applyProxySettings,
  clearProxySettings,
  readCursorSettings,
} from "../cursor/settings";
import { injectCursorUserInfo } from "../cursor/state-db";
import { startBackend, type BackendHandle } from "../backend/local";
import net from "node:net";
import {
  startProxy,
  ensureLocalCA,
  installCaToWindowsUserStore,
  getProxyCaPath,
  getProxyStatsSnapshot,
  type ProxyHandle,
  type ProxyStats,
} from "./mitm";

export interface ServiceState {
  running: boolean;
  proxyListenAddr: string;
  backendListenAddr: string;
  caCertPath?: string;
  /** Cursor settings 是否指向本 Studio 代理 */
  cursorSettingsApplied: boolean;
  /**
   * 兼容字段：运行中时为 true（表示启停会自动维护注入）。
   * 历史含义「意图勾选」已废弃。
   */
  injectCursorProxy: boolean;
  lastError?: string;
  proxyStats?: ProxyStats;
  /** 当前 Cursor http.proxy（便于 UI 展示） */
  cursorProxy?: string | null;
}

export type ProxyCaInfo = {
  certPath: string;
  keyPath?: string;
  exists: boolean;
  stats: ProxyStats | null;
  running: boolean;
};

let backend: BackendHandle | null = null;
let proxy: ProxyHandle | null = null;
/** 本进程是否已成功写入过 Cursor 代理（启停一致） */
let cursorApplied = false;
let lastError: string | undefined;

function proxyNeedle(addr: string): string {
  return String(addr || "")
    .trim()
    .replace(/^https?:\/\//, "");
}

async function readCursorProxyApplied(
  listenAddr: string,
): Promise<{ applied: boolean; proxy: string | null }> {
  try {
    const { settings } = await readCursorSettings();
    const current = String(settings["http.proxy"] ?? "").trim();
    const needle = proxyNeedle(listenAddr);
    const applied = Boolean(current && needle && current.includes(needle));
    return { applied, proxy: current || null };
  } catch {
    return { applied: false, proxy: null };
  }
}

export async function getServiceState(cfg?: AppConfig): Promise<ServiceState> {
  const config = cfg ?? (await loadConfig());
  let caCertPath = proxy?.caCertPath;
  if (!caCertPath) {
    try {
      caCertPath = (await ensureLocalCA()).certPath;
    } catch {
      caCertPath = getProxyCaPath();
    }
  }
  const listen =
    proxy?.listenAddr ?? config.proxyListenAddr ?? "127.0.0.1:18080";
  const cursor = await readCursorProxyApplied(listen);
  // 以磁盘真实状态为准，会话标志作补充
  const applied = cursor.applied || cursorApplied;
  cursorApplied = applied;

  return {
    running: Boolean(backend && proxy),
    proxyListenAddr: listen,
    backendListenAddr:
      backend?.listenAddr ?? config.backendListenAddr ?? "127.0.0.1:18090",
    caCertPath,
    cursorSettingsApplied: applied,
    injectCursorProxy: Boolean(backend && proxy),
    lastError,
    proxyStats: proxy ? proxy.getStats() : getProxyStatsSnapshot(),
    cursorProxy: cursor.proxy,
  };
}

/** CA 路径 / 代理统计（服务未启动也可查 CA） */
export async function getProxyCaInfo(): Promise<ProxyCaInfo> {
  try {
    const ca = await ensureLocalCA();
    return {
      certPath: ca.certPath,
      keyPath: ca.keyPath,
      exists: true,
      stats: proxy ? proxy.getStats() : getProxyStatsSnapshot(),
      running: Boolean(proxy),
    };
  } catch {
    return {
      certPath: getProxyCaPath(),
      exists: false,
      stats: null,
      running: Boolean(proxy),
    };
  }
}

export async function installProxyCa(): Promise<{
  ok: boolean;
  message: string;
  certPath: string;
}> {
  return installCaToWindowsUserStore();
}

/**
 * 本地协议实现。
 * 1) Backend + MITM
 * 2) injectCursorUserInfo → state.vscdb 假账号（失败不阻断）
 * 3) 安装 CA
 * 4) 写入 Cursor http.proxy
 */

function parseHostPort(addr: string): { host: string; port: number } {
  const raw = addr.trim().replace(/^https?:\/\//, "");
  const [hostPart, portPart] = raw.split(":");
  const host = hostPart || "127.0.0.1";
  const port = Number(portPart || "0");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`无效监听地址: ${addr}`);
  }
  return { host, port };
}

async function assertListenAvailable(listenAddr: string, label: string): Promise<void> {
  const { host, port } = parseHostPort(listenAddr);
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `${label} 端口 ${host}:${port} 已被占用。请先停止占用该地址的本地程序，或在配置中修改 ${label} 地址。`,
          ),
        );
        return;
      }
      reject(err);
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port, host);
  });
}

export async function startService(): Promise<ServiceState> {
  lastError = undefined;
  const cfg = await loadConfig();
  try {
    if (backend && proxy) {
      await tryInjectFakeAccount();
      const addr = proxy.listenAddr ?? cfg.proxyListenAddr;
      const ca = await installProxyCa();
      if (!ca.ok) console.warn("[service] CA install:", ca.message);
      await applyProxySettings(addr);
      cursorApplied = true;
      cfg.injectCursorProxy = true;
      await saveConfig(cfg);
      return await getServiceState(cfg);
    }

    await assertListenAvailable(cfg.backendListenAddr, "backend");
    await assertListenAvailable(cfg.proxyListenAddr, "proxy");
    backend = await startBackend(cfg.backendListenAddr, loadConfig);
    proxy = await startProxy({
      listenAddr: cfg.proxyListenAddr,
      backendBaseURL: `http://${backend.listenAddr}`,
    });

    await tryInjectFakeAccount();

    const ca = await installProxyCa();
    if (!ca.ok) {
      console.warn("[service] CA install warning:", ca.message);
      lastError = `CA 未完全信任: ${ca.message}（代理已起；若 HTTPS 失败请手动信任 ${ca.certPath}）`;
    }

    const addr = proxy.listenAddr ?? cfg.proxyListenAddr;
    try {
      await applyProxySettings(addr);
      cursorApplied = true;
      cfg.injectCursorProxy = true;
      await saveConfig(cfg);
    } catch (injectErr) {
      const msg =
        injectErr instanceof Error ? injectErr.message : String(injectErr);
      lastError = `服务已启动，但注入 Cursor 配置失败: ${msg}`;
      await stopService({ clearCursor: false }).catch(() => undefined);
      throw new Error(lastError);
    }

    return await getServiceState(cfg);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    if (!lastError.includes("注入 Cursor")) {
      await stopService({ clearCursor: false }).catch(() => undefined);
    }
    throw err;
  }
}

async function tryInjectFakeAccount(): Promise<void> {
  try {
    await injectCursorUserInfo();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[service] injectCursorUserInfo failed:", msg);
  }
}

/**
 * 本地协议实现。
 * 仅当 http.proxy 指向本代理端口时清除。
 */
export async function stopService(opts?: {
  clearCursor?: boolean;
  clearCursorProxy?: boolean;
}): Promise<ServiceState> {
  lastError = undefined;
  const clearCursor =
    opts?.clearCursor !== false && opts?.clearCursorProxy !== false;
  try {
    if (proxy) {
      await proxy.close().catch(() => undefined);
      proxy = null;
    }
    if (backend) {
      await backend.close().catch(() => undefined);
      backend = null;
    }

    const cfg = await loadConfig();
    if (clearCursor) {
      const addr = cfg.proxyListenAddr;
      // 不依赖会话标志：只要当前指向 Studio 端口就清
      await clearProxySettings({ onlyIfProxyContains: addr }).catch(
        () => undefined,
      );
      cursorApplied = false;
      cfg.injectCursorProxy = false;
      await saveConfig(cfg);
    }
    return await getServiceState(cfg);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/** 手动补写 Cursor 代理（服务须已运行；一般走 startService 即可） */
export async function injectProxyToCursor(): Promise<ServiceState> {
  const cfg = await loadConfig();
  if (!backend || !proxy) {
    throw new Error("请先启动本地服务，再注入到 Cursor");
  }
  const addr = proxy.listenAddr ?? cfg.proxyListenAddr;
  const injectResult = await applyProxySettings(addr);
  console.log("[service] proxy inject", {
    path: injectResult.path,
    backupPath: injectResult.backupPath,
    before: injectResult.beforeFingerprint,
    after: injectResult.afterFingerprint,
    changes: injectResult.changes.map((c) => c.key),
  });
  cursorApplied = true;
  cfg.injectCursorProxy = true;
  await saveConfig(cfg);
  const state = await getServiceState(cfg);
  return {
    ...state,
    lastError: injectResult.changes.length
      ? undefined
      : state.lastError,
  };
}

export async function detachProxyFromCursor(): Promise<ServiceState> {
  const cfg = await loadConfig();
  const addr = proxy?.listenAddr ?? cfg.proxyListenAddr;
  const result = await clearProxySettings({ onlyIfProxyContains: addr });
  if (!result.cleared) {
    throw new Error(result.skippedReason || "未清除代理（与 Studio 端口不一致）");
  }
  cursorApplied = false;
  cfg.injectCursorProxy = false;
  await saveConfig(cfg);
  return await getServiceState(cfg);
}

export async function reloadConfig(): Promise<AppConfig> {
  return loadConfig();
}

export async function updateAndSaveConfig(cfg: AppConfig): Promise<AppConfig> {
  return saveConfig(cfg);
}
