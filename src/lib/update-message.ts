import i18n from "@/lib/i18n";
import type { UpdateMessage, UpdateMessageCode } from "../../shared/update-contract";

const MESSAGE_KEYS: Record<UpdateMessageCode, string> = {
  "desktop-required-check": "update.message.desktopRequiredCheck",
  "desktop-required-install": "update.message.desktopRequiredInstall",
  "development-only": "update.message.developmentOnly",
  "windows-only": "update.message.windowsOnly",
  "not-configured": "update.message.notConfigured",
  available: "update.message.available",
  "up-to-date": "update.message.upToDate",
  "check-failed": "update.message.checkFailed",
  "no-update": "update.message.noUpdate",
  restarting: "update.message.restarting",
  "install-failed": "update.message.installFailed",
};

export function translateUpdateMessage(
  message: UpdateMessage | undefined,
  fallback: UpdateMessageCode,
): string {
  const resolved = message || { code: fallback };
  const args = "args" in resolved ? resolved.args : undefined;
  return String(i18n.t(MESSAGE_KEYS[resolved.code], args));
}

export function updateMessageDetail(message: UpdateMessage | undefined): string | undefined {
  return message && "detail" in message ? message.detail : undefined;
}
