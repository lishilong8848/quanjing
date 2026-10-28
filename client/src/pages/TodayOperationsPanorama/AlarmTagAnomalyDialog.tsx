import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type {
  TodayOperationsAlarmDashboardResponse,
  TodayOperationsAlarmItem,
  TodayOperationsAlarmTagIssueCode,
} from '@shared/today-operations-alarm.interface';
import { getTodayOperationsAlarmDashboard } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlarmAiConnectionBadge } from '@/components/AlarmAiConnectionBadge';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatAlarmDateTime } from './alarm-model';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import type { AlarmHumanReview, AlarmReviewTask } from '@shared/today-operations-alarm-review.interface';
import { AlarmReviewDialog } from './AlarmReviewDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: TodayOperationsAlarmDashboardResponse;
  businessDate?: string;
  initialPageLoaded?: boolean;
}

const PAGE_SIZE = 50;
const CATEGORIES: Array<{
  code: TodayOperationsAlarmTagIssueCode;
  label: string;
}> = [
  { code: 'missing', label: '描述漏填' },
  { code: 'format', label: '格式异常' },
  { code: 'pending', label: '检修/变更待确认' },
  { code: 'vague', label: '故障说明不足' },
  { code: 'nonOfficial', label: '非官方标签' },
  { code: 'semantic', label: '疑似语义错标' },
];

function reviewNotice(
  review: TodayOperationsAlarmDashboardResponse['tagReview'],
): string {
  switch (review.state) {
    case 'processing':
      return `正在复核标签语义 ${review.reviewed}/${review.total}；清单会自动更新`;
    case 'unconfigured':
      return '语义复核未启用，当前展示规则检出的异常';
    case 'error':
      return '语义复核暂不可用，规则异常仍可查看';
    case 'ready':
      return '规则核查与语义复核已完成；疑似错标需人工确认';
  }
}

