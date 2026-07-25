import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
if (!existsSync(executable)) {
  throw new Error(`Electron executable was not found: ${executable}`);
}

const profileDir = path.join(process.env.TEMP || projectRoot, "cursor-studio-vite-manual");
const child = spawn(executable, [".", "--no-sandbox", `--user-data-dir=${profileDir}`], {
  cwd: projectRoot,
  detached: true,
  stdio: "ignore",
  windowsHide: false,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173/",
  },
});
child.unref();
console.log(`Electron development process started (pid ${child.pid}).`);
