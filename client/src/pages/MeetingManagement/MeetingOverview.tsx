import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  Lightbulb,
  GraduationCap,
  Handshake,
  LineChart,
  Archive,
  X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogClose,
} from '@/components/ui/dialog';
import {
  MEETING_NATURES,
  MEETING_SCOPES,
  type MeetingSnapshot,
  type MeetingSource,
  type MeetingSummary,
} from '../../../../shared/meeting-management.interface';
import {
  filterMeetings,
  hasMeetingResources,
  sortMeetings,
  SOURCE_LABELS,
  SOURCE_ROUTES,
  meetingPage,
  meetingActivityGroups,
} from './model';

const SOURCES: MeetingSource[] = ['nantong-weekly', 'training', 'ali-meeting'];
const ICONS = [CalendarDays, GraduationCap, Handshake];
const TONES = ['blue', 'cyan', 'amber', 'neutral'];
const ACTIVITY_ICONS = {
  activity: CalendarDays,
  customer: Handshake,
  professional: Lightbulb,
  learning: GraduationCap,
};
const ACTIVITY_TONES = {
  activity: 'blue',
  customer: 'indigo',
  professional: 'cyan',
  learning: 'amber',
};
export function MeetingOverview({
  snapshot,
  loading,
  onOpenRecord,
}: {
  snapshot: MeetingSnapshot | null;
  loading: boolean;
  onOpenRecord: (id: string) => void;
}) {
  const [month, setMonth] = useState('');
  const [scope, setScope] = useState('');
  const [nature, setNature] = useState('');
  const [drill, setDrill] = useState<{
    title: string;
    rows: MeetingSummary[];
  } | null>(null);
  const all = useMemo(() => sortMeetings(snapshot?.records || []), [snapshot]);
  const records = filterMeetings(all, { month, scope, nature });
  const months = [
    ...new Set(
      all
        .map((r) => r.date?.slice(0, 7))
        .filter((v): v is string => Boolean(v)),
    ),
  ].sort();
  const trend = (month ? [month] : months.slice(-8)).map((m) => ({
    month: m,
    rows: records.filter((r) => r.date?.startsWith(m)),
  }));
  const peak = Math.max(1, ...trend.map((t) => t.rows.length));
  const activities = meetingActivityGroups(records).map((group) => ({
    ...group,
    value: group.rows.length,
    unit: '条',
    icon: ACTIVITY_ICONS[group.key],
    tone: ACTIVITY_TONES[group.key],
    hint:
      group.key === 'activity'
        ? `${new Set(group.rows.map((r) => r.date?.slice(0, 7)).filter(Boolean)).size} 个月有记录`
        : group.key === 'learning'
          ? `已记录分享人 ${new Set(group.rows.flatMap((r) => r.presenters || []).map((p) => p.id)).size} 位`
          : `${new Set(group.rows.map((r) => r.subtype || SOURCE_LABELS[r.source])).size} 种会议类型`,
  }));
  const natures = MEETING_NATURES.map((label) => ({
    label,
    rows: records.filter((r) => r.nature === label),
  }));
  const types = [
    ...new Set(records.map((r) => r.subtype || SOURCE_LABELS[r.source])),
  ]
    .map((label) => ({
      label,
      rows: records.filter(
        (r) => (r.subtype || SOURCE_LABELS[r.source]) === label,
      ),
    }))
    .sort(
      (a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label),
    );
  let offset = 0;
  const ring = natures
    .map((n, i) => {
      const begin = offset;
      offset += (n.rows.length / Math.max(1, records.length)) * 100;
      return `var(--meeting-chart-${TONES[i]}) ${begin}% ${offset}%`;
    })
    .join(',');
  const open = (title: string, rows = records) => setDrill({ title, rows });
  const unresolved =
    snapshot?.sources?.filter((s) => s.state === 'error').length || 0;
  return (
    <div className="meeting-overview">
      <div className="meeting-overview-toolbar">
        <div>
          <h1>会议总览</h1>
          <Badge variant="secondary">真实数据</Badge>
          {unresolved > 0 && <span>{unresolved} 个来源待更新</span>}
        </div>
        <div className="meeting-overview-selects">
          <NativeSelect
            aria-label="总览月份"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            <NativeSelectOption value="">全部月份</NativeSelectOption>
            {months
              .slice()
              .reverse()
              .map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {m}
                </NativeSelectOption>
              ))}
          </NativeSelect>
          <NativeSelect
            aria-label="总览范围"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <NativeSelectOption value="">全部范围</NativeSelectOption>
            {MEETING_SCOPES.map((v) => (
              <NativeSelectOption key={v}>{v}</NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="总览性质"
            value={nature}
            onChange={(e) => setNature(e.target.value)}
          >
            <NativeSelectOption value="">全部性质</NativeSelectOption>
            {MEETING_NATURES.map((v) => (
              <NativeSelectOption key={v}>{v}</NativeSelectOption>
            ))}
          </NativeSelect>
          {(month || scope || nature) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMonth('');
                setScope('');
                setNature('');
              }}
            >
              重置
            </Button>
          )}
        </div>
      </div>
      {!snapshot && (
        <div className="meeting-empty" role={loading ? 'status' : 'alert'}>
          {loading ? '正在读取会议总览…' : '会议总览暂时不可用，请重试刷新'}
        </div>
      )}
      <section className="meeting-metrics" aria-label="总览指标">
        {activities.map((item) => (
          <Card
            key={item.label}
            className="meeting-metric meeting-overview-metric"
          >
            <CardContent className="meeting-metric-content">
              <span className={`meeting-metric-icon meeting-tone-${item.tone}`}>
                <item.icon />
              </span>
              <div>
                <p>{item.label}</p>
                <strong>
                  {snapshot ? item.value : '—'}
                  <em>{item.unit}</em>
                </strong>
                <small>{item.hint}</small>
              </div>
              <button
                className="meeting-metric-action"
                disabled={!snapshot}
                aria-label={`查看${item.label}`}
                onClick={() => open(item.label, item.rows)}
              >
                <ArrowRight />
              </button>
            </CardContent>
          </Card>
        ))}
      </section>
      <section
        className="meeting-source-summary-grid"
        aria-label="已接入会议板块"
      >
        {SOURCES.map((source, i) => {
          const rows = records.filter((r) => r.source === source);
          const state = snapshot?.sources?.find((s) => s.source === source);
          const count = rows.filter(hasMeetingResources).length;
          const Icon = ICONS[i];
          return (
            <Card
              key={source}
              className={`meeting-source-summary meeting-scope-${i}`}
            >
              <CardContent className="meeting-source-summary-content">
                <div className="meeting-source-summary-title">
                  <Icon />
                  <h2>{SOURCE_LABELS[source]}</h2>
                  <Badge variant="outline">
                    {state?.state === 'error'
                      ? '更新异常'
                      : state?.state === 'refreshing'
                        ? '更新中'
                        : snapshot
                          ? '已接入'
                          : '待读取'}
                  </Badge>
                </div>
                <button
                  className="meeting-source-summary-number"
                  aria-label={`查看${SOURCE_LABELS[source]}记录`}
                  onClick={() => open(SOURCE_LABELS[source], rows)}
                >
                  <strong>
                    {state?.count === null || !snapshot ? '—' : rows.length}
                  </strong>
                  <span>条记录</span>
                  <ArrowRight />
                </button>
                <div className="meeting-source-summary-progress">
                  <i
                    style={{
                      width: `${rows.length ? (count / rows.length) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="meeting-source-summary-foot">
                  <span>{count} 条有关联资料</span>
                  <Link to={SOURCE_ROUTES[source]}>
                    进入板块
                    <ArrowRight />
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>
      <div className="meeting-overview-charts">
        <Card className="meeting-analysis-panel">
          <div className="meeting-panel-heading">
            <h2>
              <LineChart />
              归档趋势
            </h2>
            <span>{month || '最近 8 个有记录月份'}</span>
          </div>
          <div className="meeting-chart-legend">
            {SOURCES.map((s, i) => (
              <span key={s}>
                <i className={`meeting-scope-dot-${i}`} />
                {SOURCE_LABELS[s]}
              </span>
            ))}
          </div>
          <div
            className="meeting-trend-chart"
            style={
              { '--meeting-months': Math.max(1, trend.length) } as CSSProperties
            }
          >
            {trend.map((t) => (
              <button
                key={t.month}
                aria-label={`查看${t.month}的${t.rows.length}条记录`}
                onClick={() => open(`${t.month}归档记录`, t.rows)}
              >
                <span
                  className={`meeting-trend-value${t.rows.length && t.rows.length === peak ? ' meeting-trend-peak' : ''}`}
                >
                  {t.rows.length}
                  {t.rows.length && t.rows.length === peak ? (
                    <small>最高</small>
                  ) : null}
                </span>
                <span className="meeting-trend-track">
                  <span
                    className="meeting-trend-stack"
                    style={{ height: `${(t.rows.length / peak) * 100}%` }}
                  >
                    {SOURCES.map((s, i) => {
                      const count = t.rows.filter((r) => r.source === s).length;
                      return count ? (
                        <i
                          key={s}
                          className={`meeting-scope-dot-${i}`}
                          style={{ flexGrow: count }}
                        />
                      ) : null;
                    })}
                  </span>
                </span>
                <strong>{t.month.slice(2)}</strong>
              </button>
            ))}
          </div>
          {!trend.length && <div className="meeting-empty">暂无日期记录</div>}
        </Card>
        <Card className="meeting-analysis-panel">
          <div className="meeting-panel-heading">
            <h2>
              <GraduationCap />
              会议性质
            </h2>
            <span>{records.length} 条</span>
          </div>
          <div className="meeting-nature-chart">
            <div
              className="meeting-nature-ring"
              aria-hidden="true"
              style={{
                background: records.length
                  ? `conic-gradient(${ring})`
                  : 'var(--meeting-border)',
              }}
            >
              <div>
                <strong>{records.length}</strong>
                <span>归档记录</span>
              </div>
            </div>
            <div className="meeting-nature-legend">
              {natures.map((n, i) => (
                <button key={n.label} onClick={() => open(n.label, n.rows)}>
                  <i className={`meeting-nature-dot-${i}`} />
                  <span>{n.label}</span>
                  <strong>
                    {n.rows.length}
                    <small>条</small>
                  </strong>
                  <em>
                    {records.length
                      ? Math.round((n.rows.length / records.length) * 100)
                      : 0}
                    %
                  </em>
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>
      <div className="meeting-overview-bottom">
        <Card className="meeting-analysis-panel">
          <div className="meeting-panel-heading">
            <h2>
              <Archive />
              会议类型
            </h2>
            <span>前 7 类 · 按记录数排序</span>
          </div>
          <div className="meeting-topic-list">
            {types.slice(0, 7).map((t, i) => (
              <button key={t.label} onClick={() => open(t.label, t.rows)}>
                <span
                  className={`meeting-topic-rank${i === 0 ? ' meeting-topic-first' : ''}`}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <span>
                    <strong>{t.label}</strong>
                    <small>
                      {t.rows.filter(hasMeetingResources).length} 条有关联资料
                    </small>
                  </span>
                  <i>
                    <em
                      style={{
                        width: `${(t.rows.length / Math.max(1, types[0]?.rows.length || 0)) * 100}%`,
                      }}
                    />
                  </i>
                </div>
                <strong>
                  {t.rows.length}
                  <small>条记录</small>
                </strong>
              </button>
            ))}
          </div>
          {!types.length && <div className="meeting-empty">暂无会议类型</div>}
        </Card>
        <Card className="meeting-analysis-panel">
          <div className="meeting-panel-heading">
            <h2>
              <CalendarDays />
              近期会议动态
            </h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => open('近期会议动态')}
            >
              全部
              <ArrowRight />
            </Button>
          </div>
          <div className="meeting-recent-list">
            {records.slice(0, 7).map((r) => (
              <button key={r.id} onClick={() => onOpenRecord(r.id)}>
                <span className="meeting-recent-date">
                  <strong>{r.date?.slice(8) || '—'}</strong>
                  <small>{r.date?.slice(0, 7) || '未填日期'}</small>
                </span>
                <span>
                  <strong>{r.title}</strong>
                  <small>{SOURCE_LABELS[r.source]}</small>
                </span>
                <Badge variant="secondary">{r.nature}</Badge>
                <ArrowRight />
              </button>
            ))}
          </div>
          {!records.length && (
            <div className="meeting-empty">当前筛选下暂无会议</div>
          )}
        </Card>
      </div>
      <Card className="meeting-analysis-panel">
        <div className="meeting-panel-heading">
          <h2>会议范围</h2>
          <span>按现有来源统计</span>
        </div>
        <div className="meeting-scope-facts">
          {MEETING_SCOPES.map((s) => {
            const rows = records.filter((r) => r.scope === s);
            const connected = all.some((r) => r.scope === s);
            return (
              <button key={s} onClick={() => open(`${s}会议`, rows)}>
                <span>{s}</span>
                <strong>{connected ? rows.length : '—'}</strong>
                <small>{connected ? '条记录' : '未接入'}</small>
              </button>
            );
          })}
        </div>
      </Card>
      {drill && (
        <MeetingArchiveDrill
          title={drill.title}
          rows={drill.rows}
          onClose={() => setDrill(null)}
          onOpenRecord={(id) => {
            setDrill(null);
            onOpenRecord(id);
          }}
        />
      )}
    </div>
  );
}
function MeetingArchiveDrill({
  title,
  rows,
  onClose,
  onOpenRecord,
}: {
  title: string;
  rows: MeetingSummary[];
  onClose: () => void;
  onOpenRecord: (id: string) => void;
}) {
  const [requested, setPage] = useState(1);
  const page = meetingPage(rows, requested, 12);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="meeting-demo-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            所选分类的归档记录
          </DialogDescription>
          <DialogClose asChild>
            <Button
              className="meeting-close"
              size="icon"
              variant="ghost"
              aria-label="关闭"
            >
              <X />
            </Button>
          </DialogClose>
        </DialogHeader>
        <div className="meeting-demo-drill-meta">{rows.length} 条记录</div>
        <div className="meeting-demo-drill-list">
          {page.records.map((r) => (
            <section key={r.id}>
              <button onClick={() => onOpenRecord(r.id)}>
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {r.date || '日期未填写'} · {SOURCE_LABELS[r.source]}
                  </small>
                </span>
                <Badge variant="outline">{r.nature}</Badge>
                <ArrowRight />
              </button>
            </section>
          ))}
          {!rows.length && (
            <div className="meeting-empty">没有符合条件的记录</div>
          )}
        </div>
        {page.pages > 1 && (
          <div className="meeting-pagination">
            <span>
              第 {page.page} / {page.pages} 页
            </span>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={page.page === 1}
                onClick={() => setPage(page.page - 1)}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page.page === page.pages}
                onClick={() => setPage(page.page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
