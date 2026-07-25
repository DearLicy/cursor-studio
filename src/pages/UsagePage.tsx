import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Database,
  Download,
  Gauge,
  RefreshCw,
  Search,
  Trash2,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "@/components/ui/app-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination, slicePage } from "@/components/ui/pagination";
import { SimpleSelect } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import {
  getApi,
  type HomeMetrics,
  type RequestLogItem,
} from "@/lib/api";

type RangeKey = "24h" | "7d" | "30d" | "90d" | "all";
type StatusFilter = "all" | "ok" | "error";
type SourceFilter = "all" | "ide" | "agent" | "unknown";
type TrendSeries = "tokens" | "cost" | "requests";

type UsageSummary = {
  requests: number;
  valid: number;
  errors: number;
  tokens: number;
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  pricedRequests: number;
  cacheHitRate: number;
  successRate: number;
};

type ProviderStat = {
  name: string;
  requests: number;
  valid: number;
  tokens: number;
  cost: number;
  color: string;
};

type ModelStat = {
  name: string;
  requests: number;
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  cost: number;
  pricedRequests: number;
};

type TrendPoint = {
  label: string;
  tooltipLabel: string;
  start: number;
  end: number;
  tokens: number;
  requests: number;
  cost: number;
};

type PriceSource = NonNullable<RequestLogItem["priceSnapshot"]>["source"];

const LOG_PAGE_SIZE = 16;
const PROVIDER_COLORS = ["#2d7ff0", "#1b9c8b", "#8a75dc", "#ef9b38", "#db6674"];
const TREND_SERIES: TrendSeries[] = ["tokens", "cost", "requests"];
const RANGE_LABELS: Record<RangeKey, string> = {
  "24h": "24h",
  "7d": "7 天",
  "30d": "30 天",
  "90d": "90 天",
  all: "全部",
};

function compactNumber(value: number): string {
  const amount = Math.max(0, Number(value) || 0);
  if (amount >= 1_000_000_000) return `${trimDecimal(amount / 1_000_000_000)}B`;
  if (amount >= 1_000_000) return `${trimDecimal(amount / 1_000_000)}M`;
  if (amount >= 1_000) return `${trimDecimal(amount / 1_000)}K`;
  return Math.round(amount).toLocaleString();
}

function trimDecimal(value: number): string {
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(precision).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

function formatUsd(value: number): string {
  const amount = Math.max(0, Number(value) || 0);
  if (!amount) return "$0.00";
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, value * 100)).toFixed(1)}%`;
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function displayUpdatedAt(value?: string): string {
  if (!value) return "等待首次更新";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "等待首次更新";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前更新`;
  return `${Math.floor(minutes / (24 * 60))} 天前更新`;
}

function rangeStart(range: RangeKey): number {
  const now = Date.now();
  if (range === "all") return 0;
  const hours = range === "24h" ? 24 : Number(range.slice(0, -1)) * 24;
  return now - hours * 60 * 60 * 1000;
}

function isPriced(item: RequestLogItem): boolean {
  const source = item.priceSnapshot?.source;
  return source === "models-dev" || source === "model" || source === "provider";
}

function requestSourceLabel(source?: string): string {
  if (source === "ide") return "编辑器";
  if (source === "agent") return "应用";
  return "其他来源";
}

function sourceName(source?: PriceSource): string {
  switch (source) {
    case "models-dev":
      return "已匹配价格";
    case "model":
    case "provider":
      return "已设置价格";
    default:
      return "待定价";
  }
}

