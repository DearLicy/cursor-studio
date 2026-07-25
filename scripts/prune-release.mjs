import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const releaseDir = path.resolve(root, pkg.build?.directories?.output || "release");
const artifactName = pkg.build?.msi?.artifactName;

if (typeof artifactName !== "string" || !artifactName.toLowerCase().endsWith(".msi")) {
  throw new Error("The MSI artifact name is not configured.");
}

const artifactPath = path.join(releaseDir, artifactName);
const artifact = await fs.stat(artifactPath).catch(() => null);
if (!artifact?.isFile() || artifact.size < 5_000_000) {
  throw new Error(`The expected MSI is missing or incomplete: ${artifactPath}`);
}

for (const entry of await fs.readdir(releaseDir)) {
  if (entry === artifactName) continue;
  await fs.rm(path.join(releaseDir, entry), { recursive: true, force: true });
}

console.log(`Release directory pruned to ${artifactName}`);
