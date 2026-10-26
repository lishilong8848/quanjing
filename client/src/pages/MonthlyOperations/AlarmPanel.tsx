import { useMemo, useState, useRef, useEffect } from 'react';
import {
  BellRing,
  ShieldAlert,
  Clock,
  Repeat2,
  RefreshCw,
  Tag,
  CheckCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { SourceModal } from './SourceModal';
import type { MonthlyAlarm } from '@shared/monthly-operations-alarms.interface';
import type { PanelProps } from './Overview';
import {
  Panel,
  ColumnChart,
  TrendChart,
  Distribution,
  EmptyState,
} from './charts';
import { MetricCard } from './components';
import { BUILDINGS } from './model';
import { refreshAlarmReview, useAlarms } from './alarm-data';
import { repeatAlarms, alarmGroups, alarmDate } from './alarm-model';
import { AlarmList } from './AlarmList';
import { useSourceStamp } from './SourceStamp';
import { FeishuSourceLinks } from './FeishuSourceLinks';
import { MonthlyAlarmTagDialog } from './MonthlyAlarmTagDialog';
import { AlarmAiConnectionBadge } from '@/components/AlarmAiConnectionBadge';
import { useNantongAssistantPageSummary } from '@/components/NantongAssistantHost';
import type { NantongAssistantContext } from '@shared/nantong-assistant.interface';
export function AlarmPanel({ view }: PanelProps) {
  const [windowMode, setWindowMode] = useState('period');
  const end = view.period.asOf;
  const start30 = new Date(Date.parse(end + 'T00:00:00Z') - 29 * 86400000)
    .toISOString()
    .slice(0, 10);
  const range =
    windowMode === 'recent'
      ? { start: start30, end }
      : { start: view.period.start, end: view.period.end };
  return (
    <div className="mo-topic-content mo-alarms">
      <div className="mo-section-heading">
        <h2>告警分析</h2>
        <div className="mo-heading-actions">
          <FeishuSourceLinks source="alarms" />
          <Tabs value={windowMode} onValueChange={setWindowMode}>
            <TabsList aria-label="告警统计范围">
              <TabsTrigger value="period">所选周期</TabsTrigger>
              <TabsTrigger value="recent">近30天</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>
      <AlarmSource
        key={`${range.start}-${range.end}-${view.building}`}
        range={range}
        building={view.building}
      />
    </div>
  );
}
function AlarmSource({
  range,
  building,
}: {
  range: { start: string; end: string };
  building: string;
}) {
  const { data, loading, error, retry } = useAlarms(range);
  useSourceStamp('alarms', data?.syncedAt);
  const records = useMemo(
    () =>
      (data?.records ?? []).filter(
        (r) => building === 'all' || r.building === building,
      ),
    [data, building],
  );
  const assistantContext = useMemo<NantongAssistantContext | undefined>(() => {
    if (!data) return undefined;
    const buildings = [...new Set(records.map((row) => row.building))]
      .filter((name) => /^[A-H]楼$/u.test(name))
      .sort();
    return {
      scope: 'monthly',
      start: data.range.start,
      end: data.range.asOf,
      total: records.length,
      pending: records.filter((row) => row.process !== '已处理').length,
      tagAnomalies: records.filter((row) => row.tagIssues.length > 0).length,
      buildings: buildings.map((name) => ({
        name,
        total: records.filter((row) => row.building === name).length,
        anomalies: records.filter((row) => row.building === name && row.tagIssues.length > 0).length,
      })),
      review: {
        state: data.tagReview.state,
        reviewed: data.tagReview.reviewed,
        total: data.tagReview.total,
      },
    };
  }, [data, records]);
  useNantongAssistantPageSummary(assistantContext, `${range.start} 至 ${assistantContext?.end || range.end}`);
  const repeat = useMemo(() => repeatAlarms(records), [records]);
  const [chartTab, setChartTab] = useState('status'),
    [repeatPage, setRepeatPage] = useState(1),
    [tagDialogBuilding, setTagDialogBuilding] = useState<string | null>(null),
    [selection, setSelection] = useState<{
      title: string;
      rows: MonthlyAlarm[];
    } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const review = data?.tagReview;
    if (!review || (review.state !== 'processing' && !['connecting', 'error', 'unverified'].includes(review.connection ?? 'unverified'))) return;
    const timer = window.setInterval(
      () => { void refreshAlarmReview(range); },
      review.connection === 'error' ? 60_000 : 15_000,
    );
    return () => window.clearInterval(timer);
  }, [data?.tagReview?.state, data?.tagReview?.connection, range.start, range.end]);
  const open = (title: string, rows = records) => {
    trigger.current = document.activeElement as HTMLElement;
    setSelection({ title, rows });
  };
  const openTags = (selectedBuilding = 'all') => {
    trigger.current = document.activeElement as HTMLElement;
    setTagDialogBuilding(selectedBuilding);
  };
  const subset = (tag: string) => records.filter((r) => r.tags.includes(tag));
  const buildings = [
    ...new Set([...BUILDINGS, ...records.map((r) => r.building)]),
  ].filter((b) => building === 'all' || building === b);
  const byBuilding = (
    field: 'recovery' | 'process' | 'expected',
    names: string[],
  ) =>
    buildings.map((name) => {
      const items = records.filter((r) => r.building === name);
      return Object.fromEntries([
        ['name', name],
        ...names.map((label, i) => [
          'v' + i,
          items.filter((r) => (r[field] || '未打标') === label).length,
        ]),
      ]);
    });
  const buildingChart = (
    title: string,
    field: 'recovery' | 'process' | 'expected',
    names: string[],
  ) => (
    <Panel title={title}>
      <ColumnChart
        rows={byBuilding(field, names)}
        series={names.map((name, i) => ({
          key: 'v' + i,
          name,
          color: ['未处理', '未恢复', '预期外'].includes(name)
            ? 'var(--mo-amber)'
            : name === '已恢复'
              ? 'var(--mo-teal)'
              : name === '未打标'
                ? 'var(--mo-violet)'
                : 'var(--mo-blue)',
        }))}
        unit="条"
        onSelect={(name, key) =>
          open(
            `${name} · ${names[Number(key?.slice(1))]}`,
            records.filter(
              (r) =>
                r.building === name &&
                (r[field] || '未打标') === names[Number(key?.slice(1))],
            ),
          )
        }
      />
    </Panel>
  );
  const quick = subset('预期外5分钟内恢复'),
    quickNames = [...new Set(quick.map((r) => r.category))];
  const long = subset('未恢复超过48小时');
  const monthly =
    range.end.slice(0, 4) !== range.start.slice(0, 4) ||
    Date.parse(range.end) - Date.parse(range.start) > 100 * 86400000;
  const trends = useMemo(() => {
    const map = new Map<
      string,
      { name: string; total: number; unexpected: number }
    >();
    for (
      let day = Date.parse(range.start);
      day <= Date.parse(data?.range.asOf ?? range.end);
      day += 86400000
    ) {
      const name = new Date(day).toISOString().slice(0, monthly ? 7 : 10);
      map.set(name, { name, total: 0, unexpected: 0 });
    }
    for (const r of records) {
      const name = r.date!.slice(0, monthly ? 7 : 10),
        row = map.get(name) ?? { name, total: 0, unexpected: 0 };
      row.total++;
      if (r.expected === '预期外') row.unexpected++;
      map.set(name, row);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [records, monthly, range.start, range.end, data?.range.asOf]);
  const repeatPages = Math.max(1, Math.ceil(repeat.length / 5));
  const warning =
    error ||
    (data?.status === 'stale' && data.message !== '后台更新中'
      ? data.message
      : '');
  const content = useMemo(
    () => (
      <>
        <div className="mo-assessment-tools">
          {data?.tagReview && <AlarmAiConnectionBadge review={data.tagReview} />}
          {warning && <span role="alert">{warning}</span>}
          {!!data?.invalid && (
            <span role="alert">{data.invalid} 条告警日期缺失，未计入统计</span>
          )}
          <Button variant="ghost" size="sm" disabled={loading} onClick={retry}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            {loading ? '更新中' : '刷新告警'}
          </Button>
        </div>
        <div className="mo-alarm-metrics">
          {[
            { title: '有效告警', rows: records, icon: BellRing },
            { title: '未处理', rows: subset('未处理'), icon: Clock },
            { title: '未确认', rows: subset('未确认'), icon: CheckCheck },
            {
              title: '重复告警',
              rows: repeat.flatMap((g) => g.rows),
              icon: Repeat2,
              value: repeat.length,
              unit: '组',
            },
            { title: '严重告警', rows: subset('严重告警'), icon: ShieldAlert },
            { title: '打标异常', rows: subset('打标异常'), icon: Tag },
          ].map((m, i) => (
            <MetricCard
              key={m.title}
              title={m.title}
              value={data ? (m.value ?? m.rows.length).toLocaleString() : '—'}
              unit={m.unit ?? '条'}
              icon={m.icon}
              tone={i ? 'amber' : 'blue'}
              onClick={() => m.title === '打标异常' ? openTags() : open(m.title, m.rows)}
            />
          ))}
        </div>
        {!data ? (
          <EmptyState
            title={loading ? '告警数据加载中' : '告警数据暂不可用'}
            description={error || ''}
          />
        ) : (
          <>
            <div className="mo-alarm-urgent">
              {['未处理且未恢复', '未恢复超过48小时'].map((tag) => (
                <Button
                  variant="outline"
                  key={tag}
                  onClick={() => open(tag, subset(tag))}
                >
                  <ShieldAlert />
                  {tag}
                  <strong>{subset(tag).length}</strong>
                </Button>
              ))}
            </div>
            <Tabs value={chartTab} onValueChange={setChartTab}>
              <TabsList aria-label="告警分析维度">
                <TabsTrigger value="status">处理与恢复</TabsTrigger>
                <TabsTrigger value="cause">预期与原因</TabsTrigger>
                <TabsTrigger value="trend">等级与趋势</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="mo-assessment-chart-grid">
              {chartTab === 'status' && (
                <>
                  {buildingChart('各楼告警处理状态', 'process', [
                    '未处理',
                    '处理中',
                    '已处理',
                  ])}
                  {buildingChart('各楼告警恢复状态', 'recovery', [
                    '未恢复',
                    '已恢复',
                  ])}
                </>
              )}
              {chartTab === 'cause' && (
                <>
                  {buildingChart('预期内 / 外告警', 'expected', [
                    '预期内',
                    '预期外',
                    '未打标',
                  ])}
                  <Panel title="预期外 · 5分钟内恢复">
                    <ColumnChart
                      rows={buildings.map((name) =>
                        Object.fromEntries([
                          ['name', name],
                          ...quickNames.map((c, i) => [
                            'v' + i,
                            quick.filter(
                              (r) => r.building === name && r.category === c,
                            ).length,
                          ]),
                        ]),
                      )}
                      series={quickNames.map((name, i) => ({
                        name,
                        key: 'v' + i,
                      }))}
                      unit="条"
                      onSelect={(name, key) =>
                        open(
                          name + ' · ' + quickNames[Number(key?.slice(1))],
                          quick.filter(
                            (r) =>
                              r.building === name &&
                              r.category === quickNames[Number(key?.slice(1))],
                          ),
                        )
                      }
                    />
                  </Panel>
                </>
              )}
              {chartTab === 'trend' && (
                <>
                  <Panel title="告警等级分布">
                    <Distribution
                      rows={alarmGroups(records, 'level')}
                      label="有效告警"
                      onSelect={(name) =>
                        open(
                          name + '告警',
                          records.filter((r) => r.level === name),
                        )
                      }
                    />
                  </Panel>
                  <Panel title={monthly ? '告警月趋势' : '告警日趋势'}>
                    <TrendChart
                      rows={trends}
                      series={[
                        { key: 'total', name: '有效告警' },
                        {
                          key: 'unexpected',
                          name: '预期外',
                          color: 'var(--mo-amber)',
                        },
                      ]}
                      unit="条"
                      onSelect={(name) =>
                        open(
                          name + '告警',
                          records.filter((r) => r.date?.startsWith(name)),
                        )
                      }
                    />
                  </Panel>
                </>
              )}
              <Panel title="未恢复超过48小时">
                <ColumnChart
                  rows={buildings.map((name) => ({
                    name,
                    value: long.filter((r) => r.building === name).length,
                  }))}
                  series={[
                    { key: 'value', name: '未恢复', color: 'var(--mo-amber)' },
                  ]}
                  unit="条"
                  onSelect={(name) =>
                    open(
                      name + ' · 未恢复超过48小时',
                      long.filter((r) => r.building === name),
                    )
                  }
                />
              </Panel>
              <Panel title="各楼打标异常">
                <ColumnChart
                  rows={buildings.map((name) => ({
                    name,
                    value: subset('打标异常').filter((r) => r.building === name)
                      .length,
                  }))}
                  series={[
                    {
                      key: 'value',
                      name: '打标异常',
                      color: 'var(--mo-violet)',
                    },
                  ]}
                  unit="条"
                  onSelect={(name) => openTags(name)}
                />
              </Panel>
            </div>
            <Panel
              title="重复发生告警"
              action={`${repeat.length} 组 · ${repeat.reduce((s, g) => s + g.count, 0)} 次`}
              onAction={() =>
                open(
                  '重复发生告警',
                  repeat.flatMap((g) => g.rows),
                )
              }
            >
              {!repeat.length ? (
                <EmptyState title="当前范围暂无重复告警" description="" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>次数</TableHead>
                      <TableHead>告警 / 监控对象</TableHead>
                      <TableHead>楼栋</TableHead>
                      <TableHead>最近发生</TableHead>
                      <TableHead>待关注</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {repeat
                      .slice((repeatPage - 1) * 5, repeatPage * 5)
                      .map((g) => (
                        <TableRow key={g.key}>
                          <TableCell>
                            <button
                              className="mo-alarm-repeat-count"
                              onClick={() =>
                                open('重复告警 · ' + g.latest.title, g.rows)
                              }
                            >
                              {g.count}
                              <small>次</small>
                            </button>
                          </TableCell>
                          <TableCell>
                            <button
                              className="mo-event-title"
                              onClick={() =>
                                open('重复告警 · ' + g.latest.title, g.rows)
                              }
                            >
                              {g.latest.title}
                              <small>
                                {g.latest.object} · {g.latest.location}
                              </small>
                            </button>
                          </TableCell>
                          <TableCell>{g.latest.building}</TableCell>
                          <TableCell className="mo-nowrap">
                            {alarmDate(g.latest.occurredAt)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                g.pending ? 'mo-assessment-attention' : ''
                              }
                            >
                              {g.pending} 条
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
              {repeatPages > 1 && (
                <div className="mo-pagination">
                  <span>
                    {repeatPage} / {repeatPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={repeatPage === 1}
                    onClick={() => setRepeatPage(repeatPage - 1)}
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={repeatPage === repeatPages}
                    onClick={() => setRepeatPage(repeatPage + 1)}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </Panel>
            <Panel title="各楼预期外原因 TOP5">
              <div className="mo-alarm-rankings">
                {buildings
                  .filter((b) =>
                    records.some(
                      (r) => r.building === b && r.expected === '预期外',
                    ),
                  )
                  .map((b) => (
                    <div key={b}>
                      <h3>{b}</h3>
                      {alarmGroups(
                        records.filter(
                          (r) => r.building === b && r.expected === '预期外',
                        ),
                        'category',
                      )
                        .slice(0, 5)
                        .map((r, i) => (
                          <button
                            key={r.name}
                            onClick={() =>
                              open(
                                b + ' · ' + r.name,
                                records.filter(
                                  (item) =>
                                    item.building === b &&
                                    item.expected === '预期外' &&
                                    item.category === r.name,
                                ),
                              )
                            }
                          >
                            <small>{i + 1}</small>
                            <span>{r.name}</span>
                            <strong>{r.value}</strong>
                          </button>
                        ))}
                    </div>
                  ))}
              </div>
            </Panel>
            <Panel title="告警明细">
              <AlarmList records={records} compact onOpenTag={() => openTags()} />
            </Panel>
          </>
        )}
      </>
    ),
    [data, records, repeat, loading, error, chartTab, repeatPage],
  );
  return (
    <>
      {content}
      {selection && (
        <SourceModal
          title={selection.title}
          trigger={trigger.current}
          onClose={() => setSelection(null)}
        >
          <div className="mo-assessment-sheet-body">
            <AlarmList records={selection.rows} />
          </div>
        </SourceModal>
      )}
      {tagDialogBuilding !== null && data?.tagReview && (
        <MonthlyAlarmTagDialog
          records={records}
          range={{ start: data.range.start, end: data.range.asOf }}
          review={data.tagReview}
          trigger={trigger.current}
          initialBuilding={tagDialogBuilding}
          onClose={() => setTagDialogBuilding(null)}
        />
      )}
    </>
  );
}
