import type {
  TodayOperationsOverviewResponse,
  TodayOperationsRackSummary,
  TodayOperationsWorkItem,
  TodayOperationsWorkKind,
  TodayOperationsWorkSourceStates,
  TodayOperationsWorkSummary,
} from '@shared/today-operations-overview.interface';
import type { SealingInfo } from '@shared/api.interface';

import type { MaintenanceCard, PanoramaRackSummary } from './data';

export interface OperationsTickerItem {
  key: string;
  label: string;
  detail: string;
  tone: 'alert' | 'warning' | 'info' | 'success';
  isKey?: boolean;
}

export type NetworkFreezeSummary =
  | {
      status: 'loading' | 'error';
    }
  | {
      status: 'ready';
      todayCount: number;
      nextSevenDaysCount: number;
    };

export type NetworkFreezeDetailModel =
  | {
      status: 'error';
      businessDate: string;
      todayItems: readonly SealingInfo[];
      nextSevenDaysItems: readonly SealingInfo[];
    }
  | {
      status: 'ready';
      businessDate: string;
      todayItems: readonly SealingInfo[];
      nextSevenDaysItems: readonly SealingInfo[];
    };

export function sanitizeWorkFacet(
  value: string | null | undefined,
): string | null {
  const sanitized =
    value
      ?.trim()
      .replace(/[\s\-–—―/]+$/u, '')
      .trim() || '';
  return sanitized || null;
}

export function getWorkStatusLabel(
  value: string | null | undefined,
): '进行中' | '已结束' | null {
  const normalized = value?.replace(/\s+/g, '').trim();
  return normalized === '进行中' || normalized === '已结束' ? normalized : null;
}

export function formatShiftDelta(value: number | null): string {
  if (value === null) return '--';
  if (value > 0) return `▲ ${value}`;
  if (value < 0) return `▼ ${Math.abs(value)}`;
  return '—';
}

export function buildRackSummary(
  source: TodayOperationsRackSummary,
): PanoramaRackSummary {
  return {
    usageRate: source.usageRate,
    online: source.online,
    total: source.total,
    capacityDate: source.capacityDate ?? null,
    onlineThisPeriod: source.poweredOnThisWeek,
    onlineDelta: formatShiftDelta(source.poweredOnWeekDelta),
    offlineThisPeriod: source.poweredOffThisWeek,
    offlineDelta: formatShiftDelta(source.poweredOffWeekDelta),
    buildingLoads: source.buildingLoads.map((item) => ({
      building: item.building.replace('楼', '栋'),
      value: item.value,
    })),
    buildingUsages: (source.buildingUsages ?? []).map((item) => ({
      building: item.building.replace('楼', '栋'),
      online: item.online,
      total: item.total,
      usageRate: item.usageRate,
    })),
  };
}

export function reconcileOverviewChangeSnapshot(
  source: TodayOperationsOverviewResponse,
): TodayOperationsOverviewResponse {
  const detailChanges = source.details?.changes ?? [];
  const activeChanges = source.focusDetails?.activeChanges ?? [];
  const mergedChanges = [...detailChanges];
  const seenIds = new Set(detailChanges.map((item) => item.id));

  for (const item of activeChanges) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      mergedChanges.push(item);
    }
  }

  const activeChangeCount = Math.max(
    source.operations.activeChanges,
    activeChanges.length,
  );
  const todayChangeCount = Math.max(
    source.operations.todayChanges,
    activeChangeCount,
    mergedChanges.length,
  );
  const keyChangeCount = Math.max(
    source.operations.keyChanges,
    mergedChanges.filter((item) => item.isKey).length,
  );

  return {
    ...source,
    operations: {
      ...source.operations,
      todayChanges: todayChangeCount,
      activeChanges: activeChangeCount,
      keyChanges: keyChangeCount,
    },
    details: {
      ...source.details,
      changes: mergedChanges,
    },
  };
}

