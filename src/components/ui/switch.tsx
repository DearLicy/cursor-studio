import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-[#c7d1d8] shadow-inner transition-colors duration-200 ease-out",
      "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#2d7ff0]/20",
      "disabled:cursor-not-allowed disabled:opacity-40",
      "data-[state=checked]:bg-[#1b9c8b] data-[state=unchecked]:bg-[#c7d1d8]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-150 ease-out",
        "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = "Switch";

/** 开关 + 标题描述 行 */
export function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "studio-subtle-surface flex items-center justify-between gap-4 rounded-[10px] border border-[#dce7ee] bg-[#f8fbfd] px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-[#1d2935]">{title}</div>
        {description && (
          <div className="mt-0.5 text-xs text-[#81909b] leading-relaxed">{description}</div>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
