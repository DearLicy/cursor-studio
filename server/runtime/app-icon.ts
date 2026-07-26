import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CURSOR_AVATAR_ROUTE = "/cursor-studio/avatar.png";
const DEFAULT_BACKEND_PORT = 18090;

let cachedDefaultAvatarPath: string | undefined;

function candidateIconPaths(): string[] {
  const resourcesPath =
    typeof (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath === "string"
      ? String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath)
      : "";
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

  return [
    resourcesPath ? path.join(resourcesPath, "resources", "icon-runtime.png") : "",
    resourcesPath ? path.join(resourcesPath, "resources", "icon-round.png") : "",
    resourcesPath ? path.join(resourcesPath, "resources", "icon.png") : "",
    resourcesPath ? path.join(resourcesPath, "icon-round.png") : "",
    resourcesPath ? path.join(resourcesPath, "icon.png") : "",
    path.join(process.cwd(), "resources", "icon-round.png"),
    path.join(process.cwd(), "resources", "icon-runtime.png"),
    path.join(process.cwd(), "resources", "icon.png"),
    path.join(runtimeDir, "../../resources", "icon-round.png"),
    path.join(runtimeDir, "../../resources", "icon-runtime.png"),
    path.join(runtimeDir, "../../resources", "icon.png"),
    path.join(runtimeDir, "../resources", "icon-round.png"),
    path.join(runtimeDir, "../resources", "icon.png"),
  ].filter(Boolean);
}

/**
 * Resolve the same application icon used by the desktop shell in both
 * development and packaged builds.
 */
export function resolveDefaultCursorAvatarPath(): string {
  if (cachedDefaultAvatarPath !== undefined) return cachedDefaultAvatarPath;

  for (const candidate of candidateIconPaths()) {
    try {
      if (fs.existsSync(candidate)) {
        cachedDefaultAvatarPath = candidate;
        return cachedDefaultAvatarPath;
      }
    } catch {
      // Try the next layout candidate.
    }
  }

  cachedDefaultAvatarPath = "";
  return cachedDefaultAvatarPath;
}

/** A configured avatar wins; an invalid or missing file falls back to the app icon. */
export function resolveCursorAvatarPath(configuredAvatarUrl?: string): string {
  const configured = configuredAvatarUrl?.trim();
  if (configured) {
    try {
      const candidate = /^file:/i.test(configured)
        ? fileURLToPath(configured)
        : path.resolve(configured);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // The selected file may have been moved. Keep the profile usable.
    }
  }
  return resolveDefaultCursorAvatarPath();
}

export function cursorAvatarContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".png":
    default:
      return "image/png";
  }
}

/** A remote image can be used by Cursor directly without a local media hop. */
export function resolveRemoteCursorAvatarUrl(configuredAvatarUrl?: string): string | undefined {
  const configured = configuredAvatarUrl?.trim();
  if (!configured) return undefined;

  try {
    const url = new URL(configured);
    if (
      url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password
    ) {
      return url.href;
    }
  } catch {
    // Local files are served through the backend route below.
  }

  return undefined;
}

function endpointPort(listenAddr?: string): number {
  const raw = String(listenAddr || "").trim().replace(/^https?:\/\//i, "");
  const match = /:(\d+)(?:\/|$)/.exec(raw);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : DEFAULT_BACKEND_PORT;
}

function avatarRevision(configuredAvatarUrl?: string): string {
  const avatarPath = resolveCursorAvatarPath(configuredAvatarUrl);
  try {
    const stat = fs.statSync(avatarPath);
    return `${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
  } catch {
    return "default";
  }
}

/**
 * Cursor renders profile images in a sandboxed workbench where file:// URLs
 * are rejected. Always return the local backend media route instead of a raw
 * filesystem URL; the route serves either the configured file or the app icon.
 */
export function resolveCursorAvatarUrl(
  configuredAvatarUrl?: string,
  backendListenAddr?: string,
): string {
  const remoteAvatarUrl = resolveRemoteCursorAvatarUrl(configuredAvatarUrl);
  if (remoteAvatarUrl) return remoteAvatarUrl;

  const port = endpointPort(backendListenAddr);
  return `http://127.0.0.1:${port}${CURSOR_AVATAR_ROUTE}?v=${avatarRevision(configuredAvatarUrl)}`;
}
