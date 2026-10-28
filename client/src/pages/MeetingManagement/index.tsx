import { canUsePageAction } from '../business-action-access';
import {
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useSearchParams, Link, Navigate } from 'react-router-dom';
import {
  Archive,
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  Loader2,
  Search,
  LayoutDashboard,
  GraduationCap,
  Handshake,
} from 'lucide-react';
import { canAccessPage } from '@/access/access-policy';
import { useAccess } from '@/access/AccessProvider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import {
  MEETING_NATURES,
  MEETING_SCOPES,
  type MeetingSnapshot,
  type MeetingDetailResponse,
} from '../../../../shared/meeting-management.interface';
import { getMeetingSnapshot, getMeetingDetail, meetingError } from './api';
import type { WeeklyJob } from '../../../../shared/weekly-workspace.interface';
import { invalidateWeeklyFormRecord, seedWeeklyFormRecord } from './weekly-api';
import { mergeWeeklyRecord } from './weekly-record-state';
import {
  filterMeetings,
  meetingMetrics,
  meetingPage,
  SOURCE_LABELS,
} from './model';
import './styles.css';
import { LatestMeetingActions } from './LatestMeetingActions';
const MeetingOverview = lazy(() =>
  import('./MeetingOverview').then((module) => ({
    default: module.MeetingOverview,
  })),
);
const WeeklyWorkbench = lazy(() =>
  import('./WeeklyWorkbench').then((module) => ({
    default: module.WeeklyWorkbench,
  })),
);
const MeetingDetailDialog = lazy(() =>
  import('./MeetingDetailDialog').then((module) => ({
    default: module.MeetingDetailDialog,
  })),
);
const MeetingSourceBoard = lazy(() =>
  import('./MeetingSourceBoard').then((module) => ({
    default: module.MeetingSourceBoard,
  })),
);
const EMPTY_RECORDS: MeetingSnapshot['records'] = [];

export default function MeetingManagementPage() {
  const location = useLocation();
  const { role, pagePaths, isLoading, principalFingerprint } = useAccess();
  if (isLoading)
    return (
      <div className="meeting-empty" role="status">
        正在确认访问权限…
      </div>
    );
  if (!canAccessPage(role, location.pathname, pagePaths))
    return (
      <div className="meeting-empty" role="alert">
        当前账号无会议归档访问权限
      </div>
    );
  if (location.pathname.replace(/\/$/, '') === '/meeting-management/history')
    return <Navigate to={`/meeting-management${location.search}`} replace />;
  return <MeetingWorkspace key={`${principalFingerprint}:${role}`} />;
}

