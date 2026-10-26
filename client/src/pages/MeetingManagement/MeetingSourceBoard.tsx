import { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  FileText,
  PlayCircle,
  Users,
  Search,
  ExternalLink,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { TrainingSharingBoard } from './TrainingSharingBoard';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type {
  MeetingSnapshot,
  MeetingSource,
  MeetingSummary,
} from '../../../../shared/meeting-management.interface';
import {
  SOURCE_LABELS,
  filterMeetings,
  hasMeetingResources,
  meetingPage,
} from './model';

export function MeetingResourceLinks({ item }: { item: MeetingSummary }) {
  return (
    <div className="meeting-resource-links">
      {item.resources?.map((resource) => (
        <a
          key={resource.kind}
          href={resource.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {resource.kind === 'replay' ? <PlayCircle /> : <ExternalLink />}
          {resource.label}
        </a>
      ))}
    </div>
  );
}
interface MeetingSourceBoardProps {
  source: Exclude<MeetingSource, 'nantong-weekly'>;
  snapshot: MeetingSnapshot | null;
  loading: boolean;
  onOpenRecord: (id: string) => void;
}
export function MeetingSourceBoard(props: MeetingSourceBoardProps) {
  return props.source === 'training' ? (
    <TrainingSharingBoard {...props} ResourceLinks={MeetingResourceLinks} />
  ) : (
    <MeetingSourceCatalog {...props} />
  );
}
function MeetingSourceCatalog({
  source,
  snapshot,
  loading,
  onOpenRecord,
}: {
  source: Exclude<MeetingSource, 'nantong-weekly'>;
  snapshot: MeetingSnapshot | null;
  loading: boolean;
  onOpenRecord: (id: string) => void;
}) {
  const training = source === 'training';
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [year, setYear] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [presenter, setPresenter] = useState('');
  const [content, setContent] = useState('');
  const [requestedPage, setPage] = useState(1);
  const records = useMemo(
    () => snapshot?.records.filter((r) => r.source === source) || [],
    [snapshot, source],
  );
  const state = snapshot?.sources?.find((s) => s.source === source);
  const options = (values: (string | undefined)[]) =>
    [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
  const shown = filterMeetings(records, { query, year, content }).filter(
    (r) =>
      (!type || r.subtype === type) &&
      (!specialty || r.specialties?.includes(specialty)) &&
      (!presenter || r.presenters?.some((p) => p.id === presenter)),
  );
  const page = meetingPage(shown, requestedPage, training ? 12 : 20);
  const people = [
    ...new Map(
      records.flatMap((r) => r.presenters || []).map((p) => [p.id, p]),
    ).values(),
  ];
  const reset = () => {
    setQuery('');
    setType('');
    setYear('');
    setSpecialty('');
    setPresenter('');
    setContent('');
    setPage(1);
  };
  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };
  const metrics = training
    ? ([
        ['分享记录', records.length, BookOpen],
        [
          '课件资料',
          records.filter((r) => r.resources?.some((x) => x.kind === 'slides'))
            .length,
          FileText,
        ],
        [
          '回放 / 妙记',
          records.filter((r) => r.resources?.some((x) => x.kind === 'replay'))
            .length,
          PlayCircle,
        ],
        ['分享人', people.length, Users],
      ] as const)
    : ([
        ['会议记录', records.length, BookOpen],
        ['已关联资料', records.filter(hasMeetingResources).length, FileText],
        ['会议类型', options(records.map((r) => r.subtype)).length, Users],
        [
          '待补资料',
          records.filter((r) => !hasMeetingResources(r)).length,
          FileText,
        ],
      ] as const);
  return (
    <div
      className={`meeting-source-board ${training ? 'meeting-training-board' : 'meeting-ali-board'}`}
    >
      <section
        className="meeting-metrics"
        aria-label={`${SOURCE_LABELS[source]}指标`}
      >
        {metrics.map(([label, value, Icon], i) => (
          <Card key={label} className="meeting-metric">
            <CardContent className="meeting-metric-content">
              <span
                className={`meeting-metric-icon meeting-tone-${['blue', 'cyan', 'indigo', 'amber'][i]}`}
              >
                <Icon />
              </span>
              <div>
                <p>{label}</p>
                <strong>
                  {(!snapshot && loading) || state?.count === null
                    ? '—'
                    : value}
                </strong>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
      <Card className="meeting-source-catalog">
        <div className="meeting-archive-heading">
          <h2>{training ? '分享资源库' : '阿里及相关会议'}</h2>
          <span>
            {state?.count === null ? '读取失败' : `${shown.length} 条记录`}
          </span>
        </div>
        <div className="meeting-source-filters">
          <label className="meeting-source-search">
            <span>关键词</span>
            <div>
              <Search />
              <Input
                aria-label="板块关键词"
                value={query}
                placeholder={
                  training ? '搜索主题、分享人或专业' : '搜索会议名称或重点'
                }
                onChange={(e) => change(setQuery, e.target.value)}
              />
            </div>
          </label>
          <label>
            <span>年份</span>
            <NativeSelect
              aria-label="板块年份"
              value={year}
              onChange={(e) => change(setYear, e.target.value)}
            >
              <NativeSelectOption value="">全部年份</NativeSelectOption>
              {options(records.map((r) => r.date?.slice(0, 4)))
                .reverse()
                .map((v) => (
                  <NativeSelectOption key={v}>{v}</NativeSelectOption>
                ))}
            </NativeSelect>
          </label>
          <label>
            <span>{training ? '分享类型' : '会议类型'}</span>
            <NativeSelect
              aria-label="板块类型"
              value={type}
              onChange={(e) => change(setType, e.target.value)}
            >
              <NativeSelectOption value="">全部类型</NativeSelectOption>
              {options(records.map((r) => r.subtype)).map((v) => (
                <NativeSelectOption key={v}>{v}</NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {training && (
            <>
              <label>
                <span>楼栋 / 专业</span>
                <NativeSelect
                  aria-label="楼栋专业"
                  value={specialty}
                  onChange={(e) => change(setSpecialty, e.target.value)}
                >
                  <NativeSelectOption value="">全部专业</NativeSelectOption>
                  {options(records.flatMap((r) => r.specialties || [])).map(
                    (v) => (
                      <NativeSelectOption key={v}>{v}</NativeSelectOption>
                    ),
                  )}
                </NativeSelect>
              </label>
              <label>
                <span>分享人</span>
                <NativeSelect
                  aria-label="分享人"
                  value={presenter}
                  onChange={(e) => change(setPresenter, e.target.value)}
                >
                  <NativeSelectOption value="">全部分享人</NativeSelectOption>
                  {people.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            </>
          )}
          <label>
            <span>资料</span>
            <NativeSelect
              aria-label="板块资料"
              value={content}
              onChange={(e) => change(setContent, e.target.value)}
            >
              <NativeSelectOption value="">全部记录</NativeSelectOption>
              <NativeSelectOption value="documents">
                已关联资料
              </NativeSelectOption>
            </NativeSelect>
          </label>
          <Button variant="ghost" onClick={reset}>
            重置
          </Button>
        </div>
        {!snapshot && loading ? (
          <div role="status" className="meeting-empty">
            正在读取{SOURCE_LABELS[source]}…
          </div>
        ) : state?.count === null ? (
          <div role="alert" className="meeting-empty">
            {state.message}
          </div>
        ) : !page.records.length ? (
          <div className="meeting-empty">
            {snapshot ? '没有符合条件的记录' : '数据读取失败，请刷新重试'}
          </div>
        ) : (
          <>
            <div
              className={
                training ? 'meeting-training-grid' : 'meeting-ali-list'
              }
            >
              {page.records.map((item) => (
                <article
                  key={item.id}
                  className={
                    training ? 'meeting-training-card' : 'meeting-ali-row'
                  }
                >
                  {training && (
                    <div className="meeting-training-visual" aria-hidden="true">
                      <BookOpen />
                      <span>{item.specialties?.join(' · ') || '经验分享'}</span>
                    </div>
                  )}
                  <div className="meeting-source-record">
                    <div className="meeting-source-record-meta">
                      <span>{item.date || '日期未填写'}</span>
                      <Badge variant="secondary">{item.subtype}</Badge>
                      {!training && (
                        <Badge variant="outline">{item.scope}</Badge>
                      )}
                    </div>
                    <button
                      className="meeting-source-title"
                      onClick={() => onOpenRecord(item.id)}
                    >
                      {item.title}
                      <ArrowRight />
                    </button>
                    {training ? (
                      <div className="meeting-training-person">
                        <Users />
                        <strong>
                          {item.presenters?.map((p) => p.name).join('、') ||
                            '分享人待填写'}
                        </strong>
                        {item.participantCount !== null &&
                          item.participantCount !== undefined && (
                            <span>{item.participantCount} 人参与</span>
                          )}
                      </div>
                    ) : item.excerpt ? (
                      <p className="meeting-row-excerpt">{item.excerpt}</p>
                    ) : (
                      <span className="meeting-source-muted">
                        {item.warnings?.some((w) => w.includes('乱码'))
                          ? '重点含乱码，请查看原始纪要'
                          : '会议重点未填写'}
                      </span>
                    )}
                    <MeetingResourceLinks item={item} />
                    <div className="meeting-source-record-footer">
                      <span>
                        {training
                          ? item.status || '状态未填写'
                          : item.attachmentNames?.length
                            ? `${item.attachmentNames.length} 份附件`
                            : !hasMeetingResources(item)
                              ? '资料待补充'
                              : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onOpenRecord(item.id)}
                      >
                        查看详情
                        <ArrowRight />
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <div className="meeting-pagination">
              <span>
                第 {page.page} / {page.pages} 页
              </span>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page.page === 1}
                  onClick={() => setPage(page.page - 1)}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page.page === page.pages}
                  onClick={() => setPage(page.page + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
