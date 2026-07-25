import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/app-notice";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  List,
  MessageSquare,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import {
  getApi,
  type SessionDetail,
  type SessionItem,
  type SessionMessage,
  type SessionProjectGroup,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/layout";
import { useConfirm } from "@/components/ui/confirm";
import { Pagination } from "@/components/ui/pagination";
import { SimpleSelect } from "@/components/ui/select";

type SessionViewMode = "recent" | "project";

type SessionGroup = {
  project: string;
  label: string;
  sessions: SessionItem[];
};

const SESSION_VIEW_STORAGE_KEY = "cursor-studio:sessions:view";
const SESSION_COLLAPSED_STORAGE_KEY = "cursor-studio:sessions:collapsed-projects";
const SESSION_PAGE_SIZE_STORAGE_KEY = "cursor-studio:sessions:page-size";
const SESSION_PAGE_SIZE = 10;
const SESSION_PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100] as const;

function readSessionViewMode(): SessionViewMode {
  if (typeof window === "undefined") return "recent";
  try {
    return window.localStorage.getItem(SESSION_VIEW_STORAGE_KEY) === "project"
      ? "project"
      : "recent";
  } catch {
    return "recent";
  }
}

function readCollapsedProjects(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY) || "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, boolean>>(
      (next, [project, collapsed]) => {
        if (typeof collapsed === "boolean") next[project] = collapsed;
        return next;
      },
      {},
    );
  } catch {
    return {};
  }
}

function readSessionPageSize(): number {
  if (typeof window === "undefined") return SESSION_PAGE_SIZE;
  try {
    const value = Number(window.localStorage.getItem(SESSION_PAGE_SIZE_STORAGE_KEY));
    return SESSION_PAGE_SIZE_OPTIONS.includes(value as (typeof SESSION_PAGE_SIZE_OPTIONS)[number])
      ? value
      : SESSION_PAGE_SIZE;
  } catch {
    return SESSION_PAGE_SIZE;
  }
}

function formatSessionTime(value?: string): string {
  if (!value) return "未知时间";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(timestamp));
}

function formatSessionDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function messageRoleLabel(message: SessionMessage): string {
  return message.role === "user" ? "你" : "助手";
}