export function buildMaintenanceCards(
  source: TodayOperationsWorkSummary,
  templates: readonly MaintenanceCard[],
  sourceStates?: TodayOperationsWorkSourceStates,
  networkFreeze?: NetworkFreezeSummary,
): MaintenanceCard[] {
  return templates.map((template) => {
    if (template.key === 'network-freeze' && networkFreeze) {
      if (networkFreeze.status !== 'ready') {
        return {
          ...template,
          count: 0,
          rows: template.rows.map((row) => ({ ...row, value: '--' })),
          footer:
            networkFreeze.status === 'loading'
              ? '封网数据加载中'
              : '封网数据暂时不可用',
          featured: false,
          sourceUnavailable: true,
        };
      }

      const total = networkFreeze.todayCount + networkFreeze.nextSevenDaysCount;
      return {
        ...template,
        count: networkFreeze.todayCount,
        rows: [
          {
            label: '今日封网',
            value: `${networkFreeze.todayCount} 个`,
          },
          {
            label: '未来7天封网',
            value: `${networkFreeze.nextSevenDaysCount} 个`,
          },
        ],
        footer:
          total === 0
            ? '无封网计划'
            : `未来7天计划：${networkFreeze.nextSevenDaysCount} 个`,
        featured: total > 0,
        sourceUnavailable: false,
      };
    }

    const sourceKind = isWorkKind(template.key) ? template.key : null;
    const sourceState = sourceKind ? sourceStates?.[sourceKind] : undefined;
    if (sourceState?.status === 'failed') {
      return {
        ...template,
        count: 0,
        rows: template.rows.map((row) => ({ ...row, value: '--' })),
        footer: sourceState.errorMessage || `${template.title}数据暂时不可用`,
        featured: false,
        sourceUnavailable: true,
      };
    }

    if (template.key === 'events') {
      return {
        ...template,
        count: source.todayEvents,
        rows: [
          { label: '今日事件', value: `${source.todayEvents} 个` },
          {
            label: '重点事件',
            value: `${source.keyEvents} 个`,
          },
        ],
        featured: source.keyEvents > 0,
        sourceUnavailable: false,
        footer:
          source.pendingEvents > 0
            ? `重点关注：${source.pendingEvents} 个待处理`
            : `今日闭环：${source.closedTodayEvents} 个`,
      };
    }
    if (template.key === 'changes') {
      return {
        ...template,
        count: source.todayChanges,
        rows: [
          { label: '今日变更', value: `${source.todayChanges} 个` },
          {
            label: '重点变更',
            value: `${source.keyChanges} 个`,
          },
        ],
        featured: source.keyChanges > 0,
        sourceUnavailable: false,
        footer: `进行中：${source.activeChanges} 个`,
      };
    }
    if (template.key === 'inspections') {
      return {
        ...template,
        count: source.todayInspections,
        rows: [
          { label: '今日检修', value: `${source.todayInspections} 个` },
          {
            label: '进行中检修',
            value: `${source.activeInspections} 个`,
          },
        ],
        sourceUnavailable: false,
        footer: `进行中：${source.activeInspections} 个`,
      };
    }
    if (template.key === 'maintenance') {
      return {
        ...template,
        count: source.todayMaintenance,
        rows: [
          { label: '今日维保', value: `${source.todayMaintenance} 个` },
          {
            label: '进行中维保',
            value: `${source.activeMaintenance} 个`,
          },
        ],
        sourceUnavailable: false,
        footer:
          source.activeMaintenance > 0
            ? `进行中：${source.activeMaintenance} 个`
            : '全部完成',
      };
    }
    return template;
  });
}

export function buildNetworkFreezeSummary(
  sealings: readonly SealingInfo[],
  businessDate: string,
): NetworkFreezeSummary {
  const details = buildNetworkFreezeDetailModel(sealings, businessDate);
  if (details.status === 'error') {
    return { status: 'error' };
  }

  return {
    status: 'ready',
    todayCount: details.todayItems.length,
    nextSevenDaysCount: details.nextSevenDaysItems.length,
  };
}

