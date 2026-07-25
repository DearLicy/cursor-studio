/**
 * Cursor 宿主 settings.json 读写与注入。
 * 本地协议实现。
 * - 背景：不再写 backgroundCover.*，改由 workbench-inject 自注入
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppearanceConfig } from "../config/store";

const INJECTED_PROXY_KEYS = [
  "http.proxy",
  "http.proxyKerberosServicePrincipal",
  "http.proxySupport",
  "cursor.general.disableHttp2",
  "http.experimental.systemCertificatesV2",
] as const;

/** 本工具写入的 background-cover 扩展键 */
const INJECTED_APPEARANCE_KEYS = [
  "backgroundCover.imagePath",
  "backgroundCover.opacity",
  "backgroundCover.blur",
  "backgroundCover.sizeModel",
  "backgroundCover.blendModel",
  "backgroundCover.randomImageFolder",
  "backgroundCover.autoStatus",
  "backgroundCover.autoInterval",
  "backgroundCover.defaultOnlinePage",
] as const;

export function resolveCursorSettingsPath(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Cursor",
      "User",
      "settings.json",
    );
  }
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "settings.json",
    );
  }
  return path.join(os.homedir(), ".config", "Cursor", "User", "settings.json");
}

export function resolveCursorUserDir(): string {
  return path.dirname(resolveCursorSettingsPath());
}

/** 简易 JSONC：去注释后 parse（settings 可能含 // 注释） */
export function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (!stripped.trim()) return {};
  return JSON.parse(stripped) as Record<string, unknown>;
}

export async function readCursorSettings(): Promise<{
  path: string;
  settings: Record<string, unknown>;
}> {
  const settingsPath = resolveCursorSettingsPath();
  if (!existsSync(settingsPath)) {
    return { path: settingsPath, settings: {} };
  }
  const raw = await fs.readFile(settingsPath, "utf8");
  try {
    return { path: settingsPath, settings: parseJsonc(raw) };
  } catch {
    return { path: settingsPath, settings: {} };
  }
}

export async function writeCursorSettings(
  settings: Record<string, unknown>,
): Promise<string> {
  const settingsPath = resolveCursorSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const encoded = JSON.stringify(settings, null, 2) + "\n";
  const tmp = settingsPath + ".tmp";
  await fs.writeFile(tmp, encoded, "utf8");
  await fs.rename(tmp, settingsPath);
  return settingsPath;
}

export function proxyUrlFromListenAddr(listenAddr: string): string {
  const addr = listenAddr.trim();
  if (addr.startsWith("http://") || addr.startsWith("https://")) return addr;
  return `http://${addr}`;
}

function settingsBackupDir(): string {
  const home =
    process.env.CURSOR_STUDIO_HOME ||
    path.join(os.homedir(), ".cursor-studio");
  return path.join(home, "backups", "cursor-settings");
}

export function fingerprintSettings(settings: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const key of INJECTED_PROXY_KEYS) {
    if (key in settings) subset[key] = settings[key];
  }
  return createHash("sha256")
    .update(JSON.stringify(subset))
    .digest("hex")
    .slice(0, 16);
}

export async function backupCursorSettings(reason = "proxy-inject"): Promise<{
  backupPath: string;
  fingerprint: string;
  settingsPath: string;
}> {
  const { path: settingsPath, settings } = await readCursorSettings();
  const dir = settingsBackupDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `${stamp}-${reason}.json`);
  const payload = {
    reason,
    at: new Date().toISOString(),
    settingsPath,
    fingerprint: fingerprintSettings(settings),
    settings,
  };
  await fs.writeFile(backupPath, JSON.stringify(payload, null, 2), "utf8");
  // also keep latest pointer
  await fs.writeFile(
    path.join(dir, "latest.json"),
    JSON.stringify({ backupPath, ...payload }, null, 2),
    "utf8",
  );
  return {
    backupPath,
    fingerprint: payload.fingerprint,
    settingsPath,
  };
}

export type ProxyInjectPlan = {
  settingsPath: string;
  listenAddr: string;
  proxyURL: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  changes: Array<{ key: string; from: unknown; to: unknown }>;
  wouldWrite: boolean;
};

/** Dry-run: report which keys would change without writing. */
export async function dryRunProxyInject(
  listenAddr: string,
): Promise<ProxyInjectPlan> {
  const { path: settingsPath, settings } = await readCursorSettings();
  const proxyURL = proxyUrlFromListenAddr(listenAddr);
  const next: Record<string, unknown> = { ...settings };
  const desired: Record<string, unknown> = {
    "http.proxy": proxyURL,
    "http.proxyKerberosServicePrincipal": proxyURL,
    "http.proxySupport": "on",
    "cursor.general.disableHttp2": true,
    "http.experimental.systemCertificatesV2": true,
  };
  const changes: ProxyInjectPlan["changes"] = [];
  for (const [key, to] of Object.entries(desired)) {
    const from = settings[key];
    if (from !== to) {
      changes.push({ key, from, to });
      next[key] = to;
    }
  }
  return {
    settingsPath,
    listenAddr,
    proxyURL,
    beforeFingerprint: fingerprintSettings(settings),
    afterFingerprint: fingerprintSettings(next),
    changes,
    wouldWrite: changes.length > 0,
  };
}

