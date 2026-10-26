import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  CalendarX2,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  Database,
  Info,
  Loader2,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';

import { getEquipmentPatrolExecutions } from '@/api';

import { cn } from '@/lib/utils';
import {
  EQUIPMENT_PATROL_BUILDINGS,
  type EquipmentPatrolBuilding,
  type EquipmentPatrolExecutionResponse,
} from '@shared/equipment-patrol-execution.interface';

import {
  buildEquipmentPatrolExecutionView,
  type EquipmentPatrolAnomaly,
  type EquipmentPatrolExecutionView,
} from './execution-model';

import {
  getPatrolMonthDashboard,
  PATROL_MONTH_OPTIONS,
  rankPatrolDevices,
  type PatrolCellStatus,
  type PatrolDeviceRow,
} from './model';

const VNET_OFFICIAL_LOGO_URL = '/assets/vnet-official-logo.png';
const MATRIX_SEQUENCE_COLUMN_WIDTH = 44;
const MATRIX_DEVICE_COLUMN_WIDTH = 220;
const MATRIX_DAY_COLUMN_WIDTH = 38;
const DEFAULT_MONTH =
  PATROL_MONTH_OPTIONS.find((option) => option.value === '2026-07')?.value ??
  PATROL_MONTH_OPTIONS[0].value;

const STATUS_LABELS: Record<PatrolCellStatus, string> = {
  planned: '计划轮巡',
  adjusted: '调整轮巡',
  completed: '已执行',
  partial: '部分执行',
  missed: '未执行',
  none: '无计划',
};

const STATUS_CELL_CLASSES: Record<PatrolCellStatus, string> = {
  planned:
    'bg-[linear-gradient(135deg,#3b82f6_0%,#3b82f6_52%,#60a5fa_52%,#60a5fa_100%)] ring-1 ring-inset ring-blue-400/30',
  adjusted:
    'bg-[linear-gradient(135deg,#f97316_0%,#f97316_52%,#ef4444_52%,#ef4444_100%)] ring-1 ring-inset ring-red-400/30',
  completed:
    'bg-[linear-gradient(90deg,#3b82f6_0%,#3b82f6_22%,#31bd86_22%,#31bd86_100%)] ring-1 ring-inset ring-emerald-400/30',
  partial:
    'bg-[linear-gradient(90deg,#3b82f6_0%,#3b82f6_22%,#fbbf24_22%,#fbbf24_100%)] ring-1 ring-inset ring-amber-400/30',
  missed:
    'bg-[linear-gradient(90deg,#3b82f6_0%,#3b82f6_22%,#f87171_22%,#f87171_100%)] ring-1 ring-inset ring-red-400/30',
  none: '',
};

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

type DashboardView = 'calendar' | 'list';
type MatrixScope = 'standard' | EquipmentPatrolBuilding;

interface MetricCardProps {
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  value: number | string;
  unit: string;
  footerLabel: string;
  footerValue: ReactNode;
}

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split('-');
  return `${year}年${monthNumber}月`;
}

function getDayMeta(month: string, day: number) {
  const date = new Date(`${month}-${String(day).padStart(2, '0')}T00:00:00`);
  const weekday = date.getDay();

  return {
    weekday: WEEKDAY_LABELS[weekday],
    isWeekend: weekday === 0 || weekday === 6,
  };
}

function getDeviceNoteText(device: PatrolDeviceRow): string {
  return device.notes.join('\n');
}

