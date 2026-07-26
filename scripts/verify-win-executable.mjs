import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import asar from "@electron/asar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const releaseDir = path.resolve(root, pkg.build?.directories?.output || "release");
const productName = pkg.build?.productName || pkg.productName || pkg.name;
const executableName = pkg.build?.win?.executableName || productName;
const executablePath = path.join(releaseDir, "win-unpacked", `${executableName}.exe`);
const iconPath = path.resolve(root, pkg.build?.win?.icon || "resources/icon.ico");
const authorName = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;

assert.ok(fs.existsSync(executablePath), `missing packaged executable: ${executablePath}`);
assert.ok(fs.statSync(executablePath).size > 10_000_000, "packaged executable is unexpectedly small");

const executable = NtExecutable.from(fs.readFileSync(executablePath));
const resources = NtExecutableResource.from(executable);
const versionInfos = Resource.VersionInfo.fromEntries(resources.entries);
assert.ok(versionInfos.length > 0, "packaged executable has no version resource");

const stringTables = versionInfos.flatMap((versionInfo) => {
  return versionInfo.getAllLanguagesForStringValues().map((language) => versionInfo.getStringValues(language));
});
const expected = {
  CompanyName: authorName,
  FileDescription: productName,
  FileVersion: pkg.version,
  InternalName: executableName,
  LegalCopyright: pkg.build?.copyright,
  OriginalFilename: `${executableName}.exe`,
  ProductName: productName,
  ProductVersion: pkg.version,
};
const matchingTable = stringTables.find((values) => {
  return Object.entries(expected).every(([key, value]) => values[key] === value);
});
assert.ok(matchingTable, `Windows version information mismatch: ${JSON.stringify(stringTables)}`);
assert.ok(
  stringTables.every((values) => !Object.values(values).some((value) => /electron|github,? inc\.?/i.test(value))),
  "packaged executable still contains Electron product metadata",
);

function iconBytes(item) {
  return Buffer.from(item.isRaw() ? item.bin : item.generate());
}

function digest(item) {
  return crypto.createHash("sha256").update(iconBytes(item)).digest("hex");
}

const sourceIcon = Data.IconFile.from(fs.readFileSync(iconPath));
const sourceHashes = new Set(sourceIcon.icons.map(({ data }) => digest(data)));
const iconGroups = Resource.IconGroupEntry.fromEntries(resources.entries);
assert.ok(iconGroups.length > 0, "packaged executable has no icon group resource");
const packagedIcons = iconGroups.flatMap((group) => group.getIconItemsFromEntries(resources.entries));
const packagedHashes = new Set(packagedIcons.map(digest));
for (const sourceHash of sourceHashes) {
  assert.ok(packagedHashes.has(sourceHash), "packaged executable icon does not match resources/icon.ico");
}

const dimensions = [...new Set(sourceIcon.icons.map(({ data }) => `${data.width}x${data.height}`))].sort();
for (const required of ["16x16", "32x32", "48x48", "256x256"]) {
  assert.ok(dimensions.includes(required), `resources/icon.ico is missing ${required}`);
}

const appAsarPath = path.join(releaseDir, "win-unpacked", "resources", "app.asar");
assert.ok(fs.existsSync(appAsarPath), "packaged app.asar is missing");
const asarEntries = asar.listPackage(appAsarPath);
assert.ok(
  asarEntries.every((entry) => !/^\\\\node_modules(?:\\\\|$)/i.test(entry)),
  "app.asar contains bundled node_modules even though all runtime imports are compiled",
);

const localesDir = path.join(releaseDir, "win-unpacked", "locales");
const packagedLocales = fs.readdirSync(localesDir).filter((entry) => entry.toLowerCase().endsWith(".pak"));
const allowedLocales = new Set((pkg.build?.electronLanguages || []).map((locale) => `${locale}.pak`.toLowerCase()));
assert.ok(packagedLocales.length > 0, "no Electron locale resources were packaged");
assert.ok(
  packagedLocales.every((entry) => allowedLocales.has(entry.toLowerCase())),
  `unexpected Electron locales: ${packagedLocales.join(", ")}`,
);

const runtimeResourcesDir = path.join(releaseDir, "win-unpacked", "resources", "resources");
const forbiddenRuntimeResources = ["icon-round.png", "icon-source.png", "icon.png", "icon.ico"];
for (const filename of forbiddenRuntimeResources) {
  assert.ok(!fs.existsSync(path.join(runtimeResourcesDir, filename)), `unused runtime resource was packaged: ${filename}`);
}

const unpackedBytes = fs.readdirSync(path.join(releaseDir, "win-unpacked"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .reduce((total, entry) => total + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);

console.log("PASS verify-win-executable", {
  executablePath,
  version: pkg.version,
  productName,
  companyName: authorName,
  originalFilename: `${executableName}.exe`,
  iconSizes: dimensions,
  locales: packagedLocales,
  appAsarBytes: fs.statSync(appAsarPath).size,
  unpackedBytes,
});
