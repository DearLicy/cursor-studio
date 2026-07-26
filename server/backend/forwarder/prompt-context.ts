import type { HistoryMessage, HistoryPromptContext } from "./history";
import { normalizeAgentMode, type AgentMode } from "./tool-catalog";

export type DerivePromptContextsOptions = {
  mode?: string | AgentMode | null;
  latestUserText?: string;
  historyMessages?: readonly HistoryMessage[];
  structuredContexts?: readonly HistoryPromptContext[];
  /** True records a transition to `mode`; a value records the explicit target. */
  modeChanged?: boolean | string | AgentMode;
};

type SuccessfulEdit = {
  path: string;
  sourceField: string;
};

const PLAN_TURN_CONTRACT = [
  "For this plan-mode turn, the user indicated that they do not want you to execute yet. Do not make edits, run non-readonly tools, change configuration, or make commits.",
  "Research first. When the plan is ready, call CreatePlan with a concise, specific, actionable plan. If a <current_plan> is present, treat short follow-ups as revisions of that plan and omit the name field.",
  "Ask only the critical clarification questions needed to make the plan accurate. Do not make system changes until the user has confirmed the plan.",
].join("\n\n");

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function reminder(content: string): string {
  return `<system_reminder>\n${clean(content)}\n</system_reminder>`;
}

function context(source: string, content: string): HistoryPromptContext | undefined {
  const normalizedSource = clean(source);
  const normalizedContent = clean(content);
  if (!normalizedSource || !normalizedContent) return undefined;
  return {
    source: normalizedSource,
    message: { role: "user", content: normalizedContent },
  };
}

function modeContract(mode: AgentMode): string {
  switch (mode) {
    case "plan":
      return "For the turn that contains this reminder, the active mode is plan. Do not modify files or system state. Use CreatePlan when the plan is ready or needs updating.";
    case "ask":
      return "For the turn that contains this reminder, the active mode is ask. Prefer a direct answer. Use tools only when they materially improve accuracy, and do not call CreatePlan.";
    case "debug":
      return "For the turn that contains this reminder, the active mode is debug. Inspect or reproduce before editing, keep concrete hypotheses, verify with runtime evidence, and do not call CreatePlan or SwitchMode.";
    case "multitask":
      return "For the turn that contains this reminder, the active mode is multitask. Act as the foreground coordinator: delegate most non-trivial work to a coherent worker, avoid duplicating delegated work, and do not wait just for a worker to finish.";
    default:
      return "For the turn that contains this reminder, the active mode is agent. CreatePlan is not available in this mode; do not call CreatePlan. If the user explicitly asks to create or revise a plan, call SwitchMode to return to plan mode first. If there is an accepted or current plan, execute or continue the implementation using the available agent-mode tools.";
  }
}

function latestUserIntent(text: string): string {
  const normalized = text.toLowerCase();
  if (normalized.includes("review") || text.includes("评审") || text.includes("审查")) {
    return "When reviewing code, focus on bugs, regressions, behavioral risks, and missing tests.";
  }
  if (normalized.includes("plan") || text.includes("计划")) {
    return "Prefer clear staged plans with concrete checkpoints.";
  }
  return "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = clean(value?.[key]);
    if (candidate) return candidate;
  }
  return "";
}

function successfulEditFromMessage(message: HistoryMessage): SuccessfulEdit | undefined {
  if (message.role !== "tool") return undefined;
  const name = clean(message.name).toLowerCase();
  if (!/(?:^|_)(?:patch)?edit(?:_|$)|patchedit|write/.test(name)) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(message.content);
  } catch {
    return undefined;
  }
  const direct = record(payload);
  const nestedSuccess = record(direct?.success);
  const success = direct?.ok === true || Boolean(nestedSuccess);
  if (!success) return undefined;

  const path = stringField(nestedSuccess, "path", "file_path", "filePath") ||
    stringField(direct, "path", "file_path", "filePath");
  if (!path) return undefined;
  return {
    path,
    sourceField: nestedSuccess ? "successful edit result" : "PatchEdit",
  };
}

function latestSuccessfulEdit(messages: readonly HistoryMessage[]): SuccessfulEdit | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = successfulEditFromMessage(messages[index]);
    if (candidate) return candidate;
  }
  return undefined;
}

function validStructuredContexts(
  contexts: readonly HistoryPromptContext[],
): HistoryPromptContext[] {
  return contexts.flatMap((item) => {
    const source = clean(item.source);
    const content = clean(item.message?.content);
    const role = item.message?.role;
    return source && content && (role === "user" || role === "system")
      ? [{ source, message: { role, content } }]
      : [];
  });
}

/**
 * Build the provider-visible contexts persisted beside the active
 * user turn. Persistence and current-turn source/hash de-duplication remain
 * the responsibility of appendHistoryPromptContexts.
 */
export function derivePromptContexts(
  options: DerivePromptContextsOptions,
): HistoryPromptContext[] {
  const mode = normalizeAgentMode(options.mode);
  const latestUserText = clean(options.latestUserText);
  const contexts = validStructuredContexts(options.structuredContexts || []);
  const add = (source: string, content: string) => {
    const next = context(source, content);
    if (next) contexts.push(next);
  };

  if (options.modeChanged) {
    const changedMode = typeof options.modeChanged === "string"
      ? normalizeAgentMode(options.modeChanged)
      : mode;
    add(
      "mode_change",
      reminder(`At this point, the active mode changed to ${changedMode}; follow later mode reminders if present.`),
    );
  }

  if (mode === "plan") add("plan_turn_contract", reminder(PLAN_TURN_CONTRACT));
  add("active_mode_contract", reminder(modeContract(mode)));

  if (mode === "agent") {
    const edit = latestSuccessfulEdit(options.historyMessages || []);
    if (edit) {
      add(
        "latest_edit_reminder",
        reminder([
          `You recently successfully edited ${JSON.stringify(edit.path)}.`,
          `For this file, the latest source of truth is the most recent successful ${edit.sourceField}, not earlier reads or memory.`,
          "When modifying this file, use PatchEdit with an exact old_string from the latest file content; preserve spacing and line endings exactly.",
        ].join("\n\n")),
      );
    }
  }

  const intent = latestUserIntent(latestUserText);
  if (intent) add("latest_user_intent", reminder(intent));
  if (latestUserText) {
    add(
      "current_user_request",
      `<current_user_request>\n${latestUserText}\n</current_user_request>\n\nHandle this request. Use any latest tool results as evidence when present, and provide the requested answer once you have enough information. Treat surrounding system reminders as constraints, not as the user's task.`,
    );
  }
  return contexts;
}