function MetricCard({
  icon: Icon,
  iconClassName,
  title,
  value,
  unit,
  footerLabel,
  footerValue,
}: MetricCardProps) {
  return (
    <article className="flex h-[138px] min-w-0 items-center gap-4 rounded-lg border border-[#d8e5f7] bg-white px-[22px] shadow-[0_7px_20px_rgba(38,91,159,0.07)]">
      <span
        className={cn(
          'grid h-[54px] w-[54px] shrink-0 place-items-center rounded-lg text-white shadow-[0_7px_14px_rgba(35,91,176,0.18)]',
          iconClassName,
        )}
      >
        <Icon className="h-6 w-6" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[16px] font-semibold leading-6 text-[#22324c]">
          {title}
        </h2>
        <div className="mt-1 flex items-baseline gap-2">
          <strong className="text-[34px] font-bold leading-none text-[#081326]">
            {value}
          </strong>
          <span className="text-sm text-[#7b8ca7]">{unit}</span>
        </div>
        <div className="mt-[13px] flex items-center justify-between gap-2 text-sm leading-5">
          <span className="text-[#7b8ca7]">{footerLabel}</span>
          {footerValue}
        </div>
      </div>
    </article>
  );
}

function LegendItem({
  label,
  colorClassName,
}: {
  label: string;
  colorClassName: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] text-[#3a4b66]">
      <span
        className={cn('h-3 w-3 rounded-[2px]', colorClassName)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function EmptyPatrolState() {
  return (
    <div className="grid h-[294px] place-items-center rounded-md border border-dashed border-[#cbd9ec] bg-[#f8fbff] text-center">
      <div>
        <CalendarX2 className="mx-auto h-8 w-8 text-[#8ba2c1]" />
        <p className="mt-3 text-sm font-medium text-[#60738f]">
          该月份暂无轮巡计划
        </p>
      </div>
    </div>
  );
}

function MatrixStatusCell({
  device,
  month,
  cell,
}: {
  device: PatrolDeviceRow;
  month: string;
  cell: PatrolDeviceRow['days'][number];
}) {
  const date = `${month}-${String(cell.day).padStart(2, '0')}`;
  const label = STATUS_LABELS[cell.status];
  const tooltip = [
    device.name,
    date,
    label,
    cell.note,
    cell.windowId
      ? cell.isWindowStart
        ? '轮换窗口起始'
        : '轮换窗口持续'
      : undefined,
    cell.sourceCell ? `源单元格 ${cell.sourceCell}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const isKeyboardFocusable = cell.taskCount > 0 || cell.status === 'adjusted';

  if (cell.status === 'none') {
    return (
      <span
        className="block h-5 w-5 rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-[#1267d6] focus-visible:ring-offset-1"
        title={tooltip}
        aria-label={tooltip}
        role="img"
        tabIndex={-1}
      />
    );
  }

  return (
    <span
      className={cn(
        'block h-5 w-5 rounded-[4px] shadow-[0_3px_7px_rgba(48,92,153,0.18)] outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-[#1267d6] focus-visible:ring-offset-1 motion-reduce:transform-none',
        STATUS_CELL_CLASSES[cell.status],
      )}
      title={tooltip}
      aria-label={tooltip}
      role="img"
      tabIndex={isKeyboardFocusable ? 0 : -1}
    />
  );
}

function CalendarMatrix({
  devices,
  month,
}: {
  devices: PatrolDeviceRow[];
  month: string;
}) {
  if (devices.length === 0) return <EmptyPatrolState />;

  const days = devices[0].days;
  const tableWidth =
    MATRIX_SEQUENCE_COLUMN_WIDTH +
    MATRIX_DEVICE_COLUMN_WIDTH +
    days.length * MATRIX_DAY_COLUMN_WIDTH;

  return (
    <div
      className="max-w-full overflow-x-auto rounded-md bg-white shadow-[inset_0_0_0_1px_rgba(205,220,239,0.72)] outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-[#1267d6] focus-visible:ring-offset-1 [&::-webkit-scrollbar]:hidden"
      role="region"
      aria-label={`${formatMonth(month)}设备轮巡日历矩阵`}
      tabIndex={0}
    >
      <table
        className="table-fixed border-separate border-spacing-0 text-sm"
        style={{ width: tableWidth, minWidth: tableWidth }}
      >
        <colgroup>
          <col style={{ width: MATRIX_SEQUENCE_COLUMN_WIDTH }} />
          <col style={{ width: MATRIX_DEVICE_COLUMN_WIDTH }} />
          {days.map((day) => (
            <col key={day.day} style={{ width: MATRIX_DAY_COLUMN_WIDTH }} />
          ))}
        </colgroup>
        <thead>
          <tr className="h-[54px] bg-[linear-gradient(180deg,#0879dd_0%,#0568c8_100%)] text-white">
            <th className="sticky left-0 z-30 bg-[#0773d5] text-center text-[13px] font-semibold">
              序号
            </th>
            <th
              className="sticky z-30 bg-[#0773d5] px-6 text-left text-[13px] font-semibold shadow-[8px_0_16px_-14px_rgba(3,31,82,0.75)]"
              style={{ left: MATRIX_SEQUENCE_COLUMN_WIDTH }}
            >
              设备名称
            </th>
            {days.map((day) => {
              const dayMeta = getDayMeta(month, day.day);
              return (
                <th
                  key={day.day}
                  className={cn(
                    'text-center text-xs font-medium',
                    dayMeta.isWeekend && 'bg-white/[0.07]',
                  )}
                  scope="col"
                >
                  <span className="block leading-5">{day.day}</span>
                  <span
                    className={cn(
                      'block leading-5 text-blue-50',
                      dayMeta.isWeekend && 'text-[#ff7892]',
                    )}
                  >
                    {dayMeta.weekday}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {devices.map((device, index) => {
            const rowBackground = index % 2 === 0 ? 'bg-white' : 'bg-[#f8fbff]';

            return (
              <tr key={device.id} className="group h-10">
                <td
                  className={cn(
                    'sticky left-0 z-20 border-b border-[#edf2f8] text-center text-[13px] text-[#263752] transition-colors group-hover:bg-[#eef5ff]',
                    rowBackground,
                  )}
                >
                  {index + 1}
                </td>
                <th
                  className={cn(
                    'sticky z-20 border-b border-[#edf2f8] px-6 text-left text-[13px] font-medium text-[#182840] shadow-[8px_0_16px_-15px_rgba(40,77,128,0.65)] transition-colors group-hover:bg-[#eef5ff]',
                    rowBackground,
                  )}
                  scope="row"
                  title={
                    device.notes.length > 0
                      ? `${device.name}\n${getDeviceNoteText(device)}`
                      : device.name
                  }
                  style={{ left: MATRIX_SEQUENCE_COLUMN_WIDTH }}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{device.name}</span>
                    {device.notes.length > 0 && (
                      <Info
                        className="h-3.5 w-3.5 shrink-0 text-amber-500"
                        role="img"
                        aria-label={`${device.name}源表说明：${getDeviceNoteText(device)}`}
                      />
                    )}
                  </span>
                </th>
                {device.days.map((cell) => {
                  const dayMeta = getDayMeta(month, cell.day);
                  return (
                    <td
                      key={cell.day}
                      className={cn(
                        'border-b border-[#edf2f8] text-center transition-colors group-hover:bg-[#eef5ff]/80',
                        dayMeta.isWeekend ? 'bg-[#f4f8fd]' : rowBackground,
                      )}
                    >
                      <span className="grid place-items-center">
                        <MatrixStatusCell
                          device={device}
                          month={month}
                          cell={cell}
                        />
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ListView({
  devices,
  rateByDeviceId,
}: {
  devices: PatrolDeviceRow[];
  rateByDeviceId: ReadonlyMap<string, number | null>;
}) {
  if (devices.length === 0) return <EmptyPatrolState />;

  return (
    <div
      className="max-w-full overflow-x-auto rounded-md bg-white shadow-[inset_0_0_0_1px_rgba(205,220,239,0.72)] outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-[#1267d6] focus-visible:ring-offset-1 [&::-webkit-scrollbar]:hidden"
      role="region"
      aria-label="设备轮巡列表"
      tabIndex={0}
    >
      <table className="w-full min-w-[780px] table-fixed border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr className="h-[46px] bg-[linear-gradient(180deg,#0879dd_0%,#0568c8_100%)] text-white">
            <th className="w-[230px] px-6 text-left font-semibold">设备名称</th>
            <th className="text-center font-semibold">计划</th>
            <th className="text-center font-semibold">已执行</th>
            <th className="text-center font-semibold">部分执行</th>
            <th className="text-center font-semibold">未执行</th>
            <th className="text-center font-semibold">执行率</th>
            <th className="w-[170px] text-center font-semibold">
              最近未执行日期
            </th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const rate = rateByDeviceId.get(device.id) ?? null;
            return (
              <tr
                key={device.id}
                className="h-11 text-[#2b3c57] odd:bg-white even:bg-[#f8fbff] hover:bg-[#eef5ff]"
              >
                <th
                  className="border-b border-[#edf2f8] px-6 text-left font-medium"
                  scope="row"
                  title={
                    device.notes.length > 0
                      ? `${device.name}\n${getDeviceNoteText(device)}`
                      : device.name
                  }
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{device.name}</span>
                    {device.notes.length > 0 && (
                      <Info
                        className="h-3.5 w-3.5 shrink-0 text-amber-500"
                        role="img"
                        aria-label={`${device.name}源表说明：${getDeviceNoteText(device)}`}
                      />
                    )}
                  </span>
                </th>
                <td className="border-b border-[#edf2f8] text-center">
                  {device.planned}
                </td>
                <td className="border-b border-[#edf2f8] text-center text-emerald-600">
                  {device.executed ?? '--'}
                </td>
                <td className="border-b border-[#edf2f8] text-center text-amber-600">
                  {device.partial ?? '--'}
                </td>
                <td className="border-b border-[#edf2f8] text-center text-red-500">
                  {device.missed ?? '--'}
                </td>
                <td className="border-b border-[#edf2f8] text-center font-semibold text-[#1267d6]">
                  {rate === null ? '--' : `${rate.toFixed(1)}%`}
                </td>
                <td className="border-b border-[#edf2f8] text-center tabular-nums">
                  {device.lastMissedDate ?? '--'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MatrixNoteLegend({ showExecution }: { showExecution: boolean }) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-8 gap-y-2 px-[22px] text-[12px] text-[#71839d]">
      <strong className="text-[13px] font-semibold text-[#394a64]">
        备注：
      </strong>
      <LegendItem label="计划轮巡" colorClassName="bg-blue-500" />
      <LegendItem label="调整轮巡" colorClassName="bg-red-500" />
      {showExecution && (
        <>
          <LegendItem label="窗口内完成" colorClassName="bg-emerald-500" />
          <LegendItem label="执行中/偏离" colorClassName="bg-amber-400" />
          <LegendItem label="逾期未覆盖" colorClassName="bg-red-400" />
        </>
      )}
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <span className="inline-block h-3 w-3 rounded-sm bg-[#f3f7fc]" />
        无计划
      </span>
    </div>
  );
}

function SourcePlanNotes({ devices }: { devices: PatrolDeviceRow[] }) {
  const notedDevices = devices.filter((device) => device.notes.length > 0);
  if (notedDevices.length === 0) return null;

  const detail = notedDevices
    .map((device) => `${device.name}：${getDeviceNoteText(device)}`)
    .join('\n');

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-700"
      role="note"
      title={detail}
      aria-label={`源表轮巡例外说明：${detail}`}
    >
      <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      源表提示：{notedDevices.length} 个设备有轮巡例外
    </span>
  );
}

function ExecutionSourceBadge({
  view,
  loading,
  error,
}: {
  view: EquipmentPatrolExecutionView | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-[#6f829e]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        执行数据加载中
      </span>
    );
  }
  if (error || !view) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600">
        <AlertTriangle className="h-3.5 w-3.5" />
        执行数据读取失败
      </span>
    );
  }

  const isSnapshot = view.sourceStatus.mode === 'snapshot';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[12px] font-medium',
        isSnapshot ? 'text-amber-700' : 'text-emerald-700',
      )}
      title={view.sourceStatus.warnings.join('\n') || undefined}
    >
      <Database className="h-3.5 w-3.5" />
      {isSnapshot ? '飞书快照数据' : '飞书实时数据'}
      {view.sourceStatus.sourceUpdatedAt
        ? ` · ${view.sourceStatus.sourceUpdatedAt.slice(0, 10)}`
        : ''}
    </span>
  );
}

function BuildingExecutionCard({
  view,
  loading,
  error,
}: {
  view: EquipmentPatrolExecutionView | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="h-auto min-w-0 rounded-lg border border-[#d8e5f7] bg-white p-5 shadow-[0_7px_20px_rgba(38,91,159,0.07)] xl:col-span-2 xl:h-[263px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 text-[16px] font-semibold leading-6 text-[#15233a]">
          <Building2 className="h-4 w-4 text-[#1267d6]" />
          楼栋计划执行对照
        </h2>
        <ExecutionSourceBadge view={view} loading={loading} error={error} />
      </div>

      {loading ? (
        <div className="mt-3 space-y-2.5" aria-label="楼栋执行数据加载中">
          {EQUIPMENT_PATROL_BUILDINGS.map((building) => (
            <div
              key={building}
              className="h-[30px] animate-pulse rounded bg-[#f2f6fb]"
            />
          ))}
        </div>
      ) : error || !view ? (
        <div className="mt-14 text-center text-sm text-red-600">
          执行数据暂不可用，年度标准计划仍可查看
        </div>
      ) : (
        <div className="mt-3 divide-y divide-[#edf2f8]">
          {view.buildings.map((building) => {
            const rate = building.coverageRate ?? 0;
            const riskTone =
              building.overdue > 0
                ? 'text-red-600'
                : building.anomalyCount > 0
                  ? 'text-amber-700'
                  : 'text-emerald-700';
            const barTone =
              building.overdue > 0
                ? 'bg-red-500'
                : building.anomalyCount > 0
                  ? 'bg-amber-400'
                  : 'bg-emerald-500';

            return (
              <div
                key={building.building}
                className="grid min-h-[35px] grid-cols-[44px_minmax(100px,1fr)_56px_minmax(160px,1.2fr)] items-center gap-3 text-[12px] max-[560px]:grid-cols-[44px_minmax(110px,1fr)_52px]"
              >
                <strong className="text-[13px] text-[#21334e]">
                  {building.building}
                </strong>
                <span className="h-1.5 overflow-hidden rounded-full bg-[#eaf0f8]">
                  <span
                    className={cn('block h-full rounded-full', barTone)}
                    style={{ width: `${Math.min(100, rate)}%` }}
                  />
                </span>
                <span
                  className={cn(
                    'text-right font-semibold tabular-nums',
                    riskTone,
                  )}
                >
                  {building.coverageRate === null
                    ? '--'
                    : `${building.coverageRate.toFixed(1).replace('.0', '')}%`}
                </span>
                <span className="text-right tabular-nums text-[#657995] max-[560px]:col-span-3 max-[560px]:text-left">
                  应执行 {building.due} · 已覆盖 {building.covered} · 逾期{' '}
                  <strong
                    className={building.overdue > 0 ? 'text-red-600' : ''}
                  >
                    {building.overdue}
                  </strong>{' '}
                  · 偏离 {building.anomalyCount}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function anomalyTone(anomaly: EquipmentPatrolAnomaly): string {
  if (anomaly.priority <= 2) return 'border-red-200 bg-red-50 text-red-700';
  if (anomaly.priority <= 4)
    return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-blue-200 bg-blue-50 text-blue-700';
}

function ExecutionAnomalyCard({
  view,
  loading,
  error,
}: {
  view: EquipmentPatrolExecutionView | null;
  loading: boolean;
  error: string | null;
}) {
  const anomalies = view?.anomalies.slice(0, 5) ?? [];

  return (
    <section className="h-auto min-w-0 rounded-lg border border-[#f0d6d8] bg-white p-5 shadow-[0_7px_20px_rgba(136,45,54,0.07)] xl:h-[263px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 text-[16px] font-semibold leading-6 text-[#15233a]">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          执行异常
        </h2>
        <span className="text-[12px] font-semibold tabular-nums text-red-600">
          {view ? `${view.anomalies.length} 项` : '--'}
        </span>
      </div>

      {loading ? (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="h-8 animate-pulse rounded bg-[#f5f6f8]"
            />
          ))}
        </div>
      ) : error || !view ? (
        <p className="mt-16 text-center text-sm text-red-600">
          暂时无法判定执行异常
        </p>
      ) : anomalies.length === 0 ? (
        <div className="mt-14 text-center text-sm text-emerald-700">
          <CheckCircle2 className="mx-auto mb-2 h-6 w-6" />
          本月未发现执行异常
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {anomalies.map((anomaly) => (
            <li
              key={anomaly.id}
              className="grid min-w-0 grid-cols-[38px_minmax(0,1fr)_66px] items-center gap-2 text-[12px]"
              title={anomaly.message}
            >
              <span
                className={cn(
                  'rounded border px-1.5 py-1 text-center font-semibold',
                  anomalyTone(anomaly),
                )}
              >
                {anomaly.building ?? '数据'}
              </span>
              <span className="min-w-0 truncate text-[#334660]">
                {anomaly.category ? `${anomaly.category} · ` : ''}
                {anomaly.message}
              </span>
              <span className="text-right tabular-nums text-[#8292a9]">
                {anomaly.date?.slice(5) ?? '--'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function EquipmentPatrolDashboardPage() {
  const [selectedMonth, setSelectedMonth] = useState<string>(DEFAULT_MONTH);
  const [view, setView] = useState<DashboardView>('calendar');
  const [matrixScope, setMatrixScope] = useState<MatrixScope>('standard');
  const [planRevision, setPlanRevision] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [executionResponse, setExecutionResponse] =
    useState<EquipmentPatrolExecutionResponse | null>(null);
  const [executionLoading, setExecutionLoading] = useState(true);
  const [executionError, setExecutionError] = useState<string | null>(null);

  const dashboard = useMemo(
    () => getPatrolMonthDashboard(selectedMonth),
    [selectedMonth, planRevision],
  );
  const executionView = useMemo(
    () =>
      executionResponse
        ? buildEquipmentPatrolExecutionView(dashboard, executionResponse)
        : null,
    [dashboard, executionResponse],
  );
  const displayedDevices = useMemo(
    () =>
      matrixScope === 'standard'
        ? dashboard.devices
        : (executionView?.buildingDevices[matrixScope] ?? dashboard.devices),
    [dashboard.devices, executionView, matrixScope],
  );
  const ranking = useMemo(
    () => rankPatrolDevices(displayedDevices),
    [displayedDevices],
  );
  const rateByDeviceId = useMemo(
    () => new Map(ranking.map((device) => [device.id, device.rate])),
    [ranking],
  );

  const loadExecution = useCallback(
    async (refresh = false) => {
      setExecutionLoading(true);
      setExecutionError(null);
      if (!refresh) setExecutionResponse(null);
      try {
        const response = await getEquipmentPatrolExecutions(
          selectedMonth,
          refresh,
        );
        setExecutionResponse(response);
      } catch {
        setExecutionError('执行数据读取失败');
      } finally {
        setExecutionLoading(false);
      }
    },
    [selectedMonth],
  );

  useEffect(() => {
    void loadExecution(false);
  }, [loadExecution]);

  const handleMonthChange = (month: string) => {
    const nextDashboard = getPatrolMonthDashboard(month);
    setSelectedMonth(nextDashboard.month);
  };

  const handleRefresh = async () => {
    const startedAt = Date.now();
    setPlanRevision((revision) => revision + 1);
    setIsRefreshing(true);
    try {
      await loadExecution(true);
    } finally {
      const remaining = Math.max(0, 650 - (Date.now() - startedAt));
      await new Promise((resolve) => setTimeout(resolve, remaining));
      setIsRefreshing(false);
    }
  };

  const kpis = executionView?.kpis;
  const overallCoverageRate =
    kpis && kpis.due > 0 ? (kpis.covered / kpis.due) * 100 : null;
  const dataUpdatedAt =
    executionView?.sourceStatus.sourceUpdatedAt ??
    dashboard.planSourceUpdatedAt.replace(' ', 'T');
  const dataUpdatedLabel = dataUpdatedAt.replace('T', ' ').slice(0, 19);

  return (
    <div
      className="min-h-[calc(100dvh-var(--global-navigation-height,0px))] max-w-full overflow-x-hidden bg-[#f4f8fd] font-['Inter',system-ui,sans-serif] tracking-normal text-[#16243a]"
      data-screenshot-target="equipment-patrol-dashboard"
    >
      <header className="min-h-[84px] w-full bg-[linear-gradient(110deg,#075ac9_0%,#074dbb_52%,#06359d_100%)] text-white shadow-[0_5px_18px_rgba(12,66,155,0.18)] xl:h-[84px]">
        <div className="mx-auto flex min-h-[84px] max-w-[1600px] flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-3 sm:px-7 xl:flex-nowrap xl:px-8 xl:py-0">
          <div className="flex min-w-0 flex-1 items-center gap-5">
            <div
              className="inline-flex h-12 w-28 shrink-0 items-center sm:h-14 sm:w-36 xl:w-40"
              role="img"
              aria-label="世纪互联 VNET"
            >
              <span
                aria-hidden="true"
                className="block h-10 w-full bg-white drop-shadow-[0_3px_10px_rgba(0,0,0,0.2)] sm:h-12"
                style={{
                  WebkitMask: `url(${VNET_OFFICIAL_LOGO_URL}) center / contain no-repeat`,
                  mask: `url(${VNET_OFFICIAL_LOGO_URL}) center / contain no-repeat`,
                }}
              />
            </div>
            <span
              className="h-9 w-px shrink-0 bg-white/20"
              aria-hidden="true"
            />
            <h1 className="min-w-0 text-[18px] font-semibold leading-7 text-white sm:text-[24px] xl:text-[30px]">
              南通运维全景平台 · 设备轮巡看板
            </h1>
          </div>

          <div className="flex w-full flex-wrap items-center gap-x-8 gap-y-2 text-[14px] font-medium text-white sm:text-[15px] xl:w-auto xl:flex-nowrap">
            <label className="relative inline-flex items-center gap-2">
              <CalendarDays className="h-[18px] w-[18px] shrink-0" />
              <span className="sr-only">选择轮巡月份</span>
              <select
                className="appearance-none rounded-sm bg-transparent py-1 pl-0 pr-6 font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                value={selectedMonth}
                onChange={(event) => handleMonthChange(event.target.value)}
                aria-label="选择轮巡月份"
              >
                {PATROL_MONTH_OPTIONS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    className="text-[#17253d]"
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-0 h-4 w-4" />
            </label>

            <span className="inline-flex items-center gap-2 whitespace-nowrap tabular-nums">
              <Clock3 className="h-[18px] w-[18px]" />
              <span>数据版本时间</span>
              <time dateTime={dataUpdatedAt}>{dataUpdatedLabel}</time>
            </span>

            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-sm py-1 font-semibold text-white outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-80"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing}
              aria-label="重新载入计划与执行数据"
            >
              <RefreshCw
                className={cn(
                  'h-[18px] w-[18px] motion-reduce:animate-none',
                  isRefreshing && 'animate-spin [animation-duration:650ms]',
                )}
              />
              重新载入数据
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 pb-3 pt-[21px] sm:px-6">
        <section
          className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
          aria-label="设备轮巡关键指标"
        >
          <MetricCard
            icon={ClipboardList}
            iconClassName="bg-[linear-gradient(145deg,#4d8dff,#2464f5)]"
            title="本月标准计划"
            value={
              kpis?.monthPlanPerBuilding ??
              dashboard.devices.reduce(
                (total, device) => total + device.planned,
                0,
              )
            }
            unit="次"
            footerLabel="楼栋展开"
            footerValue={
              <span className="font-semibold tabular-nums text-[#1267d6]">
                {kpis ? kpis.monthPlanPerBuilding * 5 : '--'} 项
              </span>
            }
          />
          <MetricCard
            icon={CalendarDays}
            iconClassName="bg-[linear-gradient(145deg,#42cf96,#20b879)]"
            title="截至今日应执行"
            value={kpis?.due ?? '--'}
            unit="项"
            footerLabel="数据截止"
            footerValue={
              <span className="font-semibold tabular-nums text-[#55708f]">
                {executionView?.sourceStatus.referenceDate?.slice(5) ?? '--'}
              </span>
            }
          />
          <MetricCard
            icon={ClipboardCheck}
            iconClassName="bg-[linear-gradient(145deg,#34c995,#12a979)]"
            title="已覆盖计划"
            value={kpis?.covered ?? '--'}
            unit="项"
            footerLabel="覆盖率"
            footerValue={
              <span className="font-semibold tabular-nums text-emerald-600">
                {overallCoverageRate === null
                  ? '--'
                  : `${overallCoverageRate.toFixed(1)}%`}
              </span>
            }
          />
          <MetricCard
            icon={AlertTriangle}
            iconClassName="bg-[linear-gradient(145deg,#ff9345,#ef5350)]"
            title="执行偏离"
            value={kpis?.deviations ?? '--'}
            unit="项"
            footerLabel="状态"
            footerValue={
              <span
                className={cn(
                  'font-semibold',
                  kpis && kpis.deviations > 0
                    ? 'text-red-600'
                    : 'text-emerald-600',
                )}
              >
                {kpis ? (kpis.deviations > 0 ? '需关注' : '正常') : '加载中'}
              </span>
            }
          />
          <MetricCard
            icon={Building2}
            iconClassName="bg-[linear-gradient(145deg,#62a5ff,#3979eb)]"
            title="达标楼栋"
            value={kpis?.compliantBuildings ?? '--'}
            unit="/ 5 栋"
            footerLabel="无执行异常"
            footerValue={
              <span className="font-semibold text-[#55708f]">
                {kpis ? `${kpis.compliantBuildings} 栋` : '--'}
              </span>
            }
          />
        </section>

        <section className="mt-[18px] h-auto min-w-0 overflow-hidden rounded-lg border border-[#d8e5f7] bg-white shadow-[0_7px_20px_rgba(38,91,159,0.07)] xl:h-[438px]">
          <div className="px-[22px] pt-[18px]">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-[18px] font-semibold leading-7 text-[#263752]">
                设备轮巡计划与执行明细（{formatMonth(dashboard.month)}）
                {matrixScope !== 'standard' ? ` · ${matrixScope}` : ''}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative inline-flex h-[38px] items-center gap-2 rounded-md border border-[#d8e5f7] bg-white pl-3 pr-2 text-[13px] text-[#405674]">
                  <Building2 className="h-4 w-4 text-[#1267d6]" />
                  <span className="sr-only">选择楼栋执行视图</span>
                  <select
                    className="h-full appearance-none bg-transparent py-0 pl-0 pr-6 font-medium outline-none disabled:text-[#9aabc0]"
                    value={matrixScope}
                    onChange={(event) =>
                      setMatrixScope(event.target.value as MatrixScope)
                    }
                    disabled={executionLoading || !executionView}
                    aria-label="选择楼栋执行视图"
                  >
                    <option value="standard">标准计划</option>
                    {EQUIPMENT_PATROL_BUILDINGS.map((building) => (
                      <option key={building} value={building}>
                        {building}执行
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 h-4 w-4 text-[#71839d]" />
                </label>
                <div
                  className="inline-flex w-fit rounded-md border border-[#d8e5f7] bg-[#f4f8fd] p-[2px]"
                  role="group"
                  aria-label="轮巡明细视图"
                >
                  <button
                    type="button"
                    className={cn(
                      'h-8 rounded px-4 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1',
                      view === 'calendar'
                        ? 'bg-white text-[#1267d6] shadow-sm'
                        : 'text-[#71839d] hover:text-[#245b9f]',
                    )}
                    onClick={() => setView('calendar')}
                    aria-pressed={view === 'calendar'}
                  >
                    日历视图
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'h-8 rounded px-4 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1',
                      view === 'list'
                        ? 'bg-white text-[#1267d6] shadow-sm'
                        : 'text-[#71839d] hover:text-[#245b9f]',
                    )}
                    onClick={() => setView('list')}
                    aria-pressed={view === 'list'}
                  >
                    列表视图
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-7 gap-y-2">
              <LegendItem label="计划轮巡" colorClassName="bg-blue-500" />
              <LegendItem label="调整轮巡" colorClassName="bg-red-500" />
              {matrixScope !== 'standard' && (
                <>
                  <LegendItem
                    label="窗口内完成"
                    colorClassName="bg-emerald-500"
                  />
                  <LegendItem label="执行中" colorClassName="bg-amber-400" />
                  <LegendItem label="逾期未覆盖" colorClassName="bg-red-400" />
                </>
              )}
              <ExecutionSourceBadge
                view={executionView}
                loading={executionLoading}
                error={executionError}
              />
              <SourcePlanNotes devices={dashboard.devices} />
            </div>
          </div>

          <div className="mx-[22px] mt-[11px]">
            {view === 'calendar' ? (
              <CalendarMatrix
                devices={displayedDevices}
                month={dashboard.month}
              />
            ) : (
              <ListView
                devices={displayedDevices}
                rateByDeviceId={rateByDeviceId}
              />
            )}
          </div>
          <MatrixNoteLegend showExecution={matrixScope !== 'standard'} />
        </section>

        <div className="mt-[14px] grid min-w-0 grid-cols-1 items-start gap-[15px] xl:grid-cols-3">
          <BuildingExecutionCard
            view={executionView}
            loading={executionLoading}
            error={executionError}
          />
          <ExecutionAnomalyCard
            view={executionView}
            loading={executionLoading}
            error={executionError}
          />
        </div>

        <footer className="mt-[13px] flex min-h-[22px] flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[#6f829e]">
          <Info className="h-[14px] w-[14px]" />
          <span>
            计划文件更新时间：
            <time
              className="tabular-nums"
              dateTime={dashboard.planSourceUpdatedAt.replace(' ', 'T')}
            >
              {dashboard.planSourceUpdatedAt}
            </time>
          </span>
          <span className="text-[#b2bfce]">|</span>
          <span>
            执行数据：
            {executionView
              ? `${executionView.sourceStatus.mode === 'live' ? '飞书实时' : '本地快照'} · ${executionView.sourceStatus.sourceUpdatedAt?.replace('T', ' ').slice(0, 19) ?? '暂无更新时间'}`
              : executionLoading
                ? '加载中'
                : '读取失败'}
          </span>
        </footer>
      </div>
    </div>
  );
}
