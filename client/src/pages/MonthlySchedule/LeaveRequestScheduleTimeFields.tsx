import { useMemo } from 'react';
import type { LeaveRequestShiftRange } from '@shared/leave-request-impact';

export interface LeaveRequestScheduleTimeFieldsProps {
  startAt: string;
  endAt: string;
  startOptions: readonly string[];
  endOptions: readonly string[];
  shiftRanges?: readonly LeaveRequestShiftRange[];
  disabled: boolean;
  loading: boolean;
  onStartAtChange: (value: string) => void;
  onEndAtChange: (value: string) => void;
}

export interface ScheduleTimeOption {
  value: string;
  groupKey: string;
  groupLabel: string;
  timeLabel: string;
}

type ScheduleTimeBoundary = 'start' | 'end';

export function selectDefaultScheduleTimeForGroup(
  options: readonly ScheduleTimeOption[],
  groupKey: string,
  boundary: ScheduleTimeBoundary,
): string {
  const groupOptions = options.filter((option) => option.groupKey === groupKey);
  const defaultOption =
    boundary === 'end'
      ? groupOptions[groupOptions.length - 1]
      : groupOptions[0];
  return defaultOption?.value || '';
}

const WHOLE_HOUR_LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:00)$/;

const selectClassName =
  'h-9 min-w-0 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800 outline-none transition-colors focus:border-blue-300 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60';

const SHIFT_KIND_LABELS: Record<LeaveRequestShiftRange['kind'], string> = {
  white: '白班',
  night: '夜班',
  long_white: '长白',
  station_110_white: '110白班',
  station_110_night: '110夜班',
};

function getRangeGroupKey(range: LeaveRequestShiftRange): string {
  return [range.scheduleDate, range.kind, range.startAt, range.endAt].join('|');
}

function getClockLabel(value: string, anchorDate: string): string {
  const match = WHOLE_HOUR_LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return '';
  }
  return match[1] === anchorDate ? match[2] : `次日${match[2]}`;
}

function getRangeLabel(range: LeaveRequestShiftRange): string {
  const anchorDate = range.startAt.slice(0, 10);
  return `${range.scheduleDate} · ${SHIFT_KIND_LABELS[range.kind]} · ${getClockLabel(
    range.startAt,
    anchorDate,
  )}–${getClockLabel(range.endAt, anchorDate)}`;
}

function containsBoundary(
  range: LeaveRequestShiftRange,
  value: string,
  boundary: ScheduleTimeBoundary,
): boolean {
  return boundary === 'start'
    ? range.startAt <= value && value < range.endAt
    : range.startAt < value && value <= range.endAt;
}

function normalizeOptions(
  options: readonly string[],
  shiftRanges: readonly LeaveRequestShiftRange[],
  boundary: ScheduleTimeBoundary,
): ScheduleTimeOption[] {
  const uniqueOptions = new Map<string, ScheduleTimeOption>();
  const sortedRanges = [...shiftRanges].sort(
    (left, right) =>
      left.startAt.localeCompare(right.startAt) ||
      left.endAt.localeCompare(right.endAt),
  );

  for (const value of options) {
    const match = WHOLE_HOUR_LOCAL_DATE_TIME_PATTERN.exec(value);
    if (!match || uniqueOptions.has(value)) {
      continue;
    }

    if (sortedRanges.length > 0) {
      const range = sortedRanges.find((candidate) =>
        containsBoundary(candidate, value, boundary),
      );
      if (!range) {
        continue;
      }
      const anchorDate = range.startAt.slice(0, 10);
      uniqueOptions.set(value, {
        value,
        groupKey: getRangeGroupKey(range),
        groupLabel: getRangeLabel(range),
        timeLabel: getClockLabel(value, anchorDate),
      });
      continue;
    }

    uniqueOptions.set(value, {
      value,
      groupKey: match[1],
      groupLabel: match[1],
      timeLabel: match[2],
    });
  }

  return [...uniqueOptions.values()].sort((left, right) =>
    left.value.localeCompare(right.value),
  );
}

interface ScheduleTimeSelectGroupProps {
  idPrefix: 'leave-start' | 'leave-end';
  label: string;
  value: string;
  options: readonly string[];
  shiftRanges: readonly LeaveRequestShiftRange[];
  boundary: ScheduleTimeBoundary;
  disabled: boolean;
  onChange: (value: string) => void;
}

