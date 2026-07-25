/**
 * User-visible Cursor conversation browser.
 *
 * Cursor's agent-transcript JSONL files describe execution lifecycle only.
 * Real conversation headers and message bubbles are persisted in Cursor's
 * SQLite user-data store, which is the authoritative source used here.
 */
import {
  listCursorComposerSessions,
  readCursorComposerMessages,
  type CursorComposerSession,
} from "./cursor-composer-store";
import {
  clearAllCursorComposerSessions,
  removeCursorComposerSessions,
} from "./cursor-session-cleanup";

export type SessionMessageRole = "user" | "assistant";

export type SessionMessage = {
  id: string;
  index: number;
  line: number;
  role: SessionMessageRole;
  text: string;
  truncated?: boolean;
};

export type SessionItem = {
  id: string;
  sessionId: string;
  title: string;
  project: string;
  projectLabel: string;
  updatedAt?: string;
  createdAt?: string;
  preview?: string;
  messageCount: number;
};

export type SessionDetail = {
  session: SessionItem;
  messages: SessionMessage[];
  totalMessages: number;
};

export type SessionListView = "recent" | "project";

export type SessionListQuery = {
  limit?: number;
  offset?: number;
  view?: SessionListView;
  q?: string;
  project?: string;
  refresh?: boolean;
};

export type SessionProjectGroup = {
  project: string;
  label: string;
  count: number;
  latestAt?: string;
};

type SessionGroup = {
  id: string;
  composerId: string;
  source: CursorComposerSession;
};

type SessionIndex = {
  items: SessionItem[];
  groups: Map<string, SessionGroup>;
  projects: SessionProjectGroup[];
};

const INDEX_TTL_MS = 1200;
const DEFAULT_SESSION_PAGE_SIZE = 10;
const MAX_SESSION_PAGE_SIZE = 100;
const MAX_SESSION_OFFSET = 1_000_000;
const CURSOR_ID_PREFIX = "cursor:";
const COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedIndex: { createdAt: number; value: SessionIndex } | undefined;

function sessionKey(composerId: string): string {
  return `${CURSOR_ID_PREFIX}${composerId}`;
}

function composerIdFromSessionKey(value: string): string | undefined {
  const normalized = String(value || "").trim().replace(/^cursor:/i, "");
  return COMPOSER_ID.test(normalized) ? normalized : undefined;
}

function itemFromComposer(source: CursorComposerSession): SessionItem {
  return {
    id: sessionKey(source.composerId),
    sessionId: source.composerId,
    title: source.title,
    project: source.project,
    projectLabel: source.projectLabel,
    updatedAt: source.updatedAt,
    createdAt: source.createdAt,
    preview: source.preview,
    messageCount: source.messageCount,
  };
}

async function buildIndex(): Promise<SessionIndex> {
  const sources = await listCursorComposerSessions();
  const items = sources.map(itemFromComposer);
  items.sort(
    (a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || "") ||
      a.id.localeCompare(b.id),
  );

  const groups = new Map<string, SessionGroup>();
  const projects = new Map<string, SessionProjectGroup>();
  for (const source of sources) {
    const id = sessionKey(source.composerId);
    groups.set(id, { id, composerId: source.composerId, source });
    const existing = projects.get(source.project) || {
      project: source.project,
      label: source.projectLabel,
      count: 0,
      latestAt: source.updatedAt,
    };
    existing.count += 1;
    if ((source.updatedAt || "") > (existing.latestAt || "")) {
      existing.latestAt = source.updatedAt;
    }
    projects.set(source.project, existing);
  }

  return {
    items,
    groups,
    projects: [...projects.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"),
    ),
  };
}

async function getIndex(force = false): Promise<SessionIndex> {
  if (!force && cachedIndex && Date.now() - cachedIndex.createdAt < INDEX_TTL_MS) {
    return cachedIndex.value;
  }
  const value = await buildIndex();
  cachedIndex = { createdAt: Date.now(), value };
  return value;
}

function filterSessions(items: SessionItem[], query: SessionListQuery): SessionItem[] {
  let next = items;
  if (query.project && query.project !== "all") {
    next = next.filter((item) => item.project === query.project);
  }
  if (query.q?.trim()) {
    const needle = query.q.trim().toLocaleLowerCase();
    next = next.filter((item) =>
      `${item.title} ${item.preview || ""} ${item.projectLabel} ${item.sessionId}`
        .toLocaleLowerCase()
        .includes(needle),
    );
  }
  return next;
}

function sessionLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_SESSION_PAGE_SIZE;
  return Math.min(Math.max(Math.floor(value), 1), MAX_SESSION_PAGE_SIZE);
}

function sessionOffset(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), MAX_SESSION_OFFSET);
}

