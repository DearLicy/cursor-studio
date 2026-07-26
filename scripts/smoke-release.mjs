/**
 * Stage 6: release packaging smoke.
 * Verifies build outputs and the MSI used by online updates without launching UI.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const build = pkg.build || {};

function mustExist(rel, minBytes = 1) {
  const p = path.join(root, rel);
  assert.ok(fs.existsSync(p), `missing ${rel}`);
  const st = fs.statSync(p);
  if (st.isFile()) {
    assert.ok(st.size >= minBytes, `${rel} too small (${st.size})`);
  }
  return p;
}

function targetNames(targets) {
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((entry) => {
    if (typeof entry === "string") return [entry.toLowerCase()];
    if (!entry || typeof entry !== "object") return [];
    const target = entry.target;
    if (typeof target === "string") return [target.toLowerCase()];
    return Array.isArray(target)
      ? target.filter((value) => typeof value === "string").map((value) => value.toLowerCase())
      : [];
  });
}

function resolveArtifactName(template, extension) {
  const values = {
    productName: build.productName,
    name: pkg.name,
    version,
    arch: "x64",
    os: "win",
    ext: extension,
  };
  const name = template.replace(/\$\{(productName|name|version|arch|os|ext)\}/g, (_match, key) => {
    return values[key];
  });
  assert.ok(!/\$\{[^}]+\}/.test(name), `unsupported artifactName token: ${template}`);
  assert.equal(path.basename(name), name, `artifactName must not contain a path: ${template}`);
  assert.ok(name.toLowerCase().endsWith(`.${extension}`), `artifactName must end in .${extension}: ${name}`);
  return name;
}

// package metadata
assert.ok(version, "package.version");
assert.equal(build.appId, "com.cursor-studio.app");
assert.equal(build.productName, "Cursor Studio");
assert.ok(Array.isArray(build.win?.target), "win.target");
assert.notEqual(build.win?.signAndEditExecutable, false, "Windows executable resource editing must stay enabled");
assert.equal(build.win?.signExecutable, false, "unsigned builds must skip signing without skipping resource editing");
assert.equal(build.win?.executableName, "Cursor Studio");
assert.deepEqual(build.electronLanguages, ["zh-CN", "en-US"]);
const winTargets = targetNames(build.win.target);
assert.ok(winTargets.includes("msi"), "win.target must include msi for online updates");
assert.equal(typeof build.msi?.artifactName, "string", "msi.artifactName required for online updates");
const msiName = resolveArtifactName(build.msi.artifactName, "msi");

// source build artifacts (may exist from prior pack)
const distIndex = path.join(root, "dist", "index.html");
const hasDist = fs.existsSync(distIndex);
const distElectronMain = ["dist-electron/main.js", "dist-electron/main.cjs", "dist-electron/main.mjs"]
  .map((p) => path.join(root, p))
  .find((p) => fs.existsSync(p));
const hasElectronMain = Boolean(distElectronMain);

// release artifacts
const releaseDir = path.resolve(root, build.directories?.output || "release");
const msiPath = path.join(releaseDir, msiName);
const hasMsi = fs.existsSync(msiPath);

assert.ok(
  hasDist || hasMsi,
  "need at least dist/ or the release MSI from a prior build",
);
assert.ok(hasMsi, `missing required online update MSI: ${path.relative(root, msiPath)}`);

const report = {
  version,
  onlineUpdateArtifact: "msi",
  releaseDir: path.relative(root, releaseDir).replace(/\\/g, "/"),
  msiName,
  hasDist,
  hasElectronMain: Boolean(hasElectronMain),
  hasMsi,
  checks: [],
};

if (hasDist) {
  mustExist("dist/index.html", 20);
  report.checks.push("dist/index.html");
  // vite assets
  const assets = path.join(root, "dist", "assets");
  if (fs.existsSync(assets)) {
    const files = fs.readdirSync(assets);
    assert.ok(files.length > 0, "dist/assets empty");
    report.checks.push(`dist/assets:${files.length}`);
  }
}

if (hasElectronMain) {
  report.checks.push(path.relative(root, distElectronMain).replace(/\\/g, "/"));
  const preload = ["dist-electron/preload.mjs", "dist-electron/preload.cjs", "dist-electron/preload.js"]
    .map((p) => path.join(root, p))
    .find((p) => fs.existsSync(p));
  if (preload) report.checks.push(path.relative(root, preload).replace(/\\/g, "/"));
}

const msiStat = fs.statSync(msiPath);
assert.ok(msiStat.size > 5_000_000, `MSI too small: ${msiStat.size}`);
report.msiBytes = msiStat.size;
report.msi = {
  artifactName: msiName,
  path: path.relative(root, msiPath).replace(/\\/g, "/"),
  bytes: msiStat.size,
};
report.checks.push(`msi:${msiName}`);

const extraReleaseEntries = fs
  .readdirSync(releaseDir)
  .filter((entry) => entry !== msiName);
assert.deepEqual(extraReleaseEntries, [], `release contains stale artifacts: ${extraReleaseEntries.join(", ")}`);

// icon / resources for builder
mustExist("resources/icon.ico", 1_000);
report.checks.push("resources/icon.ico");
mustExist("resources/icon-runtime.png", 1_000);
report.checks.push("resources/icon-runtime.png");

// diagnostics module present for release hardening
mustExist("server/diagnostics/collect.ts", 100);
report.checks.push("diagnostics");

// write report
const outDir = path.join(root, "output", "release");
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, "smoke-release-report.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

console.log("PASS smoke-release", report);
