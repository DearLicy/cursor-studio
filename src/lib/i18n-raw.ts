import { createElement, Fragment, type ReactNode } from "react";

/** Render application or user data without treating it as a translation key. */
export function RawText({ children }: { children: ReactNode }) {
  return createElement(Fragment, null, children);
}
