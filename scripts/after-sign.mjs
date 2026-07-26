import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fourPartVersion(version) {
  const parts = version.split(/[+-]/, 1)[0].split(".").map((part) => Number.parseInt(part, 10));
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).map((part) => (Number.isFinite(part) ? part : 0)).join(".");
}

export default async function writeWindowsVersionInfo(context) {
  if (context.electronPlatformName !== "win32") return;

  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const productName = pkg.build?.productName || pkg.productName || pkg.name;
  const executableName = pkg.build?.win?.executableName || productName;
  const executablePath = path.join(context.appOutDir, `${executableName}.exe`);
  const authorName = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  const fixedVersion = fourPartVersion(pkg.version);

  const input = await fs.readFile(executablePath);
  const executable = NtExecutable.from(input);
  const resources = NtExecutableResource.from(executable);
  const versionInfos = Resource.VersionInfo.fromEntries(resources.entries);
  if (versionInfos.length === 0) {
    throw new Error(`No Windows version resource found in ${executablePath}`);
  }

  for (const versionInfo of versionInfos) {
    const languages = versionInfo.getAllLanguagesForStringValues();
    const targets = languages.length > 0 ? languages : [{ lang: 0x0409, codepage: 1200 }];
    versionInfo.setFileVersion(fixedVersion);
    versionInfo.setProductVersion(fixedVersion);
    for (const language of targets) {
      versionInfo.setStringValues(language, {
        CompanyName: authorName || productName,
        FileDescription: productName,
        FileVersion: pkg.version,
        InternalName: executableName,
        LegalCopyright: pkg.build?.copyright || "",
        OriginalFilename: `${executableName}.exe`,
        ProductName: productName,
        ProductVersion: pkg.version,
      });
    }
    versionInfo.outputToResourceEntries(resources.entries);
  }

  resources.outputResource(executable);
  await fs.writeFile(executablePath, Buffer.from(executable.generate()));
  console.log(`Applied Cursor Studio version information to ${executablePath}`);
}
