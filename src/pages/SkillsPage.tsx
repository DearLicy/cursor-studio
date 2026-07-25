import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleCheck,
  Download,
  Eye,
  GitBranch,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/app-notice";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/layout";
import { Pagination, slicePage } from "@/components/ui/pagination";
import { Switch } from "@/components/ui/switch";
import {
  type DiscoverableSkill,
  getApi,
  type SkillItem,
  type SkillListResult,
  type SkillMutationResult,
  type SkillRepo,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 9;

type Tab = "installed" | "discover" | "repos";

type ContentState = {
  skill: SkillItem;
  text: string;
};

type NewSkillForm = {
  name: string;
  description: string;
};

type RepositoryForm = {
  address: string;
  branch: string;
};

const blankNewSkill = (): NewSkillForm => ({ name: "", description: "" });
const blankRepository = (): RepositoryForm => ({ address: "", branch: "main" });

export function SkillsPage() {
  const api = useMemo(() => getApi(), []);
  const { confirm, ConfirmDialog } = useConfirm();
  const [tab, setTab] = useState<Tab>("installed");
  const [items, setItems] = useState<SkillItem[]>([]);
  const [repos, setRepos] = useState<SkillRepo[]>([]);
  const [discoverable, setDiscoverable] = useState<DiscoverableSkill[]>([]);
  const [discoverErrors, setDiscoverErrors] = useState<Array<{ repo: string; error: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [repoBusyKey, setRepoBusyKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<ContentState | null>(null);
  const [editor, setEditor] = useState<ContentState | null>(null);
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  const [newSkill, setNewSkill] = useState<NewSkillForm>(blankNewSkill());
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [repository, setRepository] = useState<RepositoryForm>(blankRepository());

  const applyList = useCallback((result: SkillListResult | SkillMutationResult) => {
    setItems(result.items || []);
    setLoadError(null);
  }, []);

  const refresh = useCallback(
    async (initial = false) => {
      const startedAt = initial ? 0 : performance.now();
      if (initial) setLoading(true);
      else setRefreshing(true);

      try {
        const [skillsResult, reposResult] = await Promise.all([
          api.listSkills(),
          api.listSkillRepos(),
        ]);
        applyList(skillsResult);
        setRepos(reposResult.repos || []);
      } catch {
        setLoadError("Skills 加载失败，请稍后重试。");
        if (!initial) toast.error("刷新失败", { description: "请稍后重试。" });
      } finally {
        if (initial) {
          setLoading(false);
        } else {
          const remaining = 280 - (performance.now() - startedAt);
          if (remaining > 0) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
          }
          setRefreshing(false);
        }
      }
    },
    [api, applyList],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const filteredInstalled = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return items;
    return items.filter((item) =>
      [item.name, item.description, skillSourceLabel(item.source), skillScopeLabel(item)]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(search)),
    );
  }, [items, query]);

  const filteredDiscover = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return discoverable;
    return discoverable.filter((skill) =>
      [skill.name, skill.description, skill.repoOwner, skill.repoName]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(search)),
    );
  }, [discoverable, query]);

  const filteredRepos = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return repos;
    return repos.filter((repo) => repositoryName(repo).toLowerCase().includes(search));
  }, [repos, query]);

  const pagedItems = tab === "installed" ? filteredInstalled : filteredDiscover;
  const pageCount = Math.max(1, Math.ceil(pagedItems.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageInstalled = slicePage(filteredInstalled, currentPage, PAGE_SIZE);
  const pageDiscover = slicePage(filteredDiscover, currentPage, PAGE_SIZE);
  const editableCount = items.filter(canEdit).length;
  const nativeBusy = creating || saving || deletingId !== null || readingId !== null;
  const repositoryBusy = discovering || installingKey !== null || repoBusyKey !== null;
  const controlsBusy = nativeBusy || repositoryBusy;

  useEffect(() => {
    setPage(1);
  }, [query, tab]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [currentPage, page]);

  const openNew = () => {
    setNewSkill(blankNewSkill());
    setNewSkillOpen(true);
  };

  const createSkill = async () => {
    const name = newSkill.name.trim();
    if (!name) {
      toast.error("请输入技能名称");
      return;
    }

    setCreating(true);
    try {
      applyList(
        await api.createSkill({
          name,
          description: newSkill.description.trim() || undefined,
        }),
      );
      setNewSkillOpen(false);
      toast.success("技能已创建", { description: "已添加到所有项目。" });
    } catch {
      toast.error("创建失败", { description: "请检查名称后重试。" });
    } finally {
      setCreating(false);
    }
  };

  const readSkill = async (skill: SkillItem, target: "preview" | "editor") => {
    if (target === "editor" && !canEdit(skill)) return;

    setReadingId(skill.id);
    try {
      const result = await api.readSkill(skill.path, 120_000);
      const content = { skill, text: result.text };
      if (target === "preview") setPreview(content);
      else setEditor(content);
    } catch {
      toast.error("内容读取失败", { description: "请稍后重试。" });
    } finally {
      setReadingId(null);
    }
  };

  const saveSkill = async () => {
    if (!editor) return;
    if (!editor.text.trim()) {
      toast.error("技能内容不能为空");
      return;
    }

    setSaving(true);
    try {
      applyList(await api.updateSkillContent(editor.skill.path, editor.text));
      setEditor(null);
      toast.success("技能已保存");
    } catch {
      toast.error("保存失败", { description: "请稍后重试。" });
    } finally {
      setSaving(false);
    }
  };

  const removeSkill = async (skill: SkillItem) => {
    if (!canDelete(skill)) return;

    const accepted = await confirm({
      title: `删除「${skill.name}」？`,
      description: "删除前会保留一份备份，删除后该技能将不再可用。",
      confirmText: "删除",
      danger: true,
    });
    if (!accepted) return;

    setDeletingId(skill.id);
    try {
      applyList(await api.removeSkill(skill.path));
      if (preview?.skill.id === skill.id) setPreview(null);
      if (editor?.skill.id === skill.id) setEditor(null);
      toast.success("技能已删除");
    } catch {
      toast.error("删除失败", { description: "请稍后重试。" });
    } finally {
      setDeletingId(null);
    }
  };

  const discoverSkills = async () => {
    setDiscovering(true);
    try {
      const result = await api.discoverSkills();
      setDiscoverable(result.items || []);
      setDiscoverErrors(result.errors || []);
      setTab("discover");
      toast.success("可导入内容已刷新", {
        description: `发现 ${result.items?.length || 0} 个可导入技能。`,
      });
    } catch {
      toast.error("刷新失败", { description: "请稍后重试。" });
    } finally {
      setDiscovering(false);
    }
  };

  const importSkill = async (skill: DiscoverableSkill) => {
    setInstallingKey(skill.key);
    try {
      const result = await api.installSkill(skill);
      applyList(result.installed);
      setDiscoverable((current) =>
        current.map((item) =>
          item.key === skill.key
            ? { ...item, installed: true, managed: true, updateAvailable: false }
            : item,
        ),
      );
      toast.success(skill.updateAvailable ? "技能已更新" : "技能已导入");
    } catch {
      toast.error("导入失败", { description: "请稍后重试。" });
    } finally {
      setInstallingKey(null);
    }
  };

  const openRepository = () => {
    setRepository(blankRepository());
    setRepositoryOpen(true);
  };

  const addRepository = async () => {
    const parsed = parseRepository(repository.address);
    if (!parsed) {
      toast.error("请输入 GitHub 仓库地址");
      return;
    }

    setRepoBusyKey("new-repository");
    try {
      const result = await api.addSkillRepo({
        owner: parsed.owner,
        name: parsed.name,
        branch: repository.branch.trim() || "main",
        enabled: true,
      });
      setRepos(result.repos || []);
      setRepositoryOpen(false);
      toast.success("来源已添加");
    } catch {
      toast.error("添加失败", { description: "请检查地址后重试。" });
    } finally {
      setRepoBusyKey(null);
    }
  };

  const removeRepository = async (repo: SkillRepo) => {
    const accepted = await confirm({
      title: `移除「${repositoryName(repo)}」？`,
      description: "已导入的技能会继续保留。",
      confirmText: "移除",
      danger: true,
    });
    if (!accepted) return;

    const key = repositoryKey(repo);
    setRepoBusyKey(key);
    try {
      const result = await api.removeSkillRepo(repo.owner, repo.name);
      setRepos(result.repos || []);
      toast.success("来源已移除");
    } catch {
      toast.error("移除失败", { description: "请稍后重试。" });
    } finally {
      setRepoBusyKey(null);
    }
  };

  const updateRepositoryAvailability = async (repo: SkillRepo, enabled: boolean) => {
    const key = repositoryKey(repo);
    setRepoBusyKey(key);
    try {
      const result = await api.addSkillRepo({
        owner: repo.owner,
        name: repo.name,
        branch: repo.branch,
        enabled,
      });
      setRepos(result.repos || []);
      toast.success(enabled ? "来源已用于查找" : "来源已暂停查找");
    } catch {
      toast.error("设置更新失败", { description: "请稍后重试。" });
    } finally {
      setRepoBusyKey(null);
    }
  };

  return (
    <div className="cs-page tools-workspace skills-workspace">
      {ConfirmDialog}

      <header className="tools-workspace__toolbar workspace-layer-enter">
        <div className="tools-workspace__context">
          <span className="tools-workspace__context-icon" aria-hidden="true">
            <Sparkles />
          </span>
          <div className="tools-workspace__context-copy">
            <h1>Skills</h1>
            <p>管理 Cursor 可识别的常用能力</p>
          </div>
        </div>

        <div className="tools-workspace__actions" data-no-drag>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="tools-workspace__icon-action"
            title="刷新 Skills"
            aria-label="刷新 Skills"
            onClick={() => void refresh()}
            disabled={loading || refreshing || controlsBusy}
          >
            <RefreshCw className={cn("workspace-refresh-icon", refreshing && "is-spinning animate-spin")} />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="tools-workspace__text-action"
            onClick={() => void discoverSkills()}
            disabled={loading || controlsBusy}
          >
            <Download className={cn("workspace-refresh-icon", discovering && "is-spinning animate-spin")} />
            查找可导入技能
          </Button>
          <Button
            type="button"
            variant="outline"
            className="tools-workspace__text-action"
            onClick={openRepository}
            disabled={controlsBusy}
          >
            <GitBranch />
            添加来源
          </Button>
          <Button
            type="button"
            className="tools-workspace__primary-action"
            onClick={openNew}
            disabled={controlsBusy}
          >
            <Plus />
            新增技能
          </Button>
        </div>
      </header>

      {loading ? (
        <section className="tools-workspace__skeleton-grid workspace-layer-enter workspace-layer-enter--delay-1" aria-label="正在加载 Skills">
          {Array.from({ length: 6 }, (_, index) => <div className="tools-workspace__skeleton" key={index} />)}
        </section>
      ) : loadError ? (
        <section className="tools-workspace__error workspace-layer-enter workspace-layer-enter--delay-1" role="alert">
          <CircleAlert aria-hidden="true" />
          <strong>Skills 加载失败</strong>
          <p>{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="tools-workspace__text-action" onClick={() => void refresh()}>
            重试
          </Button>
        </section>
      ) : (
        <>
          <section className="tools-workspace__control-panel workspace-layer-enter workspace-layer-enter--delay-1" aria-label="Skills 筛选">
            <div className="tools-workspace__tabs" role="tablist" aria-label="Skills 视图">
              {[
                { id: "installed" as const, label: "已有技能", icon: Sparkles, count: items.length },
                { id: "discover" as const, label: "可导入", icon: Download, count: discoverable.length },
                { id: "repos" as const, label: "来源管理", icon: GitBranch, count: repos.length },
              ].map((view) => (
                <button
                  key={view.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === view.id}
                  className={cn("tools-workspace__tab", tab === view.id && "is-active")}
                  onClick={() => setTab(view.id)}
                >
                  <view.icon />
                  {view.label}
                  <span className="tools-workspace__tab-count">{view.count}</span>
                </button>
              ))}
            </div>
            <div className="tools-workspace__control-grid">
              <label className="tools-workspace__field skills-workspace__search-field">
                <span className="tools-workspace__field-label">搜索</span>
                <span className="tools-workspace__search">
                  <Search aria-hidden="true" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={tab === "repos" ? "搜索来源" : tab === "discover" ? "搜索可导入技能" : "搜索名称、说明或使用范围"}
                    aria-label="搜索 Skills"
                  />
                </span>
              </label>
            </div>
            <div className="tools-workspace__summary">
              <SlidersHorizontal aria-hidden="true" />
              {tab === "installed" ? (
                <span>已有 <strong>{items.length}</strong> 个技能，其中 <strong>{editableCount}</strong> 个可管理。</span>
              ) : tab === "discover" ? (
                <span>已发现 <strong>{discoverable.length}</strong> 个可导入技能。</span>
              ) : (
                <span>已添加 <strong>{repos.length}</strong> 个查找来源。</span>
              )}
            </div>
          </section>

          {tab === "installed" ? (
            filteredInstalled.length ? (
              <>
                <section className="tools-workspace__grid workspace-layer-enter workspace-layer-enter--delay-2" aria-label="Skills 列表">
                  {pageInstalled.map((skill, index) => {
                    const status = skillStatus(skill);
                    const itemBusy = readingId === skill.id || deletingId === skill.id || (saving && editor?.skill.id === skill.id);
                    return (
                      <article
                        key={skill.id}
                        className={cn("tools-workspace__card", status.className)}
                        style={{ animationDelay: `${80 + Math.min(index, 4) * 40}ms` }}
                      >
                        <div className="tools-workspace__card-head">
                          <div className="tools-workspace__identity">
                            <span className="tools-workspace__icon is-skill" aria-hidden="true"><Sparkles /></span>
                            <div className="tools-workspace__title-wrap">
                              <strong className="tools-workspace__title" title={skill.name}>{skill.name}</strong>
                              <span className="tools-workspace__meta">{skillMeta(skill)}</span>
                            </div>
                          </div>
                          <span className={cn("tools-workspace__status", status.className)}>{status.label}</span>
                        </div>

                        <p className="tools-workspace__preview">{skill.description?.trim() || "尚未填写说明。"}</p>
                        {skill.hasSkillMd ? (
                          <div className="tools-workspace__current">
                            <CheckCircle2 aria-hidden="true" />
                            {skillScopeLabel(skill)}可用
                          </div>
                        ) : null}

                        <footer className="tools-workspace__card-footer">
                          <div className="tools-workspace__card-actions">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="tools-workspace__card-action"
                              onClick={() => void readSkill(skill, "preview")}
                              disabled={nativeBusy || itemBusy}
                            >
                              <Eye />
                              {readingId === skill.id ? "读取中" : "查看"}
                            </Button>
                            {canEdit(skill) ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="tools-workspace__card-action"
                                onClick={() => void readSkill(skill, "editor")}
                                disabled={nativeBusy || itemBusy}
                              >
                                <Pencil />
                                管理
                              </Button>
                            ) : null}
                          </div>
                          {canDelete(skill) ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="tools-workspace__card-action tools-workspace__card-icon-action is-danger"
                              title={`删除 ${skill.name}`}
                              aria-label={`删除 ${skill.name}`}
                              onClick={() => void removeSkill(skill)}
                              disabled={nativeBusy || itemBusy}
                            >
                              <Trash2 />
                            </Button>
                          ) : null}
                        </footer>
                      </article>
                    );
                  })}
                </section>
                <Pagination
                  className="tools-workspace__pagination workspace-layer-enter workspace-layer-enter--delay-3"
                  page={currentPage}
                  pageSize={PAGE_SIZE}
                  total={filteredInstalled.length}
                  onChange={setPage}
                />
              </>
            ) : (
              <EmptyView
                icon={<Sparkles />}
                title={query ? "没有匹配的技能" : "还没有可用技能"}
                description={query ? "调整关键词后再试。" : "新增技能后，可以在这里统一查看和管理。"}
                action={query ? () => setQuery("") : openNew}
                actionLabel={query ? "清除搜索" : "新增技能"}
              />
            )
          ) : null}

          {tab === "discover" ? (
            <>
              {discoverErrors.length ? (
                <div className="tools-workspace__banner workspace-layer-enter workspace-layer-enter--delay-2">
                  <AlertTriangle aria-hidden="true" />
                  有 {discoverErrors.length} 个来源暂时无法获取内容，稍后可再次刷新。
                </div>
              ) : null}
              {filteredDiscover.length ? (
                <>
                  <section className="tools-workspace__grid workspace-layer-enter workspace-layer-enter--delay-2" aria-label="可导入 Skills">
                    {pageDiscover.map((skill, index) => {
                      const status = discoverStatus(skill);
                      const importing = installingKey === skill.key;
                      const action = discoverAction(skill);
                      return (
                        <article
                          key={skill.key}
                          className={cn("tools-workspace__card", status.className)}
                          style={{ animationDelay: `${80 + Math.min(index, 4) * 40}ms` }}
                        >
                          <div className="tools-workspace__card-head">
                            <div className="tools-workspace__identity">
                              <span className="tools-workspace__icon is-skill" aria-hidden="true"><Download /></span>
                              <div className="tools-workspace__title-wrap">
                                <strong className="tools-workspace__title" title={skill.name}>{skill.name}</strong>
                                <span className="tools-workspace__meta">来自 {skill.repoName}</span>
                              </div>
                            </div>
                            <span className={cn("tools-workspace__status", status.className)}>{status.label}</span>
                          </div>
                          <p className="tools-workspace__preview">{skill.description?.trim() || "尚未填写说明。"}</p>
                          {skill.managed && !skill.updateAvailable ? (
                            <div className="tools-workspace__current"><CheckCircle2 aria-hidden="true" /> 当前已是最新内容</div>
                          ) : null}
                          <footer className="tools-workspace__card-footer">
                            <div className="tools-workspace__card-actions">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className={cn("tools-workspace__card-action", action.tone === "danger" && "is-danger")}
                                title={action.title}
                                disabled={controlsBusy || action.disabled}
                                onClick={() => { if (!action.disabled) void importSkill(skill); }}
                              >
                                <action.icon className={cn("workspace-refresh-icon", importing && "is-spinning animate-spin")} />
                                {importing ? "导入中" : action.label}
                              </Button>
                            </div>
                          </footer>
                        </article>
                      );
                    })}
                  </section>
                  <Pagination
                    className="tools-workspace__pagination workspace-layer-enter workspace-layer-enter--delay-3"
                    page={currentPage}
                    pageSize={PAGE_SIZE}
                    total={filteredDiscover.length}
                    onChange={setPage}
                  />
                </>
              ) : (
                <EmptyView
                  icon={<Download />}
                  title={query ? "没有匹配的可导入技能" : "还没有发现可导入技能"}
                  description={query ? "调整关键词后再试。" : "添加来源后，刷新即可查看可导入的技能。"}
                  action={query ? () => setQuery("") : () => void discoverSkills()}
                  actionLabel={query ? "清除搜索" : "刷新发现"}
                />
              )}
            </>
          ) : null}

          {tab === "repos" ? (
            filteredRepos.length ? (
              <section className="tools-workspace__repo-list workspace-layer-enter workspace-layer-enter--delay-2" aria-label="技能来源">
                {filteredRepos.map((repo, index) => {
                  const key = repositoryKey(repo);
                  const itemBusy = repoBusyKey === key;
                  return (
                    <article className="tools-workspace__repo-card" key={key} style={{ animationDelay: `${80 + Math.min(index, 4) * 40}ms` }}>
                      <span className="tools-workspace__icon is-repo" aria-hidden="true"><GitBranch /></span>
                      <div className="tools-workspace__repo-copy">
                        <strong>{repositoryName(repo)}</strong>
                        <span>{repo.enabled ? "用于查找可导入技能" : "暂不参与查找"}</span>
                      </div>
                      <div className="tools-workspace__repo-state">
                        <span>{repo.enabled ? "已启用" : "已暂停"}</span>
                        <Switch
                          checked={repo.enabled}
                          onCheckedChange={(value) => void updateRepositoryAvailability(repo, value)}
                          disabled={controlsBusy || itemBusy}
                          aria-label={`${repo.enabled ? "暂停" : "启用"} ${repositoryName(repo)}`}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="tools-workspace__card-action tools-workspace__card-icon-action is-danger"
                          title={`移除 ${repositoryName(repo)}`}
                          aria-label={`移除 ${repositoryName(repo)}`}
                          disabled={controlsBusy || itemBusy}
                          onClick={() => void removeRepository(repo)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </section>
            ) : (
              <EmptyView
                icon={<GitBranch />}
                title={query ? "没有匹配的来源" : "还没有查找来源"}
                description={query ? "调整关键词后再试。" : "添加来源后，即可查找并导入新的技能。"}
                action={query ? () => setQuery("") : openRepository}
                actionLabel={query ? "清除搜索" : "添加来源"}
              />
            )
          ) : null}
        </>
      )}

      <Dialog open={newSkillOpen} onOpenChange={(open) => { if (!open && !creating) setNewSkillOpen(false); }}>
        <DialogContent className="tools-workspace__dialog" size="md">
          <DialogHeader>
            <DialogTitle>新增技能</DialogTitle>
            <DialogDescription>新建后可在所有项目中使用，也可以随时回来完善内容。</DialogDescription>
          </DialogHeader>
          <DialogBody className="tools-workspace__dialog-body">
            <div className="tools-workspace__dialog-fields">
              <Field label="名称">
                <Input
                  value={newSkill.name}
                  onChange={(event) => setNewSkill((current) => ({ ...current, name: event.target.value }))}
                  placeholder="例如：项目规范"
                  autoFocus
                />
              </Field>
              <Field label="说明">
                <Input
                  value={newSkill.description}
                  onChange={(event) => setNewSkill((current) => ({ ...current, description: event.target.value }))}
                  placeholder="简要说明它适合处理什么内容"
                />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewSkillOpen(false)} disabled={creating}>取消</Button>
            <Button type="button" className="tools-workspace__dialog-save" onClick={() => void createSkill()} disabled={creating}>
              <Plus />
              {creating ? "创建中" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={repositoryOpen} onOpenChange={(open) => { if (!open && repoBusyKey !== "new-repository") setRepositoryOpen(false); }}>
        <DialogContent className="tools-workspace__dialog" size="md">
          <DialogHeader>
            <DialogTitle>添加查找来源</DialogTitle>
            <DialogDescription>填写 GitHub 仓库地址后，即可发现其中可导入的技能。</DialogDescription>
          </DialogHeader>
          <DialogBody className="tools-workspace__dialog-body">
            <div className="tools-workspace__dialog-fields">
              <Field label="GitHub 仓库地址">
                <Input
                  value={repository.address}
                  onChange={(event) => setRepository((current) => ({ ...current, address: event.target.value }))}
                  placeholder="例如：团队/项目 或 GitHub 地址"
                  autoFocus
                />
              </Field>
              <Field label="分支">
                <Input
                  value={repository.branch}
                  onChange={(event) => setRepository((current) => ({ ...current, branch: event.target.value }))}
                  placeholder="main"
                />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRepositoryOpen(false)} disabled={repoBusyKey === "new-repository"}>取消</Button>
            <Button type="button" className="tools-workspace__dialog-save" onClick={() => void addRepository()} disabled={repoBusyKey === "new-repository"}>
              <Plus />
              {repoBusyKey === "new-repository" ? "添加中" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editor)} onOpenChange={(open) => { if (!open && !saving) setEditor(null); }}>
        <DialogContent className="tools-workspace__dialog" size="lg">
          <DialogHeader>
            <DialogTitle>{editor ? `管理「${editor.skill.name}」` : "管理技能"}</DialogTitle>
            <DialogDescription>修改内容后会立即保存到这项技能。</DialogDescription>
          </DialogHeader>
          <DialogBody className="tools-workspace__dialog-body">
            <Field label="内容">
              <Textarea
                className="tools-workspace__editor"
                value={editor?.text || ""}
                onChange={(event) => setEditor((current) => current ? { ...current, text: event.target.value } : current)}
                spellCheck={false}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditor(null)} disabled={saving}>取消</Button>
            <Button type="button" className="tools-workspace__dialog-save" onClick={() => void saveSkill()} disabled={saving}>
              <Save />
              {saving ? "保存中" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="tools-workspace__dialog" size="lg">
          <DialogHeader>
            <DialogTitle>{preview?.skill.name}</DialogTitle>
            <DialogDescription>{preview ? skillMeta(preview.skill) : ""}</DialogDescription>
          </DialogHeader>
          <DialogBody className="tools-workspace__dialog-body">
            <pre className="tools-workspace__preview-content">{preview?.text || "暂无内容"}</pre>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreview(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyView({ icon, title, description, action, actionLabel }: {
  icon: ReactNode;
  title: string;
  description: string;
  action: () => void;
  actionLabel: string;
}) {
  return (
    <section className="tools-workspace__empty workspace-layer-enter workspace-layer-enter--delay-2">
      {icon}
      <strong>{title}</strong>
      <p>{description}</p>
      <Button type="button" variant="outline" size="sm" className="tools-workspace__text-action" onClick={action}>{actionLabel}</Button>
    </section>
  );
}

function canEdit(skill: SkillItem) {
  return skill.writable === true;
}

function canDelete(skill: SkillItem) {
  return canEdit(skill);
}

function skillSourceLabel(source: string) {
  const value = source.toLowerCase();
  if (value.includes("cloud")) return "已同步技能";
  if (value.includes("cursor") || value.includes("plugin") || value.includes("skills-cursor")) return "内置技能";
  return "个人技能";
}

function skillScopeLabel(skill: SkillItem) {
  const scope = String(skill.scope || "").toLowerCase();
  if (scope.includes("workspace") || scope.includes("project") || skill.workspacePath) return "当前项目";
  return "所有项目";
}

function skillMeta(skill: SkillItem) {
  return `${skillSourceLabel(skill.source)} · ${skillScopeLabel(skill)}`;
}

function skillStatus(skill: SkillItem) {
  if (!skill.hasSkillMd) return { label: "待完善", className: "is-neutral" };
  if (canEdit(skill)) return { label: "可管理", className: "is-success" };
  return { label: "可查看", className: "is-neutral" };
}

function discoverStatus(skill: DiscoverableSkill) {
  if (!skill.installed) return { label: "可导入", className: "is-neutral" };
  if (skill.managed && skill.updateAvailable) return { label: "可更新", className: "is-success" };
  if (skill.managed) return { label: "已最新", className: "is-success" };
  return { label: "需要处理", className: "is-danger" };
}

function discoverAction(skill: DiscoverableSkill) {
  if (!skill.installed) return { label: "导入", icon: Download, disabled: false, tone: "default", title: "导入此技能" };
  if (skill.updateAvailable) return { label: "更新", icon: RefreshCw, disabled: false, tone: "default", title: "更新此技能" };
  if (skill.managed) return { label: "已最新", icon: CircleCheck, disabled: true, tone: "default", title: "当前已是最新内容" };
  return { label: "同名项", icon: AlertTriangle, disabled: true, tone: "danger", title: "已有同名技能，不会覆盖" };
}

function repositoryName(repo: SkillRepo) {
  return `${repo.owner}/${repo.name}`;
}

function repositoryKey(repo: SkillRepo) {
  return `${repo.owner}/${repo.name}`;
}

function parseRepository(value: string): { owner: string; name: string } | null {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const [owner, name] = normalized.split("/");
  return owner && name ? { owner, name } : null;
}
