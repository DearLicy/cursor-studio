import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "app-dialog-overlay",
      "fixed inset-0 z-[70] bg-[rgba(45,66,82,0.24)]",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showClose?: boolean;
    size?: "sm" | "md" | "lg" | "xl";
  }
>(({ className, children, showClose = true, size = "md", ...props }, ref) => {
  const sizeClass =
    size === "sm"
      ? "max-w-sm"
      : size === "lg"
        ? "max-w-2xl"
        : size === "xl"
          ? "max-w-3xl"
          : "max-w-lg";
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "app-dialog-content",
          "fixed left-1/2 top-1/2 z-[80] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
          "rounded-[17px] border border-[#d5e2eb] bg-white shadow-[0_20px_46px_rgba(63,103,135,0.18),0_3px_10px_rgba(63,103,135,0.08)]",
          "max-h-[min(90vh,860px)] overflow-hidden flex flex-col",
          sizeClass,
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            className="app-dialog-close absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-[#dce7ee] bg-[#edf4f7] text-[#71818e] shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#2d7ff0]/20"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "app-dialog-header",
        "flex flex-col gap-1 px-5 py-4 pr-12",
        className,
      )}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "app-dialog-footer",
        "flex flex-col-reverse gap-2 px-5 py-3 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("app-dialog-body flex-1 overflow-y-auto px-5 py-4", className)} {...props} />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "app-dialog-title",
      "text-[16px] font-semibold leading-tight tracking-normal text-[#1d2935]",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("app-dialog-description text-[12.5px] text-[#73818d] leading-relaxed", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
