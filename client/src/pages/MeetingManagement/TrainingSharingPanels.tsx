import {
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ArrowRight, CalendarDays, Trophy, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { MeetingSummary } from '../../../../shared/meeting-management.interface';
import { meetingPage } from './model';
import {
  isTrainingBuilding,
  rankTrainingPeople,
  trainingAttendance,
  type trainingInsights,
} from './training-model';
type PanelProps = {
  busy: boolean;
  unavailable: boolean;
  empty: ReactNode;
  rows: MeetingSummary[];
  onOpenRecord: (id: string) => void;
};
export function TrainingPager({
  current,
  total,
  change,
}: {
  current: number;
  total: number;
  change: (value: number) => void;
}) {
  return (
    <div className="meeting-pagination">
      <span>
        第 {current} / {total} 页
      </span>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={current === 1}
          onClick={() => change(current - 1)}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={current === total}
          onClick={() => change(current + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
export function TrainingTimeline({
  rows,
  busy,
  unavailable,
  empty,
  activeFilters,
  onOpenRecord,
}: PanelProps & { activeFilters: boolean }) {
  const [timelinePage, setTimelinePage] = useState(1);
  const timeline = meetingPage(rows, timelinePage, 6);
  return (
    <Card className="meeting-analysis-panel training-timeline-panel">
      <div className="meeting-panel-heading">
        <h2>
          <CalendarDays />
          分享时间轴
        </h2>
        <span>{activeFilters ? '当前筛选' : '全部分享'}</span>
      </div>
      {!timeline.records.length || busy || unavailable ? (
        empty
      ) : (
        <>
          <ol className="training-timeline">
            {timeline.records.map((r, i) => (
              <li key={r.id}>
                {i === 0 ||
                timeline.records[i - 1].date?.slice(0, 7) !==
                  r.date?.slice(0, 7) ? (
                  <h3>
                    {r.date?.slice(0, 7).replace('-', '年')}
                    {r.date ? '月' : '日期未填写'}
                  </h3>
                ) : null}
                <button
                  className="training-timeline-entry"
                  onClick={() => onOpenRecord(r.id)}
                >
                  <time dateTime={r.date || undefined}>
                    {r.date?.slice(5) || '待填写'}
                  </time>
                  <span className="training-timeline-content">
                    <strong>{r.title}</strong>
                    <span>
                      {r.presenters?.map((p) => p.name).join('、') ||
                        '分享人未填写'}
                      <i />
                      {r.specialties
                        ?.filter((s) => !isTrainingBuilding(s))
                        .join(' · ') || '专业未填写'}
                    </span>
                  </span>
                  <span className="training-timeline-facts">
                    <Badge variant="outline">{r.status || '状态未填写'}</Badge>
                    <small>
                      {trainingAttendance(r) === null
                        ? '人数未记录'
                        : `${trainingAttendance(r)} 人参与`}
                    </small>
                  </span>
                  <ArrowRight />
                </button>
              </li>
            ))}
          </ol>
          <TrainingPager
            current={timeline.page}
            total={timeline.pages}
            change={setTimelinePage}
          />
        </>
      )}
    </Card>
  );
}
export function TrainingRanking({
  ranking,
  busy,
  unavailable,
  message,
  onOpenPerson,
}: {
  ranking: ReturnType<typeof trainingInsights>['ranking'];
  busy: boolean;
  unavailable: boolean;
  message: string;
  onOpenPerson: (id: string) => void;
}) {
  const [rankingBy, setRankingBy] = useState<'participants' | 'shares'>(
    'participants',
  );
  const [rankingPage, setRankingPage] = useState(1);
  const ranked = useMemo(
    () => rankTrainingPeople(ranking, rankingBy),
    [ranking, rankingBy],
  );
  const rankPage = meetingPage(ranked, rankingPage, 5);
  const rankedRows = rankPage.records;
  const maxRank = Math.max(1, ...ranked.map((r) => r[rankingBy] || 0));
  return (
    <Card className="meeting-analysis-panel training-ranking-panel">
      <div className="meeting-panel-heading">
        <h2>
          <Trophy />
          分享人气榜
        </h2>
        <span>{busy || unavailable ? '—' : ranked.length} 位分享人</span>
      </div>
      <div className="training-rank-switch" role="group" aria-label="人气排序">
        {(['participants', 'shares'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={rankingBy === value ? 'default' : 'ghost'}
            aria-pressed={rankingBy === value}
            onClick={() => {
              setRankingBy(value);
              setRankingPage(1);
            }}
          >
            {value === 'participants' ? '参与人次' : '分享次数'}
          </Button>
        ))}
      </div>
      {!rankedRows.length || busy || unavailable ? (
        <div className="meeting-empty" role={unavailable ? 'alert' : undefined}>
          {busy || unavailable ? message : '暂无已完成分享'}
        </div>
      ) : (
        <>
          <ol className="training-ranking">
            {rankedRows.map((r, i) => (
              <li key={r.person.id}>
                <button
                  aria-label={`查看${r.person.name}的分享`}
                  onClick={() => onOpenPerson(r.person.id)}
                >
                  <span
                    className={`training-rank-number ${(rankPage.page - 1) * 5 + i === 0 ? 'training-rank-first' : ''}`}
                  >
                    {String((rankPage.page - 1) * 5 + i + 1).padStart(2, '0')}
                  </span>
                  <span className="training-rank-person">
                    <strong>{r.person.name}</strong>
                    <small>
                      {r.shares} 次分享
                      {r.missingAttendance
                        ? ` · ${r.missingAttendance} 次人数未记录`
                        : ''}
                    </small>
                    <span className="training-bar">
                      <i
                        style={
                          {
                            '--training-width': `${((r[rankingBy] || 0) / maxRank) * 100}%`,
                          } as CSSProperties
                        }
                      />
                    </span>
                  </span>
                  <span className="training-rank-value">
                    <strong>{r[rankingBy] ?? '—'}</strong>
                    <small>
                      {rankingBy === 'participants' ? '人次' : '次'}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <TrainingPager
            current={rankPage.page}
            total={rankPage.pages}
            change={setRankingPage}
          />
        </>
      )}
      <p className="training-ranking-note">
        已结束、评分中的分享参与排名；人次按场累加，共同分享分别计入。
      </p>
    </Card>
  );
}
export function TrainingResources({
  rows,
  busy,
  unavailable,
  empty,
  ResourceLinks,
  onOpenRecord,
}: PanelProps & { ResourceLinks: ComponentType<{ item: MeetingSummary }> }) {
  const [resourcePage, setResourcePage] = useState(1);
  const resources = meetingPage(rows, resourcePage, 10);
  return (
    <Card className="meeting-source-catalog training-resource-panel">
      <div className="meeting-archive-heading">
        <h2>分享资源库</h2>
        <span>{busy || unavailable ? '—' : rows.length} 条记录</span>
      </div>
      {!resources.records.length || busy || unavailable ? (
        empty
      ) : (
        <>
          <div className="training-resource-list">
            {resources.records.map((item) => (
              <article
                key={item.id}
                className="meeting-training-card training-resource-row"
              >
                <div className="training-resource-date">
                  <strong>{item.date?.slice(8) || '—'}</strong>
                  <small>{item.date?.slice(0, 7) || '日期未填写'}</small>
                </div>
                <div className="training-resource-content">
                  <div className="meeting-source-record-meta">
                    <Badge variant="secondary">
                      {item.subtype || '分享类型未填写'}
                    </Badge>
                    <span>{item.specialties?.join(' · ') || '专业未填写'}</span>
                  </div>
                  <button
                    className="meeting-source-title"
                    onClick={() => onOpenRecord(item.id)}
                  >
                    {item.title}
                    <ArrowRight />
                  </button>
                  <div className="meeting-training-person">
                    <Users />
                    <strong>
                      {item.presenters?.map((p) => p.name).join('、') ||
                        '分享人未填写'}
                    </strong>
                    <span>
                      {trainingAttendance(item) === null
                        ? '人数未记录'
                        : `${trainingAttendance(item)} 人参与`}
                    </span>
                    <span>{item.status || '状态未填写'}</span>
                  </div>
                </div>
                <div className="training-resource-actions">
                  <ResourceLinks item={item} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenRecord(item.id)}
                  >
                    查看详情
                    <ArrowRight />
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <TrainingPager
            current={resources.page}
            total={resources.pages}
            change={setResourcePage}
          />
        </>
      )}
    </Card>
  );
}
