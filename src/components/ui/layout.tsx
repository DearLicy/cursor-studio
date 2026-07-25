import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
  hideTitle = false,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  /** Hide the page title when a shell already supplies one. */
  hideTitle?: boolean;
}) {
  return (
    <div className={cn("cs-page-head", className)}>
      <div className="min-w-0">
        {!hideTitle && title ? <h1 className="cs-page-title">{title}</h1> : null}
        {description ? <p className="cs-page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("studio-empty", className)}>
      {icon ? (
        <div className="mx-auto mb-3 flex justify-center text-[var(--cs-ink-4,#a1a1aa)]">
          {icon}
        </div>
      ) : null}
      <div className="text-[13px] font-semibold text-[var(--cs-ink-2,#3f3f46)]">{title}</div>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-[var(--cs-ink-3,#71717a)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function LoadingState({
  label = "加载中…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("studio-loading py-10", className)} role="status" aria-live="polite">
      <span className="studio-loading-dot" />
      <span>{label}</span>
    </div>
  );
}

export function StatusBanner({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "success" | "warn" | "danger";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("studio-status", tone, className)} role="status">
      <div className="min-w-0 flex-1">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn(title ? "mt-1 opacity-90" : undefined)}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "出错了",
  description,
  action,
  className,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("studio-empty", className)}>
      <div className="text-[13px] font-semibold text-[var(--cs-bad,#dc2626)]">{title}</div>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-[var(--cs-ink-3,#71717a)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-end justify-between gap-2">
        <label className="text-[12.5px] font-medium text-[var(--cs-ink-2,#3f3f46)]">{label}</label>
        {hint ? <span className="text-[11px] text-[var(--cs-ink-4,#a1a1aa)]">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "搜索…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      className={cn("field-input max-w-xs", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("cs-panel", className)}>
      {(title || actions) ? (
        <div className="cs-panel-head">
          <div className="min-w-0">
            {title ? <h2 className="cs-panel-title">{title}</h2> : null}
            {description ? <p className="cs-panel-sub">{description}</p> : null}
          </div>
          {actions ? <div className="cs-panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="cs-panel-body">{children}</div>
    </section>
  );
}
