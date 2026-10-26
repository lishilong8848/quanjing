import { useMemo, useState } from 'react';
import {
  Activity,
  BellRing,
  CheckCircle2,
  ClipboardCheck,
  GitCompareArrows,
  ShieldCheck,
  Target,
  Wrench,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ColumnChart,
  Distribution,
  EmptyState,
  Panel,
  TrendChart,
} from './charts';
import { MetricCard, WorkTable } from './components';
import {
  BUILDINGS,
  filterRecords,
  groupRecords,
  KIND_LABELS,
  percentage,
  type Building,
  type WorkKind,
  type WorkRecord,
} from './model';
import { monthsInRange, type ReportPeriod } from './period';
import type { PanelProps } from './Overview';

function workTrend(records: WorkRecord[], period: ReportPeriod) {
  const keys =
    period.grain === 'month'
      ? monthsInRange(period.start, period.asOf)
      : Array.from({ length: period.days }, (_, index) =>
          new Date(Date.parse(`${period.start}T00:00:00Z`) + index * 86400000)
            .toISOString()
            .slice(0, 10),
        );
  return keys.map((key) => {
    const items = records.filter((item) => item.date.startsWith(key));
    return {
      name:
        key.length === 7
          ? key.replace('-', '/')
          : key.slice(5).replace('-', '/'),
      total: items.length,
      done: items.filter((item) => item.status === 'done').length,
    };
  });
}

