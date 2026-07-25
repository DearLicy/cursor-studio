import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-studio-skills-"));
const previous = {
  userProfile: process.env.USERPROFILE,
  home: process.env.HOME,
  cursorHome: process.env.CURSOR_STUDIO_CURSOR_HOME,
  studioHome: process.env.CURSOR_STUDIO_HOME,
  cursorUserData: process.env.CURSOR_STUDIO_CURSOR_USER_DATA,
};

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

async function writeSkill(directory, name, description) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`,
    "utf8",
  );
}

async function writeMarkdownSkill(file, name, description) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`,
    "utf8",
  );
}

process.env.USERPROFILE = root;
process.env.HOME = root;
process.env.CURSOR_STUDIO_CURSOR_HOME = path.join(root, "cursor-home");
process.env.CURSOR_STUDIO_HOME = path.join(root, "studio-home");
process.env.CURSOR_STUDIO_CURSOR_USER_DATA = path.join(root, "cursor-user-data");

try {
  const cursorHome = process.env.CURSOR_STUDIO_CURSOR_HOME;
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  const codexSkill = path.join(root, ".codex", "skills", ".system", "global-skill");
  const cursorSkill = path.join(cursorHome, "skills", "cursor-skill");
  const builtinSkill = path.join(cursorHome, "skills-cursor", "builtin-skill");
  const cloudSkill = path.join(cursorHome, "cloud-skills", "cloud-skill.md");
  const projectSkill = path.join(workspaceA, ".cursor", "skills", "project-skill");
  const otherProjectSkill = path.join(workspaceB, ".claude", "skills", "other-project-skill");

  await Promise.all([
    writeSkill(codexSkill, "global-skill", "Global skill fixture"),
    writeSkill(cursorSkill, "cursor-skill", "Cursor global skill fixture"),
    writeSkill(builtinSkill, "builtin-skill", "Cursor managed fixture"),
    writeMarkdownSkill(cloudSkill, "cloud-skill", "Cursor cloud fixture"),
    writeSkill(projectSkill, "project-skill", "Workspace A fixture"),
    writeSkill(otherProjectSkill, "other-project-skill", "Workspace B fixture"),
  ]);

  const workspaceStorage = path.join(
    process.env.CURSOR_STUDIO_CURSOR_USER_DATA,
    "workspaceStorage",
    "fixture-workspace-a",
  );
  await fs.mkdir(workspaceStorage, { recursive: true });
  await fs.writeFile(
    path.join(workspaceStorage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(workspaceA).href }),
    "utf8",
  );

  const skills = await import("../server/workspace/skills-store.ts");
  const all = await skills.listSkills();
  assert.ok(all.items.some((item) => item.name === "global-skill" && item.source === "codex"));
  assert.ok(all.items.some((item) => item.name === "cursor-skill" && item.scope === "global"));
  assert.ok(all.items.some((item) => item.name === "project-skill" && item.scope === "workspace"));
  assert.equal(all.items.some((item) => item.name === "other-project-skill"), false);

  const builtin = all.items.find((item) => item.name === "builtin-skill");
  assert.ok(builtin);
  assert.equal(builtin.writable, false);
  await assert.rejects(skills.updateSkillContent(builtin.path, "# changed\n"));
  await assert.rejects(skills.removeSkill(builtin.path));

  const cloud = all.items.find((item) => item.name === "cloud-skill");
  assert.ok(cloud);
  assert.equal(cloud.entryKind, "file");
  assert.equal(cloud.writable, false);
  assert.match((await skills.readSkillContent(cloud.path)).text, /Cursor cloud fixture/);
  await assert.rejects(skills.updateSkillContent(cloud.path, "# changed\n"));
  await assert.rejects(skills.removeSkill(cloud.path));

  const scoped = await skills.listSkills({ workspaceRoot: workspaceA });
  assert.ok(scoped.items.some((item) => item.name === "project-skill"));
  assert.equal(scoped.items.some((item) => item.name === "other-project-skill"), false);

  const project = scoped.items.find((item) => item.name === "project-skill");
  assert.ok(project);
  assert.equal(await skills.resolveKnownSkillPath(project.path), project.path);
  await assert.rejects(skills.resolveKnownSkillPath(path.join(root, "outside-skill")));
  const read = await skills.readSkillContent(project.path);
  assert.match(read.text, /Workspace A fixture/);
  assert.equal(read.truncated, false);

  await skills.updateSkillContent(
    project.path,
    "---\nname: project-skill\ndescription: Updated workspace fixture\n---\n\n# project-skill\n\nUpdated workspace fixture\n",
  );
  const updated = await skills.readSkillContent(project.path);
  assert.match(updated.text, /Updated workspace fixture/);
  const shortened = await skills.readSkillContent(project.path, 12);
  assert.equal(shortened.truncated, true);

  const created = await skills.createSkill({
    name: "created-skill",
    description: "Created skill fixture",
  });
  assert.equal(created.source, "skills");
  assert.equal(created.scope, "global");
  const backup = await skills.backupSkillDirectory(created.path, "smoke");
  assert.ok(backup);
  assert.match(await fs.readFile(path.join(backup, "SKILL.md"), "utf8"), /Created skill fixture/);
  await skills.removeSkill(created.path);
  await assert.rejects(fs.access(created.path));
  await assert.rejects(skills.removeSkill(path.join(root, "outside-skill")));

  assert.equal(skills.cursorSkillsRootPath(), path.join(cursorHome, "skills"));
  const skillRepos = await import("../server/workspace/skills-repo.ts");
  const repoState = await skillRepos.listSkillRepos();
  assert.equal(repoState.path, path.join(process.env.CURSOR_STUDIO_HOME, "skill-repos.json"));
  const addedRepos = await skillRepos.addSkillRepo({ owner: "fixture-owner", name: "fixture-repo" });
  assert.ok(addedRepos.repos.some((repo) => repo.owner === "fixture-owner" && repo.name === "fixture-repo"));

  console.log("Skills smoke passed: Cursor roots, cloud entries, read-only sources, CRUD, backups, and repository state");
} finally {
  restoreEnv("USERPROFILE", previous.userProfile);
  restoreEnv("HOME", previous.home);
  restoreEnv("CURSOR_STUDIO_CURSOR_HOME", previous.cursorHome);
  restoreEnv("CURSOR_STUDIO_HOME", previous.studioHome);
  restoreEnv("CURSOR_STUDIO_CURSOR_USER_DATA", previous.cursorUserData);
  await fs.rm(root, { recursive: true, force: true });
}