function ScheduleTimeSelectGroup({
  idPrefix,
  label,
  value,
  options,
  shiftRanges,
  boundary,
  disabled,
  onChange,
}: ScheduleTimeSelectGroupProps) {
  const normalizedOptions = useMemo(
    () => normalizeOptions(options, shiftRanges, boundary),
    [boundary, options, shiftRanges],
  );
  const groups = useMemo(() => {
    const uniqueGroups = new Map<string, string>();
    normalizedOptions.forEach((option) => {
      if (!uniqueGroups.has(option.groupKey)) {
        uniqueGroups.set(option.groupKey, option.groupLabel);
      }
    });
    return [...uniqueGroups.entries()].map(([key, label]) => ({ key, label }));
  }, [normalizedOptions]);
  const valueGroupKey = normalizedOptions.find(
    (option) => option.value === value,
  )?.groupKey;
  const selectedGroupKey =
    valueGroupKey && groups.some((group) => group.key === valueGroupKey)
      ? valueGroupKey
      : '';
  const timeOptions = useMemo(
    () =>
      normalizedOptions.filter(
        (option) => option.groupKey === selectedGroupKey,
      ),
    [normalizedOptions, selectedGroupKey],
  );
  const selectedValue = timeOptions.some((option) => option.value === value)
    ? value
    : '';

  const handleGroupChange = (groupKey: string) => {
    const defaultValue = selectDefaultScheduleTimeForGroup(
      normalizedOptions,
      groupKey,
      boundary,
    );
    if (defaultValue) {
      onChange(defaultValue);
    }
  };

  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="text-xs font-semibold text-slate-500">{label}</legend>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_112px] gap-2">
        <div className="grid min-w-0 gap-1">
          <label
            htmlFor={`${idPrefix}-date`}
            className="text-[11px] font-medium text-slate-500"
          >
            {shiftRanges.length > 0 ? '排班班次' : '日期'}
          </label>
          <select
            id={`${idPrefix}-date`}
            value={selectedGroupKey}
            disabled={disabled}
            onChange={(event) => handleGroupChange(event.target.value)}
            className={selectClassName}
          >
            {selectedGroupKey === '' ? (
              <option value="" disabled={groups.length > 0}>
                {shiftRanges.length > 0 ? '请选择班次' : '请选择日期'}
              </option>
            ) : null}
            {groups.map((group) => (
              <option key={group.key} value={group.key}>
                {group.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid min-w-0 gap-1">
          <label
            htmlFor={`${idPrefix}-time`}
            className="text-[11px] font-medium text-slate-500"
          >
            时刻
          </label>
          <select
            id={`${idPrefix}-time`}
            value={selectedValue}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            className={selectClassName}
          >
            {selectedValue === '' ? (
              <option value="" disabled={timeOptions.length > 0}>
                请选择时刻
              </option>
            ) : null}
            {timeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.timeLabel}
              </option>
            ))}
          </select>
        </div>
      </div>
    </fieldset>
  );
}

export function LeaveRequestScheduleTimeFields({
  startAt,
  endAt,
  startOptions,
  endOptions,
  shiftRanges = [],
  disabled,
  loading,
  onStartAtChange,
  onEndAtChange,
}: LeaveRequestScheduleTimeFieldsProps) {
  const safeEndOptions = useMemo(
    () => endOptions.filter((option) => option > startAt),
    [endOptions, startAt],
  );
  const hasOptions = startOptions.length > 0 && safeEndOptions.length > 0;

  return (
    <div className="grid gap-3 sm:col-span-2" aria-busy={loading}>
      {loading ? (
        <div
          role="status"
          className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700"
        >
          正在读取该人员的排班时段…
        </div>
      ) : !hasOptions ? (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          当前人员没有可请休假的排班时段，请确认人员或排班月份。
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <ScheduleTimeSelectGroup
          idPrefix="leave-start"
          label="开始时间"
          value={startAt}
          options={startOptions}
          shiftRanges={shiftRanges}
          boundary="start"
          disabled={disabled}
          onChange={onStartAtChange}
        />
        <ScheduleTimeSelectGroup
          idPrefix="leave-end"
          label="结束时间"
          value={endAt}
          options={safeEndOptions}
          shiftRanges={shiftRanges}
          boundary="end"
          disabled={disabled}
          onChange={onEndAtChange}
        />
      </div>
    </div>
  );
}
