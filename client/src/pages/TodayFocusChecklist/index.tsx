import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import { getTodayFocusChecklist } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import type {
  TodayFocusChecklistResponse,
  TodayFocusListItem,
  TodayFocusSectionStatus,
} from '@shared/api.interface';

type SectionTone = 'rose' | 'amber' | 'blue' | 'slate';
const FOCUS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const TODAY_FOCUS_REFRESH_EVENT = 'today-focus-checklist-refresh';
const SUMMARY_TOOLTIP_LIMIT = 5;

interface SummaryTooltipLine {
  title: string;
  meta?: string;
}

interface FocusSectionProps {
  title: string;
  description: string;
  count: number;
  status: TodayFocusSectionStatus;
  tone: SectionTone;
  icon: React.ElementType;
  children: React.ReactNode;
  emptyText: string;
}

const toneClassMap: Record<SectionTone, {
  icon: string;
  badge: string;
  border: string;
  rail: string;
  number: string;
}> = {
  rose: {
    icon: 'bg-rose-50 text-rose-600 ring-rose-100',
    badge: 'border-rose-200 bg-rose-50 text-rose-700',
    border: 'border-rose-100',
    rail: 'bg-rose-500',
    number: 'text-rose-500',
  },
  amber: {
    icon: 'bg-amber-50 text-amber-600 ring-amber-100',
    badge: 'border-amber-200 bg-amber-50 text-amber-700',
    border: 'border-amber-100',
    rail: 'bg-amber-500',
    number: 'text-amber-600',
  },
  blue: {
    icon: 'bg-blue-50 text-blue-600 ring-blue-100',
    badge: 'border-blue-200 bg-blue-50 text-blue-700',
    border: 'border-blue-100',
    rail: 'bg-blue-500',
    number: 'text-blue-500',
  },
  slate: {
    icon: 'bg-slate-100 text-slate-600 ring-slate-200',
    badge: 'border-slate-200 bg-slate-50 text-slate-600',
    border: 'border-slate-200',
    rail: 'bg-slate-400',
    number: 'text-slate-400',
  },
};

function getDateParam(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('date');
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function formatDateLabel(dateKey?: string): string {
  if (!dateKey) return '';
  const date = new Date(`${dateKey}T00:00:00+08:00`);
  const weekday = date.toLocaleDateString('zh-CN', { weekday: 'short' });
  return `${dateKey} ${weekday}`;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00+08:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const dateOnly = date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  });
  if (date.getHours() === 0 && date.getMinutes() === 0) {
    return dateOnly;
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDateOnly(value?: string | null): string {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00+08:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  });
}