function messagePreview(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function messageCountLabel(value?: number): string {
  if (!Number.isFinite(value) || !value) return "暂无消息";
  return `${value} 条消息`;
}

function groupSessions(
  sessions: SessionItem[],
  projects: SessionProjectGroup[],
): SessionGroup[] {
  const projectLabels = new Map(projects.map((item) => [item.project, item.label]));
  const groups = new Map<string, SessionGroup>();

  for (const session of sessions) {
    const current = groups.get(session.project) || {
      project: session.project,
      label: projectLabels.get(session.project) || session.projectLabel,
      sessions: [],
    };
    current.sessions.push(session);
    groups.set(session.project, current);
  }

  return [...groups.values()].sort((a, b) => {
    const aUpdated = a.sessions[0]?.updatedAt || "";
    const bUpdated = b.sessions[0]?.updatedAt || "";
    return bUpdated.localeCompare(aUpdated) || a.label.localeCompare(b.label, "zh-CN");
  });
}

export function SessionsPage() {
  const api = useMemo(() => getApi(), []);
  const { confirm, ConfirmDialog } = useConfirm();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [projects, setProjects] = useState<SessionProjectGroup[]>([]);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readSessionPageSize);
  const [totalMatched, setTotalMatched] = useState(0);
  const [viewMode, setViewMode] = useState<SessionViewMode>(readSessionViewMode);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(readCollapsedProjects);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearingEmpty, setClearingEmpty] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [markedIds, setMarkedIds] = useState<Record<string, boolean>>({});
  const deferredQuery = useDeferredValue(query);
  const detailCache = useRef(new Map<string, SessionDetail>());
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const hasLoadedList = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const messageNodes = useRef(new Map<string, HTMLElement>());
  const activeTimer = useRef<number | undefined>();

  const refresh = useCallback(async (force = false) => {
    const requestId = ++listRequest.current;
    const showRefreshFeedback = hasLoadedList.current;
    const startedAt = performance.now();
    if (showRefreshFeedback) setRefreshing(true);
    else setListLoading(true);

    if (force) {
      detailCache.current.clear();
      detailRequest.current += 1;
      setDetail(null);
      setDetailError(null);
      if (selectedIdRef.current) setDetailReload((current) => current + 1);
    }

    try {
      const result = await api.listSessions({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        q: deferredQuery.trim() || undefined,
        project: project === "all" ? undefined : project,
        view: viewMode,
        refresh: force,
      });
      if (requestId !== listRequest.current) return;

      const nextSessions = result.items || [];
      const nextTotal = result.totalMatched ?? nextSessions.length;
      const effectivePageSize = result.limit || pageSize;
      const effectivePage = Math.floor((result.offset || 0) / effectivePageSize) + 1;
      if (page !== effectivePage) setPage(effectivePage);

      setSessions(nextSessions);
      setProjects(result.projects || []);
      setTotalMatched(nextTotal);
      setMarkedIds((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([id, checked]) => checked && nextSessions.some((item) => item.id === id),
          ),
        ),
      );
      setSelectedId((current) =>
        nextSessions.some((item) => item.id === current) ? current : nextSessions[0]?.id || null,
      );
    } catch (error) {
      if (requestId === listRequest.current) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === listRequest.current) {
        const minimumVisualDuration = showRefreshFeedback ? 300 : 240;
        const remaining = minimumVisualDuration - (performance.now() - startedAt);
        if (remaining > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
        }
        if (requestId !== listRequest.current) return;
        hasLoadedList.current = true;
        setListLoading(false);
        setRefreshing(false);
      }
    }
  }, [api, deferredQuery, page, pageSize, project, viewMode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_VIEW_STORAGE_KEY, viewMode);
    } catch {
      // Preference persistence is optional.
    }
  }, [viewMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedProjects));
    } catch {
      // Preference persistence is optional.
    }
  }, [collapsedProjects]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_PAGE_SIZE_STORAGE_KEY, String(pageSize));
    } catch {
      // Preference persistence is optional.
    }
  }, [pageSize]);

  const groupedSessions = useMemo(
    () => groupSessions(sessions, projects),
    [sessions, projects],
  );

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      messageNodes.current.clear();
      return;
    }

    const requestId = ++detailRequest.current;
    const cached = detailCache.current.get(selectedId);
    if (cached) {
      setDetail(cached);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    messageNodes.current.clear();
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void api
      .readSession(selectedId)
      .then((next) => {
        if (cancelled || requestId !== detailRequest.current) return;
        detailCache.current.set(selectedId, next);
        setDetail(next);
      })
      .catch((error) => {
        if (cancelled || requestId !== detailRequest.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setDetailError(message || "读取会话失败");
        toast.error(message || "读取会话失败");
      })
      .finally(() => {
        if (!cancelled && requestId === detailRequest.current) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, detailReload, selectedId]);

  useEffect(
    () => () => {
      if (activeTimer.current) window.clearTimeout(activeTimer.current);
    },
    [],
  );

  const activeDetail = detail?.session.id === selectedId ? detail : null;
  const selectedSession =
    activeDetail?.session || sessions.find((session) => session.id === selectedId) || null;
  const allSessionCount = projects.reduce((count, item) => count + item.count, 0);
  const markedCount = Object.values(markedIds).filter(Boolean).length;
  const pageSessionIds = useMemo(() => sessions.map((session) => session.id), [sessions]);
  const isCurrentPageFullyMarked =
    pageSessionIds.length > 0 && pageSessionIds.every((id) => Boolean(markedIds[id]));
  const tocMessages = activeDetail?.messages.filter((message) => message.role === "user") || [];

  const toggleMarked = (id: string, checked: boolean) => {
    setMarkedIds((current) => {
      const next = { ...current };
      if (checked) next[id] = true;
      else delete next[id];
      return next;
    });
  };

  const toggleSelectionMode = () => {
    setSelectionMode((current) => !current);
    setMarkedIds({});
  };

  const toggleCurrentPageSelection = () => {
    if (!pageSessionIds.length) return;

    setMarkedIds((current) => {
      const next = { ...current };
      const allMarked = pageSessionIds.every((id) => Boolean(current[id]));

      for (const id of pageSessionIds) {
        if (allMarked) delete next[id];
        else next[id] = true;
      }

      return next;
    });
  };

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((current) => ({
      ...current,
      [projectId]: current[projectId] !== false ? false : true,
    }));
  };

  const changeViewMode = (nextViewMode: SessionViewMode) => {
    if (nextViewMode === viewMode) return;
    setViewMode(nextViewMode);
    setPage(1);
    setMarkedIds({});
  };

  const selectSession = (id: string) => {
    if (id === selectedId) return;
    const cached = detailCache.current.get(id);
    detailRequest.current += 1;
    messageNodes.current.clear();
    setActiveMessageId(null);
    setDetail(cached || null);
    setDetailError(null);
    setDetailLoading(!cached);
    setSelectedId(id);
  };

  const retryDetail = () => {
    if (!selectedId) return;
    detailCache.current.delete(selectedId);
    setDetailReload((current) => current + 1);
  };

  const removeSessions = async (ids: string[]) => {
    if (!ids.length) return;
    const deletingCurrent = ids.includes(selectedId || "");
    const currentIndex = sessions.findIndex((session) => session.id === selectedId);
    const following = sessions.slice(Math.max(0, currentIndex + 1)).find((session) => !ids.includes(session.id));
    const fallback = deletingCurrent
      ? following || sessions.find((session) => !ids.includes(session.id))
      : null;
    const confirmed = await confirm({
      title: ids.length === 1 ? "删除此会话" : `删除 ${ids.length} 个会话`,
      description: "会话目录及其中的全部文件会一并删除，且无法恢复。",
      confirmText: "删除",
      danger: true,
    });
    if (!confirmed) return;

    setRefreshing(true);
    try {
      const result = await api.removeSessions(ids);
      if (result.failed.length) {
        toast.error(`已删除 ${result.removed.length} 个会话，${result.failed.length} 个未完成`);
      } else {
        toast.success(ids.length === 1 ? "会话已删除" : `已删除 ${result.removed.length} 个会话`);
      }
      detailCache.current.clear();
      messageNodes.current.clear();
      setMarkedIds({});
      setTocOpen(false);
      setDetail(null);
      setDetailError(null);
      setSelectedId(fallback?.id || null);
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const clearEmptySessions = async () => {
    const confirmed = await confirm({
      title: "清理空会话",
      description: "没有对话记录的会话目录及其中全部文件会被删除，且无法恢复。",
      confirmText: "清理",
      danger: true,
    });
    if (!confirmed) return;

    setClearingEmpty(true);
    setRefreshing(true);
    try {
      const result = await api.clearEmptySessions();
      if (result.failed.length) {
        toast.error(
          `已清理 ${result.removed.length} 个空会话，${result.failed.length} 个未完成`,
        );
      } else if (!result.emptyFound) {
        toast.info("没有可清理的空会话");
      } else {
        toast.success(`已清理 ${result.removed.length} 个空会话及其文件`);
      }

      detailCache.current.clear();
      messageNodes.current.clear();
      setMarkedIds({});
      setTocOpen(false);
      setDetail(null);
      setDetailError(null);
      setSelectedId((current) => (current && result.removed.includes(current) ? null : current));
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setClearingEmpty(false);
      setRefreshing(false);
    }
  };

  const jumpToMessage = (messageId: string) => {
    setTocOpen(false);
    setActiveMessageId(messageId);
    window.setTimeout(() => {
      const node = messageNodes.current.get(messageId);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      if (activeTimer.current) window.clearTimeout(activeTimer.current);
      activeTimer.current = window.setTimeout(() => setActiveMessageId(null), 1300);
    }, 120);
  };

  const renderSessionRow = (session: SessionItem, index: number) => {
    const selected = session.id === selectedId;
    const shouldAnimate = index < 6;
    return (
      <article
        className={cn("sessions-workspace__session-row", shouldAnimate && "workspace-list-enter", selected && "is-selected")}
        key={session.id}
        style={shouldAnimate ? { animationDelay: `${index * 45}ms` } : undefined}
      >
        {selectionMode ? (
          <label className="sessions-workspace__row-check" onClick={(event) => event.stopPropagation()}>
            <input
              className="sessions-workspace__row-check-input"
              type="checkbox"
              checked={Boolean(markedIds[session.id])}
              onChange={(event) => toggleMarked(session.id, event.target.checked)}
              aria-label={`选择 ${session.title}`}
            />
            <span className="sessions-workspace__row-check-control" aria-hidden="true">
              <Check />
            </span>
          </label>
        ) : null}
        <button
          type="button"
          className="sessions-workspace__session-select"
          onClick={() => selectSession(session.id)}
          aria-current={selected ? "page" : undefined}
        >
          <span className="sessions-workspace__session-title" title={session.title}>{session.title}</span>
          <span className="sessions-workspace__session-meta">
            <time dateTime={session.updatedAt}>
              <Clock3 aria-hidden="true" /> {formatSessionTime(session.updatedAt)}
            </time>
            <span>
              <Folder aria-hidden="true" /> {session.projectLabel}
            </span>
          </span>
          <span className="sessions-workspace__session-bottom">
            {session.preview ? <span className="sessions-workspace__session-preview">{session.preview}</span> : <span />}
            <small>{messageCountLabel(session.messageCount)}</small>
          </span>
        </button>
        <ChevronRight className="sessions-workspace__session-arrow" aria-hidden="true" />
      </article>
    );
  };

  const renderSessionCollection = () => {
    if (viewMode === "recent") {
      return sessions.map(renderSessionRow);
    }

    return groupedSessions.map((group) => {
      const isCollapsed = collapsedProjects[group.project] !== false;
      const rows = isCollapsed
        ? null
        : group.sessions.map(renderSessionRow);

      return (
        <section className={cn("sessions-workspace__group", isCollapsed && "is-collapsed")} key={group.project}>
          <button
            type="button"
            className="sessions-workspace__group-head"
            onClick={() => toggleProject(group.project)}
            aria-expanded={!isCollapsed}
          >
            <span className="sessions-workspace__group-label">
              <Folder aria-hidden="true" />
              <strong title={group.label}>{group.label}</strong>
            </span>
            <span className="sessions-workspace__group-count">{group.sessions.length}</span>
            <ChevronDown aria-hidden="true" />
          </button>
          {rows ? <div className="sessions-workspace__group-items">{rows}</div> : null}
        </section>
      );
    });
  };

  return (
    <div className="cs-page sessions-workspace">
      {ConfirmDialog}

      <div className="sessions-workspace__layout">
        <section
          className="sessions-workspace__panel sessions-workspace__directory workspace-layer-enter"
          aria-label="会话列表"
        >
          <header className="sessions-workspace__panel-head">
            <div className="sessions-workspace__heading">
              <span className="sessions-workspace__panel-icon" aria-hidden="true">
                <MessageSquare />
              </span>
              <div>
                <h2>{viewMode === "project" ? "项目" : "会话列表"} <b>{totalMatched}</b></h2>
                <p>{viewMode === "project" ? "按项目归类" : "按最近活动排序"}</p>
              </div>
            </div>
            <div className="sessions-workspace__head-actions" data-no-drag>
              <Button
                type="button"
                variant="outline"
                className="sessions-workspace__clear-empty"
                title="清理没有对话记录的会话及其文件"
                onClick={() => void clearEmptySessions()}
                disabled={refreshing || clearingEmpty}
              >
                <Trash2 />
                清理空会话
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn("sessions-workspace__icon-button", selectionMode && "is-active")}
                title={selectionMode ? "退出多选" : "多选会话"}
                aria-label={selectionMode ? "退出多选" : "多选会话"}
                onClick={toggleSelectionMode}
              >
                <Check />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="sessions-workspace__icon-button"
                title="刷新会话"
                aria-label="刷新会话"
                onClick={() => void refresh(true)}
                disabled={refreshing}
              >
                <RefreshCw className={cn("workspace-refresh-icon", refreshing && "is-spinning")} />
              </Button>
            </div>
          </header>

          <div className="sessions-workspace__filters">
            <label className="sessions-workspace__search">
              <Search aria-hidden="true" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                  setMarkedIds({});
                }}
                placeholder="搜索会话"
                aria-label="搜索会话"
              />
            </label>
            <div className="sessions-workspace__filter-row">
              <SimpleSelect
                value={project}
                onValueChange={(value) => {
                  setProject(value);
                  setPage(1);
                  setMarkedIds({});
                }}
                className="sessions-workspace__project-select"
                options={[
                  { value: "all", label: `全部项目 (${allSessionCount})` },
                  ...projects.map((item) => ({ value: item.project, label: `${item.label} (${item.count})` })),
                ]}
              />
              <div className="sessions-workspace__view-switch" role="group" aria-label="会话显示方式">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn("sessions-workspace__view-button", viewMode === "recent" && "is-active")}
                  title="按最近活动查看"
                  aria-label="按最近活动查看"
                  aria-pressed={viewMode === "recent"}
                  onClick={() => changeViewMode("recent")}
                >
                  <List />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn("sessions-workspace__view-button", viewMode === "project" && "is-active")}
                  title="按项目分组"
                  aria-label="按项目分组"
                  aria-pressed={viewMode === "project"}
                  onClick={() => changeViewMode("project")}
                >
                  <Folder />
                </Button>
              </div>
            </div>
          </div>

          {selectionMode ? (
            <div className="sessions-workspace__bulk-bar">
              <span>已选 {markedCount} 项</span>
              <div className="sessions-workspace__bulk-actions">
                <Button
                  type="button"
                  variant="outline"
                  className="sessions-workspace__bulk-select-page"
                  aria-pressed={isCurrentPageFullyMarked}
                  onClick={toggleCurrentPageSelection}
                  disabled={!pageSessionIds.length || refreshing}
                >
                  <Check /> {isCurrentPageFullyMarked ? "取消全选" : "全选本页"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="sessions-workspace__bulk-delete"
                  onClick={() => void removeSessions(Object.keys(markedIds).filter((id) => markedIds[id]))}
                  disabled={!markedCount || refreshing}
                >
                  <Trash2 /> 删除
                </Button>
              </div>
            </div>
          ) : null}

          <nav className="sessions-workspace__session-list" aria-label="可用会话">
            {listLoading ? (
              <SessionListSkeleton />
            ) : sessions.length ? (
              renderSessionCollection()
            ) : (
              <EmptyState
                className="sessions-workspace__directory-empty"
                icon={<MessageSquare />}
                title={totalMatched ? "当前页没有会话" : allSessionCount ? "没有匹配的会话" : "暂无会话"}
                description={totalMatched ? "切换上一页或下一页继续查看。" : allSessionCount ? "调整搜索或项目筛选后再试。" : "产生新会话后会显示在这里。"}
              />
            )}
          </nav>
          {!listLoading ? (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={totalMatched}
              onChange={(nextPage) => {
                setPage(nextPage);
                setMarkedIds({});
              }}
              onPageSizeChange={(nextPageSize) => {
                if (nextPageSize === pageSize) return;
                setPageSize(nextPageSize);
                setPage(1);
                setMarkedIds({});
              }}
              pageSizeOptions={SESSION_PAGE_SIZE_OPTIONS}
              className="sessions-workspace__pagination"
            />
          ) : null}
        </section>

        <section
          className="sessions-workspace__panel sessions-workspace__detail workspace-layer-enter workspace-layer-enter--delay-1"
          aria-label="对话记录"
        >
          {selectedSession ? (
            <div
              className="sessions-workspace__detail-view"
              key={selectedSession.id}
              aria-busy={detailLoading || undefined}
            >
              <header className="sessions-workspace__detail-head">
                <div className="sessions-workspace__heading">
                  <span className="sessions-workspace__panel-icon is-violet" aria-hidden="true">
                    <MessageSquare />
                  </span>
                  <div className="sessions-workspace__detail-title-copy">
                    <h2 title={selectedSession.title}>{selectedSession.title}</h2>
                    <div className="sessions-workspace__detail-meta">
                      <span><Clock3 aria-hidden="true" /> {formatSessionDate(selectedSession.updatedAt)}</span>
                      <span><Folder aria-hidden="true" /> {selectedSession.projectLabel}</span>
                    </div>
                  </div>
                </div>
                <div className="sessions-workspace__detail-actions" data-no-drag>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="sessions-workspace__icon-button"
                    title="查看对话目录"
                    aria-label="查看对话目录"
                    onClick={() => setTocOpen(true)}
                    disabled={!tocMessages.length || detailLoading}
                  >
                    <List />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="sessions-workspace__icon-button is-danger"
                    title="删除会话"
                    aria-label="删除会话"
                    onClick={() => void removeSessions([selectedSession.id])}
                    disabled={refreshing}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </header>

              <div className="sessions-workspace__record-head">
                <div>
                  <List aria-hidden="true" />
                  <h3>对话记录</h3>
                  <b>{activeDetail?.totalMessages ?? selectedSession.messageCount ?? 0}</b>
                </div>
                {detailLoading ? <span>正在读取</span> : null}
              </div>

              <div className="sessions-workspace__message-stream" aria-live="polite">
                {detailLoading ? (
                  <SessionDetailSkeleton />
                ) : detailError ? (
                  <div className="sessions-workspace__detail-error" role="alert">
                    <MessageSquare aria-hidden="true" />
                    <div>
                      <strong>无法读取对话记录</strong>
                      <span>{detailError}</span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="sessions-workspace__icon-button"
                      title="重新读取"
                      aria-label="重新读取"
                      onClick={retryDetail}
                    >
                      <RefreshCw />
                    </Button>
                  </div>
                ) : activeDetail?.messages.length ? (
                  activeDetail.messages.map((message, index) => {
                    const shouldAnimate = index < 6;
                    return (
                      <article
                        className={cn(
                          "sessions-workspace__message",
                          shouldAnimate && "workspace-list-enter",
                          `is-${message.role}`,
                          activeMessageId === message.id && "is-active",
                        )}
                        key={message.id}
                        style={shouldAnimate ? { animationDelay: `${index * 45}ms` } : undefined}
                        ref={(node) => {
                          if (node) messageNodes.current.set(message.id, node);
                          else messageNodes.current.delete(message.id);
                        }}
                      >
                        <header>
                          <span>{messageRoleLabel(message)}</span>
                          <small>{message.index + 1}</small>
                        </header>
                        <div className="sessions-workspace__message-content">{message.text}</div>
                        {message.truncated ? <p className="sessions-workspace__message-note">内容较长，仅显示开头部分。</p> : null}
                      </article>
                    );
                  })
                ) : (
                  <EmptyState
                    className="sessions-workspace__detail-empty"
                    icon={<MessageSquare />}
                    title="暂无可显示的对话记录"
                    description="该会话没有可读取的消息。"
                  />
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              className="sessions-workspace__detail-empty"
              icon={<MessageSquare />}
              title="选择一个会话"
              description="从左侧列表选择会话后，可在这里查看对话记录。"
            />
          )}
        </section>
      </div>

      <Dialog open={tocOpen} onOpenChange={setTocOpen}>
        <DialogContent size="lg" className="sessions-workspace__toc-dialog">
          <DialogHeader>
            <DialogTitle className="sessions-workspace__toc-title"><List /> 对话目录</DialogTitle>
            <DialogDescription>当前会话</DialogDescription>
          </DialogHeader>
          <DialogBody className="sessions-workspace__toc-body">
            <ol>
              {tocMessages.map((message, index) => (
                <li key={message.id}>
                  <button type="button" onClick={() => jumpToMessage(message.id)}>
                    <span>{index + 1}</span>
                    <p>{messagePreview(message.text, 180)}</p>
                  </button>
                </li>
              ))}
            </ol>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SessionListSkeleton() {
  return (
    <div className="sessions-workspace__list-skeleton" aria-label="正在加载会话">
      {Array.from({ length: 7 }, (_, index) => <span key={index} />)}
    </div>
  );
}

function SessionDetailSkeleton() {
  return (
    <div className="sessions-workspace__detail-skeleton" aria-label="正在读取对话记录">
      {Array.from({ length: 5 }, (_, index) => <span key={index} />)}
    </div>
  );
}
