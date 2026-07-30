import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
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
import { Field, StatusBanner } from "@/components/ui/layout";
import { SimpleSelect } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  getApi,
  type PromptInjectionMode,
  type PromptItem,
  type PromptsListResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { RawText } from "@/lib/i18n-raw";

type FormState = {
  id?: string;
  title: string;
  filename: string;
  description: string;
  content: string;
  profileIds?: string[];
};

type EditorKind = "new" | "edit" | "copy";

const blankForm = (): FormState => ({
  title: "",
  filename: "",
  description: "",
  content: "",
});

export function PromptsPage() {
  const api = useMemo(() => getApi(), []);
  const { confirm, ConfirmDialog } = useConfirm();
  const [data, setData] = useState<PromptsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(false);
  const [editorKind, setEditorKind] = useState<EditorKind>("new");
  const [form, setForm] = useState<FormState>(blankForm());
  const [preview, setPreview] = useState<PromptItem | null>(null);

  const refresh = useCallback(
    async (initial = false) => {
      const startedAt = initial ? 0 : performance.now();
      if (initial) setLoading(true);
      else setRefreshing(true);

      try {
        setLoadError(null);
        setData(await api.listPrompts());
      } catch {
        setLoadError("提示词加载失败，请稍后重试。");
        if (!initial) {
          toast.error("刷新失败", { description: "请稍后重试。" });
        }
      } finally {
        if (initial) {
          setLoading(false);
        } else {
          const remaining = 300 - (performance.now() - startedAt);
          if (remaining > 0) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
          }
          setRefreshing(false);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const items = data?.state.items || [];
  const mode = data?.state.injectionMode || "append";
  const master = data?.state.masterEnabled === true;
  const selectedCount = items.filter((item) => item.enabled).length;
  const filtered = useMemo(() => {
    const search = q.trim().toLowerCase();
    if (!search) return items;
    return items.filter((item) => {
      return [item.title, item.description, item.scene]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(search));
    });
  }, [items, q]);

  const applyResult = (result: PromptsListResult) => {
    setData(result);
    setLoadError(null);
  };

  const toggleMaster = async (enabled: boolean) => {
    setSettingsBusy(true);
    try {
      applyResult(await api.setPromptMaster(enabled));
      toast.success(enabled ? "已开启提示词应用" : "提示词应用已暂停");
    } catch {
      toast.error("设置更新失败", { description: "请稍后重试。" });
    } finally {
      setSettingsBusy(false);
    }
  };

  const setMode = async (nextMode: PromptInjectionMode) => {
    setSettingsBusy(true);
    try {
      applyResult(await api.setPromptMode(nextMode));
      toast.success(nextMode === "append" ? "已切换为多条同时启用" : "已切换为只保留一条");
    } catch {
      toast.error("设置更新失败", { description: "请稍后重试。" });
    } finally {
      setSettingsBusy(false);
    }
  };

  const toggleItem = async (item: PromptItem, enabled: boolean) => {
    setPendingItemId(item.id);
    try {
      applyResult(await api.setPromptEnabled(item.id, enabled));
      toast.success(enabled ? `已启用「${item.title}」` : `已停用「${item.title}」`);
    } catch {
      toast.error("状态更新失败", { description: "请稍后重试。" });
    } finally {
      setPendingItemId(null);
    }
  };

  const openNew = () => {
    setEditorKind("new");
    setForm(blankForm());
    setEditing(true);
  };

  const openEdit = (item: PromptItem) => {
    if (item.source === "builtin") {
      setEditorKind("copy");
      setForm({
        title: `${item.title}（副本）`,
        filename: item.filename.replace(/\.md$/i, "-copy.md"),
        description: item.description,
        content: item.content,
        profileIds: item.profileIds,
      });
    } else {
      setEditorKind("edit");
      setForm({
        id: item.id,
        title: item.title,
        filename: item.filename,
        description: item.description,
        content: item.content,
        profileIds: item.profileIds,
      });
    }
    setEditing(true);
  };

  const saveForm = async () => {
    if (!form.title.trim()) {
      toast.error("请输入提示词名称");
      return;
    }
    if (!form.content.trim()) {
      toast.error("请输入提示词内容");
      return;
    }

    setSaving(true);
    try {
      applyResult(
        await api.upsertPrompt({
          id: form.id,
          title: form.title.trim(),
          filename: form.filename || undefined,
          description: form.description.trim(),
          content: form.content,
          profileIds: form.profileIds,
        }),
      );
      setEditing(false);
      toast.success(editorKind === "copy" ? "提示词已另存" : "提示词已保存");
    } catch {
      toast.error("保存失败", { description: "请稍后重试。" });
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (item: PromptItem) => {
    if (item.source === "builtin") return;

    const accepted = await confirm({
      title: "删除提示词？",
      description: `确定删除「${item.title}」吗？此操作无法恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (!accepted) return;

    setPendingItemId(item.id);
    try {
      applyResult(await api.removePrompt(item.id));
      toast.success("提示词已删除");
    } catch {
      toast.error("删除失败", { description: "请稍后重试。" });
    } finally {
      setPendingItemId(null);
    }
  };

  const syncPrompts = async () => {
    setSyncing(true);
    try {
      await api.syncPrompts();
      await refresh();
      toast.success("提示词已同步");
    } catch {
      toast.error("同步失败", { description: "请稍后重试。" });
    } finally {
      setSyncing(false);
    }
  };

  const openPromptsFolder = async () => {
    setOpeningFolder(true);
    try {
      await api.openPromptsDir();
      toast.success("已打开所在位置");
    } catch {
      toast.error("打开失败", { description: "请稍后重试。" });
    } finally {
      setOpeningFolder(false);
    }
  };

  const editorTitle =
    editorKind === "edit" ? "管理提示词" : editorKind === "copy" ? "另存提示词" : "新增提示词";
  const editorDescription =
    editorKind === "edit"
      ? "更新这条提示词的名称、说明和内容。"
      : editorKind === "copy"
        ? "以当前内容创建一条可单独管理的新提示词。"
        : "创建一条可单独启用和管理的提示词。";
  const controlsBusy = settingsBusy || syncing;
  const settingsLocked = controlsBusy || pendingItemId !== null;

  return (
    <div className="cs-page prompts-workspace">
      {ConfirmDialog}

      <header className="prompts-workspace__toolbar workspace-layer-enter">
        <div className="prompts-workspace__context">
          <span className="prompts-workspace__context-icon" aria-hidden="true">
            <FileText />
          </span>
          <div className="prompts-workspace__context-copy">
            <h1>提示词</h1>
            <p>管理常用提示词并按需启用</p>
          </div>
        </div>

        <div className="prompts-workspace__actions" data-no-drag>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="prompts-workspace__icon-action"
            title="刷新提示词"
            aria-label="刷新提示词"
            onClick={() => void refresh()}
            disabled={loading || refreshing || settingsLocked}
          >
            <RefreshCw className={cn("workspace-refresh-icon", refreshing && "is-spinning animate-spin")} />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="prompts-workspace__icon-action"
            title="查看提示词位置"
            aria-label="查看提示词位置"
            onClick={() => void openPromptsFolder()}
            disabled={openingFolder}
          >
            <FolderOpen />
          </Button>
          <Button type="button" className="prompts-workspace__primary-action" onClick={openNew}>
            <Plus />
            新增提示词
          </Button>
        </div>
      </header>

      {data?.conflict?.conflict ? (
        <StatusBanner
          tone="warn"
          className="prompts-workspace__sync-banner workspace-layer-enter workspace-layer-enter--delay-1"
          title="提示词同步需要处理"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="prompts-workspace__text-action"
              disabled={settingsLocked}
              onClick={() => void syncPrompts()}
            >
              <RefreshCw className={cn("workspace-refresh-icon", syncing && "is-spinning animate-spin")} />
              重新同步
            </Button>
          }
        >
          检测到提示词内容发生变化，请重新同步以应用当前设置。
        </StatusBanner>
      ) : null}

      {loading ? (
        <section
          className="prompts-workspace__skeleton-grid workspace-layer-enter workspace-layer-enter--delay-1"
          aria-label="正在加载提示词"
        >
          {Array.from({ length: 6 }, (_, index) => (
            <div className="prompts-workspace__skeleton" key={index} />
          ))}
        </section>
      ) : loadError ? (
        <section className="prompts-workspace__error workspace-layer-enter workspace-layer-enter--delay-1" role="alert">
          <CircleAlert aria-hidden="true" />
          <strong>提示词加载失败</strong>
          <p data-i18n-raw>{loadError}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="prompts-workspace__text-action"
            onClick={() => void refresh()}
          >
            重试
          </Button>
        </section>
      ) : (
        <>
          <section
            className="prompts-workspace__control-panel workspace-layer-enter workspace-layer-enter--delay-1"
            aria-label="提示词设置"
          >
            <div className="prompts-workspace__master-row">
              <div className="prompts-workspace__master-copy">
                <strong>应用提示词</strong>
                <p>关闭后会保留已选择的提示词，方便下次继续使用。</p>
              </div>
              <Switch
                checked={master}
                onCheckedChange={(value) => void toggleMaster(value)}
                disabled={settingsLocked}
                aria-label="应用提示词"
              />
            </div>

            <div className="prompts-workspace__control-grid">
              <label className="prompts-workspace__field">
                <span className="prompts-workspace__field-label">启用方式</span>
                <SimpleSelect
                  className="prompts-workspace__mode-select"
                  value={mode}
                  onValueChange={(value) => void setMode(value)}
                  disabled={settingsLocked}
                  options={[
                    { value: "append", label: "多条同时启用" },
                    { value: "replace", label: "只保留一条" },
                  ]}
                />
              </label>

              <label className="prompts-workspace__field">
                <span className="prompts-workspace__field-label">搜索</span>
                <span className="prompts-workspace__search">
                  <Search aria-hidden="true" />
                  <Input
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                    placeholder="搜索名称、说明或场景"
                    aria-label="搜索提示词"
                  />
                </span>
              </label>
            </div>

            <div className="prompts-workspace__summary">
              <SlidersHorizontal aria-hidden="true" />
              <span>
                已选择 <strong>{selectedCount}</strong> 条提示词
                {master ? "，当前设置已开启。" : "，当前应用已暂停。"}
              </span>
            </div>
          </section>

          {filtered.length ? (
            <section className="prompts-workspace__grid workspace-layer-enter workspace-layer-enter--delay-2" aria-label="提示词列表">
              {filtered.map((item, index) => {
                const status = promptStatus(item, master);
                const isPending = pendingItemId === item.id;
                const userPreview = promptUserPreview(item);
                return (
                  <article
                    className={cn("prompts-workspace__card", item.enabled ? "is-enabled" : "is-disabled")}
                    key={item.id}
                    style={{ animationDelay: `${80 + Math.min(index, 4) * 40}ms` }}
                  >
                    <div className="prompts-workspace__card-head">
                      <div className="prompts-workspace__identity">
                        <span className={cn("prompts-workspace__icon", item.source === "custom" && "is-custom")} aria-hidden="true">
                          <FileText />
                        </span>
                        <div className="prompts-workspace__title-wrap">
                          <strong className="prompts-workspace__title" title={item.title} data-i18n-raw>
                            {item.title}
                          </strong>
                          <span
                            className="prompts-workspace__filename"
                            data-i18n-raw={Boolean(item.scene?.trim()) || undefined}
                          >
                            {promptMeta(item)}
                          </span>
                        </div>
                      </div>
                      <Switch
                        checked={item.enabled}
                        onCheckedChange={(value) => void toggleItem(item, value)}
                        disabled={settingsLocked}
                        aria-label={`${item.enabled ? "停用" : "启用"} ${item.title}`}
                      />
                    </div>

                    <p
                      className="prompts-workspace__preview"
                      data-i18n-raw={Boolean(userPreview) || undefined}
                    >
                      {userPreview || "尚未填写说明。"}
                    </p>

                    <div className={cn("prompts-workspace__status", status.className)}>{status.label}</div>

                    <footer className="prompts-workspace__card-footer">
                      <div className="prompts-workspace__card-actions">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="prompts-workspace__card-action"
                          onClick={() => setPreview(item)}
                        >
                          <Eye />
                          查看
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="prompts-workspace__card-action"
                          onClick={() => openEdit(item)}
                        >
                          {item.source === "builtin" ? <Copy /> : <Pencil />}
                          {item.source === "builtin" ? "另存" : "管理"}
                        </Button>
                      </div>
                      {item.source === "custom" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="prompts-workspace__card-action is-danger"
                          title={`删除 ${item.title}`}
                          aria-label={`删除 ${item.title}`}
                          onClick={() => void removeItem(item)}
                          disabled={settingsLocked || isPending}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </footer>
                  </article>
                );
              })}
            </section>
          ) : (
            <section className="prompts-workspace__empty workspace-layer-enter workspace-layer-enter--delay-2">
              <FileText aria-hidden="true" />
              <strong>{q ? "没有找到匹配的提示词" : "还没有提示词"}</strong>
              <p>{q ? "换个关键词试试，或清除搜索后查看全部提示词。" : "新增一条提示词后，可以在这里统一查看和管理。"}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="prompts-workspace__text-action"
                onClick={q ? () => setQ("") : openNew}
              >
                {q ? "清除搜索" : "新增提示词"}
              </Button>
            </section>
          )}
        </>
      )}

      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(false);
        }}
      >
        <DialogContent size="lg" className="prompts-workspace__dialog">
          <DialogHeader>
            <DialogTitle>{editorTitle}</DialogTitle>
            <DialogDescription>{editorDescription}</DialogDescription>
          </DialogHeader>
          <DialogBody className="prompts-workspace__dialog-body">
            <div className="prompts-workspace__dialog-fields">
              <Field label="名称">
                <Input
                  value={form.title}
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="例如：通用编程助手"
                  autoFocus
                />
              </Field>
              <Field label="说明">
                <Input
                  value={form.description}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="简要说明适用的场景"
                />
              </Field>
              <Field label="提示词内容">
                <Textarea
                  value={form.content}
                  onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))}
                  className="prompts-workspace__editor"
                  placeholder="输入提示词内容"
                />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
              取消
            </Button>
            <Button type="button" className="prompts-workspace__dialog-save" onClick={() => void saveForm()} disabled={saving}>
              <Save />
              {saving ? "保存中" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent size="xl" className="prompts-workspace__dialog prompts-workspace__preview-dialog">
          <DialogHeader>
            <DialogTitle><RawText>{preview?.title || ""}</RawText></DialogTitle>
            <DialogDescription>
              {preview?.scene?.trim()
                ? <RawText>{preview.scene.trim()}</RawText>
                : preview ? promptMeta(preview) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="prompts-workspace__dialog-body">
            <pre
              className="prompts-workspace__preview-content"
              data-i18n-raw={Boolean(preview?.content) || undefined}
            >
              {preview?.content || "暂无内容"}
            </pre>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreview(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function promptMeta(item: PromptItem) {
  return item.scene?.trim() || (item.source === "custom" ? "自定义提示词" : "内置提示词");
}

function promptUserPreview(item: PromptItem) {
  const text = item.description.trim() || item.content.replace(/\s+/g, " ").trim();
  return text;
}

function promptStatus(item: PromptItem, master: boolean) {
  if (item.enabled && master) return { label: "已启用", className: "is-enabled" };
  if (item.enabled) return { label: "已暂停", className: "" };
  return { label: "未启用", className: "" };
}
