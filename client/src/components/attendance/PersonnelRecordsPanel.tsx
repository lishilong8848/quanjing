import { useMemo, useState } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PersonnelTimeInsightsResponse } from '@shared/personnel-time-insights.interface';
import type { PersonnelTimeInsightsLoadState } from '../personnel-time-insights/use-personnel-time-insights';
import { formatPersonnelHours } from '../personnel-time-insights/personnel-time-insights-presentation';
import {
  buildPersonnelRecords,
  filterPersonnelRecords,
  groupPersonnelRecords,
  rankPersonnelRecords,
  type PersonnelRecordKind,
  type PersonnelRecordGroupMode,
  type PersonnelRecordDrilldown,
} from './personnel-records-presentation';

interface Props {
  kind: PersonnelRecordKind;
  data: PersonnelTimeInsightsResponse | null;
  state: PersonnelTimeInsightsLoadState;
  error: string | null;
  onRetry: () => void;
}
export function PersonnelRecordsPanel({
  kind,
  data,
  state,
  error,
  onRetry,
}: Props) {
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [groupMode, setGroupMode] =
    useState<PersonnelRecordGroupMode>('building');
  const [rankMode, setRankMode] = useState<'person' | 'building'>('person');
  const [rankMetric, setRankMetric] = useState<'hours' | 'count'>('hours');
  const [drilldown, setDrilldown] = useState<PersonnelRecordDrilldown | null>(
    null,
  );
  const rows = useMemo(
    () => buildPersonnelRecords(data?.people || [], kind),
    [data?.people, kind],
  );
  const filtered = useMemo(
    () => filterPersonnelRecords(rows, category, null, search),
    [rows, category, search],
  );
  const groups = useMemo(
    () =>
      groupPersonnelRecords(
        filterPersonnelRecords(filtered, 'all', drilldown),
        groupMode,
      ),
    [filtered, drilldown, groupMode],
  );
  const metric = category === 'pending' ? 'count' : rankMetric;
  const rankings = useMemo(
    () => rankPersonnelRecords(filtered, rankMode, metric),
    [filtered, rankMode, metric],
  );
  const label = kind === 'leave' ? '请休假' : '加班';
  const categories =
    kind === 'leave'
      ? ['all', ...new Set(rows.map((row) => row.category))]
      : ['all', 'confirmed', 'pending', '调休', '加班费', '费用结算'];
  const categoryLabels: Record<string, string> = {
    all: '全部',
    confirmed: '已确认',
    pending: '待确认',
  };
  const categoryLabel = (value: string) => categoryLabels[value] || value;
  const sum = (entries: typeof rows) =>
    formatPersonnelHours(entries.reduce((total, row) => total + row.hours, 0));
  const pending = rows.filter((row) => row.status === 'pending');
  const official = rows.filter((row) => row.status !== 'pending');
  const cards =
    kind === 'leave'
      ? [
          ['请休假人员', new Set(rows.map((row) => row.personKey)).size],
          ['休假工时', sum(rows.filter((row) => !row.travel))],
          ['差旅工时', sum(rows.filter((row) => row.travel))],
          ['申请数', new Set(rows.map((row) => row.recordId)).size],
        ]
      : [
          ['已确认人员', new Set(official.map((row) => row.personKey)).size],
          ['实际工时', sum(official)],
          ['待确认', `${pending.length} 项`],
          ['申请工时', sum(pending)],
        ];

  if (!data)
    return (
      <div
        className="flex min-h-56 flex-col items-center justify-center gap-3"
        role={state === 'error' ? 'alert' : 'status'}
      >
        {state === 'error' ? (
          <>
            <TriangleAlert className="size-7 text-rose-500" aria-hidden />
            <p className="text-sm text-rose-700">{error}</p>
            <Button variant="outline" onClick={onRetry}>
              重试
            </Button>
          </>
        ) : (
          <>
            <RefreshCw
              className="size-5 animate-spin text-blue-500"
              aria-hidden
            />
            <p className="text-sm text-muted-foreground">{label}数据加载中…</p>
          </>
        )}
      </div>
    );

  return (
    <div className="space-y-3">
      {state === 'loading' && (
        <p
          className="flex items-center gap-2 text-xs text-blue-700"
          role="status"
        >
          <RefreshCw className="size-3.5 animate-spin" aria-hidden />
          正在更新，当前保留上次查询结果
        </p>
      )}
      {state === 'error' && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-rose-50 p-2 text-xs text-rose-700"
          role="alert"
        >
          <span>{error}，当前保留上次查询结果</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map(([name, value]) => (
          <Card key={name} className="gap-0 py-3">
            <CardContent className="px-3">
              <p className="text-xs text-muted-foreground">{name}</p>
              <p className="mt-1 text-lg font-bold">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label={`${label}类型筛选`}
      >
        {categories.map((value) => (
          <Button
            key={value}
            variant={category === value ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={category === value}
            onClick={() => {
              setCategory(value);
              setDrilldown(null);
            }}
          >
            {categoryLabel(value)} {filterPersonnelRecords(rows, value).length}
          </Button>
        ))}
        <Input
          className="min-w-0 sm:ml-auto sm:w-48"
          placeholder="姓名、楼栋"
          aria-label={`${label}明细搜索`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
          所选周期暂无{label}记录
        </p>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(16rem,0.8fr)]">
          <Card className="min-w-0 gap-0 py-0">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <CardTitle className="text-sm">{label}明细</CardTitle>
              <Modes
                value={groupMode}
                onChange={(value) =>
                  setGroupMode(value as PersonnelRecordGroupMode)
                }
                options={[
                  ['building', '按楼栋'],
                  ['category', '按类型'],
                  ['person', '按人员'],
                ]}
              />
            </CardHeader>
            {drilldown && (
              <div className="flex items-center justify-between gap-2 border-b bg-blue-50 px-3 py-2 text-xs text-blue-700">
                <span>
                  {drilldown.label || drilldown.value} ·{' '}
                  {groups.reduce((n, g) => n + g.items.length, 0)} 项
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDrilldown(null)}
                >
                  清除筛选
                </Button>
              </div>
            )}
            <CardContent className="max-h-[44vh] space-y-3 overflow-y-auto p-3">
              {!groups.length && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  当前筛选没有{label}记录
                </p>
              )}
              {groups.map((group) => (
                <section
                  key={group.key}
                  className="overflow-hidden rounded-md border"
                >
                  <div className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-2">
                    <h4 className="min-w-0 truncate text-sm font-semibold">
                      {group.label}
                    </h4>
                    <Badge variant="secondary">{group.items.length} 项</Badge>
                  </div>
                  <ul className="divide-y">
                    {group.items.map((row) => (
                      <li
                        key={row.key}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs [content-visibility:auto] [contain-intrinsic-size:auto_3rem]"
                      >
                        <span className="min-w-0 break-words text-muted-foreground">
                          {row.startAt.slice(5)} 至{' '}
                          {row.endAt ? row.endAt.slice(5) : '结束时间未录'}
                        </span>
                        <span className="font-semibold">{row.name}</span>
                        <span className="text-muted-foreground">
                          {row.building}
                        </span>
                        <span className="ml-auto shrink-0 text-right font-semibold">
                          {row.status === 'pending' ? '申请 ' : ''}
                          {formatPersonnelHours(row.hours)}
                        </span>
                        <Badge
                          variant="secondary"
                          className={
                            row.status === 'pending'
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-blue-50 text-blue-700'
                          }
                        >
                          {row.category}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </CardContent>
          </Card>
          <Card className="min-w-0 gap-0 py-0">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <CardTitle className="text-sm">{label}排行</CardTitle>
              <Modes
                value={rankMode}
                onChange={(value) =>
                  setRankMode(value as 'person' | 'building')
                }
                options={[
                  ['person', '人员'],
                  ['building', '楼栋'],
                ]}
              />
            </CardHeader>
            <div className="border-b px-3 py-2">
              <Modes
                value={metric}
                onChange={(value) => setRankMetric(value as 'hours' | 'count')}
                options={
                  category === 'pending'
                    ? [['count', '按次数']]
                    : [
                        [
                          'hours',
                          kind === 'overtime' ? '按实际工时' : '按工时',
                        ],
                        ['count', '按次数'],
                      ]
                }
              />
            </div>
            <CardContent className="max-h-[44vh] overflow-y-auto px-3 py-0">
              <ol className="divide-y">
                {rankings.map((entry, index) => (
                  <li key={entry.key}>
                    <button
                      className="flex w-full items-center gap-3 rounded-md py-3 text-left hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      aria-label={`查看${entry.label}${label}明细`}
                      aria-pressed={
                        drilldown?.kind === rankMode &&
                        drilldown.value === entry.key
                      }
                      onClick={() =>
                        setDrilldown({
                          kind: rankMode,
                          value: entry.key,
                          label: entry.label,
                        })
                      }
                    >
                      <span
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                          index < 3
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-slate-100 text-slate-600',
                        )}
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {entry.label}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {entry.buildings.join('、')} · {entry.count} 项
                        </span>
                      </span>
                      <strong className="shrink-0 text-right text-sm text-blue-700">
                        {metric === 'hours'
                          ? formatPersonnelHours(entry.value)
                          : `${entry.value} 次`}
                      </strong>
                    </button>
                  </li>
                ))}
              </ol>
              {!rankings.length && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  暂无{metric === 'hours' ? '实际工时' : '次数'}排行
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Modes({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex flex-wrap rounded-md bg-slate-100 p-0.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={cn(
            'rounded px-2 py-1 text-xs',
            value === key
              ? 'bg-white font-semibold text-blue-700 shadow-sm'
              : 'text-muted-foreground',
          )}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
