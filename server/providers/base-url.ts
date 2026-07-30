/**
 * URL helpers shared by provider discovery, balance probes and chat traffic.
 * A configured base may be either a site root or an OpenAI-style `/v1` root.
 */

function normalizedPath(pathname: string): string {
  const value = pathname.replace(/\/+$/, "");
  return value === "/" ? "" : value;
}

function serializedURL(url: URL, pathname: string): string {
  const credentials = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ""}@`
    : "";
  return `${url.protocol}//${credentials}${url.host}${pathname}${url.search}`;
}

function splitFallback(value: string): { base: string; suffix: string } {
  const match = value.match(/^([^?#]*)([?#].*)?$/s);
  return {
    base: (match?.[1] || value).replace(/\/+$/, ""),
    suffix: match?.[2] || "",
  };
}

/** Trim whitespace and trailing path slashes without discarding a path prefix. */
export function normalizeProviderBaseURL(baseURL: string): string {
  const raw = String(baseURL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    return serializedURL(url, normalizedPath(url.pathname));
  } catch {
    const { base, suffix } = splitFallback(raw);
    return `${base}${suffix}`;
  }
}

/**
 * Return the deployment root used by non-OpenAI endpoints. Only one terminal
 * `/v1` segment is removed; prefixes such as `/gateway/openai` stay intact.
 */
export function providerSiteRoot(baseURL: string): string {
  const raw = String(baseURL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    const path = normalizedPath(url.pathname).replace(/\/v1$/i, "");
    return serializedURL(url, path);
  } catch {
    const { base, suffix } = splitFallback(raw);
    return `${base.replace(/\/v1$/i, "")}${suffix}`;
  }
}

function normalizedEndpointPath(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) return "";
  return value.startsWith("/") ? value : `/${value}`;
}

function endpointLeafMatches(basePath: string, endpointPath: string): boolean {
  if (/\/chat\/completions$/i.test(endpointPath)) {
    return /\/chat\/completions$/i.test(basePath);
  }
  if (/\/responses$/i.test(endpointPath)) {
    return /\/responses$/i.test(basePath);
  }
  if (/\/messages$/i.test(endpointPath)) {
    return /\/messages$/i.test(basePath);
  }
  if (/\/models$/i.test(endpointPath)) {
    return /\/models$/i.test(basePath);
  }
  return false;
}

function joinedPath(basePath: string, endpointPath: string): string {
  if (!endpointPath) return basePath;
  if (endpointLeafMatches(basePath, endpointPath)) return basePath;

  const version = endpointPath.match(/^\/(v\d+)(?:\/|$)/i)?.[1];
  if (version && new RegExp(`/${version}$`, "i").test(basePath)) {
    return `${basePath}${endpointPath.slice(version.length + 1)}`;
  }
  return `${basePath}${endpointPath}`;
}

/** Join an API endpoint while avoiding `/v1/v1/...` duplication. */
export function joinProviderEndpoint(baseURL: string, endpoint: string): string {
  const rawBase = String(baseURL || "").trim();
  const rawEndpoint = String(endpoint || "").trim();
  if (!rawBase) return "";
  if (/^https?:\/\//i.test(rawEndpoint)) {
    return normalizeProviderBaseURL(rawEndpoint);
  }
  const endpointPath = normalizedEndpointPath(rawEndpoint);

  try {
    const url = new URL(rawBase);
    url.hash = "";
    const path = joinedPath(normalizedPath(url.pathname), endpointPath);
    return serializedURL(url, path);
  } catch {
    const { base, suffix } = splitFallback(rawBase);
    return `${joinedPath(base, endpointPath)}${suffix}`;
  }
}

function terminalVersion(baseURL: string): boolean {
  try {
    return /\/v\d+$/i.test(normalizedPath(new URL(baseURL).pathname));
  } catch {
    return /\/v\d+$/i.test(splitFallback(baseURL).base);
  }
}

/**
 * Build versioned-first candidates for discovery endpoints such as `/models`.
 */
export function providerEndpointCandidates(
  baseURL: string,
  endpoint: string,
): string[] {
  const base = normalizeProviderBaseURL(baseURL);
  if (!base) return [];
  const path = normalizedEndpointPath(endpoint);
  if (!path) return [base];

  let basePath = "";
  try {
    basePath = normalizedPath(new URL(base).pathname);
  } catch {
    basePath = splitFallback(base).base;
  }
  if (endpointLeafMatches(basePath, path)) return [base];
  if (terminalVersion(base)) return [joinProviderEndpoint(base, path)];

  const versionedPath = /^\/v\d+(?:\/|$)/i.test(path) ? path : `/v1${path}`;
  return Array.from(new Set([
    joinProviderEndpoint(base, versionedPath),
    joinProviderEndpoint(base, path),
  ]));
}
