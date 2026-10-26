import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DEMO_AS_OF,
  DEMO_MONTHS,
  DEMO_START,
  DEMO_YEARS,
  rangeError,
  resolvePeriod,
  type PeriodSelection,
} from './period';

export function PeriodControl({
  value,
  onChange,
}: {
  value: PeriodSelection;
  onChange: (value: PeriodSelection) => void;
}) {
  const period = resolvePeriod(value);
  const [draft, setDraft] = useState({ start: period.start, end: period.asOf });
  const error = rangeError(draft.start, draft.end);
  const changed =
    value.mode === 'range' &&
    (value.start !== draft.start || value.end !== draft.end);
  const options: readonly string[] =
    value.mode === 'year' ? DEMO_YEARS : DEMO_MONTHS;
  const selected =
    value.mode === 'year'
      ? value.year
      : value.mode === 'month'
        ? value.month
        : '';
  const index = options.indexOf(selected);
  const select = (next: string) =>
    onChange(
      value.mode === 'year'
        ? { mode: 'year', year: next }
        : { mode: 'month', month: next },
    );
  const switchMode = (mode: PeriodSelection['mode']) => {
    if (mode === value.mode) return;
    if (mode === 'range') {
      const next = { start: period.start, end: period.asOf };
      setDraft(next);
      onChange({ mode, ...next });
    } else if (mode === 'last30') onChange({ mode });
    else if (mode === 'year')
      onChange({ mode, year: period.asOf.slice(0, 4) });
    else onChange({ mode, month: period.asOf.slice(0, 7) });
  };
  return (
    <div className="mo-period-control">
      <div className="mo-period-modes" role="group" aria-label="统计周期">
        {(
          [
            { key: 'month', label: '月度' },
            { key: 'year', label: '年度' },
            { key: 'last30', label: '过去30天' },
            { key: 'range', label: '自定义' },
          ] as const
        ).map(({ key, label }) => (
          <Button
            key={key}
            size="sm"
            variant="ghost"
            aria-pressed={value.mode === key}
            onClick={() => switchMode(key)}
          >
            {label}
          </Button>
        ))}
      </div>
      {value.mode === 'last30' ? (
        <div className="mo-recent-range" aria-label="过去30天日期范围">
          <CalendarDays aria-hidden="true" />
          <span>{period.rangeLabel}</span>
        </div>
      ) : value.mode === 'range' ? (
        <form
          className="mo-range-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!error) onChange({ mode: 'range', ...draft });
          }}
        >
          <div className="mo-range-inputs">
            <label>
              <span className="sr-only">开始日期</span>
              <Input
                type="date"
                aria-label="开始日期"
                min={DEMO_START}
                max={DEMO_AS_OF}
                value={draft.start}
                aria-invalid={!!error}
                aria-describedby="mo-range-feedback"
                onChange={(event) =>
                  setDraft({ ...draft, start: event.target.value })
                }
              />
            </label>
            <span>至</span>
            <label>
              <span className="sr-only">结束日期</span>
              <Input
                type="date"
                aria-label="结束日期"
                min={DEMO_START}
                max={DEMO_AS_OF}
                value={draft.end}
                aria-invalid={!!error}
                aria-describedby="mo-range-feedback"
                onChange={(event) =>
                  setDraft({ ...draft, end: event.target.value })
                }
              />
            </label>
            <Button type="submit" size="sm" disabled={!!error || !changed}>
              应用范围
            </Button>
          </div>
          <span
            id="mo-range-feedback"
            className={error ? 'mo-range-error' : 'mo-range-hint'}
            role="status"
          >
            {error ??
              (changed ? '日期已修改，应用后更新' : '已应用所选日期范围')}
          </span>
        </form>
      ) : (
        <div className="mo-month-control">
          <Button
            variant="ghost"
            size="icon"
            aria-label={value.mode === 'year' ? '上一年' : '上个月'}
            disabled={index <= 0}
            onClick={() => select(options[index - 1])}
          >
            <ChevronLeft />
          </Button>
          <CalendarDays aria-hidden="true" />
          <Select value={selected} onValueChange={select}>
            <SelectTrigger
              aria-label={value.mode === 'year' ? '选择年份' : '选择月份'}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option} value={option}>
                  {value.mode === 'year'
                    ? `${option} 全年`
                    : `${option.slice(0, 4)} 年 ${Number(option.slice(5))} 月`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            aria-label={value.mode === 'year' ? '下一年' : '下个月'}
            disabled={index >= options.length - 1}
            onClick={() => select(options[index + 1])}
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
