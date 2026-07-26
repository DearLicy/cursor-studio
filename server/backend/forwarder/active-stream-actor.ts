/**
 * Per-request lifecycle actor for the Cursor Agent bridge.
 *
 * Provider completion, client bridge responses and cancellation can arrive on
 * different async continuations.  Routing all lifecycle mutations through one
 * mailbox gives one owner to the turn state and makes the resume/complete
 * decision deterministic.
 */

export type TurnPhase =
  | "idle"
  | "provider_running"
  | "waiting_external"
  | "awaiting_user"
  | "compacting"
  | "completed"
  | "failed"
  | "canceled";

export type ProviderAction = "start" | "resume";

export type CompletionDisposition =
  | "resume_after_external"
  | "complete_after_external";

export type ExternalWait = {
  id: string;
  kind: "exec" | "interaction";
  name: string;
  /** CreatePlan is the only Cursor interaction that owns the end of a turn. */
  autoResume: boolean;
};

export type PendingProviderCompletion = {
  disposition: CompletionDisposition;
  finishReason: string;
  hadToolInvocation: boolean;
  providerPass: number;
};

export type StreamActorEffect =
  | { kind: "none" }
  | { kind: "start_provider"; providerPass: number }
  | { kind: "resume_provider"; providerPass: number }
  | { kind: "complete_turn"; completion: PendingProviderCompletion };

export type StreamActorCommand =
  | { kind: "run" }
  | {
      kind: "inbound";
      action:
        | "metadata"
        | "prewarm"
        | "exec_result"
        | "exec_control"
        | "interaction_result"
        | "heartbeat";
    }
  | { kind: "request_provider"; action: ProviderAction }
  | { kind: "provider_started" }
  | { kind: "provider_stopped"; providerPass?: number }
  | {
      kind: "provider_finished";
      providerPass?: number;
      finishReason?: string;
      hadToolInvocation: boolean;
      /** Force a terminal disposition for CreatePlan, even if its response raced. */
      forceComplete?: boolean;
    }
  | { kind: "external_opened"; pending: ExternalWait }
  | { kind: "external_completed"; id: string; externalKind: ExternalWait["kind"] }
  | { kind: "compaction_started" }
  | { kind: "compaction_finished"; resumeProvider?: boolean }
  | { kind: "complete" }
  | { kind: "fail" }
  | { kind: "cancel" };

export type ActiveStreamActorSnapshot = {
  requestId: string;
  phase: TurnPhase;
  providerActive: boolean;
  providerPass: number;
  pendingProviderAction?: ProviderAction;
  pendingProviderCompletion?: PendingProviderCompletion;
  pendingExternal: ExternalWait[];
  compacting: boolean;
  revision: number;
  updatedAt: number;
};

export type StreamActorDispatchResult = {
  previousPhase: TurnPhase;
  snapshot: ActiveStreamActorSnapshot;
  effect: StreamActorEffect;
};

/**
 * Serial event inbox used by the service-level turn runtime. Provider workers
 * and Bidi handlers may only post immutable events here; the handler is the
 * sole owner of mutable turn state and runs exactly one event at a time.
 */
export class StreamActorMailbox<Event> {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly handle: (event: Event) => void | Promise<void>,
  ) {}

  post(event: Event): Promise<void> {
    if (this.closed) return Promise.resolve();
    const handled = this.tail.then(() => {
      if (this.closed) return;
      return this.handle(event);
    });
    // Keep the queue usable after a rejected command. The returned promise
    // still reports that command's error to its producer.
    this.tail = handled.catch(() => undefined);
    return handled;
  }

  close(): void {
    this.closed = true;
  }
}

const NONE: StreamActorEffect = { kind: "none" };

function externalKey(kind: ExternalWait["kind"], id: string): string {
  return `${kind}:${String(id || "").trim()}`;
}

function isTerminalPhase(phase: TurnPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "canceled";
}

function mergeDisposition(
  current: CompletionDisposition | undefined,
  incoming: CompletionDisposition,
): CompletionDisposition {
  if (
    current === "complete_after_external" ||
    incoming === "complete_after_external"
  ) {
    return "complete_after_external";
  }
  return "resume_after_external";
}

export class ActiveStreamActor {
  private queue: Promise<void> = Promise.resolve();
  private phase: TurnPhase = "idle";
  private providerActive = false;
  private providerPass = 0;
  private pendingProviderAction: ProviderAction | undefined;
  private pendingProviderCompletion: PendingProviderCompletion | undefined;
  private readonly pendingExternal = new Map<string, ExternalWait>();
  private compacting = false;
  private revision = 0;
  private updatedAt = Date.now();

  constructor(readonly requestId: string) {}

