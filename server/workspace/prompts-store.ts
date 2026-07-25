/**
 * 提示词注入（对齐 Codex-X 思路，适配 Cursor）
 *
 * Codex-X：
 * - append → 写 AGENTS.md 受管区块
 * - replace → model_instructions_file
 *
 * Cursor Studio：
 * - append → 写入 ~/.cursor/rules/studio-prompts.mdc（alwaysApply），不碰用户其它 rules
 * - replace → 同样只写我们的受管文件，但内容仅含当前启用提示词（文件本身即「替换入口」）
 * - 代理引擎：本地 agent 出站时把启用提示词作为 system 注入（不依赖 Cursor 是否读 rules）
 *
 * 默认关闭；仅在用户启用某个提示词时写入/注入。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { studioHome } from "../config/store";

export type PromptSource = "builtin" | "custom";
export type PromptInjectionMode = "append" | "replace";

export type PromptItem = {
  id: string;
  title: string;
  filename: string;
  description: string;
  content: string;
  enabled: boolean;
  source: PromptSource;
  scene?: string;
  updatedAt: string;
  /** Empty/undefined = all profiles; otherwise only active when profile matches. */
  profileIds?: string[];
};

export type PromptsState = {
  version: 1;
  injectionMode: PromptInjectionMode;
  /** 全局总开关：关闭时不写 Cursor rules、不向 agent 注入 */
  masterEnabled: boolean;
  items: PromptItem[];
};

const MANAGED_BEGIN = "<!-- cursor-studio-prompts:begin -->";
const MANAGED_END = "<!-- cursor-studio-prompts:end -->";
const RULE_FILENAME = "studio-prompts.mdc";

const BUILTIN_META: Array<{
  id: string;
  title: string;
  filename: string;
  description: string;
  scene: string;
}> = [
  {
    id: "builtin-gpt5.5-unrestricted",
    title: "gpt5.5-unrestricted",
    filename: "gpt5.5-unrestricted.md",
    description: "短小通用，适合日常 coding 与常规技术任务",
    scene: "日常 coding / 常规技术",
  },
  {
    id: "builtin-gpt5.4-unrestricted",
    title: "gpt5.4-unrestricted",
    filename: "gpt5.4-unrestricted.md",
    description: "面向 GPT-5.4 / Codex CLI，偏 CTF 与安全研究工作流",
    scene: "CTF / 安全研究",
  },
  {
    id: "builtin-gpt5.5-jeli",
    title: "gpt5.5-jeli",
    filename: "gpt5.5-jeli.md",
    description: "大白话通用版，提供更完整的工程与逆向执行流程",
    scene: "工程 / 逆向流程",
  },
  {
    id: "builtin-gpt-5.6-sol-unrestricted",
    title: "gpt-5.6-sol-unrestricted",
    filename: "gpt-5.6-sol-unrestricted.md",
    description: "gpt5.6-sol 破甲提示词，偏直接执行与中英文任务",
    scene: "直接执行 / 中英文",
  },
  {
    id: "builtin-seagull-3.0",
    title: "海鸥3.0破甲",
    filename: "seagull-3.0.md",
    description: "中文技术操作员人格，覆盖 coding、CTF、逆向、内存与协议任务路由",
    scene: "中文技术操作 / 全栈路由",
  },
];

function nowIso() {
  return new Date().toISOString();
}

function promptsDir() {
  return path.join(studioHome(), "prompts");
}

function statePath() {
  return path.join(promptsDir(), "prompts.json");
}

function customContentPath(id: string) {
  return path.join(promptsDir(), "custom", `${id}.md`);
}

function cursorRulesDir() {
  const override = process.env.CURSOR_STUDIO_CURSOR_RULES_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".cursor", "rules");
}

function cursorManagedRulePath() {
  return path.join(cursorRulesDir(), RULE_FILENAME);
}

function candidateBuiltinRoots(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    // electron-builder extraResources
    resourcesPath ? path.join(resourcesPath, "resources", "prompts") : "",
    resourcesPath ? path.join(resourcesPath, "prompts") : "",
    path.join(process.cwd(), "resources", "prompts"),
    path.join(here, "../../resources/prompts"),
    path.join(here, "../../../resources/prompts"),
  ].filter(Boolean);
}

