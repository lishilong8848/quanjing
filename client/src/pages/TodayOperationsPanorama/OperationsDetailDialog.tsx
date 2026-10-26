import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Clock3,
  MapPin,
  Star,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type {
  TodayOperationsWorkItem,
  TodayOperationsWorkKind,
} from '@shared/today-operations-overview.interface';
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
import { getWorkStatusLabel, sanitizeWorkFacet } from './overview-model';

export type OperationsDetailKind = TodayOperationsWorkKind;

interface OperationsDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: OperationsDetailKind;
  items: TodayOperationsWorkItem[];
  restoreFocusTo?: HTMLElement | null;
}

const KIND_META: Record<
  OperationsDetailKind,
  { title: string; emptyTitle: string; emptyDescription: string }
> = {
  events: {
    title: '今日事件清单',
    emptyTitle: '今日暂无事件',
    emptyDescription: '当日事件记录同步后将在此显示。',
  },
  changes: {
    title: '今日变更清单',
    emptyTitle: '今日暂无变更',
    emptyDescription: '当日变更记录同步后将在此显示。',
  },
  inspections: {
    title: '今日检修清单',
    emptyTitle: '今日暂无检修',
    emptyDescription: '当日检修记录同步后将在此显示。',
  },
  maintenance: {
    title: '今日维保清单',
    emptyTitle: '今日暂无维保',
    emptyDescription: '当日维保记录同步后将在此显示。',
  },
};

const shanghaiDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatDateTime(value: string | null): string {
  if (!value) return '待补充';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return shanghaiDateTimeFormatter.format(timestamp).replace(/\//g, '-');
}

function getDisplayTime(item: TodayOperationsWorkItem): string {
  if (item.startTime && item.endTime) {
    return `${formatDateTime(item.startTime)} 至 ${formatDateTime(item.endTime)}`;
  }
  return formatDateTime(item.startTime ?? item.endTime);
}

function getLevelText(item: TodayOperationsWorkItem): string | null {
  if (item.level && item.riskLevel) {
    return `${item.level} · ${item.riskLevel}`;
  }
  return item.level ?? item.riskLevel;
}

function formatDurationDays(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '待补充';
  return `${Number.isInteger(value) ? value : value.toFixed(1)} 天`;
}

const VISIBLE_STATUS_LABELS = new Set([
  '已恢复',
  '已解决',
  '已完成',
  '已结束',
  '正常结束',
  '进行中',
  '处理中',
  '待处理',
  '未恢复',
  '未解决',
  '开始',
]);

type WorkStatusTone = 'success' | 'warning' | 'danger' | 'info';

function getVisibleStatus(item: TodayOperationsWorkItem): string | null {
  const summary = sanitizeWorkFacet(item.summary);
  if (summary && VISIBLE_STATUS_LABELS.has(summary)) return summary;

  const normalized = getWorkStatusLabel(item.status);
  if (normalized) return normalized;

  const rawStatus = sanitizeWorkFacet(item.status);
  return rawStatus && VISIBLE_STATUS_LABELS.has(rawStatus) ? rawStatus : null;
}

function getStatusTone(label: string): WorkStatusTone {
  if (/已恢复|已解决|已完成|已结束|正常结束/u.test(label)) {
    return 'success';
  }
  if (/未恢复|未解决|待处理/u.test(label)) return 'danger';
  if (/进行中|处理中|开始/u.test(label)) return 'warning';
  return 'info';
}

interface WorkMetaItem {
  label: string;
  value: string;
  icon: LucideIcon;
  dateTime?: string | null;
}

function buildMetaItems(
  kind: OperationsDetailKind,
  item: TodayOperationsWorkItem,
  building: string | null,
  specialty: string | null,
): WorkMetaItem[] {
  if (kind === 'inspections') {
    return [
      {
        label: '维修方式',
        value: item.method || '待补充',
        icon: Wrench,
      },
      {
        label: '检修天数',
        value: formatDurationDays(item.durationDays),
        icon: Clock3,
      },
      {
        label: '实际开始时间',
        value: formatDateTime(item.startTime),
        icon: CalendarClock,
        dateTime: item.startTime,
      },
      {
        label: '预期结束时间',
        value: formatDateTime(item.endTime),
        icon: CalendarClock,
        dateTime: item.endTime,
      },
    ];
  }

  if (kind === 'maintenance') {
    return [
      {
        label: '维保楼栋',
        value: building || '待补充',
        icon: Building2,
      },
      ...(specialty
        ? [{ label: '专业', value: specialty, icon: Wrench }]
        : []),
    ];
  }

  const locationText = [building, specialty].filter(Boolean).join(' · ');
  return [
    {
      label: '时间',
      value: getDisplayTime(item),
      icon: CalendarClock,
      dateTime: item.startTime ?? item.endTime,
    },
    {
      label: '楼栋和专业',
      value: locationText || '位置待补充',
      icon: MapPin,
    },
    ...(item.owner
      ? [{ label: '负责人', value: item.owner, icon: UserRound }]
      : []),
  ];
}

export function OperationsDetailDialog({
  open,
  onOpenChange,
  kind,
  items,
  restoreFocusTo,
}: OperationsDetailDialogProps) {
  const meta = KIND_META[kind];
  const scrollRef = useRef<HTMLDivElement>(null);
  const orderedItems = useMemo(
    () =>
      items
        .map((item, index) => ({ item, index }))
        .sort(
          (left, right) =>
            Number(right.item.isKey) - Number(left.item.isKey) ||
            left.index - right.index,
        )
        .map(({ item }) => item),
    [items],
  );
  const keyCount = orderedItems.filter((item) => item.isKey).length;

  useLayoutEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
  }, [kind, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="today-panorama-detail-dialog today-operations-dialog flex max-h-[min(82dvh,720px)] w-[min(1040px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-slate-200 p-0"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusTo?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="today-panorama-operations-dialog-head flex-row items-start gap-3 border-b border-slate-200 px-5 py-4 text-left sm:px-6">
          <span
            className="today-panorama-operations-dialog-icon"
            aria-hidden="true"
          >
            <CalendarClock />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg leading-6 text-slate-950">
              {meta.title}
            </DialogTitle>
            <DialogDescription className="today-panorama-operations-dialog-summary mt-1 text-sm text-slate-500">
              <span>共 {orderedItems.length} 条</span>
              {keyCount > 0 ? (
                <strong>重点 {keyCount} 条</strong>
              ) : null}
              <span>{keyCount > 0 ? '重点记录已优先展示' : '按当日记录展示'}</span>
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="today-panorama-dialog-close shrink-0 text-slate-500"
              aria-label={`关闭${meta.title}`}
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="today-panorama-operations-scroll min-h-0 flex-1 overflow-y-auto"
          tabIndex={0}
          aria-label={`${meta.title}滚动区域`}
        >
          {orderedItems.length > 0 ? (
            <ol
              className="today-panorama-work-list"
              aria-label={`${meta.title}，共${orderedItems.length}条`}
            >
              {orderedItems.map((item) => {
                const levelText = getLevelText(item);
                const title = sanitizeWorkFacet(item.title) || item.title;
                const building = sanitizeWorkFacet(item.building);
                const specialty = sanitizeWorkFacet(item.specialty);
                const statusLabel = getVisibleStatus(item);
                const summary = sanitizeWorkFacet(item.summary);
                const showSummary =
                  Boolean(summary) && summary !== statusLabel;
                const metaItems = buildMetaItems(
                  kind,
                  item,
                  building,
                  specialty,
                );

                return (
                  <li
                    key={item.id}
                    className={`today-panorama-detail-row today-operations-dialog-row${item.isKey ? ' is-key' : ''}`}
                  >
                    <div className="today-panorama-work-main">
                      <div className="today-panorama-work-identity">
                        {item.isKey ? (
                          <Badge
                            className="today-operations-key-badge"
                            variant="outline"
                          >
                            <Star className="fill-current" aria-hidden="true" />
                            重点
                          </Badge>
                        ) : null}
                        {item.code ? (
                          <span className="today-panorama-work-code">
                            {item.code}
                          </span>
                        ) : null}
                        {levelText ? (
                          <Badge
                            variant="outline"
                            className="today-panorama-work-level"
                          >
                            {levelText}
                          </Badge>
                        ) : null}
                      </div>
                      {kind === 'inspections' || kind === 'maintenance' ? (
                        <p className="today-panorama-work-eyebrow">
                          {kind === 'inspections'
                            ? '检修名称'
                            : '维保项目名称'}
                        </p>
                      ) : null}
                      <h3 className="today-panorama-work-title">
                        {title || item.code || '未命名记录'}
                      </h3>
                      {showSummary ? (
                        <p className="today-panorama-work-summary">{summary}</p>
                      ) : null}
                    </div>

                    <dl
                      className={`today-panorama-work-meta${metaItems.length > 2 ? ' is-grid' : ''}`}
                    >
                      {metaItems.map((metaItem, index) => {
                        const MetaIcon = metaItem.icon;
                        return (
                          <div key={`${metaItem.label}-${index}`}>
                            <MetaIcon aria-hidden="true" />
                            <span>
                              <dt>{metaItem.label}</dt>
                              <dd>
                                {metaItem.dateTime ? (
                                  <time dateTime={metaItem.dateTime}>
                                    {metaItem.value}
                                  </time>
                                ) : (
                                  metaItem.value
                                )}
                              </dd>
                            </span>
                          </div>
                        );
                      })}
                    </dl>

                    <div className="today-panorama-work-state">
                      {statusLabel ? (
                        <span
                          className="today-panorama-work-status"
                          data-tone={getStatusTone(statusLabel)}
                        >
                          {statusLabel}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="today-panorama-operations-empty">
              <span
                aria-hidden="true"
              >
                <AlertTriangle />
              </span>
              <strong>{meta.emptyTitle}</strong>
              <p>{meta.emptyDescription}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