export function buildNetworkFreezeDetailModel(
  sealings: readonly SealingInfo[],
  businessDate: string,
): NetworkFreezeDetailModel {
  const parsedBusinessDate = parseBusinessDate(businessDate);
  if (!parsedBusinessDate) {
    return {
      status: 'error',
      businessDate,
      todayItems: [],
      nextSevenDaysItems: [],
    };
  }

  const { year, monthIndex, day } = parsedBusinessDate;
  const dayStartMs = Date.UTC(year, monthIndex, day) - 8 * 60 * 60 * 1000;
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const nextSevenDaysEndMs = dayStartMs + 8 * 24 * 60 * 60 * 1000;
  const latestSealings = new Map<string, SealingInfo>();
  const todayItems: SealingInfo[] = [];
  const nextSevenDaysItems: SealingInfo[] = [];

  for (const sealing of sealings) {
    const id = getSealingIdentity(sealing);
    const current = latestSealings.get(id);
    if (
      !current ||
      getSealingFreshness(sealing) >= getSealingFreshness(current)
    ) {
      latestSealings.set(id, sealing);
    }
  }

  for (const sealing of latestSealings.values()) {
    const startMs = Date.parse(sealing.startDate);
    const endMs = Date.parse(sealing.endDate);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      continue;
    }

    if (startMs < dayEndMs && endMs > dayStartMs) {
      todayItems.push(sealing);
      continue;
    }
    if (startMs < nextSevenDaysEndMs && endMs > dayEndMs) {
      nextSevenDaysItems.push(sealing);
    }
  }

  const sortByStartTime = (left: SealingInfo, right: SealingInfo) =>
    Date.parse(left.startDate) - Date.parse(right.startDate) ||
    Date.parse(left.endDate) - Date.parse(right.endDate) ||
    getSealingIdentity(left).localeCompare(getSealingIdentity(right), 'zh-CN');
  todayItems.sort(sortByStartTime);
  nextSevenDaysItems.sort(sortByStartTime);

  return {
    status: 'ready',
    businessDate,
    todayItems,
    nextSevenDaysItems,
  };
}

export function getNetworkFreezeQueryYears(businessDate: string): number[] {
  const parsedBusinessDate = parseBusinessDate(businessDate);
  if (!parsedBusinessDate) {
    return [];
  }

  const { year, monthIndex, day } = parsedBusinessDate;
  const lastFutureDay = new Date(Date.UTC(year, monthIndex, day + 7));
  const lastFutureYear = lastFutureDay.getUTCFullYear();
  return lastFutureYear === year ? [year] : [year, lastFutureYear];
}

function parseBusinessDate(
  businessDate: string,
): { year: number; monthIndex: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const calendarProbe = new Date(Date.UTC(year, monthIndex, day));
  if (
    calendarProbe.getUTCFullYear() !== year ||
    calendarProbe.getUTCMonth() !== monthIndex ||
    calendarProbe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, monthIndex, day };
}

function isWorkKind(value: string): value is TodayOperationsWorkKind {
  return ['events', 'changes', 'inspections', 'maintenance'].includes(value);
}

