/**
 * Stage 5: design tokens + layout primitives smoke (no browser required).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18n from "../src/lib/i18n.tsx";
import { RawText } from "../src/lib/i18n-raw.ts";
import { jsx as localizedJsx } from "../src/lib/i18n-jsx-runtime/jsx-runtime.ts";
import { jsxDEV as localizedJsxDEV } from "../src/lib/i18n-jsx-runtime/jsx-dev-runtime.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokens = fs.readFileSync(path.join(root, "src/styles/tokens.css"), "utf8");
const css = fs.readFileSync(path.join(root, "src/styles/index.css"), "utf8");
const layout = fs.readFileSync(path.join(root, "src/components/ui/layout.tsx"), "utf8");
const main = fs.readFileSync(path.join(root, "src/main.tsx"), "utf8");
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const notices = fs.readFileSync(path.join(root, "src/components/ui/app-notice.tsx"), "utf8");
const motion = fs.readFileSync(path.join(root, "src/styles/motion.css"), "utf8");
const providers = fs.readFileSync(path.join(root, "src/pages/ProvidersPage.tsx"), "utf8");
const providerStyles = fs.readFileSync(
  path.join(root, "src/styles/provider-workspace.css"),
  "utf8",
);
const providerMonitor = fs.readFileSync(
  path.join(root, "server/runtime/provider-monitor.ts"),
  "utf8",
);

await i18n.changeLanguage("en");

const rawFixture = {
  children: "保存",
  title: "删除",
  "aria-label": "名称",
  alt: "内容",
  readOnly: true,
  value: "设置",
  "data-i18n-raw": true,
};

for (const [runtime, element] of [
  ["production", localizedJsx("input", rawFixture)],
  ["development", localizedJsxDEV("input", rawFixture, undefined, false, undefined, undefined)],
]) {
  assert.equal(element.props.children, rawFixture.children, `${runtime} raw children`);
  assert.equal(element.props.title, rawFixture.title, `${runtime} raw title`);
  assert.equal(element.props["aria-label"], rawFixture["aria-label"], `${runtime} raw aria-label`);
  assert.equal(element.props.alt, rawFixture.alt, `${runtime} raw alt`);
  assert.equal(element.props.value, rawFixture.value, `${runtime} raw read-only value`);
  assert.equal(element.props["data-i18n-raw"], undefined, `${runtime} strips the DOM marker`);
}

const localizedFixture = localizedJsx("input", {
  children: "保存",
  title: "删除",
  "aria-label": "名称",
  alt: "内容",
  readOnly: true,
  value: "设置",
});
assert.equal(localizedFixture.props.children, "Save", "ordinary children remain localized");
assert.equal(localizedFixture.props.title, "Delete", "ordinary title remains localized");
assert.equal(localizedFixture.props["aria-label"], "Name", "ordinary aria-label remains localized");
assert.equal(localizedFixture.props.alt, "Content", "ordinary alt remains localized");
assert.equal(localizedFixture.props.value, "Settings", "ordinary read-only value remains localized");

const rawTextElement = localizedJsx(RawText, { children: "保存" });
assert.equal(rawTextElement.props.children, "保存", "RawText bypasses the JSX runtime");
assert.equal(RawText({ children: rawTextElement.props.children }).props.children, "保存", "RawText renders the original value");

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
assert.ok(notices.includes('className="app-notice-toaster"'), "Sonner toaster has an application motion scope");
const reducedMotionStart = motion.indexOf("@media (prefers-reduced-motion: reduce)");
const reducedMotionEnd = motion.indexOf("/* Final shared interaction layer", reducedMotionStart);
const forcedReducedMotion = motion.slice(reducedMotionStart, reducedMotionEnd);
assert.ok(reducedMotionStart >= 0 && reducedMotionEnd > reducedMotionStart, "forced reduced-motion layer exists");
assert.ok(
  forcedReducedMotion.includes(".app-notice-toaster[data-sonner-toaster] [data-sonner-toast]"),
  "Sonner toast motion is restored for reduced-motion hosts",
);
assert.ok(
  forcedReducedMotion.includes('[data-removed="true"][data-swipe-out="false"]'),
  "Sonner exit transition is restored",
);
assert.ok(
  forcedReducedMotion.includes('height var(--workspace-motion-enter)'),
  "Sonner stack reflow transition is restored",
);
assert.ok(
  forcedReducedMotion.includes('[data-swiping="true"]'),
  "Sonner swipe tracking remains immediate",
);
assert.ok(providers.includes("provider-directory__rows"), "provider directory layout");
assert.ok(providers.includes("provider-directory__balance"), "provider balance is rendered in the directory");
assert.ok(providers.includes(".listProviderBalances("), "provider balances load automatically");
assert.ok(providers.includes("localizedBalanceAmount"), "provider balance formats a single remaining amount");
assert.ok(providers.includes('t("balance.multiplier"'), "provider balance renders an i18n multiplier");
assert.ok(providerStyles.includes(".provider-directory__balance-multiplier"), "provider multiplier has compact styling");
assert.ok(!providers.includes("balanceDetail"), "provider balance has no secondary copy");
assert.ok(!providers.includes("balanceProvider"), "provider balance does not display the platform");
assert.ok(!providers.includes("provider-editor-section--balance"), "provider editor has no manual balance panel");
assert.ok(providers.includes("api.probeProviderBalance(provider)"), "manual latency probe also refreshes the current key balance");
assert.ok(providerMonitor.includes("PROVIDER_MONITOR_INTERVAL_MS = 10 * 60 * 1_000"), "provider runtime refreshes every ten minutes");
assert.ok(providerMonitor.includes("affectCircuit: false"), "scheduled latency probes do not trip routing circuit state");
assert.ok(providerMonitor.includes("refreshUsagePricing()"), "provider runtime refreshes usage pricing");
assert.ok(providers.includes("workspace-layer-enter"), "provider directory motion");

console.log("PASS smoke-stage5-ui", {
  tokenBytes: tokens.length,
  cssBytes: css.length,
  layoutHasStatus: layout.includes("StatusBanner"),
});
