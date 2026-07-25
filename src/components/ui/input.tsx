import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      "flex h-[35px] w-full rounded-[10px] border border-[#d7e2ea] bg-white px-3 py-1 text-sm text-[#1d2935] transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-[#98a5af] hover:border-[#bdcfdb] focus-visible:outline-none focus-visible:border-[#2d7ff0] focus-visible:ring-[3px] focus-visible:ring-[#2d7ff0]/15 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      "flex min-h-[88px] w-full rounded-[10px] border border-[#d7e2ea] bg-white px-3 py-2 text-sm text-[#1d2935] transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-[#98a5af] hover:border-[#bdcfdb] focus-visible:outline-none focus-visible:border-[#2d7ff0] focus-visible:ring-[3px] focus-visible:ring-[#2d7ff0]/15 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none text-[#53616d] peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}
