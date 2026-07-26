/**
 * Serializes model work for one Cursor conversation.
 *
 * Cursor can send a retry, reconnect, or a newer user turn before a previous
 * stream has fully settled. Provider work must remain ordered by conversation,
 * otherwise an older completion can append after a newer turn and corrupt the
 * proxy-side context.
 */

type LaneState = {
  tail: Promise<void>;
  activeGeneration: number;
  activeRequestId?: string;
  updatedAt: number;
};

export type ConversationTurn = {
  key: string;
  requestId: string;
  generation: number;
  /** False once a later turn for this conversation supersedes or starts. */
  isCurrent: () => boolean;
};

const lanes = new Map<string, LaneState>();
const LANE_RETENTION_MS = 30 * 60 * 1000;
const MAX_LANES = 512;

function normalizeKey(value: string): string {
  return String(value || "").trim() || "__unscoped__";
}

function abortError(): Error {
  const error = new Error("conversation turn was cancelled before it started");
  error.name = "AbortError";
  return error;
}

function pruneLanes(now = Date.now()) {
  const cutoff = now - LANE_RETENTION_MS;
  for (const [key, state] of lanes) {
    if (!state.activeRequestId && state.updatedAt < cutoff) lanes.delete(key);
  }
  if (lanes.size <= MAX_LANES) return;
  const ordered = [...lanes.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  while (lanes.size > MAX_LANES && ordered.length) {
    const [key, state] = ordered.shift()!;
    if (!state.activeRequestId) lanes.delete(key);
  }
}

/**
 * Run one model turn after all earlier work for the same conversation settles.
 * A canceled queued turn never reaches the provider. The returned generation
 * lets callers ignore callbacks from an old provider pass after a newer turn
 * has started.
 */
export async function runInConversationLane<T>(
  key: string,
  requestId: string,
  task: (turn: ConversationTurn) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  pruneLanes();
  const normalizedKey = normalizeKey(key);
  const normalizedRequestId = String(requestId || "").trim();
  let state = lanes.get(normalizedKey);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      activeGeneration: 0,
      updatedAt: Date.now(),
    };
    lanes.set(normalizedKey, state);
  }

  const previous = state.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nextTail = previous.catch(() => undefined).then(() => gate);
  state.tail = nextTail;
  state.updatedAt = Date.now();

  try {
    await previous.catch(() => undefined);
    if (signal?.aborted) throw abortError();

    const generation = state.activeGeneration + 1;
    state.activeGeneration = generation;
    state.activeRequestId = normalizedRequestId || undefined;
    state.updatedAt = Date.now();

    return await task({
      key: normalizedKey,
      requestId: normalizedRequestId,
      generation,
      isCurrent: () => {
        const current = lanes.get(normalizedKey);
        return current === state && current.activeGeneration === generation;
      },
    });
  } finally {
    if (state.activeRequestId === normalizedRequestId) {
      state.activeRequestId = undefined;
    }
    state.updatedAt = Date.now();
    release();
    void nextTail.finally(() => {
      if (lanes.get(normalizedKey) === state && state.tail === nextTail && !state.activeRequestId) {
        state.updatedAt = Date.now();
      }
    });
  }
}

/**
 * Invalidate the currently running turn for a conversation without releasing
 * the lane early. The caller still owns transport cancellation; keeping the
 * lane blocked until that work settles prevents a stale provider callback from
 * racing a replacement turn into shared history.
 *
 * Returns true only when another request was actively running and was marked
 * stale. Queued requests are cancelled by the stream broker before they reach
 * this lane, so they observe their AbortSignal at startup instead.
 */
export function supersedeConversationLane(
  key: string,
  keepRequestId: string,
): boolean {
  const state = lanes.get(normalizeKey(key));
  const keep = String(keepRequestId || "").trim();
  if (!state || !state.activeRequestId || state.activeRequestId === keep) {
    return false;
  }

  // ConversationTurn.isCurrent compares this generation. Advancing it now
  // makes any old callback stale before the new turn has to wait for cleanup.
  state.activeGeneration += 1;
  state.updatedAt = Date.now();
  return true;
}

/** Exposed for deterministic protocol smoke tests. */
export function clearConversationLanesForTests() {
  lanes.clear();
}
