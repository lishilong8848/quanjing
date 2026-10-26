import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  MapPin,
  RefreshCw,
  UserRound,
  X,
} from 'lucide-react';
import type {
  TodayOperationsAlarmDashboardResponse,
  TodayOperationsAlarmItem,
  TodayOperationsAlarmMetric,
} from '@shared/today-operations-alarm.interface';
import { getTodayOperationsAlarmDashboard } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AlarmDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metric: TodayOperationsAlarmMetric;
  title: string;
  building?: string;
}

const PAGE_SIZE = 20;

const shanghaiDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatDateTime(value: string): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return shanghaiDateTimeFormatter.format(timestamp).replace(/\//g, '-');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '告警清单加载失败，请稍后重试。';
}

function getLevelBadgeClass(level: TodayOperationsAlarmItem['level']): string {
  const normalizedLevel = level.trim();
  if (['紧急', '严重', '高危'].includes(normalizedLevel)) {
    return 'border-red-200 bg-red-50 text-red-700';
  }
  if (['重要', '中危'].includes(normalizedLevel)) {
    return 'border-orange-200 bg-orange-50 text-orange-700';
  }
  if (['次要', '预警', '低危'].includes(normalizedLevel)) {
    return 'border-blue-200 bg-blue-50 text-blue-700';
  }
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function getProcessingBadgeClass(
  status: TodayOperationsAlarmItem['processingStatus'],
): string {
  if (status.trim() === '已处理') {
    return 'border-green-200 bg-green-50 text-green-700';
  }
  if (status.trim() === '处理中') {
    return 'border-blue-200 bg-blue-50 text-blue-700';
  }
  if (status.trim() === '未处理') {
    return 'border-orange-200 bg-orange-50 text-orange-700';
  }
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function getRecoveryBadgeClass(
  status: TodayOperationsAlarmItem['recoveryStatus'],
): string {
  if (status.trim() === '已恢复') {
    return 'border-green-200 bg-green-50 text-green-700';
  }
  if (status.trim() === '未恢复') {
    return 'border-orange-200 bg-orange-50 text-orange-700';
  }
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

export function AlarmDetailDialog({
  open,
  onOpenChange,
  metric,
  title,
  building,
}: AlarmDetailDialogProps) {
  const scopeKey = `${metric}:${building ?? ''}`;
  const [pagination, setPagination] = useState({
    scopeKey,
    page: 1,
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [dashboard, setDashboard] =
    useState<TodayOperationsAlarmDashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const page = pagination.scopeKey === scopeKey ? pagination.page : 1;

  const updatePage = (updater: (current: number) => number) => {
    setPagination((current) => ({
      scopeKey,
      page: updater(current.scopeKey === scopeKey ? current.page : 1),
    }));
  };

  useEffect(() => {
    if (!open) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    setDashboard(null);

    void getTodayOperationsAlarmDashboard({
      page,
      pageSize: PAGE_SIZE,
      metric,
      building,
    })
      .then((response) => {
        if (requestIdRef.current !== requestId) return;
        setDashboard(response);
      })
      .catch((requestError: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(getErrorMessage(requestError));
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);
      });

    return () => {
      if (requestIdRef.current === requestId) {
        requestIdRef.current += 1;
      }
    };
  }, [building, metric, open, page, reloadToken]);

  const pageData = dashboard?.page;
  const totalPages = Math.max(1, pageData?.totalPages ?? 1);
  const visibleItems = pageData?.items ?? [];
  const pageNumbers = useMemo(() => {
    const start = Math.max(1, Math.min(page - 1, totalPages - 2));
    const end = Math.min(totalPages, start + 2);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, [page, totalPages]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="today-panorama-detail-dialog today-alarm-dialog flex max-h-[min(86vh,820px)] w-[min(1220px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-slate-200 p-0"
        showCloseButton={false}
      >
        <DialogHeader className="flex-row items-start gap-3 border-b border-slate-200 bg-slate-50/80 px-5 py-4 text-left sm:px-6">
          <span
            className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"
            aria-hidden="true"
          >
            <BellRing className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg leading-6 text-slate-950">
              {title}
            </DialogTitle>
            <DialogDescription
              className={pageData ? 'mt-1 text-sm text-slate-500' : 'sr-only'}
            >
              {pageData
                ? `共 ${pageData.total} 条 · 每页 ${PAGE_SIZE} 条`
                : `${title}正在加载`}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-slate-500"
              aria-label={`关闭${title}`}
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 overflow-y-auto bg-slate-50/40"
          aria-live="polite"
        >
          {loading ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <LoaderCircle
                className="size-7 animate-spin text-blue-600"
                aria-hidden="true"
              />
              <strong className="mt-4 text-sm text-slate-900">
                正在加载告警清单
              </strong>
              <span className="mt-1 text-xs text-slate-500">
                正在读取本地或服务端快照
              </span>
            </div>
          ) : error ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <span
                className="inline-flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600"
                aria-hidden="true"
              >
                <AlertTriangle className="size-5" />
              </span>
              <strong className="mt-4 text-sm text-slate-900">
                告警清单加载失败
              </strong>
              <p className="mt-1 max-w-lg text-xs leading-5 text-slate-500">
                {error}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => setReloadToken((current) => current + 1)}
              >
                <RefreshCw aria-hidden="true" />
                重新加载
              </Button>
            </div>
          ) : visibleItems.length > 0 ? (
            <ol
              className="space-y-3 p-4 sm:p-5"
              aria-label={`${title}，第${page}页`}
            >
              {visibleItems.map((item) => (
                <li
                  className="today-panorama-detail-row today-alarm-dialog-row rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
                  key={item.id}
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-[260px] flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={getLevelBadgeClass(item.level)}
                        >
                          {item.level}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={
                            item.expectation === 'unexpected'
                              ? 'border-orange-200 bg-orange-50 text-orange-700'
                              : item.expectation === 'expected'
                                ? 'border-green-200 bg-green-50 text-green-700'
                                : 'border-slate-200 bg-slate-50 text-slate-600'
                          }
                        >
                          {item.expectation === 'unexpected'
                            ? '预期外'
                            : item.expectation === 'expected'
                              ? '预期内'
                              : '未分类'}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={getProcessingBadgeClass(
                            item.processingStatus,
                          )}
                        >
                          处理：{item.processingStatus || '未设置'}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={getRecoveryBadgeClass(item.recoveryStatus)}
                        >
                          恢复：{item.recoveryStatus || '未设置'}
                        </Badge>
                        <span className="text-xs text-slate-500">
                          {formatDateTime(item.occurredAt)}
                        </span>
                      </div>
                      <h3 className="mt-2 text-sm font-semibold leading-6 text-slate-950 sm:text-base">
                        {item.description || '未填写告警描述'}
                      </h3>
                      {item.handlingDescription ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                          {item.handlingDescription}
                        </p>
                      ) : null}
                    </div>

                    <dl className="grid min-w-[250px] gap-2 text-xs text-slate-500 sm:grid-cols-2 lg:w-[380px]">
                      <div className="flex min-w-0 items-start gap-2">
                        <MapPin
                          className="mt-0.5 size-4 shrink-0 text-cyan-600"
                          aria-hidden="true"
                        />
                        <dt className="sr-only">位置</dt>
                        <dd className="leading-5">
                          {[item.building, item.location]
                            .filter(Boolean)
                            .join(' · ') || '位置待补充'}
                        </dd>
                      </div>
                      <div className="flex min-w-0 items-start gap-2">
                        <UserRound
                          className="mt-0.5 size-4 shrink-0 text-slate-400"
                          aria-hidden="true"
                        />
                        <dt className="sr-only">负责人</dt>
                        <dd className="leading-5">
                          {item.owner || '负责人待补充'}
                        </dd>
                      </div>
                      <div className="text-slate-500 sm:col-span-2">
                        {item.alarmCategory
                          ? `类别：${item.alarmCategory}`
                          : '类别待补充'}
                        {item.acceptedAt
                          ? ` · 受理：${formatDateTime(item.acceptedAt)}`
                          : ''}
                      </div>
                    </dl>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <span
                className="inline-flex size-12 items-center justify-center rounded-full bg-blue-50 text-blue-500"
                aria-hidden="true"
              >
                <BellRing className="size-5" />
              </span>
              <strong className="mt-4 text-sm text-slate-900">
                当前口径暂无告警
              </strong>
              <p className="mt-1 text-xs text-slate-500">
                数据同步后，符合该统计口径的记录将在此显示。
              </p>
            </div>
          )}
        </div>

        {!loading && !error && pageData && pageData.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-5 py-3">
            <span className="text-xs text-slate-500">
              第 {pageData.page} / {totalPages} 页 · 共 {pageData.total} 条
            </span>
            <nav className="flex items-center gap-1" aria-label="告警清单分页">
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="上一页"
                disabled={page <= 1}
                onClick={() =>
                  updatePage((current) => Math.max(1, current - 1))
                }
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              {pageNumbers.map((pageNumber) => (
                <Button
                  type="button"
                  key={pageNumber}
                  variant={pageNumber === page ? 'default' : 'ghost'}
                  size="icon-xs"
                  aria-label={`第 ${pageNumber} 页`}
                  aria-current={pageNumber === page ? 'page' : undefined}
                  onClick={() => updatePage(() => pageNumber)}
                >
                  {pageNumber}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="下一页"
                disabled={page >= totalPages}
                onClick={() =>
                  updatePage((current) => Math.min(totalPages, current + 1))
                }
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
