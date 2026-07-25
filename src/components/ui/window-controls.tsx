import { Minus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

type WindowApi = {
  minimize: () => Promise<void> | void;
  close: () => Promise<void> | void;
};

function getWindowApi(): WindowApi | null {
  if (typeof window === "undefined") return null;
  return window.studioWindow ?? null;
}

/** 无边框窗口控制：仅最小化 / 关闭（不要最大化） */
export function WindowControls({ className }: { className?: string }) {
  const api = getWindowApi();
  const [available, setAvailable] = useState(Boolean(api));

  useEffect(() => {
    setAvailable(Boolean(getWindowApi()));
  }, []);

  if (!available || !api) return null;

  return (
    <div className={cn("flex items-center gap-0.5", className)} data-no-drag>
      <button
        type="button"
        className="window-ctrl"
        aria-label="最小化"
        onClick={() => void api.minimize()}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={2.2} />
      </button>
      <button
        type="button"
        className="window-ctrl window-ctrl-close"
        aria-label="关闭"
        onClick={() => void api.close()}
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.2} />
      </button>
    </div>
  );
}

declare global {
  interface Window {
    studioWindow?: WindowApi & {
      maximize?: () => Promise<void> | void;
      isMaximized?: () => Promise<boolean>;
      onMaximizedChange?: (cb: (maximized: boolean) => void) => () => void;
    };
  }
}
