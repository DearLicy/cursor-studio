import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "bg-[#eef5f9] text-[#5e6d78]",
  success: "bg-[#e8f7f3] text-[#167c6e]",
  warn: "bg-[#fff4e7] text-[#b96c18]",
  danger: "bg-[#fff0f1] text-[#c84d5b]",
  solid: "bg-[#1d2935] text-white",
} as const;

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: keyof typeof variants;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[7px] px-2 py-0.5 text-[11px] font-semibold tracking-normal",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