export async function listSessions(
  query: SessionListQuery = {},
): Promise<{
  items: SessionItem[];
  totalMatched: number;
  totalSessions: number;
  offset: number;
  limit: number;
  view: SessionListView;
  projects: SessionProjectGroup[];
}> {
  const index = await getIndex(Boolean(query.refresh));
  const matched = filterSessions(index.items, query);
  const limit = sessionLimit(query.limit);
  const requestedOffset = sessionOffset(query.offset);
  const view: SessionListView = query.view === "project" ? "project" : "recent";

  if (view === "project") {
    const grouped = new Map<
      string,
      { project: string; label: string; latestAt?: string; sessions: SessionItem[] }
    >();
    for (const item of matched) {
      const current = grouped.get(item.project) || {
        project: item.project,
        label: item.projectLabel,
        latestAt: item.updatedAt,
        sessions: [],
      };
      current.sessions.push(item);
      if ((item.updatedAt || "") > (current.latestAt || "")) current.latestAt = item.updatedAt;
      grouped.set(item.project, current);
    }
    const projectGroups = [...grouped.values()].sort(
      (a, b) =>
        (b.latestAt || "").localeCompare(a.latestAt || "") ||
        a.label.localeCompare(b.label, "zh-CN"),
    );
    const lastPageOffset = projectGroups.length
      ? Math.floor((projectGroups.length - 1) / limit) * limit
      : 0;
    const offset = Math.min(requestedOffset, lastPageOffset);
    const pageProjectIds = new Set(
      projectGroups.slice(offset, offset + limit).map((group) => group.project),
    );
    return {
      items: matched.filter((item) => pageProjectIds.has(item.project)),
      totalMatched: projectGroups.length,
      totalSessions: matched.length,
      offset,
      limit,
      view,
      projects: index.projects,
    };
  }

  const lastPageOffset = matched.length
    ? Math.floor((matched.length - 1) / limit) * limit
    : 0;
  const offset = Math.min(requestedOffset, lastPageOffset);
  return {
    items: matched.slice(offset, offset + limit),
    totalMatched: matched.length,
    totalSessions: matched.length,
    offset,
    limit,
    view,
    projects: index.projects,
  };
}

export async function readSessionDetail(sessionId: string): Promise<SessionDetail> {
  const index = await getIndex();
  const group = index.groups.get(sessionId);
  const session = index.items.find((item) => item.id === sessionId);
  if (!group || !session) throw new Error("会话不存在或已被清理");

  const sourceMessages = await readCursorComposerMessages(group.composerId);
  if (!sourceMessages) throw new Error("会话内容暂时不可读取，请刷新后重试");
  const messages: SessionMessage[] = sourceMessages.map((message) => ({
    id: message.id,
    index: message.index,
    line: message.index + 1,
    role: message.role,
    text: message.text,
    truncated: message.text.endsWith("内容过长，已折叠剩余部分。"),
  }));
  return { session, messages, totalMessages: messages.length };
}

export async function removeSessions(sessionIds: string[]): Promise<{
  ok: true;
  removed: string[];
  failed: Array<{ id: string; error: string }>;
}> {
  const ids = [...new Set(
    sessionIds.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  const index = await getIndex(true);
  const failed: Array<{ id: string; error: string }> = [];
  const groups = ids.flatMap((id) => {
    const group = index.groups.get(id);
    if (!group) {
      failed.push({ id, error: "会话不存在或已被清理" });
      return [];
    }
    return [group];
  });
  if (!groups.length) return { ok: true, removed: [], failed };

  const result = await removeCursorComposerSessions(groups.map((group) => group.composerId));
  const removedSet = new Set(result.removed);
  for (const group of groups) {
    if (removedSet.has(group.composerId)) continue;
    const detail = result.failed[0]?.error || "会话清理未完成";
    failed.push({ id: group.id, error: detail });
  }
  cachedIndex = undefined;
  return {
    ok: true,
    removed: groups
      .filter((group) => removedSet.has(group.composerId))
      .map((group) => group.id),
    failed,
  };
}

export async function clearEmptySessions(): Promise<{
  ok: true;
  emptyFound: number;
  removed: string[];
  failed: Array<{ id: string; error: string }>;
}> {
  const index = await getIndex(true);
  const ids = index.items.filter((item) => item.messageCount === 0).map((item) => item.id);
  const result = await removeSessions(ids);
  return { ok: true, emptyFound: ids.length, removed: result.removed, failed: result.failed };
}

export async function clearAllSessions(): Promise<{
  ok: true;
  removed: string[];
  databaseEntries: number;
  transcriptDirectories: number;
  failed: Array<{ target: string; error: string }>;
}> {
  const before = await getIndex(true);
  const result = await clearAllCursorComposerSessions();
  cachedIndex = undefined;
  return {
    ok: true,
    removed: before.items.map((item) => item.id),
    databaseEntries: result.databaseEntries,
    transcriptDirectories: result.transcriptDirectories,
    failed: result.failed,
  };
}
