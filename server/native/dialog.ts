/**
 * 无 Electron 的原生文件/目录选择（Windows: WinForms；其它: 回退 null）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getNativeStrings } from "../runtime/native-locale";

const execFileAsync = promisify(execFile);

function powerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function pickImageFile(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const strings = await getNativeStrings();
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = ${powerShellString(strings.dialog.pickBackground)}
$d.Filter = 'Media|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.mp4;*.webm;*.mov|All|*.*'
$d.Multiselect = $false
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName } else { '' }
`.trim();
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", ps],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}

export async function pickAvatarFile(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const strings = await getNativeStrings();
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = ${powerShellString(strings.dialog.pickAvatar)}
$d.Filter = 'Images|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.svg|All|*.*'
$d.Multiselect = $false
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName } else { '' }
`.trim();
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", ps],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}

export async function pickFolder(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const strings = await getNativeStrings();
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = ${powerShellString(strings.dialog.pickRandomImageFolder)}
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath } else { '' }
`.trim();
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", ps],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}
