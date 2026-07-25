/**
 * Upstream / local error code mapping (fixtures/protocol/error-mapping.json).
 */
export type ErrorMapEntry = {
  upstreamStatus?: number;
  local?: string;
  code: string;
  validTurn: boolean;
  cooldown?: boolean;
  failover?: boolean;
};

export const ERROR_MAP: ErrorMapEntry[] = [
  { upstreamStatus: 401, code: "UPSTREAM_UNAUTHORIZED", validTurn: false },
  { upstreamStatus: 403, code: "UPSTREAM_FORBIDDEN", validTurn: false },
  { upstreamStatus: 429, code: "UPSTREAM_RATE_LIMIT", validTurn: false, cooldown: true },
  { upstreamStatus: 500, code: "UPSTREAM_5XX", validTurn: false, failover: true },
  { upstreamStatus: 502, code: "UPSTREAM_5XX", validTurn: false, failover: true },
  { upstreamStatus: 0, code: "UPSTREAM_NETWORK", validTurn: false, failover: true },
  { local: "provider_cooldown", code: "PROVIDER_COOLDOWN", validTurn: false },
];

export function mapUpstreamStatus(status: number): ErrorMapEntry {
  const hit = ERROR_MAP.find((e) => e.upstreamStatus === status);
  if (hit) return hit;
  if (status >= 500) {
    return { upstreamStatus: status, code: "UPSTREAM_5XX", validTurn: false, failover: true };
  }
  if (status >= 400) {
    return { upstreamStatus: status, code: "UPSTREAM_4XX", validTurn: false };
  }
  return { upstreamStatus: status, code: "UPSTREAM_NETWORK", validTurn: false, failover: true };
}

export function mapLocalError(local: string): ErrorMapEntry {
  return (
    ERROR_MAP.find((e) => e.local === local) || {
      local,
      code: "LOCAL_ERROR",
      validTurn: false,
    }
  );
}

export function shouldFailover(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Client cancel / intentional abort: never failover.
  if (
    (error instanceof Error && error.name === "AbortError") ||
    /abort|cancel/i.test(msg)
  ) {
    return false;
  }
  if (/\b401\b|\b403\b/i.test(msg)) return false;
  if (
    /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|timeout/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}
