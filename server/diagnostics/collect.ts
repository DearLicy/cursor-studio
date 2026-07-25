/**
 * Stage 6: diagnostics package for Cursor Studio.
 * Collects version, ports, inject status, CA, usage summary, prompt conflict.
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { studioHome, loadConfig, configPath } from "../config/store";
import { getServiceState, getProxyCaInfo } from "../proxy/service";
import { getInjectStatus } from "../cursor/workbench-inject";
import { getHomeMetricsSummary } from "../metrics/usage-store";
import { getCursorStatus } from "../cursor/settings";
import { detectPromptConflict } from "../workspace/prompts-store";

export type DiagnosticsBundle = {
  createdAt: string;
  app: {
    name: string;
    version: string;
    platform: string;
    arch: string;
    node: string;
    studioHome: string;
  };
  config: {
    path: string;
    exists: boolean;
    fingerprint?: string;
    providerCount: number;
    routingMode: string;
    proxyListenAddr: string;
    backendListenAddr: string;
    activeProfileId?: string;
  };
  service: Awaited<ReturnType<typeof getServiceState>>;
  ca: Awaited<ReturnType<typeof getProxyCaInfo>>;
  cursor: Awaited<ReturnType<typeof getCursorStatus>>;
  inject: Awaited<ReturnType<typeof getInjectStatus>>;
  metrics: Awaited<ReturnType<typeof getHomeMetricsSummary>>;
  prompts: Awaited<ReturnType<typeof detectPromptConflict>>;
  notes: string[];
};

function appVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function collectDiagnostics(): Promise<DiagnosticsBundle> {
  const notes: string[] = [];
  const cfg = await loadConfig();
  const cfgPath = configPath();
  let fingerprint: string | undefined;
  if (existsSync(cfgPath)) {
    const raw = await fs.readFile(cfgPath, "utf8");
    fingerprint = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  } else {
    notes.push("config.yaml missing");
  }

  const [service, ca, cursor, inject, metrics, prompts] = await Promise.all([
    getServiceState(cfg),
    getProxyCaInfo(),
    getCursorStatus(),
    getInjectStatus(),
    getHomeMetricsSummary(),
    detectPromptConflict(),
  ]);

  if (!service.running) notes.push("proxy/backend service not running");
  if (!service.cursorSettingsApplied) notes.push("Cursor proxy settings not applied");
  if (!ca.exists) notes.push("MITM CA cert not found");
  if (prompts.conflict) notes.push(`prompt rules conflict: ${prompts.reason || "diff"}`);

  return {
    createdAt: new Date().toISOString(),
    app: {
      name: "cursor-studio",
      version: appVersion(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      studioHome: studioHome(),
    },
    config: {
      path: cfgPath,
      exists: existsSync(cfgPath),
      fingerprint,
      providerCount: cfg.providers.length,
      routingMode: cfg.routingMode,
      proxyListenAddr: cfg.proxyListenAddr,
      backendListenAddr: cfg.backendListenAddr,
      activeProfileId: cfg.activeProfileId,
    },
    service,
    ca,
    cursor,
    inject,
    metrics,
    prompts,
    notes,
  };
}

export async function writeDiagnosticsPackage(): Promise<{
  path: string;
  bundle: DiagnosticsBundle;
}> {
  const bundle = await collectDiagnostics();
  const dir = path.join(studioHome(), "diagnostics");
  await fs.mkdir(dir, { recursive: true });
  const stamp = bundle.createdAt.replace(/[:.]/g, "-");
  const out = path.join(dir, `diagnostics-${stamp}.json`);
  const redacted = JSON.parse(JSON.stringify(bundle));
  await fs.writeFile(out, JSON.stringify(redacted, null, 2), "utf8");
  await fs.writeFile(
    path.join(dir, "latest.json"),
    JSON.stringify(redacted, null, 2),
    "utf8",
  );
  return { path: out, bundle };
}
