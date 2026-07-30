export type UpdateMessage =
  | { code: "desktop-required-check" }
  | { code: "desktop-required-install" }
  | { code: "development-only" }
  | { code: "windows-only" }
  | { code: "not-configured" }
  | { code: "available"; args: { version: string } }
  | { code: "up-to-date" }
  | { code: "check-failed"; detail?: string }
  | { code: "no-update" }
  | { code: "restarting" }
  | { code: "install-failed"; detail?: string };

export type UpdateMessageCode = UpdateMessage["code"];