function WorkList({
  view,
  openDetail,
  kind,
  title,
  pending = false,
}: PanelProps & { kind: WorkKind; title: string; pending?: boolean }) {
  const records = filterRecords(view.records, {
    kind,
    status: pending ? 'unfinished' : undefined,
  }).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Panel
      title={title}
      action={`全部 ${records.length} 项`}
      onAction={() =>
        openDetail({ title, kind, status: pending ? 'unfinished' : undefined })
      }
      className="mo-work-list-panel"
    >
      <WorkTable
        records={records.slice(0, 5)}
        onSelect={(record) =>
          openDetail({ title: record.title, kind, id: record.id })
        }
      />
    </Panel>
  );
}
export function WorkCalendar({
  records,
  period,
  onSelect,
}: {
  records: Pick<WorkRecord, 'date'>[];
  period: ReportPeriod;
  onSelect: (day: string) => void;
}) {
  const months = monthsInRange(period.start, period.asOf);
  const [selectedMonth, setSelectedMonth] = useState(period.asOf.slice(0, 7));
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const month = months.includes(selectedMonth)
    ? selectedMonth
    : months[months.length - 1];
  const [year, number] = month.split('-').map(Number);
  const count = new Date(year, number, 0).getDate();
  const start = (new Date(year, number - 1, 1).getDay() + 6) % 7;
  const totals = useMemo(() => {
    const result = new Map<string, number>();
    records.forEach(({ date }) => {
      if (date >= period.start && date <= period.asOf)
        result.set(date, (result.get(date) ?? 0) + 1);
    });
    return result;
  }, [records, period.start, period.asOf]);
  const monthDays = [...totals].filter(([date]) => date.startsWith(month));
  const monthTotal = monthDays.reduce((sum, [, value]) => sum + value, 0);
  const activeDate = [hoveredDate, focusedDate].find(
    (date) =>
      date?.startsWith(month) && date >= period.start && date <= period.asOf,
  );
  return (
    <div className="mo-calendar">
      <div className="mo-calendar-month">
        <Select value={month} onValueChange={setSelectedMonth}>
          <SelectTrigger aria-label="日历月份">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((value) => (
              <SelectItem key={value} value={value}>
                {value.slice(0, 4)} 年 {Number(value.slice(5))} 月
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>{monthTotal.toLocaleString('zh-CN')} 项</span>
      </div>
      <div className="mo-calendar-week">
        {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="mo-calendar-grid">
        {Array.from({ length: start }, (_, index) => (
          <span key={`space-${index}`} />
        ))}
        {Array.from({ length: count }, (_, index) => {
          const date = `${month}-${String(index + 1).padStart(2, '0')}`;
          const value = totals.get(date) ?? 0;
          return (
            <button
              type="button"
              key={date}
              disabled={date < period.start || date > period.asOf}
              onClick={() => onSelect(date)}
              onMouseEnter={() => setHoveredDate(date)}
              onMouseLeave={() => setHoveredDate(null)}
              onFocus={() => setFocusedDate(date)}
              onBlur={() => setFocusedDate(null)}
              className={
                value > 5
                  ? 'is-dense'
                  : value > 2
                    ? 'is-medium'
                    : value > 0
                      ? 'is-active'
                      : ''
              }
              aria-label={`${date}，${value} 项，查看明细`}
            >
              <span>{index + 1}</span>
            </button>
          );
        })}
        {Array.from({ length: 42 - start - count }, (_, index) => (
          <span key={`end-space-${index}`} aria-hidden="true" />
        ))}
      </div>
      <div className="mo-calendar-footer">
        <span className="mo-calendar-detail" aria-live="polite">
          {activeDate
            ? `${activeDate.slice(5).replace('-', '/')} · ${totals.get(activeDate) ?? 0} 项`
            : `${monthDays.length} 天有安排`}
        </span>
        <span
          className="mo-calendar-scale"
          aria-label="数量色阶：1至2项、3至5项、6项及以上"
        >
          少<i />
          <i />
          <i />多
        </span>
      </div>
    </div>
  );
}
export function WorkPanel({ view, openDetail }: PanelProps) {
  const [kind] = useState<'event' | 'change'>('change');
  const stat = view.kinds[kind];
  const records = view.records.filter((item) => item.kind === kind);
  const label = KIND_LABELS[kind];
  const sources = groupRecords(records, 'source');
  return (
    <div className="mo-topic-content">
      <div className="mo-section-heading">
        <div>
          <span className="mo-eyebrow">CHANGE OPERATIONS</span>
          <h2>变更管理</h2>
        </div>
        <span className="mo-demo-section-label">变更管理 · 演示数据</span>
      </div>
      <div className="mo-metrics">
        <MetricCard
          title={`${view.period.scope}${label}`}
          value={String(stat.total)}
          unit="项"
          note="当前周期与楼栋范围"
          icon={kind === 'event' ? Activity : GitCompareArrows}
          onClick={() =>
            openDetail({ title: `${view.period.noun}${label}`, kind })
          }
        />
        <MetricCard
          title={kind === 'event' ? '已闭环事件' : '已完成变更'}
          value={String(stat.done)}
          unit="项"
          note={`完成率 ${stat.rate.toFixed(1)}%`}
          icon={CheckCircle2}
          tone="teal"
          onClick={() =>
            openDetail({ title: `已完成${label}`, kind, status: 'done' })
          }
        />
        <MetricCard
          title={`待完成${label}`}
          value={String(stat.total - stat.done)}
          unit="项"
          note="含进行中及未开始"
          icon={Wrench}
          tone="amber"
          onClick={() =>
            openDetail({ title: `待完成${label}`, kind, status: 'unfinished' })
          }
        />
        <MetricCard
          title={kind === 'event' ? 'I2 级事件' : '客户变更'}
          value={String(
            kind === 'event'
              ? records.filter((item) => item.level === 'I2').length
              : records.filter((item) => item.source === '客户变更').length,
          )}
          unit="项"
          note={kind === 'event' ? '重点等级单独关注' : '与智航变更分别统计'}
          icon={ShieldCheck}
          onClick={() =>
            openDetail({
              title: kind === 'event' ? 'I2级事件' : '客户变更',
              kind,
              ...(kind === 'event' ? { level: 'I2' } : { source: '客户变更' }),
            })
          }
        />
      </div>
      <div className="mo-three-columns">
        <Panel title={`${label}来源`}>
          <Distribution
            rows={sources}
            label={`${label}总数`}
            onSelect={(source) =>
              openDetail({ title: `${source}${label}`, kind, source })
            }
          />
        </Panel>
        <Panel title={`${label}分布日历`}>
          <WorkCalendar
            records={records}
            period={view.period}
            onSelect={(date) =>
              openDetail({ title: `${date}${label}`, kind, date })
            }
          />
        </Panel>
        <Panel
          title={`${label}${view.period.grain === 'month' ? '月' : '日'}趋势`}
          eyebrow="PERIOD TREND"
        >
          <TrendChart
            rows={workTrend(records, view.period)}
            series={[
              {
                key: 'total',
                name: `${label}总量`,
                color: 'var(--mo-blue)',
              },
              { key: 'done', name: '已完成' },
            ]}
            unit="项"
            dateAxis={false}
          />
        </Panel>
      </div>
      <WorkList
        view={view}
        openDetail={openDetail}
        kind={kind}
        title={kind === 'event' ? '待闭环事件' : `${view.period.scope}变更清单`}
        pending={kind === 'event'}
      />
    </div>
  );
}

export function AssurancePanel({ view, openDetail }: PanelProps) {
  const [kind, setKind] = useState<'drill' | 'maintenance'>('maintenance');
  const records = view.records.filter((item) => item.kind === kind);
  const stat = view.kinds[kind];
  const label = KIND_LABELS[kind];
  const scores = records.filter((item) => item.score !== null);
  const averageScore = scores.length
    ? scores.reduce((sum, item) => sum + (item.score ?? 0), 0) / scores.length
    : null;
  const completion = BUILDINGS.map((building) => {
    const items = records.filter((item) => item.building === building);
    return {
      name: building,
      total: items.length,
      done: items.filter((item) => item.status === 'done').length,
    };
  }).filter((row) => row.total > 0);
  return (
    <div className="mo-topic-content">
      <div className="mo-section-heading">
        <div>
          <span className="mo-eyebrow">DRILLS & MAINTENANCE</span>
          <h2>计划有进度，执行有质量。</h2>
        </div>
        <Tabs
          value={kind}
          onValueChange={(value) => setKind(value as 'drill' | 'maintenance')}
        >
          <TabsList className="mo-subtabs">
            <TabsTrigger value="maintenance">计划维护</TabsTrigger>
            <TabsTrigger value="drill">应急演练</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="mo-metrics">
        <MetricCard
          title={`${view.period.scope}${label}计划`}
          value={String(stat.total)}
          unit="项"
          note="含已完成、进行中和未开始"
          icon={ClipboardCheck}
          onClick={() =>
            openDetail({ title: `${view.period.noun}${label}`, kind })
          }
        />
        <MetricCard
          title="计划完成率"
          value={stat.rate.toFixed(1)}
          unit="%"
          note={`已完成 ${stat.done} / 计划 ${stat.total}`}
          icon={Target}
          tone="teal"
          onClick={() =>
            openDetail({ title: `已完成${label}`, kind, status: 'done' })
          }
        />
        <MetricCard
          title={`进行中${label}`}
          value={String(stat.active)}
          unit="项"
          note="持续跟踪执行情况"
          icon={Wrench}
          onClick={() =>
            openDetail({ title: `进行中${label}`, kind, status: 'active' })
          }
        />
        <MetricCard
          title={kind === 'maintenance' ? '逾期维护' : '演练平均分'}
          value={
            kind === 'maintenance'
              ? String(stat.overdue)
              : (averageScore?.toFixed(1) ?? '—')
          }
          unit={kind === 'maintenance' ? '项' : '分'}
          note={
            kind === 'maintenance'
              ? '需要优先安排跟进'
              : `已评分 ${scores.length} 场 · 合格线 80 分`
          }
          icon={ShieldCheck}
          tone="amber"
          onClick={() =>
            openDetail({
              title: kind === 'maintenance' ? '逾期维护' : '演练评分清单',
              kind,
              status: kind === 'maintenance' ? 'overdue' : 'done',
            })
          }
        />
      </div>
      <div className="mo-three-columns">
        <Panel
          title={`各楼${label}进度`}
          onAction={() =>
            openDetail({ title: `${view.period.noun}${label}`, kind })
          }
        >
          <ColumnChart
            rows={completion}
            series={[
              { key: 'total', name: '计划', color: 'var(--mo-light-blue)' },
              { key: 'done', name: '已完成', color: 'var(--mo-teal)' },
            ]}
            onSelect={(building) =>
              openDetail({
                title: `${building}${label}`,
                kind,
                building: building as Building,
              })
            }
          />
        </Panel>
        <Panel title={kind === 'maintenance' ? '专业构成' : '演练类型'}>
          <Distribution
            rows={groupRecords(
              records,
              kind === 'maintenance' ? 'specialty' : 'source',
            )}
            label={`${label}计划`}
            onSelect={(value) =>
              openDetail({
                title: `${value}${label}`,
                kind,
                ...(kind === 'drill'
                  ? { source: value }
                  : { specialty: value }),
              })
            }
          />
        </Panel>
        <Panel title={kind === 'maintenance' ? '维护日历' : '楼栋演练得分'}>
          {kind === 'maintenance' ? (
            <WorkCalendar
              records={records}
              period={view.period}
              onSelect={(date) =>
                openDetail({ title: `${date}维护清单`, kind, date })
              }
            />
          ) : (
            <div className="mo-score-list">
              {completion.map((row, index) => {
                const items = scores.filter(
                  (record) => record.building === row.name,
                );
                const score = items.length
                  ? items.reduce((sum, item) => sum + (item.score ?? 0), 0) /
                    items.length
                  : null;
                return (
                  <button
                    key={row.name}
                    type="button"
                    onClick={() =>
                      openDetail({
                        title: `${row.name}演练评分`,
                        kind,
                        building: row.name as Building,
                        status: 'done',
                      })
                    }
                  >
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <strong>{row.name}</strong>
                    <small>{items.length} 场已评分</small>
                    <b>{score?.toFixed(1) ?? '—'}</b>
                  </button>
                );
              })}
              {!completion.length && <EmptyState />}
            </div>
          )}
        </Panel>
      </div>
      <WorkList
        view={view}
        openDetail={openDetail}
        kind={kind}
        title={
          kind === 'maintenance' ? '待完成维护' : `${view.period.scope}演练清单`
        }
        pending={kind === 'maintenance'}
      />
    </div>
  );
}

export function AlarmsPanel({ view, openDetail }: PanelProps) {
  const records = view.records.filter((item) => item.kind === 'alarm');
  const severe = records.filter((item) => item.level === '严重').length;
  const unresolved = records.filter((item) => item.status !== 'done').length;
  const notRecovered = records.filter((item) => !item.recovered).length;
  const rows = BUILDINGS.map((building) => {
    const items = records.filter((item) => item.building === building);
    return {
      name: building,
      total: items.length,
      done: items.filter((item) => item.status === 'done').length,
      pending: items.filter((item) => item.status !== 'done').length,
      recovered: items.filter((item) => item.recovered).length,
      notRecovered: items.filter((item) => !item.recovered).length,
    };
  }).filter((row) => row.total > 0);
  return (
    <div className="mo-topic-content">
      <div className="mo-section-heading">
        <div>
          <span className="mo-eyebrow">ALARM INTELLIGENCE</span>
          <h2>让告警回归重点。</h2>
        </div>
        <span className="mo-period-note">按所选周期统计</span>
      </div>
      <div className="mo-metrics">
        <MetricCard
          title={`${view.period.scope}告警`}
          value={String(records.length)}
          unit="条"
          note="统计所选周期与楼栋"
          icon={BellRing}
          onClick={() =>
            openDetail({ title: `${view.period.noun}告警`, kind: 'alarm' })
          }
        />
        <MetricCard
          title="严重告警"
          value={String(severe)}
          unit="条"
          note="严重等级单独关注"
          icon={ShieldCheck}
          tone="amber"
          onClick={() =>
            openDetail({ title: '严重告警', kind: 'alarm', level: '严重' })
          }
        />
        <MetricCard
          title="待处理告警"
          value={String(unresolved)}
          unit="条"
          note={`处理率 ${percentage(records.length - unresolved, records.length).toFixed(1)}%`}
          icon={Activity}
          tone="amber"
          onClick={() =>
            openDetail({
              title: '待处理告警',
              kind: 'alarm',
              status: 'unfinished',
            })
          }
        />
        <MetricCard
          title="未恢复告警"
          value={String(notRecovered)}
          unit="条"
          note="处理状态与恢复状态分别统计"
          icon={Wrench}
          onClick={() =>
            openDetail({ title: '未恢复告警', kind: 'alarm', recovered: false })
          }
        />
      </div>
      <div className="mo-two-columns">
        <Panel
          title="各楼告警处理状态"
          onAction={() => openDetail({ title: '告警处理清单', kind: 'alarm' })}
        >
          <ColumnChart
            rows={rows}
            series={[
              { key: 'done', name: '已处理' },
              { key: 'pending', name: '待处理', color: 'var(--mo-amber)' },
            ]}
            onSelect={(building) =>
              openDetail({
                title: `${building}告警`,
                kind: 'alarm',
                building: building as Building,
              })
            }
          />
        </Panel>
        <Panel
          title="各楼告警恢复状态"
          onAction={() => openDetail({ title: '告警恢复清单', kind: 'alarm' })}
        >
          <ColumnChart
            rows={rows}
            series={[
              { key: 'recovered', name: '已恢复', color: 'var(--mo-teal)' },
              { key: 'notRecovered', name: '未恢复', color: 'var(--mo-amber)' },
            ]}
            onSelect={(building) =>
              openDetail({
                title: `${building}告警`,
                kind: 'alarm',
                building: building as Building,
              })
            }
          />
        </Panel>
      </div>
      <WorkList
        view={view}
        openDetail={openDetail}
        kind="alarm"
        title="待处理告警清单"
        pending
      />
    </div>
  );
}
