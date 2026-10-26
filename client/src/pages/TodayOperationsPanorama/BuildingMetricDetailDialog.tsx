import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  CalendarDays,
  Droplets,
  Minus,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type {
  TodayOperationsKpiBuilding,
  TodayOperationsKpiBuildingMetricDetails,
} from '@shared/today-operations-kpi.interface';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type BuildingMetricKey = 'averagePue' | 'electricityKwh' | 'waterTons';

interface BuildingMetricDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metricKey: BuildingMetricKey;
  details: TodayOperationsKpiBuildingMetricDetails | null;
  restoreFocusTo?: HTMLElement | null;
}

interface MetricMeta {
  title: string;
  unit: string;
  precision: number;
  icon: LucideIcon;
}

const BUILDING_ORDER = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'] as const;

const METRIC_META: Record<BuildingMetricKey, MetricMeta> = {
  averagePue: {
    title: '各楼 PUE 明细',
    unit: '',
    precision: 3,
    icon: Zap,
  },
  electricityKwh: {
    title: '各楼用电量明细',
    unit: 'kWh',
    precision: 0,
    icon: Zap,
  },
  waterTons: {
    title: '各楼耗水量明细',
    unit: 't',
    precision: 1,
    icon: Droplets,
  },
};

function formatDate(value: string | null): string {
  if (!value) return '日期待同步';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

function formatValue(
  value: number | null,
  precision: number,
  unit: string,
): string {
  if (value === null || !Number.isFinite(value)) return '暂无数据';
  const number = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value);
  return unit ? `${number} ${unit}` : number;
}

function getComparison(
  value: number | null,
  previousValue: number | null,
  precision: number,
  unit: string,
) {
  if (
    value === null ||
    previousValue === null ||
    !Number.isFinite(value) ||
    !Number.isFinite(previousValue)
  ) {
    return { direction: 'neutral' as const, label: '暂无上期对比' };
  }

  const scale = 10 ** precision;
  const delta = Math.round((value - previousValue) * scale) / scale;
  if (Object.is(delta, 0) || Object.is(delta, -0)) {
    return { direction: 'neutral' as const, label: '较上期持平' };
  }

  return {
    direction: delta > 0 ? ('up' as const) : ('down' as const),
    label: `较上期 ${delta > 0 ? '↑' : '↓'} ${formatValue(
      Math.abs(delta),
      precision,
      unit,
    )}`,
  };
}

export function BuildingMetricDetailDialog({
  open,
  onOpenChange,
  metricKey,
  details,
  restoreFocusTo,
}: BuildingMetricDetailDialogProps) {
  const meta = METRIC_META[metricKey];
  const MetricIcon = meta.icon;
  const includedBuildings = new Set<TodayOperationsKpiBuilding>(
    details?.includedBuildings ??
      (metricKey === 'averagePue'
        ? BUILDING_ORDER.slice(0, 3)
        : BUILDING_ORDER),
  );
  const rows = BUILDING_ORDER.map((building) => ({
    building,
    row: details?.rows.find((item) => item.building === building) ?? null,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="today-panorama-detail-dialog today-panorama-building-metric-dialog flex max-h-[min(84dvh,680px)] w-[min(980px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-slate-200 p-0"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusTo?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="today-panorama-building-metric-head flex-row items-start gap-3 border-b border-slate-200 px-5 py-4 text-left sm:px-6">
          <span
            className="today-panorama-building-metric-icon"
            data-metric={metricKey}
            aria-hidden="true"
          >
            <MetricIcon />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg leading-6 text-slate-950">
              {meta.title}
            </DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-3.5" aria-hidden="true" />
                数据日期 {formatDate(details?.date ?? null)}
              </span>
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="today-panorama-dialog-close shrink-0 text-slate-500"
              aria-label={`关闭${meta.title}`}
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/40 p-4 sm:p-5">
          <ol
            className="today-panorama-building-metric-grid"
            aria-label={`${meta.title}，按A至E楼排列`}
          >
            {rows.map(({ building, row }) => {
              const comparison = getComparison(
                row?.value ?? null,
                row?.previousValue ?? null,
                meta.precision,
                meta.unit,
              );
              const ComparisonIcon =
                comparison.direction === 'up'
                  ? ArrowUpRight
                  : comparison.direction === 'down'
                    ? ArrowDownRight
                    : Minus;
              const included = includedBuildings.has(building);
              return (
                <li
                  className="today-panorama-building-metric-card"
                  data-included={included ? 'true' : 'false'}
                  key={building}
                >
                  <header>
                    <span aria-hidden="true">
                      <Building2 />
                    </span>
                    <h3>{building}</h3>
                    {metricKey === 'averagePue' ? (
                      <em>{included ? '计入平均' : '仅展示'}</em>
                    ) : null}
                  </header>
                  <div className="today-panorama-building-metric-value">
                    <span>本期</span>
                    <strong>
                      {formatValue(
                        row?.value ?? null,
                        meta.precision,
                        meta.unit,
                      )}
                    </strong>
                  </div>
                  <p
                    className="today-panorama-building-metric-comparison"
                    data-direction={comparison.direction}
                  >
                    <ComparisonIcon aria-hidden="true" />
                    {comparison.label}
                  </p>
                  <footer>
                    <span>
                      上期 {formatDate(details?.previousDate ?? null)}
                    </span>
                    <b>
                      {formatValue(
                        row?.previousValue ?? null,
                        meta.precision,
                        meta.unit,
                      )}
                    </b>
                  </footer>
                </li>
              );
            })}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  );
}
