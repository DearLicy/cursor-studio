import { app } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_REPOSITORY_URL,
  RELEASE_UPDATE_MANIFEST_URL,
} from "../shared/release-source";

export const UPDATE_CHECK_INTERVAL_MS = RELEASE_CHECK_INTERVAL_MS;

type UpdateSourceKind = "manifest" | "github";

export type UpdateCheckState =
  | "idle"
  | "unsupported"
  | "not-configured"
  | "up-to-date"
  | "available"
  | "error";

export interface AppUpdateInfo {
  version: string;
  title?: string;
  notes?: string;
  publishedAt?: string;
  releaseUrl?: string;
  downloadUrl: string;
  sha256: string;
  size?: number;
  source: UpdateSourceKind;
}

export interface UpdateCheckResult {
  state: UpdateCheckState;
  currentVersion: string;
  checkedAt: string;
  message?: string;
  update?: AppUpdateInfo;
}

export interface UpdateProgress {
  phase: "downloading" | "verifying";
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface UpdateInstallResult {
  state: "unsupported" | "not-configured" | "no-update" | "restarting" | "error";
  currentVersion: string;
  message: string;
  update?: AppUpdateInfo;
}

interface UpdateRuntimeConfig {
  githubRepository: string;
  manifestUrl: string;
}

interface UpdateAsset {
  name?: string;
  url?: string;
  size?: number;
  sha256?: string;
}

interface RawRelease {
  version?: string;
  tagName?: string;
  name?: string;
  notes?: string;
  publishedAt?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  sha256?: string;
  size?: number;
  assets: UpdateAsset[];
}

interface PackageUpdaterConfig {
  cursorStudio?: {
    update?: {
      githubRepository?: string;
      manifestUrl?: string;
    };
  };
}

const DEFAULT_GITHUB_REPOSITORY = new URL(RELEASE_REPOSITORY_URL).pathname.replace(
  /^\/+|\/+$/g,
  "",
);
const DEFAULT_MANIFEST_URL = RELEASE_UPDATE_MANIFEST_URL;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

let lastCheck: UpdateCheckResult = {
  state: "idle",
  currentVersion: currentVersion(),
  checkedAt: "",
};
let checkInFlight: Promise<UpdateCheckResult> | null = null;
let installInFlight: Promise<UpdateInstallResult> | null = null;

function currentVersion(): string {
  try {
    return stripVersionPrefix(app.getVersion()) || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function now(): string {
  return new Date().toISOString();
}

function stripVersionPrefix(value: string): string {
  return String(value || "").trim().replace(/^v/i, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function normalizeSha256(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
    const digest = candidate.replace(/^sha256:/, "");
    if (/^[a-f0-9]{64}$/.test(digest)) return digest;
  }
  return undefined;
}

function packageUpdaterConfig(): UpdateRuntimeConfig {
  try {
    const packagePath = path.join(app.getAppPath(), "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as PackageUpdaterConfig;
    return {
      githubRepository: firstText(parsed.cursorStudio?.update?.githubRepository) || "",
      manifestUrl: firstText(parsed.cursorStudio?.update?.manifestUrl) || "",
    };
  } catch {
    return { githubRepository: "", manifestUrl: "" };
  }
}

function environmentValue(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function normalizeRepository(value: string): string {
  const raw = value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const match = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) return "";
  const [, owner, repository] = match;
  if (/^(owner|your-org|example|replace-me)$/i.test(owner)) return "";
  return `${owner}/${repository}`;
}

function updateRuntimeConfig(): UpdateRuntimeConfig {
  const packaged = packageUpdaterConfig();
  return {
    githubRepository: normalizeRepository(
      environmentValue(
        "CURSOR_STUDIO_UPDATE_REPOSITORY",
        "CURSOR_STUDIO_GITHUB_REPOSITORY",
      ) || packaged.githubRepository || DEFAULT_GITHUB_REPOSITORY,
    ),
    manifestUrl:
      environmentValue("CURSOR_STUDIO_UPDATE_MANIFEST_URL", "CURSOR_STUDIO_UPDATE_URL") ||
      packaged.manifestUrl ||
      DEFAULT_MANIFEST_URL,
  };
}

function parseVersion(value: string): { numbers: number[]; prerelease?: string } | null {
  const match = stripVersionPrefix(value).match(
    /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.([0-9]+))?(?:-([0-9A-Za-z.-]+))?$/,
  );
  if (!match) return null;
  return {
    numbers: [match[1], match[2], match[3], match[4]].map((part) => Number(part || 0)),
    prerelease: match[5],
  };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true });
  for (let index = 0; index < a.numbers.length; index += 1) {
    const difference = a.numbers[index] - b.numbers[index];
    if (difference) return difference;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return (a.prerelease || "").localeCompare(b.prerelease || "", undefined, { numeric: true });
}

function requireHttps(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label}不是有效链接。`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label}仅支持 HTTPS。`);
  }
  return parsed;
}