function MeetingWorkspace() {
  const access = useAccess();
  const canRefresh = canUsePageAction(access, 'meetings', 'refresh', !access.readOnlyPage);
  const [externalJob, setExternalJob] = useState<WeeklyJob | null>(null);
  const location = useLocation();
  const weekly = location.pathname.endsWith('/nantong-weekly');
  const additionalSource = location.pathname.endsWith('/training')
    ? 'training'
    : location.pathname.endsWith('/ali-meetings')
      ? 'ali-meeting'
      : null;
  const overview =
    location.pathname.replace(/\/$/, '') === '/meeting-management';
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  const [params, setParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<MeetingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const details = useRef(new Map<string, MeetingDetailResponse>());
  const mounted = useRef(true);
  const snapshotEpoch = useRef(0);
  const snapshotReading = useRef(false);

  const load = useCallback(async (refresh = false, background = false) => {
    refresh = refresh && canRefresh;
    if (background && snapshotReading.current) return;
    snapshotReading.current = true;
    const epoch = snapshotEpoch.current;
    request.current?.abort();
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const controller = new AbortController();
    request.current = controller;
    if (!background) setLoading(true);
    setError(null);
    try {
      let data = await getMeetingSnapshot(controller.signal, refresh);
      if (
        controller.signal.aborted ||
        !mounted.current ||
        epoch !== snapshotEpoch.current
      )
        return;
      setSnapshot(data);
      setLoading(false);
      let polls = 0;
      const poll = async () => {
        try {
          data = await getMeetingSnapshot(controller.signal);
          if (
            controller.signal.aborted ||
            !mounted.current ||
            epoch !== snapshotEpoch.current
          )
            return;
          setSnapshot(data);
          polls += 1;
          if (data.syncState === 'refreshing' && polls < 20)
            pollTimer.current = setTimeout(() => void poll(), 1500);
          else if (data.syncState === 'refreshing')
            setError('后台更新尚未完成，历史数据仍可查看；稍后可重试刷新');
        } catch (reason) {
          if (!controller.signal.aborted && mounted.current)
            setError(meetingError(reason));
        }
      };
      if (data.syncState === 'refreshing')
        pollTimer.current = setTimeout(() => void poll(), 1500);
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current)
        setError(meetingError(reason));
    } finally {
      if (request.current === controller) snapshotReading.current = false;
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }, [canRefresh]);

  const weeklySynced = useCallback((job: WeeklyJob) => {
    snapshotEpoch.current += 1;
    if (job.record) {
      setSnapshot((current) =>
        current ? mergeWeeklyRecord(current, job.record!) : current,
      );
      if (job.createOnly) return;
    }
    const epoch = snapshotEpoch.current;
    details.current.delete(job.targetRecordId);
    invalidateWeeklyFormRecord(job.targetRecordId);
    const controller = new AbortController();
    void getMeetingDetail(job.targetRecordId, controller.signal)
      .then(({ meeting, snapshotId, latestActions }) => {
        if (!mounted.current || epoch !== snapshotEpoch.current) return;
        seedWeeklyFormRecord({ meeting, snapshotId, latestActions });
        setSnapshot((current) =>
          current
            ? {
                ...current,
                snapshotId,
                latestActions:
                  latestActions === undefined
                    ? current.latestActions
                    : latestActions,
                records: current.records.some(
                  (record) => record.id === meeting.id,
                )
                  ? current.records.map((record) =>
                      record.id === meeting.id
                        ? {
                            ...record,
                            ...meeting,
                            searchText: [
                              meeting.title,
                              meeting.date,
                              ...meeting.sections.map(
                                (section) => section.content,
                              ),
                            ]
                              .join(' ')
                              .toLowerCase(),
                          }
                        : record,
                    )
                  : [
                      {
                        ...meeting,
                        searchText: [
                          meeting.title,
                          meeting.date,
                          ...meeting.sections.map((section) => section.content),
                        ]
                          .join(' ')
                          .toLowerCase(),
                      },
                      ...current.records,
                    ],
              }
            : current,
        );
      })
      .catch((reason) => {
        if (mounted.current) setError(meetingError(reason));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(false, true);
    };
    const timer = setInterval(refresh, 10000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const update = (key: string, value: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key !== 'page' && key !== 'record') next.delete('page');
        return next;
      },
      { replace: key === 'q' },
    );
  };
  const query = params.get('q') || '';
  const records = snapshot?.records || EMPTY_RECORDS;
  const weeklyRecords = useMemo(
    () => records.filter((r) => r.source === 'nantong-weekly'),
    [records],
  );
  const scopedRecords = weekly ? weeklyRecords : records;
  const filters = {
    query,
    year: params.get('year') || '',
    scope: weekly ? '机房' : params.get('scope') || '',
    nature: params.get('nature') || '',
    content: params.get('content') || '',
    source: weekly ? 'nantong-weekly' : params.get('source') || '',
    month: params.get('month') || '',
  };
  const filtered = useMemo(
    () => filterMeetings(records, filters),
    [
      records,
      filters.query,
      filters.year,
      filters.scope,
      filters.nature,
      filters.content,
      filters.source,
      filters.month,
    ],
  );
  const metrics = useMemo(() => meetingMetrics(scopedRecords), [scopedRecords]);
  const page = meetingPage(filtered, Number(params.get('page') || '1'));
  const years = useMemo(
    () =>
      [
        ...new Set(
          records
            .map((item) => item.date?.slice(0, 4))
            .filter((value): value is string => Boolean(value)),
        ),
      ]
        .sort()
        .reverse(),
    [records],
  );
  const selectedId = params.get('record');
  const notConnected = Boolean(
    filters.scope && !records.some((r) => r.scope === filters.scope),
  );
  const feedback = error || snapshot?.message;
  const syncing = snapshot?.syncState === 'refreshing' && !error;
  const metricItems = [
    {
      label: '归档记录',
      value: metrics.records,
      icon: Archive,
      key: '',
      tone: 'blue',
    },
    {
      label: weekly ? '已关联周报' : '已关联资料',
      value: metrics.documents,
      icon: FileText,
      key: 'documents',
      tone: 'cyan',
    },
    {
      label: '含待办记录',
      value: metrics.withActions,
      icon: ClipboardList,
      key: 'actions',
      tone: 'amber',
    },
    {
      label: weekly ? '覆盖周次' : '已接入来源',
      value: weekly
        ? metrics.weeks
        : snapshot?.sources?.filter((s) => s.count !== null).length || 0,
      icon: CalendarDays,
      key: 'weeks',
      tone: 'indigo',
    },
  ];

  return (
    <div className="meeting-workspace">
      <ManagementHeader
        activePage="meeting"
        title="议事航迹"
        subtitle={
          overview
            ? '南通基地会议总览'
            : weekly
              ? '南通属地周会'
              : additionalSource
                ? SOURCE_LABELS[additionalSource]
                : '南通基地会议归档'
        }
        toolbarLabel="会议归档工具栏"
        showSearch={false}
        updatedAt={
          snapshot
            ? new Date(snapshot.updatedAt).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              })
            : '待读取'
        }
        refreshing={loading || Boolean(syncing)}
        onRefresh={() => void load(canRefresh)}
      />
      <main className="meeting-main">
        {feedback && (
          <div role="alert" className="meeting-feedback">
            <span>{feedback}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load(canRefresh)}
            >
              重新加载
            </Button>
          </div>
        )}
        {syncing && (
          <div role="status" className="meeting-sync">
            <Loader2 className="animate-spin" />
            归档更新中，历史记录可继续查看
          </div>
        )}
        <nav className="meeting-page-nav" aria-label="议事航迹二级页面">
          <Link
            to="/meeting-management"
            aria-current={overview ? 'page' : undefined}
          >
            <LayoutDashboard />
            <span>会议总览</span>
          </Link>
          <Link
            to="/meeting-management/nantong-weekly"
            aria-current={weekly ? 'page' : undefined}
          >
            <CalendarDays />
            <span>南通属地周会</span>
          </Link>
          <Link
            to="/meeting-management/training"
            aria-current={additionalSource === 'training' ? 'page' : undefined}
          >
            <GraduationCap />
            <span>培训分享</span>
          </Link>
          <Link
            to="/meeting-management/ali-meetings"
            aria-current={
              additionalSource === 'ali-meeting' ? 'page' : undefined
            }
          >
            <Handshake />
            <span>阿里会议</span>
          </Link>
        </nav>
        {overview ? (
          <Suspense
            fallback={
              <div className="meeting-empty" role="status">
                正在打开会议总览…
              </div>
            }
          >
            <MeetingOverview
              snapshot={snapshot}
              loading={loading}
              onOpenRecord={(id) => update('record', id)}
            />
          </Suspense>
        ) : additionalSource ? (
          <Suspense
            fallback={
              <div className="meeting-empty" role="status">
                正在打开会议板块…
              </div>
            }
          >
            <MeetingSourceBoard
              key={additionalSource}
              source={additionalSource}
              snapshot={snapshot}
              loading={loading}
              onOpenRecord={(id) => update('record', id)}
            />
          </Suspense>
        ) : (
          <>
            {weekly && (
              <Suspense
                fallback={
                  <div role="status" className="meeting-empty">
                    正在打开周会工作台…
                  </div>
                }
              >
                <WeeklyWorkbench
                  snapshot={
                    snapshot ? { ...snapshot, records: weeklyRecords } : null
                  }
                  onOpenRecord={(id) => update('record', id)}
                  onSynced={weeklySynced}
                  externalJob={externalJob}
                />
              </Suspense>
            )}
            {weekly && (
              <LatestMeetingActions
                data={snapshot?.latestActions}
                loading={loading}
                onOpenRecord={(id) => update('record', id)}
                onSynced={weeklySynced}
                onDeferred={setExternalJob}
              />
            )}
            <section className="meeting-metrics" aria-label="会议归档概览">
              {metricItems.map((item) => (
                <Card key={item.label} className="meeting-metric">
                  <CardContent className="meeting-metric-content">
                    <span
                      className={`meeting-metric-icon meeting-tone-${item.tone}`}
                    >
                      <item.icon />
                    </span>
                    <div>
                      <p>{item.label}</p>
                      {!snapshot && loading ? (
                        <span
                          aria-label="正在加载"
                          className="meeting-number-loading"
                        >
                          —
                        </span>
                      ) : (
                        <strong>{snapshot ? item.value : '—'}</strong>
                      )}
                    </div>
                    {item.key !== 'weeks' && snapshot && (
                      <button
                        type="button"
                        className="meeting-metric-action"
                        aria-label={`筛选${item.label}`}
                        onClick={() => update('content', item.key)}
                      >
                        <ArrowRight />
                      </button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </section>
            <Card className="meeting-archive">
              <div className="meeting-archive-heading">
                <h2>{weekly ? '南通属地周会' : '历史会议'}</h2>
                <span>
                  {snapshot ? `${filtered.length} 条归档记录` : '等待加载'}
                </span>
              </div>
              <div className="meeting-filters">
                <label className="meeting-search">
                  <span>关键词</span>
                  <div>
                    <Search />
                    <Input
                      value={params.get('q') || ''}
                      onChange={(event) => update('q', event.target.value)}
                      placeholder="搜索会议、人员、内容或待办"
                    />
                  </div>
                </label>
                {!weekly && (
                  <label>
                    <span>会议来源</span>
                    <NativeSelect
                      aria-label="会议来源"
                      value={filters.source}
                      onChange={(e) => update('source', e.target.value)}
                    >
                      <NativeSelectOption value="">全部来源</NativeSelectOption>
                      {Object.entries(SOURCE_LABELS).map(([key, label]) => (
                        <NativeSelectOption key={key} value={key}>
                          {label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                )}
                <label>
                  <span>年份</span>
                  <NativeSelect
                    aria-label="年份"
                    value={filters.year}
                    onChange={(event) => update('year', event.target.value)}
                  >
                    <NativeSelectOption value="">全部年份</NativeSelectOption>
                    {years.map((year) => (
                      <NativeSelectOption key={year}>{year}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  <span>会议范围</span>
                  <NativeSelect
                    aria-label="会议范围"
                    disabled={weekly}
                    value={filters.scope}
                    onChange={(event) => update('scope', event.target.value)}
                  >
                    <NativeSelectOption value="">全部范围</NativeSelectOption>
                    {MEETING_SCOPES.map((scope) => (
                      <NativeSelectOption key={scope}>
                        {scope}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  <span>会议性质</span>
                  <NativeSelect
                    aria-label="会议性质"
                    value={filters.nature}
                    onChange={(event) => update('nature', event.target.value)}
                  >
                    <NativeSelectOption value="">全部性质</NativeSelectOption>
                    {MEETING_NATURES.map((nature) => (
                      <NativeSelectOption key={nature}>
                        {nature}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setParams((current) => {
                      const next = new URLSearchParams();
                      if (current.get('record'))
                        next.set('record', current.get('record')!);
                      return next;
                    })
                  }
                >
                  重置
                </Button>
              </div>
              {filters.content && (
                <div className="meeting-active-filter">
                  <Badge variant="secondary">
                    {filters.content === 'documents'
                      ? '已关联资料'
                      : '含待办记录'}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => update('content', '')}
                  >
                    取消筛选
                  </Button>
                </div>
              )}
              {!snapshot && loading ? (
                <div className="meeting-empty" role="status">
                  <Loader2 className="animate-spin" />
                  正在读取历史会议…
                </div>
              ) : !snapshot ? (
                <div className="meeting-empty">
                  <p>会议归档暂时不可用</p>
                  <Button onClick={() => void load()}>重新加载</Button>
                </div>
              ) : !page.records.length ? (
                <div className="meeting-empty">
                  <Archive />
                  <h3>
                    {notConnected
                      ? '尚未接入数据源'
                      : records.length
                        ? '没有符合条件的记录'
                        : '尚无归档记录'}
                  </h3>
                  <p>
                    {notConnected
                      ? '该类别暂未接入独立数据源。'
                      : records.length
                        ? '调整筛选条件后查看历史记录。'
                        : '源表暂时没有记录。'}
                  </p>
                </div>
              ) : (
                <>
                  <div className="meeting-list-labels" aria-hidden="true">
                    <span>会议与周报</span>
                    <span>分类</span>
                    <span>已收录内容</span>
                    <span>操作</span>
                  </div>
                  <ul className="meeting-list">
                    {page.records.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="meeting-row-main"
                          onClick={() => update('record', item.id)}
                          aria-label={`查看${item.title}`}
                        >
                          <span className="meeting-row-icon">
                            <FileText />
                          </span>
                          <span>
                            <strong>{item.title}</strong>
                            <small>
                              {item.date || '日期未填写'}
                              {item.date &&
                                item.date === scopedRecords[0]?.date && (
                                  <span className="meeting-row-latest">
                                    最新一期
                                  </span>
                                )}
                            </small>
                          </span>
                        </button>
                        <div className="meeting-row-category">
                          <Badge variant="secondary">{item.scope}</Badge>
                          <Badge variant="outline">{item.nature}</Badge>
                          {!weekly && (
                            <small>{SOURCE_LABELS[item.source]}</small>
                          )}
                        </div>
                        <div className="meeting-row-content">
                          <span>
                            {item.sectionTitles.length
                              ? item.sectionTitles.join(' · ')
                              : '正文未收录'}
                          </span>
                          {item.excerpt && (
                            <p className="meeting-row-excerpt">
                              {item.excerpt}
                            </p>
                          )}
                          {item.documentUrl && (
                            <small>
                              已关联
                              {item.source === 'nantong-weekly'
                                ? '原始周报'
                                : '会议资料'}
                            </small>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="meeting-row-open"
                          onClick={() => update('record', item.id)}
                        >
                          查看
                          <ArrowRight />
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <div className="meeting-pagination">
                    <span>
                      第 {page.page} / {page.pages} 页 · 每页 20 条
                    </span>
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label="上一页"
                        disabled={page.page === 1}
                        onClick={() => update('page', String(page.page - 1))}
                      >
                        <ChevronLeft />
                        上一页
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label="下一页"
                        disabled={page.page === page.pages}
                        onClick={() => update('page', String(page.page + 1))}
                      >
                        下一页
                        <ChevronRight />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </Card>
          </>
        )}
      </main>
      {selectedId && snapshot && (
        <Suspense
          fallback={
            <div role="status" className="meeting-dialog-loading">
              正在打开会议内容…
            </div>
          }
        >
          <MeetingDetailDialog
            key={`${selectedId}:${snapshot.snapshotId}`}
            id={selectedId}
            summary={records.find((item) => item.id === selectedId)}
            snapshotId={snapshot.snapshotId}
            cache={details.current}
            onClose={() => update('record', '')}
          />
        </Suspense>
      )}
    </div>
  );
}
