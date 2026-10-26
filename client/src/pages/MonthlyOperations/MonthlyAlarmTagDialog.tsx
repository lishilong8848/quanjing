import { useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { MonthlyAlarm } from '@shared/monthly-operations-alarms.interface';
import type { TodayOperationsAlarmTagIssueCode, TodayOperationsAlarmTagReviewStatus } from '@shared/today-operations-alarm.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SourceModal } from './SourceModal';
import { alarmDate } from './alarm-model';
import { BUILDINGS } from './model';

const PAGE_SIZE = 50;
const CATEGORIES: { code: TodayOperationsAlarmTagIssueCode; label: string }[] = [
  { code: 'missing', label: '描述漏填' },
  { code: 'format', label: '格式异常' },
  { code: 'pending', label: '检修/变更待确认' },
  { code: 'vague', label: '故障说明不足' },
  { code: 'nonOfficial', label: '非官方标签' },
  { code: 'semantic', label: '疑似语义错标' },
];

function reviewLabel(review: TodayOperationsAlarmTagReviewStatus): string {
  switch (review.state) {
    case 'processing': return `AI 语义复核中 ${review.reviewed}/${review.total}`;
    case 'ready': return 'AI 语义复核已完成，疑似错标需人工确认';
    case 'error': return 'AI 语义复核暂不可用，规则异常仍可查看';
    case 'unconfigured': return 'AI 语义复核未启用，当前只显示规则异常';
  }
}

export function MonthlyAlarmTagDialog({
  records,
  range,
  review,
  trigger,
  initialBuilding,
  onClose,
}: {
  records: MonthlyAlarm[];
  range: { start: string; end: string };
  review: TodayOperationsAlarmTagReviewStatus;
  trigger: HTMLElement | null;
  initialBuilding: string;
  onClose: () => void;
}) {
  const [building, setBuilding] = useState(initialBuilding);
  const [category, setCategory] = useState<TodayOperationsAlarmTagIssueCode | 'all'>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const anomalies = useMemo(() => records.filter((row) => row.tagIssues.length), [records]);
  const buildings = useMemo(
    () => [...new Set([...BUILDINGS, ...records.map((row) => row.building)])],
    [records],
  );
  const buildingCount = (name: string) => anomalies.filter((row) =>
    row.building === name && (category === 'all' || row.tagIssues.some((issue) => issue.code === category)),
  ).length;
  const typeCount = (code: TodayOperationsAlarmTagIssueCode) => anomalies.filter((row) =>
    (building === 'all' || row.building === building) && row.tagIssues.some((issue) => issue.code === code),
  ).length;
  const maxBuilding = Math.max(1, ...buildings.map(buildingCount));
  const maxType = Math.max(1, ...CATEGORIES.map(({ code }) => typeCount(code)));
  const filtered = useMemo(() => anomalies.filter((row) =>
    (building === 'all' || row.building === building) &&
    (category === 'all' || row.tagIssues.some((issue) => issue.code === category)) &&
    (!search || [row.title, row.location, row.object, row.acceptanceDescription, row.confirmationDescription]
      .join(' ').toLocaleLowerCase('zh-CN').includes(search.toLocaleLowerCase('zh-CN'))),
  ), [anomalies, building, category, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const selectBuilding = (value: string) => { setBuilding(value); setPage(1); setExpanded(null); };
  const selectCategory = (value: TodayOperationsAlarmTagIssueCode | 'all') => {
    setCategory(value); setPage(1); setExpanded(null);
  };

  return (
    <SourceModal title="打标异常" trigger={trigger} onClose={onClose}>
      <div className="mo-tag-dialog">
        <div className="mo-tag-overview">
          <div className="mo-tag-count">
            <strong>{anomalies.length.toLocaleString()}</strong>
            <span>条异常告警</span>
            <small>{range.start} 至 {range.end}</small>
          </div>
          <div className="mo-tag-charts">
            <section className="mo-tag-chart" aria-label="各楼栋异常告警分布">
              <header><h3>楼栋异常告警</h3><button type="button" aria-pressed={building === 'all'} onClick={() => selectBuilding('all')}>全部楼栋</button></header>
              {buildings.map((name) => {
                const count = buildingCount(name);
                return <button type="button" key={name} className="mo-tag-chart-row" aria-pressed={building === name}
                  aria-label={`${name}，${count}条异常告警`} onClick={() => selectBuilding(name)}>
                  <span>{name}</span><i><b style={{ width: `${count / maxBuilding * 100}%` }} /></i><strong>{count}</strong>
                </button>;
              })}
            </section>
            <section className="mo-tag-chart" aria-label="异常类型分布">
              <header><h3>异常类型</h3><button type="button" aria-pressed={category === 'all'} onClick={() => selectCategory('all')}>全部类型</button></header>
              {CATEGORIES.map(({ code, label }) => {
                const count = typeCount(code);
                return <button type="button" key={code} className="mo-tag-chart-row" aria-pressed={category === code}
                  aria-label={`${label}，${count}条告警`} onClick={() => selectCategory(code)}>
                  <span>{label}</span><i><b style={{ width: `${count / maxType * 100}%` }} /></i><strong>{count}</strong>
                </button>;
              })}
            </section>
          </div>
          <p className="mo-tag-review" role="status">{reviewLabel(review)}</p>
        </div>
        <div className="mo-tag-toolbar">
          <div><strong>异常清单</strong><span>{filtered.length.toLocaleString()} 条</span></div>
          <form onSubmit={(event) => { event.preventDefault(); setSearch(searchDraft.trim()); setPage(1); setExpanded(null); }}>
            <Input aria-label="搜索异常告警" placeholder="搜索告警、位置或描述" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
            <Button type="submit" size="sm" variant="outline"><Search aria-hidden="true" />搜索</Button>
          </form>
        </div>
        <div className="mo-tag-list-scroll">
          {!filtered.length ? <div className="mo-tag-empty">当前筛选下没有异常告警</div> :
            <ol className="mo-tag-list" aria-label="打标异常告警清单">
              {filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((row) => {
                const issues = category === 'all' ? row.tagIssues : row.tagIssues.filter((issue) => issue.code === category);
                const isExpanded = expanded === row.id;
                return <li key={row.id} className="mo-tag-row">
                  <button type="button" className="mo-tag-row-main" aria-expanded={isExpanded}
                    onClick={() => setExpanded(isExpanded ? null : row.id)}>
                    <span className="mo-tag-row-title"><small>{row.building} · {row.level} · {alarmDate(row.occurredAt)}</small><strong>{row.title}</strong><em>{row.location} · {row.object}</em></span>
                    <span className="mo-tag-row-issues">{issues.slice(0, 2).map((issue, index) => <span key={`${issue.code}-${issue.side}-${index}`}>{issue.label}</span>)}{issues.length > 2 && <span>+{issues.length - 2}</span>}</span>
                    <span className="mo-tag-row-status"><span>处理 <b>{row.process}</b></span><span>确认 <b>{row.confirmedAt ? '已确认' : '待确认'}</b></span><span>恢复 <b>{row.recovery}</b></span></span>
                    <ChevronDown aria-hidden="true" className={isExpanded ? 'mo-tag-chevron-open' : ''} />
                  </button>
                  {isExpanded && <div className="mo-tag-row-detail">
                    <div className="mo-tag-reasons">{issues.map((issue, index) => <div key={`${issue.code}-${issue.side}-${index}`}><strong>{issue.label} · {issue.side === 'acceptance' ? '受理' : issue.side === 'confirmation' ? '确认' : '双侧'}{issue.source === 'ai' ? ' · AI 疑似' : ''}</strong><p>{issue.reason}</p>{issue.suggestedTag && <small>建议标签：【{issue.suggestedTag}】</small>}</div>)}</div>
                    <dl><div><dt>受理描述</dt><dd>{row.acceptanceDescription || '（空）'}</dd></div><div><dt>确认描述</dt><dd>{row.confirmationDescription || '（空）'}</dd></div></dl>
                  </div>}
                </li>;
              })}
            </ol>}
        </div>
        <footer className="mo-tag-footer"><span>第 {currentPage}/{pages} 页 · 每页最多 {PAGE_SIZE} 条</span><nav aria-label="异常清单分页"><Button type="button" variant="outline" size="icon-sm" aria-label="上一页" disabled={currentPage <= 1} onClick={() => { setPage(currentPage - 1); setExpanded(null); }}><ChevronLeft /></Button><Button type="button" variant="outline" size="icon-sm" aria-label="下一页" disabled={currentPage >= pages} onClick={() => { setPage(currentPage + 1); setExpanded(null); }}><ChevronRight /></Button></nav></footer>
      </div>
    </SourceModal>
  );
}