export function buildOperationsTickerItems(
  source: TodayOperationsOverviewResponse,
  cards: readonly MaintenanceCard[] = [],
  networkFreezeDetails?: NetworkFreezeDetailModel,
): OperationsTickerItem[] {
  const focusItems: OperationsTickerItem[] = [];
  const seenIds = new Set<string>();
  const pendingEvents = source.focusDetails?.pendingEvents ?? [];
  const activeChanges = source.focusDetails?.activeChanges ?? [];
  const inspections = source.details?.inspections ?? [];
  const maintenance = source.details?.maintenance ?? [];
  const events = source.details?.events ?? [];
  const changes = source.details?.changes ?? [];
  appendTickerItems(
    focusItems,
    seenIds,
    pendingEvents.filter((item) => item.isKey),
    'events',
    'key-event',
    '重点事件',
    'alert',
  );
  appendTickerItems(
    focusItems,
    seenIds,
    activeChanges.filter((item) => item.isKey),
    'changes',
    'key-change',
    '重点变更',
    'warning',
  );
  appendTickerItems(
    focusItems,
    seenIds,
    pendingEvents.filter((item) => !item.isKey),
    'events',
    'pending-event',
    '未完成事件',
    'alert',
  );
  appendTickerItems(
    focusItems,
    seenIds,
    activeChanges.filter((item) => !item.isKey),
    'changes',
    'active-change',
    '进行中变更',
    'warning',
  );

  if (networkFreezeDetails?.status === 'ready') {
    appendNetworkFreezeTickerItems(
      focusItems,
      networkFreezeDetails.todayItems,
      'today',
      '今日封网',
    );
    appendNetworkFreezeTickerItems(
      focusItems,
      networkFreezeDetails.nextSevenDaysItems,
      'upcoming',
      '未来7天封网',
    );
  } else if (!networkFreezeDetails) {
    const networkFreezeToday = readRowValue(
      cards,
      'network-freeze',
      '今日封网',
    );
    const networkFreezeNextWeek = readRowValue(
      cards,
      'network-freeze',
      '未来7天封网',
    );
    if (networkFreezeToday + networkFreezeNextWeek > 0) {
      focusItems.push({
        key: 'network-freeze',
        label: `封网安排 · ${networkFreezeToday + networkFreezeNextWeek} 项`,
        detail: `今日 ${networkFreezeToday} 项，未来7天 ${networkFreezeNextWeek} 项`,
        tone: 'warning',
      });
    }
  }

  const constructionItems = readRowValue(cards, 'other-items', '今日施工');
  const otherItems = readRowValue(cards, 'other-items', '其他事宜');
  if (constructionItems + otherItems > 0) {
    focusItems.push({
      key: 'other-items',
      label: `其他事宜 · ${constructionItems + otherItems} 项`,
      detail: `今日施工 ${constructionItems} 项，其他事宜 ${otherItems} 项`,
      tone: 'info',
    });
  }

  if (focusItems.length > 0) {
    appendTickerItems(
      focusItems,
      seenIds,
      events.filter(isClosedEvent),
      'events',
      'closed-event',
      '已闭环事件',
      'success',
    );
    appendTickerItems(
      focusItems,
      seenIds,
      events.filter((item) => !isClosedEvent(item)),
      'events',
      'today-event',
      '今日事件',
      'info',
    );
    return focusItems;
  }

  const fallbackItems: OperationsTickerItem[] = [];
  appendTickerItems(
    fallbackItems,
    seenIds,
    inspections.filter(isActiveWorkItem),
    'inspections',
    'inspection',
    '今日检修',
    'info',
  );
  appendTickerItems(
    fallbackItems,
    seenIds,
    maintenance.filter(isActiveWorkItem),
    'maintenance',
    'maintenance',
    '今日维保',
    'info',
  );
  appendTickerItems(
    fallbackItems,
    seenIds,
    events.filter(isClosedEvent),
    'events',
    'closed-event',
    '已闭环事件',
    'success',
  );
  appendTickerItems(
    fallbackItems,
    seenIds,
    changes.filter(isCompletedChange),
    'changes',
    'closed-change',
    '已完成变更',
    'success',
  );

  if (
    fallbackItems.length === 0 &&
    source.sourceStatus &&
    source.sourceStatus !== 'fresh'
  ) {
    return [
      {
        key: 'source-unavailable',
        label: '运维数据尚未全部更新',
        detail: '部分数据暂不可用或仍在刷新，请查看对应卡片状态',
        tone: 'warning',
      },
    ];
  }

  return fallbackItems.length > 0
    ? fallbackItems
    : [
        {
          key: 'stable',
          label: '今日运行平稳',
          detail: '暂无需要重点播报的运维事项',
          tone: 'success',
        },
      ];
}

const sealingDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function getSealingIdentity(sealing: SealingInfo): string {
  return (
    sealing.bitableRecordId?.trim() ||
    sealing.id?.trim() ||
    `${sealing.startDate}\u0000${sealing.endDate}\u0000${sealing.sealingName.trim()}`
  );
}

