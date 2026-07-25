/**
 * Cursor Workspace Profile store (stage 2).
 * Semantics: Cursor workspace asset combo, not multi-CLI app profile.
 */
import { randomUUID } from "node:crypto";
import {
  loadConfig,
  saveConfig,
  type AppConfig,
  type WorkspaceProfile,
} from "../config/store";

export type { WorkspaceProfile };

function nowIso(): string {
  return new Date().toISOString();
}

export function newWorkspaceProfile(
  partial?: Partial<WorkspaceProfile>,
): WorkspaceProfile {
  const ts = nowIso();
  return {
    id: partial?.id || randomUUID(),
    name: partial?.name?.trim() || "Default Profile",
    description: partial?.description,
    providerIds: partial?.providerIds ? [...partial.providerIds] : [],
    defaultProviderId: partial?.defaultProviderId,
    defaultModelID: partial?.defaultModelID,
    promptIds: partial?.promptIds ? [...partial.promptIds] : [],
    mcpServerIds: partial?.mcpServerIds ? [...partial.mcpServerIds] : [],
    skillIds: partial?.skillIds ? [...partial.skillIds] : [],
    createdAt: partial?.createdAt || ts,
    updatedAt: partial?.updatedAt || ts,
  };
}

export async function listProfiles(): Promise<{
  profiles: WorkspaceProfile[];
  activeProfileId?: string;
}> {
  const cfg = await loadConfig();
  return {
    profiles: cfg.profiles || [],
    activeProfileId: cfg.activeProfileId,
  };
}

export async function upsertProfile(
  input: Partial<WorkspaceProfile> & { name?: string },
): Promise<{ profiles: WorkspaceProfile[]; activeProfileId?: string }> {
  const cfg = await loadConfig();
  const profiles = [...(cfg.profiles || [])];
  const id = input.id || randomUUID();
  const idx = profiles.findIndex((p) => p.id === id);
  const base =
    idx >= 0
      ? profiles[idx]
      : newWorkspaceProfile({ id, name: input.name || "Profile" });
  const next: WorkspaceProfile = {
    ...base,
    ...input,
    id,
    name: (input.name ?? base.name).trim() || base.name,
    providerIds: input.providerIds ? [...input.providerIds] : base.providerIds,
    promptIds: input.promptIds ? [...input.promptIds] : base.promptIds,
    mcpServerIds: input.mcpServerIds
      ? [...input.mcpServerIds]
      : base.mcpServerIds,
    skillIds: input.skillIds ? [...input.skillIds] : base.skillIds,
    updatedAt: nowIso(),
    createdAt: base.createdAt || nowIso(),
  };
  if (idx >= 0) profiles[idx] = next;
  else profiles.push(next);
  cfg.profiles = profiles;
  await saveConfig(cfg);
  return { profiles, activeProfileId: cfg.activeProfileId };
}

export async function removeProfile(
  id: string,
): Promise<{ profiles: WorkspaceProfile[]; activeProfileId?: string }> {
  const cfg = await loadConfig();
  cfg.profiles = (cfg.profiles || []).filter((p) => p.id !== id);
  if (cfg.activeProfileId === id) cfg.activeProfileId = undefined;
  await saveConfig(cfg);
  return { profiles: cfg.profiles, activeProfileId: cfg.activeProfileId };
}

export async function setActiveProfile(
  id: string | null,
): Promise<{ profiles: WorkspaceProfile[]; activeProfileId?: string }> {
  const cfg = await loadConfig();
  if (id) {
    const exists = (cfg.profiles || []).some((p) => p.id === id);
    if (!exists) throw new Error(`Profile not found: ${id}`);
    cfg.activeProfileId = id;
  } else {
    cfg.activeProfileId = undefined;
  }
  await saveConfig(cfg);
  return { profiles: cfg.profiles || [], activeProfileId: cfg.activeProfileId };
}

/** Apply profile defaults onto providers (enable subset + default model). */
export async function applyProfile(id: string): Promise<AppConfig> {
  const cfg = await loadConfig();
  const profile = (cfg.profiles || []).find((p) => p.id === id);
  if (!profile) throw new Error(`Profile not found: ${id}`);
  const allow = new Set(profile.providerIds);
  cfg.providers = cfg.providers.map((p) => {
    const enabled = allow.size === 0 ? p.enabled : allow.has(p.id);
    if (profile.defaultProviderId === p.id && profile.defaultModelID) {
      return { ...p, enabled, modelID: profile.defaultModelID };
    }
    return { ...p, enabled };
  });
  cfg.activeProfileId = id;
  await saveConfig(cfg);

  // Prompt scope: enable/disable profile-tagged prompts; keep unscoped as-is.
  try {
    const {
      listPrompts,
      setPromptEnabled,
      syncCursorInjection,
    } = await import("./prompts-store");
    const { state } = await listPrompts();
    const explicit = new Set(profile.promptIds || []);
    for (const item of state.items) {
      if (explicit.size > 0 && explicit.has(item.id)) {
        if (!item.enabled) await setPromptEnabled(item.id, true);
        continue;
      }
      if (!item.profileIds || item.profileIds.length === 0) continue;
      const shouldEnable = item.profileIds.includes(id);
      if (item.enabled !== shouldEnable) {
        await setPromptEnabled(item.id, shouldEnable);
      }
    }
    await syncCursorInjection();
  } catch (e) {
    console.warn("[profiles] prompt apply skipped", e);
  }

  return loadConfig();
}
