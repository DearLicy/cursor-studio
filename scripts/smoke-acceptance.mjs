/**
 * Automated acceptance pack (Stage 1–6 code path).
 * Covers protocol, routing, usage, diagnostics, release artifacts.
 * Real Cursor IDE/Agent checklist is emitted as pending external steps.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function run(name, cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: root,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      results.push({
        name,
        ok: code === 0,
        code,
        tail: out.trim().split(/\r?\n/).slice(-6).join(" | "),
      });
      resolve(code === 0);
    });
  });
}

const suites = [
  ["fixtures", "npm", ["run", "smoke:fixtures"]],
  ["proto", "npm", ["run", "smoke:proto"]],
  ["connect", "npm", ["run", "smoke:connect"]],
  ["stream", "npm", ["run", "smoke:stream"]],
  ["cancel", "npm", ["run", "smoke:cancel"]],
  ["prompt-context", "npm", ["run", "smoke:prompt-context"]],
  ["routing", "npm", ["run", "smoke:routing"]],
  ["proxy-inject", "npm", ["run", "smoke:proxy-inject"]],
  ["stage2", "npm", ["run", "smoke:stage2"]],
  ["stage3", "npm", ["run", "smoke:stage3"]],
  ["stage4", "npm", ["run", "smoke:stage4"]],
  ["cursor-sessions", "npm", ["run", "smoke:cursor-sessions"]],
  ["stage5", "npm", ["run", "smoke:stage5"]],
  ["stage6", "npm", ["run", "smoke:stage6"]],
  ["release", "npm", ["run", "smoke:release"]],
];

for (const [name, cmd, args] of suites) {
  // eslint-disable-next-line no-await-in-loop
  await run(name, cmd, args);
}

const failed = results.filter((r) => !r.ok);
const external = [
  {
    name: "cursor-ide-chat",
    ok: null,
    note: "External: open Cursor IDE via Studio proxy, complete normal chat",
  },
  {
    name: "cursor-ide-stream-cancel",
    ok: null,
    note: "External: stream output then cancel mid-turn",
  },
  {
    name: "cursor-agent-tools",
    ok: null,
    note: "External: Agent mode tool call (read/shell) succeeds",
  },
  {
    name: "cursor-detach-restore",
    ok: null,
    note: "External: detach proxy restores previous settings.json",
  },
];

const report = {
  createdAt: new Date().toISOString(),
  automated: results,
  automatedPassed: results.filter((r) => r.ok).length,
  automatedTotal: results.length,
  externalChecklist: external,
  readyForManualCursor: failed.length === 0,
};

const outDir = path.join(root, "output", "acceptance");
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, "acceptance-report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

// markdown summary
const md = [
  "# Cursor Studio Acceptance Report",
  "",
  `Generated: ${report.createdAt}`,
  "",
  `Automated: **${report.automatedPassed}/${report.automatedTotal}** passed`,
  "",
  "## Automated suites",
  "",
  ...results.map((r) => `- ${r.ok ? "✅" : "❌"} \`${r.name}\`${r.ok ? "" : ` — ${r.tail}`}`),
  "",
  "## External Cursor checklist (manual)",
  "",
  ...external.map((e) => `- [ ] ${e.name} — ${e.note}`),
  "",
  failed.length
    ? "## Result\n\nAutomated suite failed; fix before manual Cursor sign-off."
    : "## Result\n\nAutomated suite green. Manual Cursor checklist remains for final product sign-off.",
  "",
].join("\n");
fs.writeFileSync(path.join(outDir, "ACCEPTANCE.md"), md);

assert.equal(failed.length, 0, `failed suites: ${failed.map((f) => f.name).join(",")}`);
console.log("PASS smoke-acceptance", {
  automatedPassed: report.automatedPassed,
  automatedTotal: report.automatedTotal,
  report: path.relative(root, reportPath),
});
