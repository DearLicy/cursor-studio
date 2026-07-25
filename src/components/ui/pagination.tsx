import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  onPageSizeChange,
  pageSizeOptions,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (safe - 1) * pageSize + 1;
  const to = Math.min(total, safe * pageSize);
  const normalizedPageSizeOptions = [...new Set((pageSizeOptions || [])
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value)))].sort((a, b) => a - b);
  const canChangePageSize = Boolean(onPageSizeChange && normalizedPageSizeOptions.length);
  const pageSizeValues = normalizedPageSizeOptions.includes(pageSize)
    ? normalizedPageSizeOptions
    : [...normalizedPageSizeOptions, pageSize].sort((a, b) => a - b);
  const pageSizeControl = canChangePageSize ? (
    <label className="pagination__page-size">
      <span>每页显示</span>
      <SimpleSelect
        value={String(pageSize)}
        onValueChange={(value) => onPageSizeChange?.(Number(value))}
        options={pageSizeValues.map((value) => ({ value: String(value), label: `${value} 条` }))}
        className="pagination__page-size-select h-[30px] w-[72px] rounded-[8px] px-2 text-xs"
      />
    </label>
  ) : null;

  if (total <= pageSize) {
    return total > 0 || pageSizeControl ? (
      <div className={cn("pagination pagination--compact flex min-h-[30px] items-center text-xs text-[#999]", className)}>
        {pageSizeControl || <span>共 {total} 条</span>}
      </div>
    ) : null;
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 pt-1 text-xs text-[#888]",
        className,
      )}
    >
      {pageSizeControl || <span>第 {from}-{to} 条 · 共 {total}</span>}
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-[30px] w-[30px] rounded-[8px] p-0"
          disabled={safe <= 1}
          onClick={() => onChange(safe - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[3.5rem] text-center tabular-nums">
          {safe} / {pages}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-[30px] w-[30px] rounded-[8px] p-0"
          disabled={safe >= pages}
          onClick={() => onChange(safe + 1)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function slicePage<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (Math.max(1, page) - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
