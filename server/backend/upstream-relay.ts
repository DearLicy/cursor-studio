import https from "node:https";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "x-server-upstream-url",
]);

export type CursorUpstreamRelayResult =
  | { relayed: true }
  | { relayed: false; reason: "missing" | "invalid" | "unavailable" | "aborted" };

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function isCursorHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "cursor.sh" || normalized.endsWith(".cursor.sh");
}

/**
 * The MITM layer supplies the original target in this header. Only accept the
 * Cursor HTTPS origin so a local process cannot turn the backend into a relay
 * for arbitrary network destinations.
 */
export function resolveCursorUpstreamUrl(req: IncomingMessage): URL | undefined {
  const raw = firstHeaderValue(req.headers["x-server-upstream-url"]).trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      !isCursorHost(url.hostname) ||
      (url.port !== "" && url.port !== "443") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function copyRequestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    copied[key] = value;
  }
  return copied;
}

function copyResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    copied[key] = value;
  }
  return copied;
}

/**
 * Relays an explicitly approved ancillary Cursor procedure to the original
 * HTTPS endpoint. It deliberately does not follow redirects: a redirected
 * request would no longer be covered by the origin validation above.
 */
export async function relayCursorUpstream(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<CursorUpstreamRelayResult> {
  const target = resolveCursorUpstreamUrl(req);
  if (!target) {
    return {
      relayed: false,
      reason: firstHeaderValue(req.headers["x-server-upstream-url"]).trim()
        ? "invalid"
        : "missing",
    };
  }

  return new Promise<CursorUpstreamRelayResult>((resolve) => {
    const abortController = new AbortController();
    let settled = false;

    const cleanup = () => {
      req.off("aborted", abortRequest);
      req.off("error", abortRequest);
      res.off("close", abortResponse);
    };
    const settle = (result: CursorUpstreamRelayResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abortRequest = () => {
      if (!abortController.signal.aborted) abortController.abort();
    };
    const abortResponse = () => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        abortController.abort();
      }
    };

    req.once("aborted", abortRequest);
    req.once("error", abortRequest);
    res.once("close", abortResponse);

    const upstream = https.request(
      {
        protocol: "https:",
        hostname: target.hostname,
        port: 443,
        method: req.method || "POST",
        path: `${target.pathname}${target.search}`,
        headers: copyRequestHeaders(req.headers),
        signal: abortController.signal,
      },
      (upstreamResponse) => {
        const status = upstreamResponse.statusCode || 502;
        if (status >= 300 && status < 400) {
          // Redirects are intentionally never followed or exposed to the client.
          upstreamResponse.resume();
          settle({ relayed: false, reason: "unavailable" });
          return;
        }

        if (res.destroyed || res.writableEnded) {
          upstreamResponse.destroy();
          settle({ relayed: false, reason: "aborted" });
          return;
        }

        res.writeHead(status, copyResponseHeaders(upstreamResponse.headers));
        upstreamResponse.once("error", () => {
          if (!res.writableEnded && !res.destroyed) res.destroy();
          settle({ relayed: true });
        });
        upstreamResponse.once("end", () => settle({ relayed: true }));
        upstreamResponse.once("close", () => settle({ relayed: true }));
        upstreamResponse.pipe(res);
      },
    );

    upstream.once("error", () => {
      settle({
        relayed: false,
        reason: abortController.signal.aborted ? "aborted" : "unavailable",
      });
    });
    req.pipe(upstream);
  });
}
