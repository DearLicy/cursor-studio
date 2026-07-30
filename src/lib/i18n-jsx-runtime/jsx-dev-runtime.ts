import {
  Fragment,
  jsxDEV as reactJsxDEV,
  type JSX,
} from "react/jsx-dev-runtime";
import { translateUiText } from "@/lib/i18n";
import { RawText } from "@/lib/i18n-raw";

export { Fragment };
export type { JSX };

function localizeValue(value: unknown): unknown {
  if (typeof value === "string") return translateUiText(value);
  if (Array.isArray(value)) return value.map(localizeValue);
  return value;
}

function localizeProps(
  type: unknown,
  props: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!props) return props;
  if (type === RawText) return props;
  const next = { ...props };
  if (next["data-i18n-raw"] === true) {
    if (typeof type === "string") delete next["data-i18n-raw"];
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(next, "children")) {
    next.children = localizeValue(next.children);
  }
  for (const name of ["placeholder", "title", "aria-label", "alt"] as const) {
    if (typeof next[name] === "string") next[name] = translateUiText(next[name] as string);
  }
  if (next.readOnly === true && typeof next.value === "string") {
    next.value = translateUiText(next.value);
  }
  return next;
}

export function jsxDEV(
  type: unknown,
  props: Record<string, unknown> | null,
  key: string | undefined,
  isStaticChildren: boolean,
  source: unknown,
  self: unknown,
) {
  return reactJsxDEV(
    type as never,
    localizeProps(type, props),
    key,
    isStaticChildren,
    source as never,
    self,
  );
}