async function readBuiltinFile(filename: string): Promise<string> {
  for (const root of candidateBuiltinRoots()) {
    const p = path.join(root, filename);
    if (existsSync(p)) {
      return fs.readFile(p, "utf8");
    }
  }
  return `# ${filename}\n\n（内置模板文件缺失，请确认 resources/prompts 已打包）\n`;
}

async function ensureStoreDirs() {
  await fs.mkdir(promptsDir(), { recursive: true });
  await fs.mkdir(path.join(promptsDir(), "custom"), { recursive: true });
}

function defaultState(): PromptsState {
  return {
    version: 1,
    injectionMode: "append",
    // 默认关闭：不写 Cursor rules、不向 agent 注入
    masterEnabled: false,
    items: [],
  };
}

async function loadRawState(): Promise<PromptsState> {
  await ensureStoreDirs();
  if (!existsSync(statePath())) return defaultState();
  try {
    const raw = JSON.parse(await fs.readFile(statePath(), "utf8")) as Partial<PromptsState>;
    return {
      version: 1,
      injectionMode: raw.injectionMode === "replace" ? "replace" : "append",
      // 显式 true 才开启；缺省/历史 false 均视为关闭
      masterEnabled: raw.masterEnabled === true,
      items: Array.isArray(raw.items) ? (raw.items as PromptItem[]) : [],
    };
  } catch {
    return defaultState();
  }
}

