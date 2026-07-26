/**
 * Stage 5: design tokens + layout primitives smoke (no browser required).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokens = fs.readFileSync(path.join(root, "src/styles/tokens.css"), "utf8");
const css = fs.readFileSync(path.join(root, "src/styles/index.css"), "utf8");
const layout = fs.readFileSync(path.join(root, "src/components/ui/layout.tsx"), "utf8");
const main = fs.readFileSync(path.join(root, "src/main.tsx"), "utf8");
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const providers = fs.readFileSync(path.join(root, "src/pages/ProvidersPage.tsx"), "utf8");

for (const key of [
  "--studio-ink",
  "--studio-paper",
  "--chrome-height",
  "--dur-med",
  "--r-lg",
  "--content-pad",
]) {
  assert.ok(tokens.includes(key), `missing token ${key}`);
}

assert.ok(main.includes('tokens.css'), "main imports tokens");
assert.ok(css.includes("Stage 5"), "stage5 css section");
assert.ok(css.includes(".studio-empty"), "empty surface");
assert.ok(css.includes(".studio-status"), "status surface");
assert.ok(css.includes(".app-top-nav"), "top nav");
assert.ok(layout.includes("export function LoadingState"), "LoadingState");
assert.ok(layout.includes("export function StatusBanner"), "StatusBanner");
assert.ok(layout.includes("export function ErrorState"), "ErrorState");
assert.ok(layout.includes("export function SectionCard"), "SectionCard");
assert.ok(app.includes("LoadingState"), "App uses LoadingState");
assert.ok(app.includes("page-enter"), "page enter animation class");
assert.ok(providers.includes("provider-directory__rows"), "provider directory layout");
assert.ok(providers.includes("workspace-layer-enter"), "provider directory motion");

console.log("PASS smoke-stage5-ui", {
  tokenBytes: tokens.length,
  cssBytes: css.length,
  layoutHasStatus: layout.includes("StatusBanner"),
});