export async function applyProxySettings(listenAddr: string): Promise<{
  path: string;
  backupPath: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  changes: ProxyInjectPlan["changes"];
}> {
  const plan = await dryRunProxyInject(listenAddr);
  const backup = await backupCursorSettings("proxy-inject");
  if (!plan.wouldWrite) {
    return {
      path: plan.settingsPath,
      backupPath: backup.backupPath,
      beforeFingerprint: plan.beforeFingerprint,
      afterFingerprint: plan.afterFingerprint,
      changes: [],
    };
  }
  const { settings } = await readCursorSettings();
  for (const change of plan.changes) {
    settings[change.key] = change.to;
  }
  const written = await writeCursorSettings(settings);
  const after = await readCursorSettings();
  return {
    path: written,
    backupPath: backup.backupPath,
    beforeFingerprint: plan.beforeFingerprint,
    afterFingerprint: fingerprintSettings(after.settings),
    changes: plan.changes,
  };
}

export async function restoreLatestSettingsBackup(): Promise<{
  ok: boolean;
  path?: string;
  error?: string;
}> {
  const latestPath = path.join(settingsBackupDir(), "latest.json");
  if (!existsSync(latestPath)) {
    return { ok: false, error: "no latest settings backup" };
  }
  try {
    const raw = JSON.parse(await fs.readFile(latestPath, "utf8")) as {
      settings?: Record<string, unknown>;
      backupPath?: string;
    };
    let settings = raw.settings;
    if (!settings && raw.backupPath && existsSync(raw.backupPath)) {
      const full = JSON.parse(await fs.readFile(raw.backupPath, "utf8")) as {
        settings?: Record<string, unknown>;
      };
      settings = full.settings;
    }
    if (!settings) return { ok: false, error: "backup missing settings payload" };
    const pathWritten = await writeCursorSettings(settings);
    return { ok: true, path: pathWritten };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 清除本工具注入的代理设置。
 * onlyIfProxyContains：仅当当前 http.proxy 包含该片段时才清除，
 * 本地协议实现。
 */
export async function clearProxySettings(opts?: {
  onlyIfProxyContains?: string;
}): Promise<{ path: string; cleared: boolean; skippedReason?: string }> {
  const { settings } = await readCursorSettings();
  const settingsPath = resolveCursorSettingsPath();
  const current = String(settings["http.proxy"] ?? "");

  if (opts?.onlyIfProxyContains) {
    const needle = opts.onlyIfProxyContains.replace(/^https?:\/\//, "");
    if (current && !current.includes(needle)) {
      return {
        path: settingsPath,
        cleared: false,
        skippedReason: `当前代理为 ${current}，与 Studio 端口 ${needle} 不一致，已跳过以保留现有代理设置`,
      };
    }
  }

  for (const key of INJECTED_PROXY_KEYS) {
    delete settings[key];
  }
  await writeCursorSettings(settings);
  return { path: settingsPath, cleared: true };
}

/** 清除本工具曾写入的 backgroundCover / 旧配色标记（不再依赖扩展） */
export async function clearLegacyBackgroundCoverKeys(): Promise<string> {
  const { settings } = await readCursorSettings();
  for (const key of INJECTED_APPEARANCE_KEYS) {
    delete settings[key];
  }
  const managed = (settings["cursorStudio.managedColorKeys"] as string[] | undefined) ?? [];
  if (managed.length > 0) {
    const existing =
      (settings["workbench.colorCustomizations"] as Record<string, string> | undefined) ?? {};
    for (const k of managed) delete existing[k];
    settings["workbench.colorCustomizations"] = existing;
  }
  delete settings["cursorStudio.managedColorKeys"];
  delete settings["cursorStudio.customCssPath"];
  return writeCursorSettings(settings);
}

/** @deprecated 使用 workbench-inject；保留别名兼容旧调用 */
export async function clearAppearanceManagedKeys(): Promise<string> {
  return clearLegacyBackgroundCoverKeys();
}

/** @deprecated 背景改走 workbench-inject */
export async function applyAppearance(_appearance: AppearanceConfig): Promise<string> {
  void _appearance;
  return clearLegacyBackgroundCoverKeys();
}

export async function getCursorStatus(): Promise<{
  settingsPath: string;
  proxy?: string;
  backgroundImage?: string;
  backgroundOpacity?: number;
  exists: boolean;
}> {
  const settingsPath = resolveCursorSettingsPath();
  if (!existsSync(settingsPath)) {
    return { settingsPath, exists: false };
  }
  const { settings } = await readCursorSettings();
  return {
    settingsPath,
    exists: true,
    proxy: settings["http.proxy"] as string | undefined,
    // 背景已改自注入，settings 中不再维护 backgroundCover
    backgroundImage: undefined,
    backgroundOpacity: undefined,
  };
}