async function saveRawState(state: PromptsState) {
  await ensureStoreDirs();
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

async function mergeWithBuiltins(state: PromptsState): Promise<PromptsState> {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  const next: PromptItem[] = [];

  for (const meta of BUILTIN_META) {
    const prev = byId.get(meta.id);
    const content = await readBuiltinFile(meta.filename);
    next.push({
      id: meta.id,
      title: meta.title,
      filename: meta.filename,
      description: meta.description,
      scene: meta.scene,
      content: prev?.content && prev.source === "builtin" ? content : content,
      enabled: Boolean(prev?.enabled),
      source: "builtin",
      updatedAt: prev?.updatedAt || nowIso(),
    });
    byId.delete(meta.id);
  }

  for (const item of byId.values()) {
    if (item.source === "builtin") continue; // 丢弃未知内置
    let content = item.content || "";
    const cp = customContentPath(item.id);
    if (existsSync(cp)) {
      try {
        content = await fs.readFile(cp, "utf8");
      } catch {
        /* keep */
      }
    }
    next.push({ ...item, content, source: "custom" });
  }

  return { ...state, items: next };
}

export async function listPrompts(): Promise<{
  state: PromptsState;
  cursorRulePath: string;
  cursorRuleExists: boolean;
  activeCount: number;
  conflict: PromptConflict;
}> {
  const state = await mergeWithBuiltins(await loadRawState());
  // 持久化合并后的结构（不写 content 大字段到 json？仍写摘要）
  const slim: PromptsState = {
    ...state,
    items: state.items.map((i) => ({
      ...i,
      // json 里保留 content 方便离线；内置可再从文件刷新
      content: i.source === "custom" ? i.content : "",
    })),
  };
  await saveRawState(slim);

  const activeCount = state.masterEnabled
    ? state.items.filter((i) => i.enabled).length
    : 0;
  const conflict = await detectPromptConflict(state);

  return {
    state,
    cursorRulePath: cursorManagedRulePath(),
    cursorRuleExists: existsSync(cursorManagedRulePath()),
    activeCount,
    conflict,
  };
}

export async function getActiveSystemPrompt(): Promise<string> {
  const { state } = await listPrompts();
  if (!state.masterEnabled) return "";
  let activeProfileId: string | undefined;
  try {
    const { loadConfig } = await import("../config/store");
    activeProfileId = (await loadConfig()).activeProfileId;
  } catch {
    activeProfileId = undefined;
  }
  const enabled = state.items.filter(
    (i) => i.enabled && i.content.trim() && isPromptInProfile(i, activeProfileId),
  );
  if (!enabled.length) return "";
  return enabled
    .map(
      (i) =>
        `### ${i.title}\n\n${i.content.trim()}`,
    )
    .join("\n\n---\n\n");
}

function buildManagedMarkdown(state: PromptsState): string {
  const enabled = state.items.filter((i) => i.enabled && i.content.trim());
  if (!enabled.length) return "";

  const body = enabled
    .map((i) => {
      return [
        `<!-- template: ${i.id} -->`,
        `## ${i.title}`,
        "",
        i.content.trim(),
      ].join("\n");
    })
    .join("\n\n");

  // Cursor Project/User Rules (.mdc)
  return [
    "---",
    "description: Cursor Studio managed prompts",
    "alwaysApply: true",
    "---",
    "",
    MANAGED_BEGIN,
    body,
    MANAGED_END,
    "",
  ].join("\n");
}


function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function isPromptInProfile(item: PromptItem, activeProfileId?: string): boolean {
  if (!item.profileIds || item.profileIds.length === 0) return true;
  if (!activeProfileId) return true;
  return item.profileIds.includes(activeProfileId);
}

export type PromptConflict = {
  path: string;
  conflict: boolean;
  reason?: string;
  expectedFingerprint?: string;
  actualFingerprint?: string;
  managedMarkersPresent: boolean;
};

/** Detect external edits to the managed .mdc before overwrite. */
export async function detectPromptConflict(
  state?: PromptsState,
): Promise<PromptConflict> {
  const current = state || (await mergeWithBuiltins(await loadRawState()));
  const rulePath = cursorManagedRulePath();
  const expected = buildManagedMarkdown(current);
  const expectedFingerprint = fingerprint(expected);
  if (!existsSync(rulePath)) {
    return {
      path: rulePath,
      conflict: false,
      expectedFingerprint,
      managedMarkersPresent: false,
    };
  }
  try {
    const actual = await fs.readFile(rulePath, "utf8");
    const actualFingerprint = fingerprint(actual);
    const managedMarkersPresent =
      actual.includes(MANAGED_BEGIN) || actual.includes("cursor-studio-prompts");
    if (actualFingerprint === expectedFingerprint) {
      return {
        path: rulePath,
        conflict: false,
        expectedFingerprint,
        actualFingerprint,
        managedMarkersPresent,
      };
    }
    // Outside edit or stale: conflict if file exists and differs
    return {
      path: rulePath,
      conflict: true,
      reason: managedMarkersPresent
        ? "Cursor 受管 rules 文件与 Studio 当前启用提示词不一致（可能被外部修改或未同步）"
        : "目标 rules 文件存在但不是当前 Studio 内容",
      expectedFingerprint,
      actualFingerprint,
      managedMarkersPresent,
    };
  } catch (e) {
    return {
      path: rulePath,
      conflict: true,
      reason: e instanceof Error ? e.message : String(e),
      expectedFingerprint,
      managedMarkersPresent: false,
    };
  }
}

/** 将当前启用提示词同步到 Cursor rules 文件 */
export async function syncCursorInjection(): Promise<{
  path: string;
  written: boolean;
  removed: boolean;
  activeCount: number;
}> {
  const { state } = await listPrompts();
  const rulePath = cursorManagedRulePath();
  let activeProfileId: string | undefined;
  try {
    const { loadConfig } = await import("../config/store");
    activeProfileId = (await loadConfig()).activeProfileId;
  } catch {
    activeProfileId = undefined;
  }
  const active = state.masterEnabled
    ? state.items.filter(
        (i) => i.enabled && i.content.trim() && isPromptInProfile(i, activeProfileId),
      )
    : [];

  if (!active.length) {
    if (existsSync(rulePath)) {
      await fs.unlink(rulePath);
      return { path: rulePath, written: false, removed: true, activeCount: 0 };
    }
    return { path: rulePath, written: false, removed: false, activeCount: 0 };
  }

  await fs.mkdir(cursorRulesDir(), { recursive: true });
  // append/replace 在「仅受管文件」场景下内容相同：我们从不改用户其它 rules
  // replace 语义：只保留启用项（文件即唯一入口）；append 也是只写我们的区块文件
  const md = buildManagedMarkdown(state);
  await fs.writeFile(rulePath, md, "utf8");
  return { path: rulePath, written: true, removed: false, activeCount: active.length };
}

export async function setInjectionMode(mode: PromptInjectionMode) {
  const state = await mergeWithBuiltins(await loadRawState());
  state.injectionMode = mode === "replace" ? "replace" : "append";
  if (state.injectionMode === "replace") {
    const enabled = state.items
      .filter((item) => item.enabled)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const keepId = enabled[0]?.id;
    for (const item of state.items) item.enabled = item.id === keepId;
  }
  await saveRawState({
    ...state,
    items: state.items.map((i) => ({
      ...i,
      content: i.source === "custom" ? i.content : "",
    })),
  });
  const inject = await syncCursorInjection();
  return { ...(await listPrompts()), inject };
}

export async function setMasterEnabled(enabled: boolean) {
  const state = await mergeWithBuiltins(await loadRawState());
  state.masterEnabled = Boolean(enabled);
  await saveRawState({
    ...state,
    items: state.items.map((i) => ({
      ...i,
      content: i.source === "custom" ? i.content : "",
    })),
  });
  const inject = await syncCursorInjection();
  return { ...(await listPrompts()), inject };
}

export async function setPromptEnabled(id: string, enabled: boolean) {
  const state = await mergeWithBuiltins(await loadRawState());
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`提示词不存在: ${id}`);

  // Selecting a prompt is an explicit request to use it. Keep the global
  // pause control for an intentional pause, but do not leave a newly enabled
  // prompt silently inactive behind that pause state.
  if (enabled) state.masterEnabled = true;

  // replace 模式：启用一个时关闭其它（对齐 Codex-X 单入口）
  if (enabled && state.injectionMode === "replace") {
    for (const i of state.items) i.enabled = i.id === id;
  } else {
    item.enabled = Boolean(enabled);
  }
  item.updatedAt = nowIso();

  await saveRawState({
    ...state,
    items: state.items.map((i) => ({
      ...i,
      content: i.source === "custom" ? i.content : "",
    })),
  });
  const inject = await syncCursorInjection();
  return { ...(await listPrompts()), inject };
}

