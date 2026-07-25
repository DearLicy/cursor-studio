import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import type { HomeMetrics } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const TOKEN_PRICE = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

function n(v: number | undefined | null): number {
  return Math.max(0, Number(v) || 0);
}

function rate(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.min(1, Math.max(0, num / den));
}

function formatRate(r: number | null): string {
  if (r == null) return "—";
  return `${(r * 100).toFixed(1)}%`;
}

function formatUSD(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0.00";
  if (v < 0.01) return "<$0.01";
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatCompact(v: number | undefined | null): string {
  const x = n(v);
  if (x < 1000) return String(Math.round(x));
  if (x < 1_000_000) {
    const k = x / 1000;
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = x / 1_000_000;
  return `${m >= 10 ? m.toFixed(1).replace(/\.0$/, "") : m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
}

function CacheRing({ rateValue }: { rateValue: number | null }) {
  const pct = rateValue == null ? 0 : rateValue * 100;
  const c = 2 * Math.PI * 36;
  const dash = (pct / 100) * c;
  return (
    <div className="cs-ring">
      <svg viewBox="0 0 100 62" className="cs-ring-svg">
        <path
          d="M 14 54 A 36 36 0 0 1 86 54"
          fill="none"
          stroke="rgba(0,0,0,0.06)"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          d="M 14 54 A 36 36 0 0 1 86 54"
          fill="none"
          stroke="#0c0c0c"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          className="cs-ring-progress"
        />
      </svg>
      <div className="cs-ring-value">
        {rateValue == null ? "—" : `${pct.toFixed(0)}%`}
      </div>
    </div>
  );
}

export function HomeMetricsCard({
  metrics,
  loading,
  onRefresh,
  onToggleIncludeCacheWrite,
  onReset,
}: {
  metrics: HomeMetrics | null;
  loading?: boolean;
  onRefresh: () => void;
  onToggleIncludeCacheWrite: (v: boolean) => void;
  onReset?: () => void;
}) {
  const m = metrics;
  const cacheRead = n(m?.cacheReadTokens);
  const cacheWrite = n(m?.cacheWriteTokens);
  const prompt = n(m?.promptTokensTotal);
  const request = n(m?.requestTokensTotal);
  const inputTokens = Math.max(0, prompt - cacheRead - cacheWrite);
  const completion = Math.max(0, request - prompt);

  const defaultHit = rate(cacheRead, cacheRead + inputTokens);
  const reuseHit = rate(cacheRead, cacheRead + cacheWrite + inputTokens);
  const includeWrite = Boolean(m?.includeCacheWriteInHitRate);
  const hit = includeWrite ? reuseHit : defaultHit;

  const cost = useMemo(() => {
    const input = (inputTokens / 1e6) * TOKEN_PRICE.input;
    const output = (completion / 1e6) * TOKEN_PRICE.output;
    const cr = (cacheRead / 1e6) * TOKEN_PRICE.cacheRead;
    const cw = (cacheWrite / 1e6) * TOKEN_PRICE.cacheWrite;
    return {
      total: input + output + cr + cw,
      cache: cr + cw,
    };
  }, [inputTokens, completion, cacheRead, cacheWrite]);

  return (
    <section className="cs-panel cs-usage-panel">
      <div className="cs-panel-head">
        <div>
          <h2 className="cs-panel-title">用量</h2>
          <p className="cs-panel-sub">本机会话累计</p>
        </div>
        <div className="cs-panel-actions">
          {onReset ? (
            <Button type="button" size="sm" variant="ghost" onClick={onReset}>
              清零
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={onRefresh}
            disabled={loading}
            title="刷新"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="cs-stat-grid">
        <div className="cs-stat cs-stat-wide">
          <div className="cs-stat-top">
            <span className="cs-stat-label">缓存命中</span>
            <label className="cs-stat-switch">
              <Switch
                checked={includeWrite}
                onCheckedChange={onToggleIncludeCacheWrite}
                className="scale-90"
              />
              <span>计入写入</span>
            </label>
          </div>
          <div className="cs-stat-ring-row">
            <CacheRing rateValue={hit} />
            <div className="cs-stat-ring-side">
              <div className="cs-stat-main">{formatRate(hit)}</div>
              <div className="cs-stat-sub">
                {includeWrite ? "含写入" : "默认口径"}
              </div>
            </div>
          </div>
        </div>

        <div className="cs-stat">
          <div className="cs-stat-label">对话轮次</div>
          <div className="cs-stat-main">{formatCompact(m?.turnsTotal)}</div>
          <div className="cs-stat-sub">
            有效 {formatCompact(m?.validTurnsTotal)} · 异常{" "}
            {formatCompact(m?.invalidTurnsTotal)}
          </div>
        </div>

        <div className="cs-stat">
          <div className="cs-stat-label">Token</div>
          <div className="cs-stat-main">{formatCompact(m?.requestTokensTotal)}</div>
          <div className="cs-stat-sub">
            Prompt {formatCompact(m?.promptTokensTotal)}
          </div>
        </div>

        <div className="cs-stat">
          <div className="cs-stat-label">费用估算</div>
          <div className="cs-stat-main">{formatUSD(cost.total)}</div>
          <div className="cs-stat-sub">缓存 {formatUSD(cost.cache)}</div>
        </div>
      </div>
    </section>
  );
}
