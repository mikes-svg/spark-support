/**
 * Per-person workload bars — Phase 5. Stub with its final prop shape.
 *
 * Render with hand-rolled SVG, exactly like src/pages/AnalyticsPage.tsx. There
 * is no chart library in this project and adding one for a stacked bar chart
 * would be the single largest dependency in the bundle.
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

export function WorkloadChart(_props: WorkloadChartProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-16 text-center text-sm text-gray-500">
      Workload chart — coming soon.
    </div>
  );
}