export async function upsertPrompt(input: {
  profileIds?: string[];
  id?: string;
  title: string;
  filename?: string;
  description?: string;
  content: string;
  enabled?: boolean;
}): Promise<Awaited<ReturnType<typeof listPrompts>>> {
  const state = await mergeWithBuiltins(await loadRawState());
  const title = (input.title || "").trim();
  if (!title) throw new Error("标题不能为空");
  const content = input.content ?? "";
  const id = input.id?.trim() || `custom-${randomUUID().slice(0, 8)}`;

  const existing = state.items.find((i) => i.id === id);
  if (existing?.source === "builtin") {
    // 内置允许改 description 外的副本：改为另存自定义
    throw new Error("内置提示词不可覆盖，请另存为自定义");
  }

  const filename =
    (input.filename || `${title}.md`).replace(/[\\/]+/g, "-").trim() || "prompt.md";

  const next: PromptItem = {
    id,
    title,
    filename: filename.endsWith(".md") ? filename : `${filename}.md`,
    description: (input.description || "自定义提示词").trim(),
    content,
    enabled: input.enabled ?? existing?.enabled ?? false,
    source: "custom",
    updatedAt: nowIso(),
    profileIds: input.profileIds,
  };

  await fs.writeFile(customContentPath(id), content, "utf8");

  const idx = state.items.findIndex((i) => i.id === id);
  if (idx >= 0) state.items[idx] = next;
  else state.items.push(next);

  if (next.enabled && state.injectionMode === "replace") {
    for (const item of state.items) item.enabled = item.id === next.id;
  }

  // API callers can create a prompt already enabled. Treat that exactly like
  // turning on an existing item so the provider path and Cursor rule agree.
  if (input.enabled === true) state.masterEnabled = true;

  await saveRawState({
    ...state,
    items: state.items.map((i) => ({
      ...i,
      content: i.source === "custom" ? i.content : "",
    })),
  });

  if (next.enabled) await syncCursorInjection();
  return listPrompts();
}

export async function removePrompt(id: string) {
  const state = await mergeWithBuiltins(await loadRawState());
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`提示词不存在: ${id}`);
  if (item.source === "builtin") throw new Error("内置提示词不可删除，可关闭启用");

  state.items = state.items.filter((i) => i.id !== id);
  const cp = customContentPath(id);
  if (existsSync(cp)) await fs.unlink(cp);

  await saveRawState({
    ...state,
    items: state.items.map((i) => ({
      ...i,
      content: i.source === "custom" ? i.content : "",
    })),
  });
  const inject = await syncCursorInjection();
  return { ...(await listPrompts()), inject };
}

export async function openPromptsDir(): Promise<string> {
  await ensureStoreDirs();
  return promptsDir();
}
