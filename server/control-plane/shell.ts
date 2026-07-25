import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** 在资源管理器中显示文件 */
export async function shellOpenPath(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("explorer.exe", ["/select,", path.resolve(filePath)]);
    return;
  }
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", filePath]);
    return;
  }
  await execFileAsync("xdg-open", [path.dirname(filePath)]);
}