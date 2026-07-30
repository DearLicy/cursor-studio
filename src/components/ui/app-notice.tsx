import type { ReactNode } from "react";
import { Toaster, toast as sonnerToast } from "sonner";
import { translateUiText } from "@/lib/i18n";

export type NoticeInput = {
  title?: string;
  description?: string;
  duration?: number;
};

type NoticeApi = {
  success: (message: string, opts?: NoticeInput | string) => void;
  error: (message: string, opts?: NoticeInput | string) => void;
  message: (message: string, opts?: NoticeInput | string) => void;
  info: (message: string, opts?: NoticeInput | string) => void;
  dismiss: (id?: string | number) => void;
};

function normalizeOpts(
  message: string,
  opts?: NoticeInput | string,
): { title: string; description?: string; duration?: number } {
  if (typeof opts === "string") {
    return { title: message, description: opts };
  }
  return {
    title: opts?.title || message,
    description: opts?.description,
    duration: opts?.duration,
  };
}

function notify(
  method: "success" | "error" | "message" | "info",
  message: string,
  opts?: NoticeInput | string,
) {
  const normalized = normalizeOpts(message, opts);
  sonnerToast[method](translateUiText(normalized.title), {
    description: normalized.description
      ? translateUiText(normalized.description)
      : undefined,
    duration: normalized.duration,
  });
}

export function AppNoticeProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster
        className="app-notice-toaster"
        position="top-center"
        theme="light"
        richColors={false}
        closeButton={false}
        expand={false}
        visibleToasts={3}
      />
    </>
  );
}

/** Stable application-facing API backed by Sonner. */
export const toast: NoticeApi = {
  success: (message, opts) => notify("success", message, opts),
  error: (message, opts) => notify("error", message, opts),
  message: (message, opts) => notify("message", message, opts),
  info: (message, opts) => notify("info", message, opts),
  dismiss: (id) => sonnerToast.dismiss(id),
};

export function useNotice() {
  return toast;
}
