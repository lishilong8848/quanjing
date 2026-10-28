import { useMonthlyOperationsExport } from './use-export-access';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  MonthlyEvent,
  MonthlyEventReviewReport,
  MonthlyEventReviewReportContent,
} from '@shared/monthly-operations-events.interface';
import type { ReportPeriod } from './period';
import { EmptyState, Panel } from './charts';
import { fetchEventReviewReport } from './event-data';
import {
  DEFAULT_EVENT_FILTERS,
  eventDeviceOccurrences,
  eventRepeatOccurrences,
  filterEvents,
  type EventPriorityReason,
  type EventFilters,
} from './event-model';
import { eventDeviceCode } from '@shared/monthly-operations-event-identity';
function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value || '__all'}
      onValueChange={(v) => onChange(v === '__all' ? '' : v)}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value || '__all'}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export const eventTime = (value: string | null) =>
  value
    ? new Date(value)
        .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        .replace(/\//g, '-')
    : '—';

type ActiveReport = {
  eventId: string;
  reportIndex: number;
  report: MonthlyEventReviewReport;
};

type ReportPreviewState =
  | { status: 'idle' | 'loading'; data: null; error: '' }
  | { status: 'ready'; data: MonthlyEventReviewReportContent; error: '' }
  | { status: 'error'; data: null; error: string };

function RepeatOccurrenceCurve({
  occurrences,
  selectedId,
}: {
  occurrences: MonthlyEvent[];
  selectedId: string;
}) {
  const gradientId = useId().replace(/:/g, '');
  const points = occurrences.reduce<
    { record: MonthlyEvent; x: number; y: number }[]
  >((result, record, index) => {
    const previous = result[index - 1];
    const elapsed = previous
      ? Date.parse(record.occurredAt ?? '') -
        Date.parse(previous.record.occurredAt ?? '')
      : 0;
    const elapsedDays = Number.isFinite(elapsed)
      ? Math.max(0, elapsed / 86_400_000)
      : 0;
    const gap = previous
      ? 96 + Math.min(80, Math.log2(1 + elapsedDays) * 12)
      : 0;
    result.push({
      record,
      x: previous ? previous.x + gap : 60,
      y: 92 - (index * 58) / (occurrences.length - 1),
    });
    return result;
  }, []);
  const width = Math.max(520, points[points.length - 1].x + 60);
  const line = points.reduce((path, { x, y }, index) => {
    if (index === 0) return `M ${x} ${y}`;
    const previous = points[index - 1];
    const control = (x - previous.x) / 3;
    return `${path} C ${previous.x + control} ${previous.y} ${x - control} ${y} ${x} ${y}`;
  }, '');
  return (
    <div className="mo-event-repeat-chart">
      <div className="mo-event-repeat-chart-heading">
        <h4>重复发生曲线</h4>
        <span>按发生顺序 · 累计次数</span>
      </div>
      <div
        className="mo-event-repeat-chart-scroll"
        tabIndex={0}
        role="img"
        aria-label={`${occurrences.length} 次重复事件的发生时间和累计次数：${occurrences
          .map(
            (record, index) =>
              `第 ${index + 1} 次 ${eventTime(record.occurredAt)}`,
          )
          .join('；')}`}
      >
        <svg
          width={width}
          height="156"
          viewBox={`0 0 ${width} 156`}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--mo-blue)" stopOpacity="0.17" />
              <stop offset="100%" stopColor="var(--mo-blue)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`M 60 104 H ${width - 60}`}
            className="mo-event-repeat-baseline"
          />
          <path
            d={`${line} L ${points[points.length - 1].x} 104 L 60 104 Z`}
            fill={`url(#${gradientId})`}
          />
          <path d={line} className="mo-event-repeat-line" />
          {points.map(({ record, x, y }, index) => {
            const [date, time] = eventTime(record.occurredAt).split(' ');
            return (
              <g key={record.id}>
                <circle
                  cx={x}
                  cy={y}
                  r="5"
                  className={
                    record.id === selectedId
                      ? 'mo-event-repeat-point is-current'
                      : 'mo-event-repeat-point'
                  }
                />
                <text
                  x={x}
                  y={y - 13}
                  className="mo-event-repeat-point-count"
                  textAnchor="middle"
                >
                  {index + 1}
                </text>
                <text
                  x={x}
                  y="125"
                  className="mo-event-repeat-point-time"
                  textAnchor="middle"
                >
                  {date}
                </text>
                <text
                  x={x}
                  y="142"
                  className="mo-event-repeat-point-time"
                  textAnchor="middle"
                >
                  {time}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export function EventList({
  records,
  period,
  filters,
  onChange,
  loading,
  ready,
  error = '',
  fixedScope = false,
  priorityReasons,
  timelineRecords,
}: {
  records: MonthlyEvent[];
  period: ReportPeriod;
  filters: EventFilters;
  onChange: (filters: EventFilters) => void;
  loading: boolean;
  ready: boolean;
  error?: string;
  fixedScope?: boolean;
  priorityReasons?: Record<string, EventPriorityReason[]>;
  timelineRecords?: MonthlyEvent[];
}) {
  const { canExport, authorizeExport } = useMonthlyOperationsExport();
  const [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [notice, setNotice] = useState(''),
    [selected, setSelected] = useState<MonthlyEvent | null>(null),
    [activeReport, setActiveReport] = useState<ActiveReport | null>(null),
    [reportRetry, setReportRetry] = useState(0),
    [reportPreview, setReportPreview] = useState<ReportPreviewState>({
      status: 'idle',
      data: null,
      error: '',
    });
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    setPage(1);
    setNotice('');
  }, [filters]);
  useEffect(() => setActiveReport(null), [selected?.id]);
  useEffect(() => {
    if (!activeReport) {
      setReportPreview({ status: 'idle', data: null, error: '' });
      return;
    }
    const controller = new AbortController();
    setReportPreview({ status: 'loading', data: null, error: '' });
    void fetchEventReviewReport(
      activeReport.eventId,
      activeReport.reportIndex,
      controller.signal,
    )
      .then((data) => setReportPreview({ status: 'ready', data, error: '' }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setReportPreview({
          status: 'error',
          data: null,
          error:
            cause instanceof Error ? cause.message : '复盘报告读取失败，请重试',
        });
      });
    return () => controller.abort();
  }, [activeReport, reportRetry]);
  const setFilters = onChange;
  const apply = (patch: Partial<EventFilters>) => {
    onChange({ ...filters, ...patch });
    setPage(1);
    setNotice('');
  };
  const filtered = useMemo(
    () =>
      ready ? filterEvents(records, filters, period.start, period.asOf) : [],
    [records, filters, period.start, period.asOf, ready],
  );
  const occurrences = useMemo(
    () =>
      selected
        ? eventRepeatOccurrences(
            timelineRecords ?? records,
            selected,
            period.asOf,
          )
        : [],
    [timelineRecords, records, selected, period.asOf],
  );
  const deviceOccurrences = useMemo(
    () =>
      selected
        ? eventDeviceOccurrences(
            timelineRecords ?? records,
            selected,
            period.asOf,
          )
        : [],
    [timelineRecords, records, selected, period.asOf],
  );
  const showDeviceOccurrences =
    deviceOccurrences.length > 0 &&
    (occurrences.length === 0 ||
      deviceOccurrences.some(
        (record) => !occurrences.some((item) => item.id === record.id),
      ));
  const pages = Math.max(1, Math.ceil(filtered.length / size)),
    safePage = Math.min(page, pages);
  const exportCsv = () => void authorizeExport(() => {
    const rows = [
      [
        '机楼',
        '告警描述',
        '持续时间（天）',
        '事件发生时间',
        '专业',
        '等级',
        '发现来源',
        '当前状态',
      ],
      ...filtered.map((r) => [
        r.building,
        r.title,
        r.durationDays ?? '',
        eventTime(r.occurredAt),
        r.specialty,
        r.level,
        r.source,
        r.status,
      ]),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map((row) =>
          row
            .map(
              (v) =>
                '"' +
                String(v)
                  .replace(/^[=+@-]/, "'$&")
                  .replace(/"/g, '""') +
                '"',
            )
            .join(','),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `事件清单-${period.asOf}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`已导出 ${filtered.length} 条事件`);
  }, setNotice);

  if (!ready)
    return (
      <EmptyState
        title={loading ? '正在读取事件' : error || '事件数据暂不可用'}
        description=""
      />
    );
  return (
    <>
      <div className="mo-event-filters">
        {!fixedScope && (
          <>
            <Picker
              label="事件统计范围"
              value={filters.scope}
              options={[
                { value: 'history', label: '历史累计' },
                { value: 'period', label: '所选周期' },
                { value: 'year', label: '年度' },
              ]}
              onChange={(scope) =>
                apply({ scope: scope as EventFilters['scope'] })
              }
            />
            <Picker
              label="事件状态"
              value={filters.state}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'active', label: '检修中' },
                { value: 'open', label: '未闭环' },
                { value: 'key', label: 'I2及以上' },
                { value: 'done', label: '检修完成' },
                { value: 'none', label: '未转检修' },
                { value: 'unknown', label: '待确认' },
                { value: 'unresolved', label: '未解决' },
              ]}
              onChange={(state) =>
                apply({ state: state as EventFilters['state'] })
              }
            />
          </>
        )}
        {(['source', 'specialty', 'level'] as const).map((key, i) => (
          <Picker
            key={key}
            label={['事件来源', '事件专业', '事件等级'][i]}
            value={filters[key]}
            options={[
              { value: '', label: ['全部来源', '全部专业', '全部等级'][i] },
              ...[
                ...new Set(
                  records.map((r) => (key === 'level' ? r.finalLevel : r[key])),
                ),
              ]
                .filter(Boolean)
                .sort()
                .map((value) => ({ value, label: value })),
            ]}
            onChange={(v) => apply({ [key]: v })}
          />
        ))}
        <div className="mo-event-search">
          <Search />
          <Input
            aria-label="搜索事件"
            placeholder="搜索告警、编号…"
            value={filters.query}
            onChange={(e) => apply({ query: e.target.value })}
          />
        </div>
        <Button
          variant="outline"
          onClick={exportCsv}
          disabled={!canExport || !filtered.length}
        >
          <Download />
          导出
        </Button>
      </div>
      <div className="mo-event-scope">
        <span>
          {!fixedScope &&
            (filters.scope === 'history'
              ? '截至 ' + period.asOf
              : filters.scope === 'year'
                ? period.asOf.slice(0, 4) + ' 年'
                : period.rangeLabel) + ' · '}
          {filtered.length} 条{filters.date ? ' · ' + filters.date : ''}
          {filters.building ? ' · ' + filters.building : ''}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setFilters({ ...DEFAULT_EVENT_FILTERS, state: 'all' });
            setPage(1);
          }}
        >
          重置筛选
        </Button>
      </div>
      <div className="mo-table-scroll">
        <Table>
          <TableHeader>
            <TableRow>
              {[
                '机楼',
                '告警描述',
                '持续（天）',
                '发生时间',
                '专业',
                '等级',
                '发现来源',
                '当前状态',
              ].map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.slice((safePage - 1) * size, safePage * size).map((r) => (
              <TableRow
                key={r.id}
                className={
                  priorityReasons?.[r.id]?.includes('3个月内重复')
                    ? 'mo-event-rapid-row'
                    : undefined
                }
              >
                <TableCell>
                  <Badge variant="outline">{r.building}</Badge>
                </TableCell>
                <TableCell>
                  <button
                    className="mo-event-title"
                    onClick={(e) => {
                      trigger.current = e.currentTarget;
                      setSelected(r);
                    }}
                    title={r.title}
                  >
                    {r.title}
                  </button>
                  <small className="mo-event-code">{r.code}</small>
                  {!!priorityReasons?.[r.id]?.length && (
                    <div className="mo-event-priority-reasons">
                      {priorityReasons[r.id].map((reason) => (
                        <Badge
                          key={reason}
                          variant="outline"
                          className={
                            reason === '3个月内重复'
                              ? 'mo-event-rapid-badge'
                              : reason === '同设备多发'
                                ? 'mo-event-device-badge'
                                : undefined
                          }
                        >
                          {reason}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="mo-number">
                  {r.durationDays ?? '—'}
                </TableCell>
                <TableCell className="mo-nowrap">
                  {eventTime(r.occurredAt)}
                </TableCell>
                <TableCell>{r.specialty}</TableCell>
                <TableCell>{r.level}</TableCell>
                <TableCell>{r.source}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={r.repair === 'active' ? 'mo-demo-badge' : ''}
                  >
                    {r.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!filtered.length && (
          <EmptyState
            title={loading ? '正在读取事件' : '暂无匹配事件'}
            onReset={() => {
              setFilters({ ...DEFAULT_EVENT_FILTERS, state: 'all' });
              setPage(1);
            }}
          />
        )}
      </div>
      <div className="mo-resource-pagination">
        <span role="status">{notice || `${filtered.length} 条记录`}</span>
        <div>
          <Picker
            label="事件每页条数"
            value={String(size)}
            options={[10, 20, 50].map((n) => ({
              value: String(n),
              label: n + ' 条/页',
            }))}
            onChange={(v) => {
              setSize(Number(v));
              setPage(1);
            }}
          />
          <Button
            variant="outline"
            aria-label="事件上一页"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft />
          </Button>
          <span>
            {safePage} / {pages}
          </span>
          <Button
            variant="outline"
            aria-label="事件下一页"
            disabled={safePage >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>{' '}
      {selected && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <SheetContent
            className="monthly-operations mo-detail-sheet"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <SheetHeader>
              <SheetTitle>事件详情</SheetTitle>
              <SheetDescription className="sr-only">
                事件状态、时间与处理进展
              </SheetDescription>
            </SheetHeader>
            <div className="mo-event-detail">
              <div className="mo-event-detail-badges">
                <Badge variant="outline">{selected.status}</Badge>
                {priorityReasons?.[selected.id]?.map((reason) => (
                  <Badge
                    key={reason}
                    variant="outline"
                    className={
                      reason === '3个月内重复'
                        ? 'mo-event-rapid-badge'
                        : reason === '同设备多发'
                          ? 'mo-event-device-badge'
                          : undefined
                    }
                  >
                    {reason}
                  </Badge>
                ))}
              </div>
              <h2>{selected.title}</h2>
              <dl>
                {[
                  ['事件编号', selected.code],
                  ['机楼', selected.building],
                  ['专业', selected.specialty],
                  ['等级', selected.level],
                  ['发现来源', selected.source],
                  ['发生时间', eventTime(selected.occurredAt)],
                  ['恢复时间', eventTime(selected.recoveredAt)],
                  ['结束时间', eventTime(selected.endedAt)],
                  ['检修完成', eventTime(selected.repairedAt)],
                  [
                    '持续时间',
                    selected.durationDays === null
                      ? '—'
                      : selected.durationDays + ' 天',
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <Panel title="目前进展">
                <p>{selected.progress || '暂无进展记录'}</p>
              </Panel>
              {(selected.needsReview ||
                selected.reviewReports.length > 0 ||
                selected.cause ||
                selected.resolution) && (
                <section className="mo-event-review" aria-label="事件复盘">
                  <div className="mo-event-review-heading">
                    <div>
                      <h3>事件复盘</h3>
                      <span>
                        {selected.reviewReports.length
                          ? `${selected.reviewReports.length} 份报告`
                          : '已标记需复盘'}
                      </span>
                    </div>
                    <Badge variant="outline">重点关注</Badge>
                  </div>
                  {!!selected.reviewReports.length && (
                    <div className="mo-event-review-reports">
                      {selected.reviewReports.map((report, reportIndex) => (
                        <button
                          key={report.url}
                          type="button"
                          onClick={() =>
                            setActiveReport({
                              eventId: selected.id,
                              reportIndex,
                              report,
                            })
                          }
                        >
                          <FileText aria-hidden="true" />
                          <span>
                            <small>{report.label}</small>
                            <strong>{report.title}</strong>
                          </span>
                          <ExternalLink aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                  {(selected.cause || selected.resolution) && (
                    <dl className="mo-event-review-summary">
                      {selected.cause && (
                        <div>
                          <dt>事件原因</dt>
                          <dd>{selected.cause}</dd>
                        </div>
                      )}
                      {selected.resolution && (
                        <div>
                          <dt>解决措施</dt>
                          <dd>{selected.resolution}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                  {!selected.reviewReports.length && (
                    <p className="mo-event-review-empty">复盘报告待补充</p>
                  )}
                </section>
              )}
              {occurrences.length > 0 && (
                <section
                  className="mo-event-repeat-timeline"
                  aria-label="重复事件时间线"
                >
                  <div className="mo-event-repeat-heading">
                    <h3>
                      重复发生 <strong>{occurrences.length}</strong> 次
                    </h3>
                    <span>
                      {eventTime(occurrences[0].occurredAt)} —{' '}
                      {eventTime(
                        occurrences[occurrences.length - 1].occurredAt,
                      )}
                    </span>
                  </div>
                  <RepeatOccurrenceCurve
                    occurrences={occurrences}
                    selectedId={selected.id}
                  />
                  <ol>
                    {occurrences.map((occurrence, index) => (
                      <li
                        key={occurrence.id}
                        aria-current={
                          occurrence.id === selected.id ? 'true' : undefined
                        }
                      >
                        <div className="mo-event-repeat-item-heading">
                          <span>第 {index + 1} 次</span>
                          <time dateTime={occurrence.occurredAt}>
                            {eventTime(occurrence.occurredAt)}
                          </time>
                        </div>
                        <p>{occurrence.title}</p>
                        <div className="mo-event-repeat-meta">
                          {occurrence.code && <small>{occurrence.code}</small>}
                          <Badge variant="outline">{occurrence.status}</Badge>
                        </div>
                        {occurrence.progress && (
                          <p className="mo-event-repeat-progress">
                            {occurrence.progress}
                          </p>
                        )}
                        {(occurrence.recoveredAt ||
                          occurrence.endedAt ||
                          occurrence.repairedAt) && (
                          <div className="mo-event-repeat-milestones">
                            {occurrence.recoveredAt && (
                              <span>
                                恢复 {eventTime(occurrence.recoveredAt)}
                              </span>
                            )}
                            {occurrence.endedAt && (
                              <span>结束 {eventTime(occurrence.endedAt)}</span>
                            )}
                            {occurrence.repairedAt && (
                              <span>
                                检修完成 {eventTime(occurrence.repairedAt)}
                              </span>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {showDeviceOccurrences && (
                <section
                  className="mo-event-repeat-timeline mo-event-device-timeline"
                  aria-label="同设备事件历史"
                >
                  <div className="mo-event-repeat-heading">
                    <h3>
                      同设备多发 <strong>{deviceOccurrences.length}</strong> 次
                    </h3>
                    <span>{eventDeviceCode(selected.title)}</span>
                  </div>
                  <ol>
                    {deviceOccurrences.map((record) => (
                      <li
                        key={record.id}
                        aria-current={
                          record.id === selected.id ? 'true' : undefined
                        }
                      >
                        <div className="mo-event-repeat-item-heading">
                          <time dateTime={record.occurredAt}>
                            {eventTime(record.occurredAt)}
                          </time>
                          <Badge variant="outline">{record.status}</Badge>
                        </div>
                        <p>{record.title}</p>
                        {record.progress && (
                          <p className="mo-event-repeat-progress">
                            {record.progress}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
      <Dialog
        open={activeReport !== null}
        onOpenChange={(open) => {
          if (!open) setActiveReport(null);
        }}
      >
        {activeReport && (
          <DialogContent className="monthly-operations mo-event-report-dialog">
            <DialogHeader className="mo-event-report-header">
              <div>
                <span>{activeReport.report.label}</span>
                <DialogTitle>{activeReport.report.title}</DialogTitle>
              </div>
              <a
                href={activeReport.report.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                飞书中打开
                <ExternalLink aria-hidden="true" />
              </a>
              <DialogDescription className="sr-only">
                当前事件的飞书复盘报告内容
              </DialogDescription>
            </DialogHeader>
            <div className="mo-event-report-content" aria-live="polite">
              {reportPreview.status === 'loading' && (
                <div className="mo-event-report-state">
                  <span
                    className="mo-event-report-spinner"
                    aria-hidden="true"
                  />
                  <strong>正在读取复盘报告</strong>
                </div>
              )}
              {reportPreview.status === 'error' && (
                <div className="mo-event-report-state mo-event-report-error">
                  <strong>{reportPreview.error}</strong>
                  <Button
                    variant="outline"
                    onClick={() => setReportRetry((value) => value + 1)}
                  >
                    重新读取
                  </Button>
                </div>
              )}
              {reportPreview.status === 'ready' &&
                (reportPreview.data.kind === 'document' ? (
                  <article className="mo-event-report-body">
                    {reportPreview.data.content}
                  </article>
                ) : (
                  <div className="mo-event-report-state">
                    <FileText aria-hidden="true" />
                    <strong>{reportPreview.data.message}</strong>
                    <a
                      href={activeReport.report.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      飞书中打开
                      <ExternalLink aria-hidden="true" />
                    </a>
                  </div>
                ))}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
