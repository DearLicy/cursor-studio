/**
 * 无 Electron 的原生文件/目录选择（Windows: WinForms；其它: 回退 null）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pickImageFile(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '选择背景图片 / 视频'
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
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '选择头像图片'
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
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择随机图库目录'
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