  dispatch(command: StreamActorCommand): Promise<StreamActorDispatchResult> {
    let resolve!: (result: StreamActorDispatchResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<StreamActorDispatchResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.queue = this.queue
      .then(() => {
        const previousPhase = this.phase;
        const effect = this.apply(command);
        this.revision += 1;
        this.updatedAt = Date.now();
        resolve({ previousPhase, snapshot: this.snapshot(), effect });
      })
      .catch((error) => {
        reject(error);
      });
    return result;
  }

  snapshot(): ActiveStreamActorSnapshot {
    return {
      requestId: this.requestId,
      phase: this.phase,
      providerActive: this.providerActive,
      providerPass: this.providerPass,
      pendingProviderAction: this.pendingProviderAction,
      pendingProviderCompletion: this.pendingProviderCompletion
        ? { ...this.pendingProviderCompletion }
        : undefined,
      pendingExternal: [...this.pendingExternal.values()].map((item) => ({
        ...item,
      })),
      compacting: this.compacting,
      revision: this.revision,
      updatedAt: this.updatedAt,
    };
  }

  private apply(command: StreamActorCommand): StreamActorEffect {
    if (isTerminalPhase(this.phase)) return NONE;

    switch (command.kind) {
      case "run":
        if (!this.providerActive && !this.pendingProviderAction) {
          this.pendingProviderAction = "start";
        }
        break;
      case "inbound":
        break;
      case "request_provider":
        if (
          command.action === "start" ||
          this.pendingProviderAction !== "start"
        ) {
          this.pendingProviderAction = command.action;
        }
        break;
      case "provider_started":
        this.providerPass += 1;
        this.providerActive = true;
        this.pendingProviderAction = undefined;
        this.phase = "provider_running";
        return NONE;
      case "provider_stopped":
        if (
          command.providerPass != null &&
          command.providerPass !== this.providerPass
        ) {
          return NONE;
        }
        this.providerActive = false;
        this.pendingProviderAction = undefined;
        this.pendingProviderCompletion = undefined;
        break;
      case "provider_finished": {
        if (
          command.providerPass != null &&
          command.providerPass !== this.providerPass
        ) {
          return NONE;
        }
        this.providerActive = false;
        const finishReason = String(command.finishReason || "").trim();
        const awaitingUser = [...this.pendingExternal.values()].some(
          (pending) => pending.kind === "interaction" && !pending.autoResume,
        );
        const incomingDisposition: CompletionDisposition =
          command.forceComplete || awaitingUser
            ? "complete_after_external"
            : command.hadToolInvocation ||
                finishReason === "tool_use" ||
                finishReason === "tool_calls" ||
                finishReason === "function_call"
              ? "resume_after_external"
              : "complete_after_external";
        const disposition = mergeDisposition(
          this.pendingProviderCompletion?.disposition,
          incomingDisposition,
        );
        this.pendingProviderCompletion = {
          disposition,
          finishReason,
          hadToolInvocation: command.hadToolInvocation,
          providerPass: this.providerPass,
        };
        break;
      }
      case "external_opened":
        this.pendingExternal.set(
          externalKey(command.pending.kind, command.pending.id),
          { ...command.pending },
        );
        break;
      case "external_completed":
        this.pendingExternal.delete(
          externalKey(command.externalKind, command.id),
        );
        break;
      case "compaction_started":
        this.compacting = true;
        this.providerActive = false;
        break;
      case "compaction_finished":
        this.compacting = false;
        if (command.resumeProvider) this.pendingProviderAction = "resume";
        break;
      case "complete":
        this.providerActive = false;
        this.pendingExternal.clear();
        this.pendingProviderAction = undefined;
        this.pendingProviderCompletion = undefined;
        this.compacting = false;
        this.phase = "completed";
        return NONE;
      case "fail":
        this.providerActive = false;
        this.pendingExternal.clear();
        this.pendingProviderAction = undefined;
        this.pendingProviderCompletion = undefined;
        this.compacting = false;
        this.phase = "failed";
        return NONE;
      case "cancel":
        this.providerActive = false;
        this.pendingExternal.clear();
        this.pendingProviderAction = undefined;
        this.pendingProviderCompletion = undefined;
        this.compacting = false;
        this.phase = "canceled";
        return NONE;
    }

    return this.reconcile();
  }

  private reconcile(): StreamActorEffect {
    if (this.providerActive) {
      this.phase = "provider_running";
      return NONE;
    }
    if (this.pendingExternal.size > 0) {
      const awaitingUser = [...this.pendingExternal.values()].some(
        (pending) => pending.kind === "interaction" && !pending.autoResume,
      );
      this.phase = awaitingUser
        ? "awaiting_user"
        : this.compacting
          ? "compacting"
          : "waiting_external";
      return NONE;
    }
    if (this.compacting) {
      this.phase = "compacting";
      return NONE;
    }
    if (this.pendingProviderCompletion) {
      const completion = this.pendingProviderCompletion;
      this.pendingProviderCompletion = undefined;
      if (completion.disposition === "resume_after_external") {
        this.pendingProviderAction = "resume";
      } else {
        this.pendingProviderAction = undefined;
        // The service still has to persist usage/checkpoint and publish the
        // native terminal events. It acknowledges completion explicitly only
        // after those side effects succeed.
        this.phase = "idle";
        return { kind: "complete_turn", completion };
      }
    }
    if (this.pendingProviderAction) {
      const action = this.pendingProviderAction;
      this.pendingProviderAction = undefined;
      this.phase = action === "resume" ? "waiting_external" : "idle";
      return {
        kind: action === "resume" ? "resume_provider" : "start_provider",
        providerPass: this.providerPass + 1,
      };
    }
    this.phase = "idle";
    return NONE;
  }
}

const actors = new Map<string, ActiveStreamActor>();
const MAX_ACTORS = 256;

function pruneActors(): void {
  if (actors.size <= MAX_ACTORS) return;
  const terminal = [...actors.entries()]
    .filter(([, actor]) => isTerminalPhase(actor.snapshot().phase))
    .sort((left, right) => left[1].snapshot().updatedAt - right[1].snapshot().updatedAt);
  while (actors.size > MAX_ACTORS && terminal.length) {
    actors.delete(terminal.shift()![0]);
  }
}

export function ensureActiveStreamActor(requestId: string): ActiveStreamActor {
  const key = String(requestId || "").trim();
  let actor = actors.get(key);
  if (!actor) {
    actor = new ActiveStreamActor(key);
    actors.set(key, actor);
    pruneActors();
  }
  return actor;
}

export function getActiveStreamActorSnapshot(
  requestId: string,
): ActiveStreamActorSnapshot | undefined {
  return actors.get(String(requestId || "").trim())?.snapshot();
}

export function disposeActiveStreamActor(requestId: string): void {
  actors.delete(String(requestId || "").trim());
}
