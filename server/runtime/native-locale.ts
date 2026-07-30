import { loadConfig } from "../config/store";

export type NativeLocale = "en" | "zh-CN";

export interface NativeLocaleStrings {
  tray: {
    running: string;
    notRunning: string;
    startService: string;
    stopService: string;
    showWindow: string;
    hideWindow: string;
    quit: string;
    todayUsage: (tokens: string) => string;
    tooltip: (status: string, tokens: string) => string;
  };
  dialog: {
    pickBackground: string;
    pickAvatar: string;
    pickRandomImageFolder: string;
  };
}

const STRINGS: Record<NativeLocale, NativeLocaleStrings> = {
  en: {
    tray: {
      running: "Running",
      notRunning: "Not running",
      startService: "Start service",
      stopService: "Stop service",
      showWindow: "Show window",
      hideWindow: "Hide window",
      quit: "Quit",
      todayUsage: (tokens) => `Today's usage: ${tokens} tokens`,
      tooltip: (status, tokens) =>
        `Cursor Studio · ${status} · Today ${tokens} tokens`,
    },
    dialog: {
      pickBackground: "Choose background image or video",
      pickAvatar: "Choose avatar image",
      pickRandomImageFolder: "Choose random image folder",
    },
  },
  "zh-CN": {
    tray: {
      running: "启动中",
      notRunning: "未启动",
      startService: "启动服务",
      stopService: "停止服务",
      showWindow: "显示窗口",
      hideWindow: "隐藏窗口",
      quit: "退出",
      todayUsage: (tokens) => `今日用量：${tokens} token`,
      tooltip: (status, tokens) =>
        `Cursor Studio · ${status} · 今日 ${tokens} token`,
    },
    dialog: {
      pickBackground: "选择背景图片 / 视频",
      pickAvatar: "选择头像图片",
      pickRandomImageFolder: "选择随机图库目录",
    },
  },
};

function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en";
  } catch {
    return "en";
  }
}

export function resolveNativeLocale(
  configuredLocale: unknown,
  currentSystemLocale = systemLocale(),
): NativeLocale {
  if (configuredLocale === "en" || configuredLocale === "zh-CN") {
    return configuredLocale;
  }
  return /^zh(?:-|_|$)/i.test(currentSystemLocale) ? "zh-CN" : "en";
}

export async function getNativeLocale(
  currentSystemLocale?: string,
): Promise<NativeLocale> {
  let configuredLocale: unknown = "system";
  try {
    configuredLocale = (await loadConfig()).locale;
  } catch {
    // Native UI should remain usable even when the configuration is unreadable.
  }
  return resolveNativeLocale(
    configuredLocale,
    currentSystemLocale?.trim() || systemLocale(),
  );
}

export async function getNativeStrings(
  currentSystemLocale?: string,
): Promise<NativeLocaleStrings> {
  return STRINGS[await getNativeLocale(currentSystemLocale)];
}
