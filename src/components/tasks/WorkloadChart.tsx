/**
 * Per-person workload bars — Phase 5.
 *
 * Render with hand-rolled SVG, exactly like src/pages/AnalyticsPage.tsx. There
 * is no chart library in this project and adding one for a stacked bar chart
 * would be the single largest dependency in the bundle.
 *
 * The bar shows the selected metric; a compliance dot per row is drawn
 * regardless of which metric is selected, because a person's recurring work
 * silently rotting (the "Check for Expired Concessions" case, §10 of the
 * migration plan) shouldn't only be visible when someone happens to pick that
 * metric — it's the whole point of the chart.
 */
export interface WorkloadRow {
  userId: string;
  name: string;
  open: number;
  overdue: number;
  dueThisWeek: number;
  completed30d: number;
  /** 0–100. How often the recurring work actually gets done in its cycle. */
  recurringCompliance: number | null;
}

export interface WorkloadChartProps {
  rows: WorkloadRow[];
  /** Which number drives the bar length; the rest show as figures. */
  metric?: 'open' | 'overdue' | 'dueThisWeek' | 'completed30d';
}

const METRIC_LABEL: Record<NonNullable<WorkloadChartProps['metric']>, string> = {
  open: 'Open',
  overdue: 'Overdue',
  dueThisWeek: 'Due this week',
  completed30d: 'Completed (30d)',
};

/** Red below 50%, amber below 80%, green at or above — the same thresholds
 *  the metrics table uses, so the chart and the numbers never disagree. */
function complianceColor(pct: number | null): string {
  if (pct == null) return '#9CA3AF';
  if (pct < 50) return '#DC2626';
  if (pct < 80) return '#D97706';
  return '#16A34A';
}

export function WorkloadChart({ rows, metric = 'open' }: WorkloadChartProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">No workload data for this range.</p>;
  }

  const max = Math.max(1, ...rows.map((r) => r[metric]));
  const rowH = 32;
  const pad = { l: 150, r: 120, t: 10, b: 10 };
  const w = 820;
  const innerW = w - pad.l - pad.r;
  const h = pad.t + pad.b + rows.length * rowH;
  const barW = (v: number) => Math.max(v > 0 ? 2 : 0, (v / max) * innerW);

  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full min-w-[640px]" style={{ height: h }}>
          {rows.map((r, i) => {
            const y = pad.t + i * rowH;
            const bw = barW(r[metric]);
            return (
              <g key={r.userId}>
                <text x={pad.l - 8} y={y + rowH / 2 + 4} fontSize="12" textAnchor="end" fill="#374151">
                  {r.name}
                </text>
                <rect x={pad.l} y={y + 7} width={innerW} height={rowH - 14} fill="#F3F4F6" rx={3} />
                <rect x={pad.l} y={y + 7} width={bw} height={rowH - 14} fill="#064923" rx={3} />
                <text x={pad.l + bw + 6} y={y + rowH / 2 + 4} fontSize="12" fill="#111827">
                  {r[metric]}
                </text>
                {/* Recurring-compliance dot, always shown regardless of `metric`. */}
                <circle cx={w - 16} cy={y + rowH / 2} r={5} fill={complianceColor(r.recurringCompliance)} />
                <text x={w - 28} y={y + rowH / 2 + 4} fontSize="11" textAnchor="end" fill="#6B7280">
                  {r.recurringCompliance == null ? 'n/a' : `${Math.round(r.recurringCompliance)}%`}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-600 mt-2 px-1 flex-wrap">
        <span className="font-medium text-gray-700">{METRIC_LABEL[metric]}</span>
        <span className="text-gray-400">·</span>
        <span className="text-gray-500">Recurring compliance:</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#16A34A] inline-block" /> ≥ 80%</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#D97706] inline-block" /> 50–79%</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#DC2626] inline-block" /> &lt; 50%</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#9CA3AF] inline-block" /> no recurring tasks</span>
      </div>
    </div>
  );
}