function getSealingFreshness(sealing: SealingInfo): number {
  const updatedAt = Date.parse(sealing.updatedAt);
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }

  const createdAt = Date.parse(sealing.createdAt);
  return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
}

function formatSealingDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;

  const parts = Object.fromEntries(
    sealingDateTimeFormatter
      .formatToParts(timestamp)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function appendNetworkFreezeTickerItems(
  destination: OperationsTickerItem[],
  items: readonly SealingInfo[],
  keyPrefix: 'today' | 'upcoming',
  categoryLabel: '今日封网' | '未来7天封网',
): void {
  items.forEach((item) => {
    const identifier =
      item.sealingCode.trim() ||
      item.autoNumber?.trim() ||
      item.sealingName.trim() ||
      '未命名封网';
    const detail = [
      item.sealingName.trim() || '未命名封网',
      `${formatSealingDateTime(item.startDate)} 至 ${formatSealingDateTime(item.endDate)}`,
      item.sealingType?.trim() || '类型未维护',
    ]
      .filter(Boolean)
      .join(' · ');

    destination.push({
      key: `network-freeze-${keyPrefix}-${getSealingIdentity(item)}`,
      label: `${categoryLabel} · ${identifier}`,
      detail,
      tone: 'warning',
    });
  });
}

function appendTickerItems(
  destination: OperationsTickerItem[],
  seenIds: Set<string>,
  items: readonly TodayOperationsWorkItem[],
  dedupeDomain: TodayOperationsWorkKind,
  keyPrefix: string,
  categoryLabel: string,
  tone: OperationsTickerItem['tone'],
): void {
  items.forEach((item) => {
    const dedupeKey = `${dedupeDomain}:${item.id}`;
    if (seenIds.has(dedupeKey)) return;
    seenIds.add(dedupeKey);

    const title = sanitizeWorkFacet(item.title) || item.title;
    const identifier = item.code?.trim() || title;
    const location = [
      sanitizeWorkFacet(item.building),
      sanitizeWorkFacet(item.specialty),
    ]
      .filter(Boolean)
      .join(' / ');
    const summary =
      item.summary?.trim() && item.summary.trim() !== item.title
        ? item.summary.trim()
        : null;
    const detail = [title, summary, getWorkStatusLabel(item.status), location]
      .filter(Boolean)
      .join(' · ');

    destination.push({
      key: `${keyPrefix}-${item.id}`,
      label: `${categoryLabel} · ${identifier}`,
      detail: detail || item.summary || '详情待补充',
      tone,
      ...(item.isKey ? { isKey: true } : {}),
    });
  });
}

function normalizeStatus(item: TodayOperationsWorkItem): string {
  return item.status?.replace(/\s+/g, '').trim() || '';
}

function isActiveWorkItem(item: TodayOperationsWorkItem): boolean {
  const status = normalizeStatus(item);
  if (!status || /取消|作废|未开始|待开始|已完成|已结束|已关闭/.test(status)) {
    return false;
  }
  return (
    status === '开始' ||
    status === '更新' ||
    /今日进行中|进行中|执行中|处理中|检修中|维保中|作业中/.test(status)
  );
}

function isClosedEvent(item: TodayOperationsWorkItem): boolean {
  const status = normalizeStatus(item);
  if (!status || /未闭环|待闭环/.test(status)) return false;
  return (
    status.includes('闭环') || /^(已)?(恢复|完成|关闭|解决|结束)$/.test(status)
  );
}

function isCompletedChange(item: TodayOperationsWorkItem): boolean {
  const status = normalizeStatus(item);
  if (!status || /未完成|待完成|进行中|执行中/.test(status)) return false;
  return /已完成|变更完成|完成$|已关闭|已结束/.test(status);
}

function readRowValue(
  cards: readonly MaintenanceCard[],
  cardKey: string,
  rowLabel: string,
): number {
  const value = cards
    .find((item) => item.key === cardKey)
    ?.rows.find((row) => row.label === rowLabel)?.value;
  const match = value?.match(/\d+/);
  return match ? Number(match[0]) : 0;
}
