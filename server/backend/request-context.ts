/**
 * Per-request context for Cursor IDE/Agent turns.
 * Stage 1: route reason, abort, usage hooks.
 */
import { randomUUID } from "node:crypto";

export type RequestSource = "ide" | "agent" | "unknown";
export type RouteReason = "default" | "hint" | "failover" | "sticky" | "only";

export interface RequestContext {
  requestId: string;
  source: RequestSource;
  startedAt: number;
  providerId?: string;
  modelID?: string;
  routeReason?: RouteReason;
  attempt?: number;
  modelHint?: string;
  lastError?: string;
}

export function createRequestContext(input?: {
  requestId?: string;
  source?: RequestSource;
  modelHint?: string;
}): RequestContext {
  return {
    requestId: input?.requestId?.trim() || randomUUID(),
    source: input?.source || "unknown",
    startedAt: Date.now(),
    modelHint: input?.modelHint,
    attempt: 0,
  };
}

export function markRoute(
  ctx: RequestContext,
  input: {
    providerId: string;
    modelID: string;
    routeReason: RouteReason;
    attempt?: number;
  },
): RequestContext {
  ctx.providerId = input.providerId;
  ctx.modelID = input.modelID;
  ctx.routeReason = input.routeReason;
  if (typeof input.attempt === "number") ctx.attempt = input.attempt;
  return ctx;
}

export function markError(ctx: RequestContext, error: unknown): RequestContext {
  ctx.lastError = error instanceof Error ? error.message : String(error);
  return ctx;
}

export function elapsedMs(ctx: RequestContext): number {
  return Date.now() - ctx.startedAt;
}