function formatChineseDateOnly(value?: string | null): string {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00+08:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}年${month}月${day}日`;
}

function formatPlannedEndDateLabel(value?: string | null): string {
  const dateLabel = formatChineseDateOnly(value);
  return dateLabel ? `计划结束日期：${dateLabel}` : '';
}

function formatDateRangeOnly(start?: string | null, end?: string | null): string {
  const startLabel = formatDateOnly(start);
  const endLabel = formatDateOnly(end);
  if (startLabel && startLabel === endLabel) return startLabel;
  if (startLabel && endLabel) return `${startLabel} - ${endLabel}`;
  return startLabel || endLabel;
}

function formatTimeRange(start?: string | null, end?: string | null): string {
  const startLabel = formatDateTime(start);
  const endLabel = formatDateTime(end);
  if (startLabel && startLabel === endLabel) return startLabel;
  if (startLabel && endLabel) return `${startLabel} - ${endLabel}`;
  return startLabel || endLabel || '时间待确认';
}

function joinMeta(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

function dedupeMetaValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value?.trim() || '')
    .filter((value) => value && !/^opt[a-zA-Z0-9]+$/.test(value))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function compactFocusTitle(value: string): string {
  const source = value
    .replace(/需要/g, '')
    .replace(/^\s*\d+[、.．]\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[；;。,.，]+$/g, '');
  const compact = source
    .replace(/^今日/, '')
    .replace(/^按计划对/, '')
    .replace(/^按计划/, '')
    .replace(/^对/, '')
    .replace(/EA118园区/g, '')
    .replace(/EA118机房/g, '')
    .replace(/园区/g, '')
    .replace(/机房/g, '')
    .replace(/变更[-—]*第[一二三四五六七八九十百\d]+阶段/g, '')
    .replace(/变更（第[一二三四五六七八九十百\d]+阶段）/g, '')
    .replace(/变更\(第[一二三四五六七八九十百\d]+阶段\)/g, '')
    .replace(/100%容量深度放电/g, '容量放电')
    .replace(/100%容量放电/g, '容量放电')
    .replace(/预作用系统喷头泄水及气密性测试/g, '预作用系统泄水/气密测试')
    .replace(/气密性测试/g, '气密测试')
    .replace(/进行/g, '')
    .replace(/变更$/g, '')
    .replace(/[；;。,.，]+$/g, '');

  return compact || value;
}

function truncateDisplayText(value: string, maxLength = 26): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function getFocusItemDisplayTitle(item: TodayFocusListItem): string {
  return truncateDisplayText(compactFocusTitle(item.title), 28);
}

function getSealingDisplayTitle(item: TodayFocusChecklistResponse['sealings'][number]): string {
  return truncateDisplayText(compactFocusTitle(item.name), 28);
}

function buildSealingTooltipLines(
  items: TodayFocusChecklistResponse['sealings'],
): SummaryTooltipLine[] {
  return items.map((item) => ({
    title: item.name || '未命名封网',
    meta: joinMeta([
      item.type || undefined,
      item.code || item.autoNumber || undefined,
      formatTimeRange(item.startDate, item.endDate),
    ]),
  }));
}

function buildFocusTooltipLines(items: TodayFocusListItem[]): SummaryTooltipLine[] {
  return items.map((item) => ({
    title: item.title || '未命名事项',
    meta: joinMeta(dedupeMetaValues([
      item.level,
      item.riskLevel,
      ...item.tags.slice(0, 2),
      formatPlannedEndDateLabel(item.endTime),
    ])),
  }));
}

function SummaryTooltipContent({
  title,
  lines,
  emptyText,
}: {
  title: string;
  lines: SummaryTooltipLine[];
  emptyText: string;
}) {
  const visibleLines = lines.slice(0, SUMMARY_TOOLTIP_LIMIT);
  const extraCount = Math.max(0, lines.length - visibleLines.length);

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold leading-5 text-slate-900">{title}</div>
      {visibleLines.length > 0 ? (
        <div className="space-y-1.5">
          {visibleLines.map((line, index) => (
            <div key={`${line.title}-${index}`} className="flex min-w-0 gap-2">
              <span className="w-4 flex-shrink-0 text-right text-[11px] font-medium text-slate-400">
                {index + 1}.
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-normal leading-5 text-blue-500">{line.title}</div>
                {line.meta && (
                  <div className="truncate text-[11px] leading-4 text-slate-500">{line.meta}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md bg-slate-50 px-2.5 py-2 text-xs leading-5 text-slate-500">
          {emptyText}
        </div>
      )}
      {extraCount > 0 && (
        <div className="border-t border-slate-100 pt-1.5 text-[11px] leading-4 text-slate-400">
          其余 {extraCount} 项请查看下方卡片
        </div>
      )}
    </div>
  );
}

function FocusSection({
  title,
  description,
  count,
  status,
  tone,
  icon: Icon,
  children,
  emptyText,
}: FocusSectionProps) {
  const toneClass = toneClassMap[tone];
  const hasItems = count > 0;
  const badgeLabel = !status.configured
    ? '待接入'
    : hasItems
      ? `${count} 项`
      : '正常';

  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-lg border bg-card p-3 shadow-sm transition-transform duration-200 hover:-translate-y-0.5',
        toneClass.border,
      )}
    >
      <div className={cn('absolute left-0 top-0 h-full w-1', hasItems ? toneClass.rail : 'bg-slate-200')} />
      <div className="flex items-start justify-between gap-3 pl-1">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={cn('inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ring-1', toneClass.icon)}>
            <Icon className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-5 text-foreground">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        <Badge variant="outline" className={cn('h-6 flex-shrink-0 rounded-md px-2 text-xs font-semibold', toneClass.badge)}>
          {badgeLabel}
        </Badge>
      </div>

      <div className="mt-3 pl-1">
        {hasItems ? (
          <div className="space-y-1.5">{children}</div>
        ) : (
          <div className="flex min-h-20 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-3 py-4 text-center text-xs leading-5 text-slate-500">
            {status.message || emptyText}
          </div>
        )}
      </div>
    </section>
  );
}

function SealingItem({
  item,
  index,
}: {
  item: TodayFocusChecklistResponse['sealings'][number];
  index: number;
}) {
  const displayTitle = getSealingDisplayTitle(item);
  const timeLabel = formatTimeRange(item.startDate, item.endDate);
  const triggerClass = 'group grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 rounded-md px-1 py-1.5 text-inherit no-underline outline-none transition-colors hover:bg-slate-50 hover:no-underline focus-visible:ring-2 focus-visible:ring-blue-100';

  const rowContent = (
    <>
      <span className="pt-0.5 text-right text-[11px] font-medium leading-5 text-rose-500">
        {index + 1}.
      </span>
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-xs font-normal leading-5 text-blue-500 group-hover:underline">
            {displayTitle}
          </span>
          {item.recordUrl && <ExternalLink className="h-3 w-3 flex-shrink-0 text-blue-400 opacity-0 transition-opacity group-hover:opacity-100" />}
        </div>
        <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <Badge className="h-5 rounded-md bg-rose-600 px-1.5 text-[11px] text-white">封网</Badge>
          {item.type && (
            <span className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[11px] leading-4 text-rose-700">{item.type}</span>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] leading-4 text-slate-500">
            <Clock3 className="h-3 w-3 text-rose-500" />
            {timeLabel}
          </span>
        </div>
      </div>
    </>
  );

  return (
    <HoverCard openDelay={180} closeDelay={80}>
      <HoverCardTrigger asChild>
        {item.recordUrl ? (
          <a href={item.recordUrl} target="_blank" rel="noreferrer" className={triggerClass}>
            {rowContent}
          </a>
        ) : (
          <div tabIndex={0} className={triggerClass}>
            {rowContent}
          </div>
        )}
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8} className="w-80 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
        <div className="space-y-2">
          <div className="text-xs font-semibold leading-5 text-slate-900">封网详情</div>
          <p className="text-xs leading-5 text-slate-700">{item.name}</p>
          <div className="flex flex-wrap gap-1.5 text-[11px] leading-4 text-slate-500">
            {item.type && <span>{item.type}</span>}
            {item.code && <span>{item.code}</span>}
            {item.autoNumber && <span>编号 {item.autoNumber}</span>}
            <span>{timeLabel}</span>
          </div>
          {item.recordUrl && <div className="border-t border-slate-100 pt-1.5 text-[11px] text-blue-500">点击条目打开飞书记录</div>}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function GenericFocusItem({
  item,
  tone,
  index,
}: {
  item: TodayFocusListItem;
  tone: SectionTone;
  index: number;
}) {
  const toneClass = toneClassMap[tone];
  const primaryBadges = dedupeMetaValues([item.level, item.riskLevel]);
  const secondaryBadges = dedupeMetaValues(item.tags)
    .filter((tag) => !primaryBadges.includes(tag))
    .slice(0, 2);
  const dateLabel = formatPlannedEndDateLabel(item.endTime);
  const displayTitle = getFocusItemDisplayTitle(item);
  const triggerClass = 'group grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 rounded-md px-1 py-1.5 text-inherit no-underline outline-none transition-colors hover:bg-slate-50 hover:no-underline focus-visible:ring-2 focus-visible:ring-blue-100';

  const rowContent = (
    <>
      <span className={cn('pt-0.5 text-right text-[11px] font-medium leading-5', toneClass.number)}>
        {index + 1}.
      </span>
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-xs font-normal leading-5 text-blue-500 group-hover:underline">
            {displayTitle}
          </span>
          {item.recordUrl && <ExternalLink className="h-3 w-3 flex-shrink-0 text-blue-400 opacity-0 transition-opacity group-hover:opacity-100" />}
        </div>
        <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {primaryBadges.map((badge) => (
            <Badge key={badge} variant="outline" className={cn('h-5 rounded-md px-1.5 text-[11px]', toneClass.badge)}>
              {badge}
            </Badge>
          ))}
          {secondaryBadges.map((tag) => (
            <span key={tag} className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] leading-4 text-slate-500">
              {tag}
            </span>
          ))}
          {dateLabel && (
            <span className="inline-flex items-center gap-1 text-[11px] leading-4 text-slate-500">
              <CalendarClock className="h-3 w-3" />
              {dateLabel}
            </span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <HoverCard openDelay={180} closeDelay={80}>
      <HoverCardTrigger asChild>
        {item.recordUrl ? (
          <a href={item.recordUrl} target="_blank" rel="noreferrer" className={triggerClass}>
            {rowContent}
          </a>
        ) : (
          <div tabIndex={0} className={triggerClass}>
            {rowContent}
          </div>
        )}
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8} className="w-80 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
        <div className="space-y-2">
          <div className="text-xs font-semibold leading-5 text-slate-900">完整内容</div>
          <p className="text-xs leading-5 text-slate-700">{item.title}</p>
          {item.summary && item.summary.trim() !== item.title.trim() && (
            <p className="rounded-md bg-slate-50 px-2.5 py-2 text-[11px] leading-5 text-slate-500">
              {item.summary}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {primaryBadges.map((badge) => (
              <Badge key={badge} variant="outline" className={cn('h-5 rounded-md px-1.5 text-[11px]', toneClass.badge)}>
                {badge}
              </Badge>
            ))}
            {secondaryBadges.map((tag) => (
              <span key={tag} className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] leading-4 text-slate-500">
                {tag}
              </span>
            ))}
            {dateLabel && <span className="text-[11px] leading-5 text-slate-500">{dateLabel}</span>}
          </div>
          {item.recordUrl && <div className="border-t border-slate-100 pt-1.5 text-[11px] text-blue-500">点击条目打开飞书记录</div>}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export default function TodayFocusChecklistPage() {
  const [data, setData] = useState<TodayFocusChecklistResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateParam = useMemo(() => getDateParam(), []);

  const loadData = useCallback(async (silent = false, forceRefresh = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const result = await getTodayFocusChecklist(dateParam, forceRefresh);
      setData(result);
    } catch (err) {
      logger.error('加载今日园区重点关注清单失败', err);
      setError('清单加载失败，请稍后重试');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateParam]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadData(true, true);
    }, FOCUS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    const handleRefresh = () => {
      void loadData(true, true);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === TODAY_FOCUS_REFRESH_EVENT) {
        handleRefresh();
      }
    };

    window.addEventListener(TODAY_FOCUS_REFRESH_EVENT, handleRefresh);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(TODAY_FOCUS_REFRESH_EVENT, handleRefresh);
      window.removeEventListener('storage', handleStorage);
    };
  }, [loadData]);

  const totalFocusCount = data
    ? data.sealings.length + data.keyChanges.length + data.majorIncidents.length + data.others.length
    : 0;
  const configuredCount = data
    ? Object.values(data.sectionStatus).filter((status) => status.configured).length
    : 0;
  const sealingTooltipLines = data ? buildSealingTooltipLines(data.sealings) : [];
  const keyChangeTooltipLines = data ? buildFocusTooltipLines(data.keyChanges) : [];
  const majorIncidentTooltipLines = data ? buildFocusTooltipLines(data.majorIncidents) : [];
  const otherTooltipLines = data ? buildFocusTooltipLines(data.others) : [];

  if (loading) {
    return (
      <main className="min-h-full bg-background p-3">
        <div className="mx-auto flex min-h-[320px] w-full max-w-3xl items-center justify-center rounded-lg border bg-card shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载重点关注清单
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="today-focus-checklist min-h-full bg-background p-3 text-foreground">
      <div className="mx-auto w-full max-w-3xl space-y-3">
        <header className="rounded-lg border border-blue-100 bg-card p-3 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 ring-1 ring-blue-100">
                <ClipboardList className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-base font-semibold leading-6 text-slate-900">今日园区重点关注清单</h1>
                  <Badge className="rounded-md bg-blue-600 px-2 text-xs text-white">今日</Badge>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {formatDateLabel(data?.date)}
                </p>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 self-start border-blue-200 text-blue-700 hover:bg-blue-50"
              disabled={refreshing}
              onClick={() => void loadData(true, true)}
              aria-label="刷新清单"
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryTile
              label="封网"
              value={data?.sealings.length || 0}
              tone="rose"
              detailTitle="封网具体信息"
              detailLines={sealingTooltipLines}
              emptyText={data?.sectionStatus.sealings.message || '今日暂无封网安排'}
            />
            <SummaryTile
              label="变更"
              value={data?.keyChanges.length || 0}
              tone="amber"
              detailTitle="重点变更具体信息"
              detailLines={keyChangeTooltipLines}
              emptyText={data?.sectionStatus.keyChanges.message || '今日暂无重点变更'}
            />
            <SummaryTile
              label="事件"
              value={data?.majorIncidents.length || 0}
              tone="blue"
              detailTitle="重点关注事件具体信息"
              detailLines={majorIncidentTooltipLines}
              emptyText={data?.sectionStatus.majorIncidents.message || '当前无重点关注事件'}
            />
            <SummaryTile
              label="其他"
              value={data?.others.length || 0}
              tone="slate"
              detailTitle="其他关注具体信息"
              detailLines={otherTooltipLines}
              emptyText={data?.sectionStatus.others.message || '其他事项待补充'}
            />
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <FocusSection
            title="封网关注"
            description="今日生效或跨日延续的封网"
            count={data?.sealings.length || 0}
            status={data?.sectionStatus.sealings || { configured: false }}
            tone="rose"
            icon={ShieldAlert}
            emptyText="今日无封网安排"
          >
            {data?.sealings.map((item, index) => (
              <SealingItem key={item.id} item={item} index={index} />
            ))}
          </FocusSection>

          <FocusSection
            title="重点变更"
            description="I2 或中风险及以上变更"
            count={data?.keyChanges.length || 0}
            status={data?.sectionStatus.keyChanges || { configured: false }}
            tone="amber"
            icon={AlertTriangle}
            emptyText="今日暂无重点变更"
          >
            {data?.keyChanges.map((item, index) => (
              <GenericFocusItem key={item.id} item={item} tone="amber" index={index} />
            ))}
          </FocusSection>

          <FocusSection
            title="重点关注事件"
            description="最终状态检修中，等级 I2/I1/P"
            count={data?.majorIncidents.length || 0}
            status={data?.sectionStatus.majorIncidents || { configured: false }}
            tone="blue"
            icon={Activity}
            emptyText="当前无重点关注事件"
          >
            {data?.majorIncidents.map((item, index) => (
              <GenericFocusItem key={item.id} item={item} tone="blue" index={index} />
            ))}
          </FocusSection>

          <FocusSection
            title="其他关注"
            description=""
            count={data?.others.length || 0}
            status={data?.sectionStatus.others || { configured: false }}
            tone="slate"
            icon={Sparkles}
            emptyText="其他事项待补充"
          >
            {data?.others.map((item, index) => (
              <GenericFocusItem key={item.id} item={item} tone="slate" index={index} />
            ))}
          </FocusSection>
        </div>

        {totalFocusCount === 0 && configuredCount > 0 && (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            今日暂无需升级关注的园区事项
          </div>
        )}
      </div>
    </main>
  );
}

function SummaryTile({
  label,
  value,
  tone,
  detailTitle,
  detailLines,
  emptyText,
}: {
  label: string;
  value: number;
  tone: SectionTone;
  detailTitle: string;
  detailLines: SummaryTooltipLine[];
  emptyText: string;
}) {
  const toneClass = toneClassMap[tone];
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-label={`${label} ${value} 项，悬浮查看详情`}
          className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 outline-none transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white hover:shadow-sm focus-visible:border-blue-300 focus-visible:ring-2 focus-visible:ring-blue-100"
        >
          <div className="text-[11px] font-medium text-slate-500">{label}</div>
          <div className={cn('mt-1 text-xl font-semibold leading-6', toneClass.badge.includes('rose') ? 'text-rose-600' : toneClass.badge.includes('amber') ? 'text-amber-600' : 'text-blue-600')}>
            {value}
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        sideOffset={8}
        className="w-72 rounded-lg border border-slate-200 bg-white p-3 text-slate-700 shadow-lg"
      >
        <SummaryTooltipContent title={detailTitle} lines={detailLines} emptyText={emptyText} />
      </HoverCardContent>
    </HoverCard>
  );
}