export function AlarmTagAnomalyDialog({ open, onOpenChange, snapshot, businessDate, initialPageLoaded = false }: Props) {
  const access = useAccess();
  const canReview = canUsePageAction(access, 'alarm_review', 'confirm', access.role === 'admin' || access.role === 'editor') || canUsePageAction(access, 'alarm_review', 'update', access.role === 'admin' || access.role === 'editor');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<TodayOperationsAlarmItem[]>([]);
  const [reviews, setReviews] = useState<Record<string, AlarmHumanReview>>({});
  const [reviewStates, setReviewStates] = useState<Record<string, string>>({});
  const reviewCompletedAt = useRef<Record<string, number>>({});
  const [category, setCategory] = useState<
    TodayOperationsAlarmTagIssueCode | 'all'
  >('all');
  const [building, setBuilding] = useState('all');
  const [page, setPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => { setSelected(new Set()); }, [open, category, building, page, search]);
  useEffect(() => { if (!canReview) { setSelected(new Set()); setReviewOpen(false); setReviewStates({}); } }, [canReview]);
  const receiveReviewTask = (task: AlarmReviewTask) => {
    setReviewStates((previous) => ({ ...previous, ...Object.fromEntries(task.items.map((item) => [item.recordId, item.state])) }));
    setReviews((previous) => {
      const next = { ...previous };
      for (const item of task.items) if (item.state === 'success' && item.review) {
        next[item.recordId] = item.review;
        reviewCompletedAt.current[item.recordId] = Date.parse(task.updatedAt);
      }
      return next;
    });
  };
  const openReviews = (rows: TodayOperationsAlarmItem[]) => {
    if (!canReview) return;
    setReviewItems(rows.map((item) => ({ ...item, humanReview: reviews[item.id]?.version ? reviews[item.id] : item.humanReview })));
    setReviewOpen(true);
  };
  const requestKey = JSON.stringify({
    category, building, page, search,
    windowStart: snapshot.window.startDate,
    businessDate,
  });
  const [result, setResult] = useState<{
    key: string;
    data: TodayOperationsAlarmDashboardResponse;
  } | null>(() => initialPageLoaded ? { key: requestKey, data: snapshot } : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const resultRef = useRef(result);
  const currentData = result?.key === requestKey ? result.data : null;
  const latestData =
    result?.data.window.startDate === snapshot.window.startDate
      ? result.data
      : snapshot;
  const summary = latestData.summary;
  const review = latestData.tagReview;
  useEffect(() => {
    if (!currentData || currentData.sourceStatus !== 'fresh') return;
    const syncedAt = Date.parse(currentData.syncedAt);
    setReviews((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const item of currentData.page.items) if (reviewCompletedAt.current[item.id] <= syncedAt && next[item.id]) {
        delete next[item.id]; changed = true;
      }
      return changed ? next : previous;
    });
  }, [result]);

  useEffect(() => {
    if (!open) return;
    if (initialPageLoaded && reloadToken === 0 && resultRef.current?.key === requestKey) return;
    const requestId = ++requestIdRef.current;
    setLoading(resultRef.current?.key !== requestKey);
    setError(null);
    void getTodayOperationsAlarmDashboard({
      date: businessDate,
      metric: 'tagAnomaly',
      page,
      pageSize: PAGE_SIZE,
      tagIssueCode: category === 'all' ? undefined : category,
      building: building === 'all' ? undefined : building,
      q: search || undefined,
    })
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        const next = { key: requestKey, data };
        resultRef.current = next;
        setResult(next);
      })
      .catch((requestError: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(
          requestError instanceof Error && requestError.message.trim()
            ? requestError.message
            : '异常打标清单读取失败，请重试',
        );
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
    return () => {
      if (requestIdRef.current === requestId) requestIdRef.current += 1;
    };
  }, [building, category, open, page, reloadToken, requestKey, search, businessDate, initialPageLoaded]);

  useEffect(() => {
    if (!open || review.state !== 'processing') return;
    const timer = window.setInterval(
      () => setReloadToken((value) => value + 1),
      15_000,
    );
    return () => window.clearInterval(timer);
  }, [open, review.state]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(searchDraft.trim());
    setPage(1);
    setExpandedRows(new Set());
  };
  const items = currentData?.page.items ?? [];
  const totalPages = Math.max(1, currentData?.page.totalPages ?? 1);
  const selectedBuilding = summary.tagAnomalyByBuilding.find(
    (item) => item.building === building,
  );
  const categoryTotal =
    category === 'all'
      ? (selectedBuilding?.total ?? summary.tagAnomalyTotal)
      : (selectedBuilding?.byType[category] ??
        summary.tagAnomalyByType[category]);
  const buildingCount = (
    point: (typeof summary.tagAnomalyByBuilding)[number],
  ) => (category === 'all' ? point.total : point.byType[category]);
  const maxBuildingCount = Math.max(
    1,
    ...summary.tagAnomalyByBuilding.map(buildingCount),
  );
  const typeCount = (code: TodayOperationsAlarmTagIssueCode) =>
    selectedBuilding?.byType[code] ?? summary.tagAnomalyByType[code];
  const maxTypeCount = Math.max(
    1,
    ...CATEGORIES.map(({ code }) => typeCount(code)),
  );

  const selectBuilding = (next: string) => {
    setBuilding(next);
    setPage(1);
    setExpandedRows(new Set());
  };
  const selectCategory = (next: TodayOperationsAlarmTagIssueCode | 'all') => {
    setCategory(next);
    setPage(1);
    setExpandedRows(new Set());
  };
  const toggleExpanded = (id: string) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (<>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="today-panorama-detail-dialog today-panorama-tag-dialog flex max-h-[min(92dvh,960px)] w-[min(1240px,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogHeader className="today-panorama-tag-dialog-header flex-row items-start gap-3 border-b px-5 py-4 text-left sm:px-6">
          <span className="today-panorama-tag-dialog-icon" aria-hidden="true">
            <AlertTriangle />
          </span>
          <div className="min-w-0 flex-1">
            <div className="today-panorama-tag-dialog-title-row">
              <DialogTitle>异常打标</DialogTitle>
              <AlarmAiConnectionBadge review={review} />
            </div>
            <DialogDescription className="sr-only">
              {businessDate ? `${businessDate}告警描述与分类标签异常清单` : '近7天告警描述与分类标签异常清单'}
            </DialogDescription>
            <p className="today-panorama-tag-dialog-count">
              {businessDate || '近7天'}共 {summary.tagAnomalyTotal} 条告警涉及异常
            </p>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="关闭异常打标弹窗"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="today-panorama-tag-dialog-body min-h-0 flex-1 overflow-y-auto">
          <div className="today-panorama-tag-dialog-summary">
            <div className="today-panorama-tag-charts">
              <section
                className="today-panorama-tag-chart"
                aria-label="各楼栋异常告警分布"
              >
                <header>
                  <h3>
                    楼栋异常告警{' '}
                    <small>
                      {category === 'all'
                        ? '全部类型'
                        : CATEGORIES.find((item) => item.code === category)
                            ?.label}
                    </small>
                  </h3>
                  <button
                    type="button"
                    data-active={building === 'all'}
                    onClick={() => selectBuilding('all')}
                  >
                    全部楼栋
                  </button>
                </header>
                <div className="today-panorama-tag-chart-rows">
                  {summary.tagAnomalyByBuilding.map((point) => {
                    const count = buildingCount(point);
                    return (
                      <button
                        key={point.building}
                        type="button"
                        className="today-panorama-tag-chart-row"
                        data-active={building === point.building}
                        data-highest={count > 0 && count === maxBuildingCount}
                        aria-pressed={building === point.building}
                        aria-label={`${point.building}，${count}条异常告警`}
                        onClick={() => selectBuilding(point.building)}
                      >
                        <span>{point.building}</span>
                        <span className="today-panorama-tag-chart-track">
                          <i
                            style={{
                              width: `${(count / maxBuildingCount) * 100}%`,
                            }}
                          />
                        </span>
                        <strong>{count}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section
                className="today-panorama-tag-chart"
                aria-label="异常类型分布"
              >
                <header>
                  <h3>
                    异常类型{' '}
                    <small>{building === 'all' ? '全部楼栋' : building}</small>
                  </h3>
                  <button
                    type="button"
                    data-active={category === 'all'}
                    onClick={() => selectCategory('all')}
                  >
                    全部类型{' '}
                    {selectedBuilding?.total ?? summary.tagAnomalyTotal}
                  </button>
                </header>
                <div className="today-panorama-tag-chart-rows">
                  {CATEGORIES.map(({ code, label }) => {
                    const count = typeCount(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        className="today-panorama-tag-chart-row"
                        data-active={category === code}
                        data-highest={count > 0 && count === maxTypeCount}
                        aria-pressed={category === code}
                        aria-label={`${label}，${count}条告警`}
                        onClick={() => selectCategory(code)}
                      >
                        <span>{label}</span>
                        <span className="today-panorama-tag-chart-track">
                          <i
                            style={{
                              width: `${(count / maxTypeCount) * 100}%`,
                            }}
                          />
                        </span>
                        <strong>{count}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
            <p className="today-panorama-tag-review-state" role="status">
              {reviewNotice(review)}
              。同一告警可涉及多项异常，类型数量可能相加超过告警数。
            </p>
          </div>

          <div className="today-panorama-tag-list-toolbar">
            <div>
              <strong>异常清单</strong>
              <span>
                {building === 'all' ? '全部楼栋' : building} ·{' '}
                {category === 'all'
                  ? '全部类型'
                  : CATEGORIES.find((item) => item.code === category)
                      ?.label}{' '}
                · {currentData?.page.total ?? categoryTotal} 条
              </span>
            </div>
            <form onSubmit={submitSearch} className="today-panorama-tag-search">
              <Input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                aria-label="搜索异常告警"
                placeholder="搜索告警、位置或描述"
              />
              <Button type="submit" variant="outline" size="sm">
                <Search aria-hidden="true" />
                搜索
              </Button>
            </form>
          </div>

          {canReview && items.length ? <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 bg-muted/20">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="选择当前页异常" checked={items.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(items.filter((item) => !['pending', 'syncing'].includes(reviewStates[item.id])).map((item) => item.id)) : new Set())} />当前页全选</label>
            <span className="text-sm text-muted-foreground">已选 {selected.size} 条</span>
            <Button size="sm" disabled={!selected.size} onClick={() => openReviews(items.filter((item) => selected.has(item.id)))}>批量跟进</Button>
            {selected.size ? <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清空选择</Button> : null}
          </div> : null}
          {error ? (
            <div className="today-panorama-tag-list-state" role="alert">
              <AlertTriangle aria-hidden="true" />
              <strong>清单读取失败</strong>
              <span>{error}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                <RefreshCw aria-hidden="true" />
                重试
              </Button>
            </div>
          ) : loading && !currentData ? (
            <div className="today-panorama-tag-list-state" role="status">
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              <strong>正在读取异常清单</strong>
            </div>
          ) : items.length ? (
            <ol
              className="today-panorama-tag-list"
              aria-label="异常打标告警清单"
            >
              {items.map((item) => {
                const issues =
                  category === 'all'
                    ? item.tagIssues
                    : item.tagIssues.filter((issue) => issue.code === category);
                const expanded = expandedRows.has(item.id);
                const detailId = `tag-anomaly-detail-${item.id}`;
                return (
                  <li
                    className="today-panorama-tag-row"
                    data-expanded={expanded}
                    key={item.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
                      {canReview ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`选择 ${item.building} ${item.description}`} checked={selected.has(item.id)} disabled={['pending', 'syncing'].includes(reviewStates[item.id])} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />选择</label> : <span />}
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        {(reviews[item.id] || item.humanReview) ? <span className="text-foreground whitespace-pre-wrap break-words">{(reviews[item.id] || item.humanReview)!.customReply || (reviews[item.id] || item.humanReview)!.outcome} · {(reviews[item.id] || item.humanReview)!.responsibleName}</span> : null}
                        {reviewStates[item.id] && reviewStates[item.id] !== 'success' ? <span role="status" className="text-muted-foreground">{reviewStates[item.id] === 'error' ? '复核同步失败' : '复核同步中'}</span> : null}
                        {canReview ? <Button size="sm" variant="outline" onClick={() => openReviews([item])}>异常跟进</Button> : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="today-panorama-tag-row-toggle"
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      aria-label={`${item.building} ${item.description}，${issues.length}项异常，${expanded ? '收起' : '展开'}详情`}
                      onClick={() => toggleExpanded(item.id)}
                    >
                      <span className="today-panorama-tag-row-heading">
                        <span className="today-panorama-tag-row-meta">
                          <b>{item.building}</b>
                          <span>{item.level}</span>
                          <time>{formatAlarmDateTime(item.occurredAt)}</time>
                        </span>
                        <strong title={item.description}>
                          {item.description}
                        </strong>
                        <small>
                          {[item.location, item.monitorObject]
                            .filter((value) => value && value !== '—')
                            .join(' · ')}
                        </small>
                      </span>
                      <span className="today-panorama-tag-row-issue-preview">
                        {issues.slice(0, 2).map((issue, index) => (
                          <span
                            key={`${issue.code}-${issue.side}-${index}`}
                            data-source={issue.source}
                          >
                            {issue.label}
                            <small>
                              {issue.side === 'acceptance'
                                ? '受理'
                                : issue.side === 'confirmation'
                                  ? '确认'
                                  : '双侧'}
                            </small>
                          </span>
                        ))}
                        {issues.length > 2 ? (
                          <em>+{issues.length - 2}</em>
                        ) : null}
                      </span>
                      <span className="today-panorama-tag-row-statuses">
                        <span data-state={item.processingStatus}>
                          <small>处理</small>
                          <strong>{item.processingStatus || '—'}</strong>
                        </span>
                        <span data-state={item.confirmationStatus}>
                          <small>确认</small>
                          <strong>{item.confirmationStatus || '—'}</strong>
                        </span>
                        <span data-state={item.recoveryStatus}>
                          <small>恢复</small>
                          <strong>{item.recoveryStatus || '—'}</strong>
                        </span>
                      </span>
                      <ChevronDown
                        className="today-panorama-tag-row-chevron"
                        aria-hidden="true"
                      />
                    </button>
                    {expanded ? (
                      <div
                        className="today-panorama-tag-row-detail"
                        id={detailId}
                      >
                        <div className="today-panorama-tag-row-issues">
                          {issues.map((issue, index) => (
                            <div
                              className="today-panorama-tag-issue"
                              data-source={issue.source}
                              key={`${issue.code}-${issue.side}-${index}`}
                            >
                              <div>
                                <strong>{issue.label}</strong>
                                <span>
                                  {issue.side === 'acceptance'
                                    ? '受理'
                                    : issue.side === 'confirmation'
                                      ? '确认'
                                      : '受理 / 确认'}
                                </span>
                                {issue.source === 'ai' ? (
                                  <em>AI 疑似</em>
                                ) : null}
                              </div>
                              <p>{issue.reason}</p>
                              {issue.suggestedTag ? (
                                <small>
                                  建议标签：【{issue.suggestedTag}】
                                </small>
                              ) : null}
                            </div>
                          ))}
                        </div>
                        <dl className="today-panorama-tag-descriptions">
                          <div>
                            <dt>受理描述</dt>
                            <dd>{item.acceptanceDescription || '（空）'}</dd>
                          </div>
                          <div>
                            <dt>确认描述</dt>
                            <dd>{item.confirmationDescription || '（空）'}</dd>
                          </div>
                        </dl>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="today-panorama-tag-list-state">
              <strong>当前筛选下没有异常告警</strong>
              <span>可切换类别或调整搜索条件。</span>
            </div>
          )}
        </div>

        {currentData && currentData.page.total > 0 ? (
          <footer className="today-panorama-tag-dialog-footer">
            <span>
              共 {currentData.page.total} 条 · 第 {currentData.page.page}/
              {totalPages} 页
            </span>
            <nav aria-label="异常清单分页">
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="上一页"
                disabled={page <= 1}
                onClick={() => {
                  setPage((value) => value - 1);
                  setExpandedRows(new Set());
                }}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="下一页"
                disabled={page >= totalPages}
                onClick={() => {
                  setPage((value) => value + 1);
                  setExpandedRows(new Set());
                }}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          </footer>
        ) : null}
      </DialogContent>
    </Dialog>
    <AlarmReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} items={reviewItems} allowed={canReview} sessionReady={!access.isLoading} onTask={receiveReviewTask} />
    </>
  );
}