function expectedRepositoryPath(repository: string): string {
  return `/${repository.toLowerCase()}/`;
}

function assertManifestUrl(rawUrl: string, repository: string): void {
  const url = requireHttps(rawUrl, "更新清单链接");
  if (!repository) return;
  const host = url.hostname.toLowerCase();
  const expectedPath = expectedRepositoryPath(repository);
  const valid =
    host === "raw.githubusercontent.com" && url.pathname.toLowerCase().startsWith(expectedPath);
  if (!valid) {
    throw new Error("The update manifest must belong to the configured GitHub repository.");
  }
}

function assertReleaseDownloadUrl(rawUrl: string, repository: string): void {
  const url = requireHttps(rawUrl, "更新安装包链接");
  const expectedPrefix = `/${repository.toLowerCase()}/releases/download/`;
  const valid =
    url.hostname.toLowerCase() === "github.com" &&
    url.pathname.toLowerCase().startsWith(expectedPrefix) &&
    url.pathname.toLowerCase().endsWith(".msi");
  if (!valid) {
    throw new Error("The update asset must be a Windows MSI from the configured GitHub release.");
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (new URL(response.url).protocol !== "https:") {
      throw new Error("The update server returned a non-HTTPS address.");
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(rawUrl: string, headers?: Record<string, string>): Promise<unknown> {
  const response = await fetchWithTimeout(
    rawUrl,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": `Cursor-Studio/${currentVersion()}`,
        ...headers,
      },
    },
    CHECK_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new HttpStatusError(response.status, `Update request failed (${response.status}).`);
  }
  return response.json();
}

function isMissingManifest(error: unknown): boolean {
  return error instanceof HttpStatusError && (error.status === 404 || error.status === 410);
}

function githubLatestReleaseUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/releases/latest`;
}

async function fetchGitHubReleaseUpdate(repository: string): Promise<AppUpdateInfo> {
  const release = await fetchJson(githubLatestReleaseUrl(repository), {
    Accept: "application/vnd.github+json",
  });
  return toUpdateInfo(normalizeRelease(release, "github"), "github", repository);
}

function assetsFrom(value: unknown): UpdateAsset[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const asset = asRecord(entry);
    return {
      name: firstText(asset.name),
      url: firstText(asset.browser_download_url, asset.downloadUrl, asset.url),
      size: positiveNumber(asset.size),
      sha256: normalizeSha256(asset.sha256, asset.digest, asset.checksum),
    };
  });
}

function selectWindowsAsset(assets: UpdateAsset[]): UpdateAsset | undefined {
  return [...assets]
    .filter((asset) => asset.url && asset.name?.toLowerCase().endsWith(".msi"))
    .sort((left, right) => scoreAsset(right) - scoreAsset(left))[0];
}

function scoreAsset(asset: UpdateAsset): number {
  const name = asset.name?.toLowerCase() || "";
  let score = 0;
  if (name.endsWith(".msi")) score += 100;
  if (/(?:x64|win64|amd64)/.test(name)) score += 15;
  return score;
}

function normalizeRelease(
  body: unknown,
  source: UpdateSourceKind,
): RawRelease {
  const root = asRecord(body);
  const release = asRecord(root.release);
  const assets = assetsFrom(root.assets).concat(assetsFrom(release.assets));
  const selected = selectWindowsAsset(assets);
  return {
    version: firstText(root.version, root.tag, root.tag_name, release.version, release.tag, release.tag_name),
    tagName: firstText(root.tag_name, root.tag, release.tag_name, release.tag),
    name: firstText(root.name, release.name),
    notes: firstText(root.notes, root.releaseNotes, root.body, release.notes, release.releaseNotes, release.body),
    publishedAt: firstText(root.publishedAt, root.published_at, release.publishedAt, release.published_at),
    releaseUrl: firstText(root.releaseUrl, root.html_url, release.releaseUrl, release.html_url),
    downloadUrl: firstText(
      root.downloadUrl,
      root.download_url,
      release.downloadUrl,
      release.download_url,
      selected?.url,
    ),
    sha256: normalizeSha256(
      root.sha256,
      root.checksum,
      root.digest,
      release.sha256,
      release.checksum,
      release.digest,
      selected?.sha256,
    ),
    size: positiveNumber(root.size) || positiveNumber(release.size) || selected?.size,
    assets,
  };
}

function toUpdateInfo(
  release: RawRelease,
  source: UpdateSourceKind,
  repository: string,
): AppUpdateInfo {
  const version = stripVersionPrefix(release.version || release.tagName || "");
  if (!parseVersion(version)) {
    throw new Error("The update manifest is missing a valid version.");
  }
  if (!release.downloadUrl) {
    throw new Error("The update manifest is missing the Windows download URL.");
  }
  assertReleaseDownloadUrl(release.downloadUrl, repository);
  const sha256 = normalizeSha256(release.sha256);
  if (!sha256) {
    throw new Error("The update manifest is missing a SHA-256 checksum.");
  }
  return {
    version,
    title: release.name,
    notes: release.notes,
    publishedAt: release.publishedAt,
    releaseUrl: release.releaseUrl,
    downloadUrl: release.downloadUrl,
    sha256,
    size: release.size,
    source,
  };
}

function unsupportedResult(message: string): UpdateCheckResult {
  return {
    state: "unsupported",
    currentVersion: currentVersion(),
    checkedAt: now(),
    message,
  };
}

function runtimeAvailability(): string | null {
  if (!app.isPackaged) return "Development mode: updates are available in installed builds only.";
  if (process.platform !== "win32") return "Automatic updates are currently available on Windows only.";
  return null;
}

async function performCheck(): Promise<UpdateCheckResult> {
  const unavailable = runtimeAvailability();
  if (unavailable) return unsupportedResult(unavailable);

  const config = updateRuntimeConfig();
  if (!config.githubRepository && !config.manifestUrl) {
    return {
      state: "not-configured",
      currentVersion: currentVersion(),
      checkedAt: now(),
      message: "更新服务尚未配置。",
    };
  }

  try {
    let update: AppUpdateInfo | undefined;
    let manifestError: unknown;
    if (config.manifestUrl) {
      try {
        assertManifestUrl(config.manifestUrl, config.githubRepository);
        const manifest = await fetchJson(config.manifestUrl);
        update = toUpdateInfo(
          normalizeRelease(manifest, "manifest"),
          "manifest",
          config.githubRepository,
        );
      } catch (error) {
        // A release may be published just before update.json reaches the default
        // branch. In that short window GitHub's release API remains authoritative.
        if (!config.githubRepository || !isMissingManifest(error)) throw error;
        manifestError = error;
      }
    }

    if (!update && config.githubRepository) {
      try {
        update = await fetchGitHubReleaseUpdate(config.githubRepository);
      } catch (error) {
        if (manifestError) {
          const manifestMessage =
            manifestError instanceof Error ? manifestError.message : "the manifest was unavailable";
          const releaseMessage = error instanceof Error ? error.message : "the release could not be loaded";
          throw new Error(`${manifestMessage} GitHub release fallback failed: ${releaseMessage}`);
        }
        throw error;
      }
    }

    if (!update) {
      throw new Error("No update source is configured.");
    }

    const current = currentVersion();
    return {
      state: compareVersions(update.version, current) > 0 ? "available" : "up-to-date",
      currentVersion: current,
      checkedAt: now(),
      message:
        compareVersions(update.version, current) > 0
          ? `发现 Cursor Studio v${update.version}。`
          : "当前已是最新版本。",
      update: compareVersions(update.version, current) > 0 ? update : undefined,
    };
  } catch (error) {
    return {
      state: "error",
      currentVersion: currentVersion(),
      checkedAt: now(),
      message: error instanceof Error ? error.message : "更新检查失败。",
    };
  }
}

export function getLastUpdateCheck(): UpdateCheckResult {
  return { ...lastCheck, update: lastCheck.update ? { ...lastCheck.update } : undefined };
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (checkInFlight) return checkInFlight;
  checkInFlight = performCheck()
    .then((result) => {
      lastCheck = result;
      return result;
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function safeVersion(value: string): string {
  return stripVersionPrefix(value).replace(/[^0-9A-Za-z._-]/g, "-") || "update";
}

function updateStagingDirectory(): string {
  try {
    return path.join(app.getPath("temp"), "Cursor Studio", "updates");
  } catch {
    const tempRoot = process.env.TEMP || process.env.TMP || path.dirname(process.execPath);
    return path.join(tempRoot, "Cursor Studio", "updates");
  }
}

async function downloadUpdate(
  update: AppUpdateInfo,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<string> {
  const config = updateRuntimeConfig();
  assertReleaseDownloadUrl(update.downloadUrl, config.githubRepository);
  const stagingDirectory = updateStagingDirectory();
  await fs.mkdir(stagingDirectory, { recursive: true });
  const fileName = `.cursor-studio-${safeVersion(update.version)}-${randomUUID()}.update.msi`;
  const targetPath = path.join(stagingDirectory, fileName);
  const partialPath = `${targetPath}.part`;

  try {
    const response = await fetchWithTimeout(
      update.downloadUrl,
      { headers: { "User-Agent": `Cursor-Studio/${currentVersion()}` } },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.ok || !response.body) {
      throw new Error(`更新下载失败（${response.status}）。`);
    }
    const totalBytes = positiveNumber(response.headers.get("content-length")) || update.size;
    let receivedBytes = 0;
    const progressStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        onProgress?.({
          phase: "downloading",
          receivedBytes,
          totalBytes,
          percent: totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : undefined,
        });
        callback(null, chunk);
      },
    });
    const source = Readable.fromWeb(response.body as never);
    await pipeline(source, progressStream, createWriteStream(partialPath, { flags: "wx" }));

    const stat = await fs.stat(partialPath);
    if (!stat.size) throw new Error("The downloaded update file is empty.");
    if (update.size && stat.size !== update.size) {
      throw new Error("The downloaded update file size did not match the release metadata.");
    }

    onProgress?.({ phase: "verifying", receivedBytes: stat.size, totalBytes: stat.size, percent: 100 });
    const actualSha256 = await hashFile(partialPath);
    if (actualSha256 !== update.sha256) {
      throw new Error("The downloaded update file failed its SHA-256 verification.");
    }
    await fs.rename(partialPath, targetPath);
    return targetPath;
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    await fs.rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function launchMsiInstaller(msiPath: string): Promise<void> {
  const scriptPath = path.join(
    path.dirname(msiPath),
    `.cursor-studio-msi-update-${randomUUID()}.ps1`,
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$parentProcessId = ${process.pid}`,
    `$msiPath = ${psQuote(msiPath)}`,
    `$launchPath = ${psQuote(process.execPath)}`,
    "$deadline = [DateTime]::UtcNow.AddSeconds(120)",
    "while (Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue) {",
    "  if ([DateTime]::UtcNow -gt $deadline) { exit 11 }",
    "  Start-Sleep -Milliseconds 250",
    "}",
    "try {",
    "  $msiExec = Join-Path $env:SystemRoot 'System32\\msiexec.exe'",
    "  if (-not (Test-Path -LiteralPath $msiExec)) { $msiExec = 'msiexec.exe' }",
    "  $msiArguments = '/i \"' + $msiPath.Replace('\"', '\"\"') + '\" /qn /norestart'",
    "  $installer = Start-Process -FilePath $msiExec -ArgumentList $msiArguments -Wait -PassThru",
    "  if ($installer.ExitCode -notin @(0, 3010, 1641)) { exit $installer.ExitCode }",
    "  if ($installer.ExitCode -ne 1641) {",
    "    if (Test-Path -LiteralPath $launchPath) { Start-Process -FilePath $launchPath }",
    "  }",
    "} finally {",
    "  if (Test-Path -LiteralPath $msiPath) { Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue }",
    "  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
    "}",
    "",
  ].join("\r\n");

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } catch (error) {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installAvailableUpdate(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<UpdateInstallResult> {
  if (installInFlight) return installInFlight;
  const pending = (async (): Promise<UpdateInstallResult> => {
    const unavailable = runtimeAvailability();
    if (unavailable) {
      return { state: "unsupported", currentVersion: currentVersion(), message: unavailable };
    }
    const result =
      lastCheck.state === "available" && lastCheck.update ? lastCheck : await checkForUpdates();
    if (result.state === "not-configured") {
      return {
        state: "not-configured",
        currentVersion: currentVersion(),
        message: result.message || "更新服务尚未配置。",
      };
    }
    if (result.state !== "available" || !result.update) {
      return {
        state: "no-update",
        currentVersion: currentVersion(),
        message: result.message || "当前没有可安装的更新。",
      };
    }

    try {
      const stagedPath = await downloadUpdate(result.update, onProgress);
      await launchMsiInstaller(stagedPath);
      setTimeout(() => app.quit(), 400);
      return {
        state: "restarting",
        currentVersion: currentVersion(),
        message: "更新已校验，正在安装并重新启动应用。",
        update: result.update,
      };
    } catch (error) {
      return {
        state: "error",
        currentVersion: currentVersion(),
        message: error instanceof Error ? error.message : "更新安装失败。",
        update: result.update,
      };
    }
  })();
  const scheduled = pending.finally(() => {
    installInFlight = null;
  });
  installInFlight = scheduled;
  return scheduled;
}
