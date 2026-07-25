import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({
  className,
  interactive,
  active,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "studio-surface rounded-[17px] border border-[#dce7ee] bg-white shadow-[0_10px_26px_rgba(74,119,153,0.07),0_2px_5px_rgba(74,119,153,0.04)]",
        "transition-[border-color,box-shadow,transform] duration-200",
        interactive &&
          "cursor-pointer hover:border-[#b8cddd] hover:shadow-[0_12px_30px_rgba(74,119,153,0.10)] hover:-translate-y-px",
        active && "border-[#2d7ff0] shadow-[0_0_0_1px_rgba(45,127,240,0.18)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-start justify-between gap-3 px-5 py-4", className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-sm font-semibold text-[#1d2935]", className)} {...props} />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-[#81909b] mt-0.5", className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}