function downloadCsv(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `cursor-studio-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function buildTrend(logs: RequestLogItem[], range: RangeKey): TrendPoint[] {
  if (!logs.length) return [];
  const end = Date.now();
  let count = 14;
  let span = 24 * 60 * 60 * 1000;

  if (range === "24h") {
    count = 12;
    span = 2 * 60 * 60 * 1000;
  } else if (range === "7d") {
    count = 7;
  } else if (range === "30d") {
    count = 15;
    span = 2 * 24 * 60 * 60 * 1000;
  } else if (range === "90d") {
    count = 13;
    span = 7 * 24 * 60 * 60 * 1000;
  } else {
    const oldest = Math.min(...logs.map((item) => Date.parse(item.at)).filter(Number.isFinite));
    span = Number.isFinite(oldest)
      ? Math.max(24 * 60 * 60 * 1000, Math.ceil((end - oldest) / count))
      : span;
  }

  const start = end - count * span;
  const points = Array.from({ length: count }, (_, index) => {
    const pointStart = start + index * span;
    const pointEnd = pointStart + span;
    const midpoint = new Date(pointStart + span / 2);
    const label = range === "24h"
      ? midpoint.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : midpoint.toLocaleDateString([], { month: "numeric", day: "numeric" });
    const tooltipLabel = range === "24h"
      ? `${new Date(pointStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${new Date(pointEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : label;
    return {
      label,
      tooltipLabel,
      start: pointStart,
      end: pointEnd,
      tokens: 0,
      requests: 0,
      cost: 0,
    };
  });

  for (const item of logs) {
    const at = Date.parse(item.at);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const index = Math.min(count - 1, Math.max(0, Math.floor((at - start) / span)));
    const point = points[index];
    point.tokens += Math.max(0, item.requestTokens || 0);
    point.requests += 1;
    point.cost += Math.max(0, item.costUsd || 0);
  }

  return points;
}

function UsageTrendChart({ points }: { points: TrendPoint[] }) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<TrendSeries>>(() => new Set());
  const hasData = points.some((point) => point.tokens > 0 || point.requests > 0 || point.cost > 0);
  const xInterval = points.length > 12 ? 1 : 0;

  const toggleSeries = (series: TrendSeries) => {
    setHiddenSeries((current) => {
      const next = new Set(current);
      if (next.has(series)) next.delete(series);
      else next.add(series);
      return next;
    });
  };

  if (!hasData) {
    return <DashboardEmpty label="当前范围内暂无趋势数据" className="usage-dashboard__trend-empty" />;
  }

  return (
    <div className="usage-dashboard__trend-wrap" aria-label="Token、请求和费用趋势">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 12, right: 6, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id="usage-token-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2d7ff0" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#2d7ff0" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#e7eff4" strokeDasharray="3 4" />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            interval={xInterval}
            minTickGap={18}
            tick={{ fill: "#94a3ae", fontSize: 11 }}
          />
          <YAxis
            yAxisId="tokens"
            axisLine={false}
            tickLine={false}
            tickMargin={8}
            width={46}
            tickFormatter={(value: number) => compactNumber(value)}
            tick={{ fill: "#94a3ae", fontSize: 11 }}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            axisLine={false}
            tickLine={false}
            tickMargin={8}
            width={46}
            tickFormatter={(value: number) => formatUsd(value)}
            tick={{ fill: "#94a3ae", fontSize: 11 }}
          />
          <YAxis yAxisId="requests" hide />
          <Tooltip cursor={false} content={<UsageTrendTooltip />} />
          <Bar
            yAxisId="cost"
            dataKey="cost"
            name="费用"
            fill="#1b9c8b"
            fillOpacity={0.42}
            radius={[4, 4, 0, 0]}
            maxBarSize={30}
            hide={hiddenSeries.has("cost")}
            animationDuration={620}
            animationEasing="ease-out"
          />
          <Area
            yAxisId="tokens"
            dataKey="tokens"
            name="Tokens"
            type="monotone"
            stroke="#2d7ff0"
            strokeWidth={1.7}
            fill="url(#usage-token-fill)"
            dot={false}
            activeDot={{ r: 3.5, fill: "#2d7ff0", stroke: "#f8fcff", strokeWidth: 2 }}
            hide={hiddenSeries.has("tokens")}
            animationDuration={620}
            animationEasing="ease-out"
          />
          <Line
            yAxisId="requests"
            dataKey="requests"
            name="请求"
            type="monotone"
            stroke="#8c79dd"
            strokeWidth={1.4}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 3.5, fill: "#8c79dd", stroke: "#f8fcff", strokeWidth: 2 }}
            hide={hiddenSeries.has("requests")}
            animationDuration={620}
            animationEasing="ease-out"
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="usage-dashboard__trend-legend" aria-label="趋势图例">
        {TREND_SERIES.map((series) => {
          const hidden = hiddenSeries.has(series);
          const label = series === "tokens" ? "Tokens" : series === "cost" ? "费用" : "请求";
          return (
            <button
              key={series}
              type="button"
              className={hidden ? "is-muted" : undefined}
              aria-pressed={!hidden}
              onClick={() => toggleSeries(series)}
            >
              <TrendLegendMark series={series} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UsageTrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    color?: string;
    dataKey?: string | number;
    name?: string | number;
    value?: string | number;
    payload?: TrendPoint;
  }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  const rows = [
    { key: "tokens", label: "Tokens", value: point?.tokens ?? 0, color: "#2d7ff0" },
    { key: "cost", label: "费用", value: point?.cost ?? 0, color: "#1b9c8b" },
    { key: "requests", label: "请求", value: point?.requests ?? 0, color: "#8c79dd" },
  ];

  return (
    <div className="usage-dashboard__chart-tooltip">
      <strong>{point?.tooltipLabel || "当前时段"}</strong>
      {rows.map((row) => (
        <span key={row.key}>
          <i style={{ backgroundColor: row.color }} />
          <em>{row.label}</em>
          <b>{row.key === "cost" ? formatUsd(Number(row.value)) : compactNumber(Number(row.value))}</b>
        </span>
      ))}
    </div>
  );
}

function TrendLegendMark({ series }: { series: TrendSeries }) {
  if (series === "cost") return <i className="usage-dashboard__legend-cost" aria-hidden="true" />;
  return <i className={`usage-dashboard__legend-line is-${series}`} aria-hidden="true" />;
}

function ProviderDistribution({
  stats,
  providerLabel,
}: {
  stats: ProviderStat[];
  providerLabel: (id?: string) => string;
}) {
  const [hoveredStripe, setHoveredStripe] = useState<number | null>(null);
  const totalRequests = stats.reduce((sum, item) => sum + item.requests, 0);
  const totalSuccessful = stats.reduce((sum, item) => sum + item.valid, 0);
  const successRate = totalRequests ? totalSuccessful / totalRequests : 0;
  const stripes = useMemo(() => buildProviderStripes(stats, totalRequests), [stats, totalRequests]);
  const hovered = hoveredStripe === null ? null : stripes[hoveredStripe] || null;
  const hoveredShare = hovered && totalRequests ? hovered.requests / totalRequests : 0;
  const tooltipPosition = hoveredStripe === null
    ? 50
    : Math.max(14, Math.min(86, ((hoveredStripe + 0.5) / Math.max(1, stripes.length)) * 100));

  if (!stats.length) {
    return <DashboardEmpty label="当前范围内暂无来源数据" className="usage-dashboard__provider-empty" />;
  }

  return (
    <div className="usage-dashboard__provider-content">
      <div className="usage-dashboard__provider-rate">
        <span>成功率</span>
        <strong>{formatPercent(successRate)}</strong>
      </div>
      <div className="usage-dashboard__provider-stripes-wrap">
        <div
          className="usage-dashboard__provider-stripes"
          aria-label="供应商请求占比"
          onPointerLeave={() => setHoveredStripe(null)}
        >
          {stripes.map((item, index) => (
            <span
              key={`${item?.name || "empty"}-${index}`}
              className={hoveredStripe === index ? "is-hovered" : undefined}
              style={{ backgroundColor: item?.color || "#eaf1f5" }}
              onPointerEnter={() => setHoveredStripe(index)}
              title={item ? `${providerLabel(item.name)}: ${item.requests} 次请求` : "暂无请求"}
            />
          ))}
        </div>
        {hovered ? (
          <div className="usage-dashboard__provider-tooltip" style={{ left: `${tooltipPosition}%` }}>
            {providerLabel(hovered.name)} · {hovered.requests} 次 · {formatPercent(hoveredShare)}
          </div>
        ) : null}
      </div>
      <div className="usage-dashboard__provider-list">
        {stats.map((item) => {
          const share = totalRequests ? item.requests / totalRequests : 0;
          const itemSuccessRate = item.requests ? item.valid / item.requests : 0;
          return (
            <div className="usage-dashboard__provider-row" key={item.name}>
              <i style={{ backgroundColor: item.color }} />
              <div>
                <strong title={providerLabel(item.name)}>{providerLabel(item.name)}</strong>
                <span>{formatPercent(itemSuccessRate)} 成功率 · {compactNumber(item.tokens)} Tokens</span>
              </div>
              <aside>
                <strong>{item.requests.toLocaleString()}</strong>
                <span>{formatPercent(share)}</span>
              </aside>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildProviderStripes<T extends { requests: number }>(providers: T[], totalRequests: number): Array<T | null> {
  const count = 36;
  if (!totalRequests) return Array.from({ length: count }, () => null);
  let accumulated = 0;
  const boundaries = providers.map((provider) => {
    accumulated += provider.requests / totalRequests;
    return accumulated;
  });
  return Array.from({ length: count }, (_, index) => {
    const position = (index + 0.5) / count;
    const providerIndex = boundaries.findIndex((boundary) => position <= boundary);
    return providers[providerIndex >= 0 ? providerIndex : providers.length - 1] || null;
  });
}

function ActivityHeatmap({ logs }: { logs: RequestLogItem[] }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [gridShape, setGridShape] = useState({ columns: 26, rows: 7 });
  const [hovered, setHovered] = useState<{
    date: Date;
    requests: number;
    x: number;
    y: number;
  } | null>(null);
  const cells = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const log of logs) {
      const date = new Date(log.at);
      if (!Number.isFinite(date.getTime())) continue;
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      byDate.set(key, (byDate.get(key) || 0) + 1);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const max = Math.max(...byDate.values(), 1);
    return Array.from({ length: 180 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - 179 + index);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const requests = byDate.get(key) || 0;
      const level = requests ? Math.min(4, Math.ceil((Math.log1p(requests) / Math.log1p(max)) * 4)) : 0;
      return { key, date, requests, level };
    });
  }, [logs]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const syncGridShape = () => {
      const gap = 2;
      const preferredCellSize = 17;
      const maxRows = 11;
      const width = frame.clientWidth;
      const widthDrivenColumns = Math.floor((width + gap) / (preferredCellSize + gap));
      const columns = Math.max(Math.ceil(cells.length / maxRows), widthDrivenColumns, 1);
      const rows = Math.ceil(cells.length / columns);

      setGridShape((current) => (
        current.columns === columns && current.rows === rows ? current : { columns, rows }
      ));
    };

    syncGridShape();
    const observer = new ResizeObserver(syncGridShape);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [cells.length]);

  const totalRequests = cells.reduce((total, cell) => total + cell.requests, 0);
  const firstDate = cells[0]?.date;
  const lastDate = cells[cells.length - 1]?.date;
  const activityRange = firstDate && lastDate
    ? `${formatActivityDay(firstDate)} - ${formatActivityDay(lastDate)}`
    : "-";

  const showTooltip = (
    event: React.PointerEvent<HTMLSpanElement>,
    cell: (typeof cells)[number],
  ) => {
    const frame = frameRef.current;
    if (!frame) return;
    const frameBounds = frame.getBoundingClientRect();
    const cellBounds = event.currentTarget.getBoundingClientRect();
    const centerX = cellBounds.left - frameBounds.left + cellBounds.width / 2;
    const horizontalInset = Math.min(92, frameBounds.width / 2);
    setHovered({
      date: cell.date,
      requests: cell.requests,
      x: Math.max(horizontalInset, Math.min(frameBounds.width - horizontalInset, centerX)),
      y: cellBounds.top - frameBounds.top,
    });
  };

  return (
    <>
      <div className="usage-dashboard__activity-summary">
        <strong>{totalRequests.toLocaleString()}</strong>
        <span>{activityRange}</span>
      </div>
      <div ref={frameRef} className="usage-dashboard__heatmap-frame" onPointerLeave={() => setHovered(null)}>
        <div
          className="usage-dashboard__heatmap"
          style={{
            "--activity-columns": gridShape.columns,
            "--activity-rows": gridShape.rows,
          } as CSSProperties}
          aria-label="近 180 天请求活跃度"
        >
          {cells.map((cell) => (
            <span
              key={cell.key}
              className={`usage-dashboard__heatmap-cell level-${cell.level}`}
              onPointerEnter={(event) => showTooltip(event, cell)}
              aria-label={`${formatActivityDay(cell.date)}，${cell.requests} 次请求`}
            />
          ))}
        </div>
        {hovered ? (
          <div className="usage-dashboard__heatmap-tooltip" style={{ left: `${hovered.x}px`, top: `${hovered.y}px` }} role="status">
            {formatActivityDay(hovered.date)} · {hovered.requests.toLocaleString()} 次请求
          </div>
        ) : null}
      </div>
      <div className="usage-dashboard__heatmap-legend" aria-hidden="true">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => <i key={level} className={`usage-dashboard__heatmap-cell level-${level}`} />)}
        <span>多</span>
      </div>
    </>
  );
}

function formatActivityDay(value: Date): string {
  return value.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function DashboardEmpty({ label, className }: { label: string; className?: string }) {
  return <div className={`usage-dashboard__empty ${className || ""}`}>{label}</div>;
}

export function UsagePage() {
  const api = getApi();
  const { confirm, ConfirmDialog } = useConfirm();
  const [metrics, setMetrics] = useState<HomeMetrics | null>(null);
  const [logs, setLogs] = useState<RequestLogItem[]>([]);
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const [range, setRange] = useState<RangeKey>("7d");
  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (initial = false) => {
    const startedAt = performance.now();
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const [summary, detail, config] = await Promise.all([
        api.getHomeMetrics(),
        api.getRequestLogs(),
        api.getConfig().catch(() => null),
      ]);
      setMetrics(summary);
      setLogs(detail.logs || []);
      if (config) {
        setProviderLabels(
          Object.fromEntries(
            config.providers.map((item) => [item.id, item.displayName || item.id]),
          ),
        );
      }
      setError(null);
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      setError(message);
      if (!initial) toast.error("用量数据刷新失败", { description: message });
    } finally {
      const minimumVisualDuration = initial ? 240 : 300;
      const remaining = minimumVisualDuration - (performance.now() - startedAt);
      if (remaining > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
      }
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh(true);
  }, []);

  const providers = useMemo(
    () => [...new Set(logs.map((item) => item.providerId).filter(Boolean) as string[])].sort(),
    [logs],
  );
  const models = useMemo(
    () => [...new Set(logs.map((item) => item.modelID).filter(Boolean) as string[])].sort(),
    [logs],
  );

  const filtered = useMemo(() => {
    const start = rangeStart(range);
    const needle = query.trim().toLowerCase();
    return logs.filter((item) => {
      const timestamp = Date.parse(item.at);
      if (start && (!Number.isFinite(timestamp) || timestamp < start)) return false;
      if (provider !== "all" && item.providerId !== provider) return false;
      if (model !== "all" && item.modelID !== model) return false;
      if (status === "ok" && !item.valid) return false;
      if (status === "error" && item.valid) return false;
      if (source !== "all" && (item.source || "unknown") !== source) return false;
      if (needle) {
        const searchable = `${item.providerId || ""} ${item.modelID || ""} ${item.error || ""} ${item.requestId || ""} ${item.priceSnapshot?.source || ""}`.toLowerCase();
        if (!searchable.includes(needle)) return false;
      }
      return true;
    });
  }, [logs, model, provider, query, range, source, status]);

  useEffect(() => setPage(1), [model, provider, query, range, source, status]);

  const summary = useMemo<UsageSummary>(() => {
    const requests = filtered.length;
    const valid = filtered.filter((item) => item.valid).length;
    const prompt = filtered.reduce((sum, item) => sum + Math.max(0, item.promptTokens || 0), 0);
    const cacheRead = filtered.reduce((sum, item) => sum + Math.max(0, item.cacheReadTokens || 0), 0);
    const cacheWrite = filtered.reduce((sum, item) => sum + Math.max(0, item.cacheWriteTokens || 0), 0);
    const denominator = metrics?.includeCacheWriteInHitRate
      ? cacheRead + cacheWrite
      : prompt || filtered.reduce((sum, item) => sum + Math.max(0, item.requestTokens || 0), 0);
    return {
      requests,
      valid,
      errors: requests - valid,
      tokens: filtered.reduce((sum, item) => sum + Math.max(0, item.requestTokens || 0), 0),
      prompt,
      completion: filtered.reduce((sum, item) => sum + Math.max(0, item.completionTokens || 0), 0),
      cacheRead,
      cacheWrite,
      cost: filtered.reduce((sum, item) => sum + Math.max(0, item.costUsd || 0), 0),
      pricedRequests: filtered.filter(isPriced).length,
      cacheHitRate: denominator > 0 ? cacheRead / denominator : 0,
      successRate: requests > 0 ? valid / requests : 0,
    };
  }, [filtered, metrics?.includeCacheWriteInHitRate]);

  const providerStats = useMemo<ProviderStat[]>(() => {
    const rows = new Map<string, ProviderStat>();
    for (const item of filtered) {
      const name = item.providerId || "未标记供应商";
      const row = rows.get(name) || {
        name,
        requests: 0,
        valid: 0,
        tokens: 0,
        cost: 0,
        color: PROVIDER_COLORS[rows.size % PROVIDER_COLORS.length],
      };
      row.requests += 1;
      row.valid += item.valid ? 1 : 0;
      row.tokens += Math.max(0, item.requestTokens || 0);
      row.cost += Math.max(0, item.costUsd || 0);
      rows.set(name, row);
    }
    return [...rows.values()].sort((a, b) => b.requests - a.requests).slice(0, 5);
  }, [filtered]);

  const modelStats = useMemo<ModelStat[]>(() => {
    const rows = new Map<string, ModelStat>();
    for (const item of filtered) {
      const name = item.modelID || "未标记模型";
      const row = rows.get(name) || {
        name,
        requests: 0,
        prompt: 0,
        completion: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 0,
        cost: 0,
        pricedRequests: 0,
      };
      row.requests += 1;
      row.prompt += Math.max(0, item.promptTokens || 0);
      row.completion += Math.max(0, item.completionTokens || 0);
      row.cacheRead += Math.max(0, item.cacheReadTokens || 0);
      row.cacheWrite += Math.max(0, item.cacheWriteTokens || 0);
      row.tokens += Math.max(0, item.requestTokens || 0);
      row.cost += Math.max(0, item.costUsd || 0);
      row.pricedRequests += isPriced(item) ? 1 : 0;
      rows.set(name, row);
    }
    return [...rows.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 10);
  }, [filtered]);

  const trend = useMemo(() => buildTrend(filtered, range), [filtered, range]);
  const modelMatches = useMemo(
    () => new Set(filtered.filter((item) => item.priceSnapshot?.source === "models-dev").map((item) => item.modelID).filter(Boolean)).size,
    [filtered],
  );
  const unpricedModels = useMemo(
    () => new Set(filtered.filter((item) => !isPriced(item)).map((item) => item.modelID).filter(Boolean)).size,
    [filtered],
  );
  const logSlice = useMemo(() => slicePage(filtered, page, LOG_PAGE_SIZE), [filtered, page]);
  const pricing = metrics?.pricing;
  const providerLabel = (id?: string) =>
    (id ? providerLabels[id] : undefined) || id || "未标记供应商";
  const directInput = Math.max(0, summary.prompt - summary.cacheRead - summary.cacheWrite);
  const cacheTotal = summary.cacheRead + directInput + summary.cacheWrite;
  const cacheSegments = [
    { id: "read", label: "缓存读取", value: summary.cacheRead, share: cacheTotal ? summary.cacheRead / cacheTotal : 0 },
    { id: "input", label: "直接输入", value: directInput, share: cacheTotal ? directInput / cacheTotal : 0 },
    { id: "write", label: "缓存写入", value: summary.cacheWrite, share: cacheTotal ? summary.cacheWrite / cacheTotal : 0 },
  ];

  const queryParams = () => ({
    from: range === "all" ? undefined : new Date(rangeStart(range)).toISOString(),
    providerId: provider === "all" ? undefined : provider,
    modelID: model === "all" ? undefined : model,
    source: source === "all" ? undefined : source,
    valid: status === "all" ? undefined : status === "ok" ? "valid" : "invalid",
    q: query.trim() || undefined,
  });

  const refreshPricing = async () => {
    setPricingBusy(true);
    try {
      const result = await api.refreshUsagePricing();
      await refresh();
      toast.success("价格目录已更新", {
        description: `已重算 ${result.updatedRequests} 条请求，${result.unpricedRequests} 条待匹配。`,
      });
    } catch (pricingError) {
      toast.error("价格更新失败", {
        description: pricingError instanceof Error ? pricingError.message : String(pricingError),
      });
    } finally {
      setPricingBusy(false);
    }
  };

  const exportCsv = async () => {
    try {
      downloadCsv(await api.exportUsageCsv(queryParams()));
      toast.success("已导出 CSV");
    } catch (exportError) {
      toast.error("导出失败", {
        description: exportError instanceof Error ? exportError.message : String(exportError),
      });
    }
  };

  const clearUsage = async () => {
    const accepted = await confirm({
      title: "清空用量和请求记录？",
      description: "此操作会移除本地保存的用量统计和最近请求明细。",
      confirmText: "清空记录",
      danger: true,
    });
    if (!accepted) return;
    try {
      await api.resetMetrics();
      await refresh();
      toast.success("用量记录已清空");
    } catch (clearError) {
      toast.error("清空失败", {
        description: clearError instanceof Error ? clearError.message : String(clearError),
      });
    }
  };

  return (
    <div className="cs-page usage-dashboard usage-workbench">
      {ConfirmDialog}

      <header className="usage-dashboard__toolbar workspace-layer-enter">
        <div className="usage-dashboard__context">
          <span className={`usage-dashboard__catalog-dot is-${pricing?.state || "empty"}`} aria-hidden="true" />
          <span>本地用量</span>
          <small>
            {pricing?.state === "ready"
              ? `价格目录 ${displayUpdatedAt(pricing.updatedAt)}`
              : pricing?.state === "stale"
                ? "价格目录等待更新"
                : "价格目录尚未同步"}
          </small>
        </div>
        <div className="usage-dashboard__actions" data-no-drag>
          <div className="usage-dashboard__range" role="group" aria-label="统计范围">
            {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={range === key ? "is-active" : undefined}
                onClick={() => setRange(key)}
              >
                {RANGE_LABELS[key]}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="usage-dashboard__icon-action"
            title="刷新用量数据"
            aria-label="刷新用量数据"
            onClick={() => void refresh()}
            disabled={refreshing || loading}
          >
            <RefreshCw className={`workspace-refresh-icon${refreshing ? " is-spinning animate-spin" : ""}`} />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="usage-dashboard__catalog-action"
            onClick={() => void refreshPricing()}
            disabled={pricingBusy}
          >
            <Database className={pricingBusy ? "animate-spin" : undefined} />
            更新价格
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="usage-dashboard__icon-action"
            title="导出当前筛选结果"
            aria-label="导出当前筛选结果"
            onClick={() => void exportCsv()}
            disabled={!filtered.length}
          >
            <Download />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="usage-dashboard__icon-action is-danger"
            title="清空本地用量记录"
            aria-label="清空本地用量记录"
            onClick={() => void clearUsage()}
            disabled={!logs.length}
          >
            <Trash2 />
          </Button>
        </div>
      </header>

      {error ? (
        <section className="usage-dashboard__error workspace-layer-enter workspace-layer-enter--delay-1">
          <span>{error}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>重试</Button>
        </section>
      ) : null}

      {loading ? (
        <div className="usage-dashboard__loading-layout workspace-layer-enter workspace-layer-enter--delay-1" aria-label="正在加载用量数据">
          <div className="usage-dashboard__skeleton is-overview" />
          <div className="usage-dashboard__skeleton is-cache" />
          <div className="usage-dashboard__skeleton is-chart" />
          <div className="usage-dashboard__skeleton is-source" />
        </div>
      ) : (
        <>
          <section className="usage-dashboard__snapshot-grid workspace-layer-enter workspace-layer-enter--delay-1" aria-label="使用概览">
            <article className="usage-dashboard__panel usage-dashboard__overview-panel">
              <PanelHeading
                title="使用概览"
                icon={<BarChart3 />}
                detail={`${RANGE_LABELS[range]}内的本地代理请求`}
                right={<span className="usage-dashboard__success-rate"><b>{formatPercent(summary.successRate)}</b> 成功率</span>}
              />
              <div className="usage-dashboard__overview-metrics">
                <OverviewMetric
                  label="请求次数"
                  value={compactNumber(summary.requests)}
                  detail={summary.errors ? `${summary.errors} 次异常` : "请求运行正常"}
                  tone="blue"
                />
                <OverviewMetric
                  label="Token 用量"
                  value={compactNumber(summary.tokens)}
                  detail={`输入 ${compactNumber(summary.prompt)} · 输出 ${compactNumber(summary.completion)}`}
                  tone="violet"
                />
                <OverviewMetric
                  label="估算费用"
                  value={formatUsd(summary.cost)}
                  detail={summary.pricedRequests ? `${summary.pricedRequests} 条已定价` : "等待价格匹配"}
                  tone="green"
                />
              </div>
            </article>

            <article className="usage-dashboard__panel usage-dashboard__cache-panel">
              <PanelHeading
                title="缓存效率"
                icon={<Gauge />}
                right={<strong className="usage-dashboard__cache-rate">{formatPercent(summary.cacheHitRate)}</strong>}
              />
              <div className="usage-dashboard__cache-body">
                <div className="usage-dashboard__cache-ring" role="img" aria-label={`缓存命中率 ${formatPercent(summary.cacheHitRate)}`}>
                  <svg viewBox="0 0 112 112" aria-hidden="true">
                    <circle className="usage-dashboard__cache-track" cx="56" cy="56" r="43" pathLength="100" />
                    {cacheTotal ? (
                      <circle
                        className="usage-dashboard__cache-value"
                        cx="56"
                        cy="56"
                        r="43"
                        pathLength="100"
                        strokeDasharray={`${Math.max(0, Math.min(100, summary.cacheHitRate * 100))} 100`}
                        transform="rotate(-90 56 56)"
                      />
                    ) : null}
                  </svg>
                  <span>
                    <strong>{cacheTotal ? `${Math.round(summary.cacheHitRate * 100)}%` : "-"}</strong>
                    <small>{cacheTotal ? "命中" : "暂无数据"}</small>
                  </span>
                </div>
                <dl className="usage-dashboard__cache-breakdown">
                  {cacheSegments.map((segment) => (
                    <div key={segment.id} className={`is-${segment.id}`}>
                      <div>
                        <dt>{segment.label}</dt>
                        <dd>{compactNumber(segment.value)}</dd>
                      </div>
                      <span aria-hidden="true"><i style={{ width: `${segment.share * 100}%` }} /></span>
                    </div>
                  ))}
                </dl>
              </div>
            </article>
          </section>

          <section className="usage-dashboard__analytics-grid workspace-layer-enter workspace-layer-enter--delay-2">
            <article className="usage-dashboard__panel usage-dashboard__trend-panel">
              <PanelHeading
                title="用量趋势"
                icon={<TrendingUp />}
                detail="Token、费用与请求量"
              />
              <UsageTrendChart points={trend} />
            </article>

            <article className="usage-dashboard__panel usage-dashboard__provider-panel">
              <PanelHeading title="请求来源" icon={<Activity />} detail="按供应商分布" />
              <ProviderDistribution stats={providerStats} providerLabel={providerLabel} />
            </article>
          </section>

          <section className="usage-dashboard__detail-grid workspace-layer-enter workspace-layer-enter--delay-3">
            <article className="usage-dashboard__panel usage-dashboard__models-panel">
              <PanelHeading
                title="模型计费"
                icon={<CircleDollarSign />}
                detail="按当前筛选范围聚合"
                right={(
                  <span className={`usage-dashboard__pricing-summary is-${pricing?.state || "empty"}`}>
                    <i />
                    {pricing?.state === "ready" ? `${pricing.catalogEntries.toLocaleString()} 个模型` : "等待价格目录"}
                  </span>
                )}
              />
              {modelStats.length ? (
                <div className="usage-dashboard__models-table-wrap">
                  <table className="usage-dashboard__models-table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th><span className="is-cost">费用</span></th>
                        <th><span className="is-token">Tokens</span></th>
                        <th><span className="is-request">请求</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelStats.map((item) => (
                        <tr key={item.name}>
                          <td>
                            <strong title={item.name}>{item.name}</strong>
                            <span>输入 {compactNumber(item.prompt)} · 输出 {compactNumber(item.completion)} · 缓存 {compactNumber(item.cacheRead)}</span>
                          </td>
                          <td className={item.pricedRequests ? "is-priced" : "is-unpriced"}>
                            {item.pricedRequests ? formatUsd(item.cost) : "待定价"}
                          </td>
                          <td className="is-token">{compactNumber(item.tokens)}</td>
                          <td className="is-request">{item.requests.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <DashboardEmpty label="当前范围内暂无模型计费数据" className="usage-dashboard__models-empty" />
              )}
              <footer className="usage-dashboard__models-footer">
                <span>{modelMatches} 个模型已匹配价格</span>
                {unpricedModels ? <span className="is-warning">{unpricedModels} 个模型等待匹配</span> : null}
              </footer>
            </article>

            <article className="usage-dashboard__panel usage-dashboard__activity-panel">
              <PanelHeading title="请求活跃度" icon={<Activity />} right={<span className="usage-dashboard__period">近 180 天</span>} />
              <ActivityHeatmap logs={filtered} />
            </article>
          </section>

          <section className="usage-dashboard__panel usage-dashboard__logs-panel workspace-layer-enter workspace-layer-enter--delay-3">
            <div className="usage-dashboard__logs-header">
              <PanelHeading
                title="请求明细"
                icon={<Database />}
                detail={`${filtered.length.toLocaleString()} 条匹配记录`}
              />
              <div className="usage-dashboard__filters">
                <label>
                  <span>供应商</span>
                  <SimpleSelect
                    value={provider}
                    onValueChange={setProvider}
                    options={[{ value: "all", label: "全部供应商" }, ...providers.map((item) => ({ value: item, label: providerLabel(item) }))]}
                  />
                </label>
                <label>
                  <span>模型</span>
                  <SimpleSelect
                    value={model}
                    onValueChange={setModel}
                    options={[{ value: "all", label: "全部模型" }, ...models.map((item) => ({ value: item, label: item }))]}
                  />
                </label>
                <label>
                  <span>状态</span>
                  <SimpleSelect
                    value={status}
                    onValueChange={(value) => setStatus(value as StatusFilter)}
                    options={[{ value: "all", label: "全部状态" }, { value: "ok", label: "成功" }, { value: "error", label: "异常" }]}
                  />
                </label>
                <label className="usage-dashboard__source-filter">
                  <span>来源</span>
                  <SimpleSelect
                    value={source}
                    onValueChange={(value) => setSource(value as SourceFilter)}
                    options={[{ value: "all", label: "全部来源" }, { value: "agent", label: "应用" }, { value: "ide", label: "编辑器" }, { value: "unknown", label: "其他来源" }]}
                  />
                </label>
                <label className="usage-dashboard__search">
                  <span>搜索</span>
                  <div>
                    <Search />
                    <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="模型、供应商或错误" />
                  </div>
                </label>
              </div>
            </div>
            {filtered.length ? (
              <>
                <div className="usage-dashboard__log-table-wrap">
                  <table className="usage-dashboard__log-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>模型 / 供应商</th>
                        <th>输入</th>
                        <th>输出</th>
                        <th>缓存</th>
                        <th>费用</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logSlice.map((item) => (
                        <tr key={item.id}>
                          <td className="is-time">{displayDate(item.at)}</td>
                          <td className="usage-dashboard__model-cell">
                            <strong title={item.modelID || "未标记模型"}>{item.modelID || "未标记模型"}</strong>
                            <span>{providerLabel(item.providerId)} · {requestSourceLabel(item.source)} · {sourceName(item.priceSnapshot?.source)}</span>
                          </td>
                          <td>{compactNumber(item.promptTokens)}</td>
                          <td>{compactNumber(item.completionTokens)}</td>
                          <td>读 {compactNumber(item.cacheReadTokens)}<br />写 {compactNumber(item.cacheWriteTokens)}</td>
                          <td className={isPriced(item) ? "is-priced" : "is-unpriced"} title={item.priceSnapshot ? `输入 $${item.priceSnapshot.inputPerMillion}/1M · 输出 $${item.priceSnapshot.outputPerMillion}/1M` : undefined}>
                            {isPriced(item) ? formatUsd(item.costUsd) : "待定价"}
                          </td>
                          <td>
                            <span className={`usage-dashboard__status ${item.valid ? "is-success" : "is-error"}`} title={item.error}>
                              {item.valid ? "成功" : "异常"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageSize={LOG_PAGE_SIZE} total={filtered.length} onChange={setPage} className="usage-dashboard__pagination" />
              </>
            ) : (
              <div className="usage-dashboard__empty-logs">
                <Database />
                <strong>暂无匹配的请求记录</strong>
                <span>完成一次 Cursor 请求后，这里会同步显示用量与计费明细。</span>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function PanelHeading({
  title,
  icon,
  detail,
  right,
}: {
  title: string;
  icon: ReactNode;
  detail?: string;
  right?: ReactNode;
}) {
  return (
    <header className="usage-dashboard__panel-heading">
      <div>
        <span className="usage-dashboard__panel-icon">{icon}</span>
        <span>
          <h2>{title}</h2>
          {detail ? <p>{detail}</p> : null}
        </span>
      </div>
      {right ? <aside>{right}</aside> : null}
    </header>
  );
}

function OverviewMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "blue" | "violet" | "green";
}) {
  return (
    <div className={`usage-dashboard__overview-metric is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small title={detail}>{detail}</small>
    </div>
  );
}
