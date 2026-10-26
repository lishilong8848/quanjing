import type {
  TodayOperationsOverviewResponse,
  TodayOperationsRackSummary,
  TodayOperationsWorkItem,
  TodayOperationsWorkSourceStates,
  TodayOperationsWorkSummary,
} from '../../shared/today-operations-overview.interface';
import type { SealingInfo } from '../../shared/api.interface';
import { PANORAMA_MAINTENANCE_CARDS } from '../../client/src/pages/TodayOperationsPanorama/data';
import {
  buildMaintenanceCards,
  buildNetworkFreezeDetailModel,
  buildNetworkFreezeSummary,
  buildOperationsTickerItems,
  buildRackSummary,
  formatShiftDelta,
  getNetworkFreezeQueryYears,
  getWorkStatusLabel,
  reconcileOverviewChangeSnapshot,
  sanitizeWorkFacet,
} from '../../client/src/pages/TodayOperationsPanorama/overview-model';

const rackSummary = {
  usageRate: 74.4,
  online: 3959,
  total: 5322,
  poweredOnThisWeek: 5,
  poweredOffThisWeek: 2,
  poweredOnWeekDelta: 3,
  poweredOffWeekDelta: -1,
  weekStartDate: '2026-07-20',
  capacityDate: '2026-07-19',
  loadDate: '2026-07-20',
  buildingLoads: [
    { building: 'A楼', value: 71.1 },
    { building: 'B楼', value: 73.5 },
    { building: 'C楼', value: 74.8 },
    { building: 'D楼', value: 31 },
    { building: 'E楼', value: 13.5 },
  ],
  buildingUsages: [
    { building: 'A楼', online: 800, total: 1000, usageRate: 80 },
    { building: 'B楼', online: 675, total: 900, usageRate: 74.9 },
    { building: 'C楼', online: 834, total: 1100, usageRate: 75.8 },
    { building: 'D楼', online: 401, total: 800, usageRate: 50.1 },
    { building: 'E楼', online: 990, total: 1200, usageRate: 82.5 },
  ],
} as unknown as TodayOperationsRackSummary;

const workSummary = {
  todayEvents: 2,
  pendingEvents: 0,
  priorPendingEvents: 0,
  closedTodayEvents: 2,
  keyEvents: 1,
  todayChanges: 4,
  activeChanges: 4,
  priorActiveChanges: 0,
  keyChanges: 2,
  todayInspections: 2,
  activeInspections: 2,
  todayMaintenance: 22,
  activeMaintenance: 22,
} as unknown as TodayOperationsWorkSummary;

function workItem(
  overrides: Partial<TodayOperationsWorkItem> &
    Pick<TodayOperationsWorkItem, 'id' | 'title'>,
): TodayOperationsWorkItem {
  return {
    id: overrides.id,
    code: null,
    title: overrides.title,
    summary: null,
    level: null,
    riskLevel: null,
    status: null,
    owner: null,
    startTime: null,
    endTime: null,
    building: null,
    specialty: null,
    isKey: false,
    ...overrides,
  } as TodayOperationsWorkItem;
}

function sealingInfo(
  id: string,
  startDate: string,
  endDate: string,
  overrides: Partial<SealingInfo> = {},
): SealingInfo {
  return {
    id,
    bitableRecordId: id,
    sealingCode: '',
    sealingName: id,
    startDate,
    endDate,
    sealingType: null,
    autoNumber: null,
    isToday: false,
    createdAt: startDate,
    updatedAt: startDate,
    ...overrides,
  };
}

describe('today operations overview client model', () => {
  it('maps the live rack response and formats every shift delta state', () => {
    expect(buildRackSummary(rackSummary)).toEqual({
      usageRate: 74.4,
      online: 3959,
      total: 5322,
      capacityDate: '2026-07-19',
      onlineThisPeriod: 5,
      onlineDelta: '▲ 3',
      offlineThisPeriod: 2,
      offlineDelta: '▼ 1',
      buildingLoads: [
        { building: 'A栋', value: 71.1 },
        { building: 'B栋', value: 73.5 },
        { building: 'C栋', value: 74.8 },
        { building: 'D栋', value: 31 },
        { building: 'E栋', value: 13.5 },
      ],
      buildingUsages: [
        { building: 'A栋', online: 800, total: 1000, usageRate: 80 },
        { building: 'B栋', online: 675, total: 900, usageRate: 74.9 },
        { building: 'C栋', online: 834, total: 1100, usageRate: 75.8 },
        { building: 'D栋', online: 401, total: 800, usageRate: 50.1 },
        { building: 'E栋', online: 990, total: 1200, usageRate: 82.5 },
      ],
    });
    expect(formatShiftDelta(3)).toBe('▲ 3');
    expect(formatShiftDelta(-3)).toBe('▼ 3');
    expect(formatShiftDelta(0)).toBe('—');
    expect(formatShiftDelta(null)).toBe('--');
    expect(sanitizeWorkFacet('D楼---')).toBe('D楼');
    expect(sanitizeWorkFacet('消防—')).toBe('消防');
    expect(sanitizeWorkFacet('---')).toBeNull();
    expect(getWorkStatusLabel('进行中')).toBe('进行中');
    expect(getWorkStatusLabel('已结束')).toBe('已结束');
    expect(getWorkStatusLabel('待处理')).toBeNull();
  });

  it('keeps a legacy rack payload without capacity details renderable', () => {
    const legacyRackSummary = {
      ...rackSummary,
      capacityDate: undefined,
      buildingUsages: undefined,
    } as unknown as TodayOperationsRackSummary;

    expect(buildRackSummary(legacyRackSummary)).toMatchObject({
      usageRate: 74.4,
      online: 3959,
      total: 5322,
      capacityDate: null,
      onlineThisPeriod: 5,
      offlineThisPeriod: 2,
      buildingUsages: [],
    });
  });

  it('replaces all four mapped operation cards while retaining unmapped cards', () => {
    const cards = buildMaintenanceCards(
      workSummary,
      PANORAMA_MAINTENANCE_CARDS,
    );

    expect(cards.find((item) => item.key === 'events')).toMatchObject({
      count: 2,
      rows: [
        { label: '今日事件', value: '2 个' },
        { label: '重点事件', value: '1 个' },
      ],
      footer: '今日闭环：2 个',
      featured: true,
    });
    expect(cards.find((item) => item.key === 'changes')).toMatchObject({
      count: 4,
      rows: [
        { label: '今日变更', value: '4 个' },
        { label: '重点变更', value: '2 个' },
      ],
      footer: '进行中：4 个',
      featured: true,
    });
    expect(cards.find((item) => item.key === 'inspections')).toMatchObject({
      count: 2,
      footer: '进行中：2 个',
    });
    expect(cards.find((item) => item.key === 'maintenance')).toMatchObject({
      count: 22,
      footer: '进行中：22 个',
    });
    expect(cards.find((item) => item.key === 'network-freeze')).toEqual(
      PANORAMA_MAINTENANCE_CARDS.find((item) => item.key === 'network-freeze'),
    );
    expect(cards.find((item) => item.key === 'other-items')).toEqual(
      PANORAMA_MAINTENANCE_CARDS.find((item) => item.key === 'other-items'),
    );
  });

  it('maps live sealing ranges into today and the following seven days without double counting', () => {
    const sealing = (
      id: string,
      startDate: string,
      endDate: string,
    ): SealingInfo =>
      ({
        id,
        bitableRecordId: id,
        sealingCode: id,
        sealingName: id,
        startDate,
        endDate,
        sealingType: null,
        autoNumber: null,
        isToday: false,
        createdAt: startDate,
        updatedAt: startDate,
      }) as SealingInfo;
    const summary = buildNetworkFreezeSummary(
      [
        sealing(
          'active-today-and-tomorrow',
          '2026-07-28T16:00:00.000Z',
          '2026-07-30T16:00:00.000Z',
        ),
        sealing(
          'active-today-and-tomorrow',
          '2026-07-28T16:00:00.000Z',
          '2026-07-30T16:00:00.000Z',
        ),
        sealing(
          'future-one',
          '2026-07-30T00:00:00.000Z',
          '2026-07-31T00:00:00.000Z',
        ),
        sealing(
          'future-two',
          '2026-08-04T00:00:00.000Z',
          '2026-08-05T00:00:00.000Z',
        ),
        sealing(
          'outside-window',
          '2026-08-06T00:00:00.000Z',
          '2026-08-07T00:00:00.000Z',
        ),
      ],
      '2026-07-29',
    );

    expect(summary).toEqual({
      status: 'ready',
      todayCount: 1,
      nextSevenDaysCount: 2,
    });

    const cards = buildMaintenanceCards(
      workSummary,
      PANORAMA_MAINTENANCE_CARDS,
      undefined,
      summary,
    );
    expect(cards.find((item) => item.key === 'network-freeze')).toMatchObject({
      count: 1,
      rows: [
        { label: '今日封网', value: '1 个' },
        { label: '未来7天封网', value: '2 个' },
      ],
      footer: '未来7天计划：2 个',
      featured: true,
      sourceUnavailable: false,
    });
  });

  it('builds one sorted sealing detail model for cards, dialogs, and ticker items', () => {
    const duplicateToday = sealingInfo(
      'today-late',
      '2026-07-30T02:00:00.000Z',
      '2026-07-30T10:00:00.000Z',
      { sealingName: '核心系统强管控', sealingCode: 'FW-002' },
    );
    const details = buildNetworkFreezeDetailModel(
      [
        sealingInfo(
          'future-late',
          '2026-08-03T01:00:00.000Z',
          '2026-08-03T03:00:00.000Z',
        ),
        duplicateToday,
        sealingInfo(
          'today-early',
          '2026-07-29T16:00:00.000Z',
          '2026-07-30T01:00:00.000Z',
        ),
        duplicateToday,
        sealingInfo(
          'future-early',
          '2026-07-31T01:00:00.000Z',
          '2026-07-31T03:00:00.000Z',
        ),
        sealingInfo(
          'invalid',
          '2026-07-31T03:00:00.000Z',
          '2026-07-31T03:00:00.000Z',
        ),
        sealingInfo(
          'outside',
          '2026-08-07T01:00:00.000Z',
          '2026-08-07T03:00:00.000Z',
        ),
      ],
      '2026-07-30',
    );

    expect(details.status).toBe('ready');
    expect(details.todayItems.map((item) => item.id)).toEqual([
      'today-early',
      'today-late',
    ]);
    expect(details.nextSevenDaysItems.map((item) => item.id)).toEqual([
      'future-early',
      'future-late',
    ]);
    expect(buildNetworkFreezeDetailModel([], 'not-a-date')).toMatchObject({
      status: 'error',
      todayItems: [],
      nextSevenDaysItems: [],
    });
  });

  it('broadcasts every concrete sealing with today items before upcoming items', () => {
    const response = {
      operations: workSummary,
      details: {
        events: [],
        changes: [],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [],
        activeChanges: [],
      },
    } as unknown as TodayOperationsOverviewResponse;
    const details = buildNetworkFreezeDetailModel(
      [
        sealingInfo(
          'future',
          '2026-07-31T01:00:00.000Z',
          '2026-07-31T03:00:00.000Z',
          {
            sealingName: '办公网弱管控',
            autoNumber: '08',
            sealingType: '弱管控',
          },
        ),
        sealingInfo(
          'today',
          '2026-07-30T00:00:00.000Z',
          '2026-07-30T10:00:00.000Z',
          {
            sealingName: '核心系统强管控',
            sealingCode: 'FW-001',
            sealingType: '强管控',
          },
        ),
      ],
      '2026-07-30',
    );

    expect(buildOperationsTickerItems(response, [], details)).toEqual([
      {
        key: 'network-freeze-today-today',
        label: '今日封网 · FW-001',
        detail: '核心系统强管控 · 07-30 08:00 至 07-30 18:00 · 强管控',
        tone: 'warning',
      },
      {
        key: 'network-freeze-upcoming-future',
        label: '未来7天封网 · 08',
        detail: '办公网弱管控 · 07-31 09:00 至 07-31 11:00 · 弱管控',
        tone: 'warning',
      },
    ]);
  });

  it('keeps missing sealing type explicit and never revives a stale count summary', () => {
    const response = {
      operations: workSummary,
      details: {
        events: [],
        changes: [],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [],
        activeChanges: [],
      },
    } as unknown as TodayOperationsOverviewResponse;
    const noTypeDetails = buildNetworkFreezeDetailModel(
      [
        sealingInfo(
          'no-type',
          '2026-07-30T00:00:00.000Z',
          '2026-07-30T02:00:00.000Z',
          { sealingName: '未分类封网' },
        ),
      ],
      '2026-07-30',
    );
    const staleCards = PANORAMA_MAINTENANCE_CARDS.map((card) =>
      card.key === 'network-freeze'
        ? {
            ...card,
            rows: [
              { label: '今日封网', value: '9 个' },
              { label: '未来7天封网', value: '8 个' },
            ],
          }
        : card,
    );
    const emptyDetails = buildNetworkFreezeDetailModel([], '2026-07-30');

    expect(buildOperationsTickerItems(response, [], noTypeDetails)).toEqual([
      {
        key: 'network-freeze-today-no-type',
        label: '今日封网 · 未分类封网',
        detail: '未分类封网 · 07-30 08:00 至 07-30 10:00 · 类型未维护',
        tone: 'warning',
      },
    ]);
    expect(
      buildOperationsTickerItems(response, staleCards, emptyDetails).some(
        (item) => item.key.startsWith('network-freeze'),
      ),
    ).toBe(false);
  });

  it('uses the stable Feishu record identity and keeps the latest sealing snapshot', () => {
    const details = buildNetworkFreezeDetailModel(
      [
        sealingInfo(
          'local-stale-id',
          '2026-08-10T00:00:00.000Z',
          '2026-08-10T02:00:00.000Z',
          {
            bitableRecordId: ' rec-shared ',
            sealingCode: 'FW-OLD',
            updatedAt: '2026-07-29T00:00:00.000Z',
          },
        ),
        sealingInfo(
          'local-current-id',
          '2026-07-30T00:00:00.000Z',
          '2026-07-30T02:00:00.000Z',
          {
            bitableRecordId: 'rec-shared',
            sealingCode: 'FW-CURRENT',
            updatedAt: '2026-07-30T00:00:00.000Z',
          },
        ),
      ],
      '2026-07-30',
    );
    const response = {
      operations: workSummary,
      details: {
        events: [],
        changes: [],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [],
        activeChanges: [],
      },
    } as unknown as TodayOperationsOverviewResponse;

    expect(details.todayItems.map((item) => item.id)).toEqual([
      'local-current-id',
    ]);
    expect(buildOperationsTickerItems(response, [], details)).toMatchObject([
      {
        key: 'network-freeze-today-rec-shared',
        label: '今日封网 · FW-CURRENT',
      },
    ]);
  });

  it('queries the next year only when the seven-day window crosses New Year', () => {
    expect(getNetworkFreezeQueryYears('2026-12-24')).toEqual([2026]);
    expect(getNetworkFreezeQueryYears('2026-12-25')).toEqual([2026, 2027]);
    expect(getNetworkFreezeQueryYears('2026-12-31')).toEqual([2026, 2027]);
    expect(getNetworkFreezeQueryYears('2026-02-30')).toEqual([]);
  });

  it('shows sealing data as unavailable instead of presenting a static zero', () => {
    const cards = buildMaintenanceCards(
      workSummary,
      PANORAMA_MAINTENANCE_CARDS,
      undefined,
      { status: 'loading' },
    );

    expect(cards.find((item) => item.key === 'network-freeze')).toMatchObject({
      rows: [
        { label: '今日封网', value: '--' },
        { label: '未来7天封网', value: '--' },
      ],
      footer: '封网数据加载中',
      sourceUnavailable: true,
    });
  });

  it('reconciles carried-over active changes into the today count and detail list', () => {
    const keyChange = workItem({
      id: 'change-key',
      code: 'BG-260720-258',
      title: 'A楼挖潜机房改造变更',
      status: '进行中',
      isKey: true,
    });
    const activeChange = workItem({
      id: 'change-active',
      code: 'BG-260720-256',
      title: 'D楼HVDC蓄电池更换变更',
      status: '进行中',
    });
    const staleResponse = {
      operations: {
        ...workSummary,
        todayChanges: 0,
        activeChanges: 2,
        priorActiveChanges: 2,
        keyChanges: 0,
      },
      details: {
        events: [],
        changes: [],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [],
        activeChanges: [keyChange, activeChange],
      },
    } as unknown as TodayOperationsOverviewResponse;

    const response = reconcileOverviewChangeSnapshot(staleResponse);
    const changeCard = buildMaintenanceCards(
      response.operations,
      PANORAMA_MAINTENANCE_CARDS,
    ).find((item) => item.key === 'changes');

    expect(response.operations).toMatchObject({
      todayChanges: 2,
      activeChanges: 2,
      keyChanges: 1,
    });
    expect(response.details.changes.map((item) => item.id)).toEqual([
      'change-key',
      'change-active',
    ]);
    expect(changeCard).toMatchObject({
      count: 2,
      rows: [
        { label: '今日变更', value: '2 个' },
        { label: '重点变更', value: '1 个' },
      ],
      footer: '进行中：2 个',
    });
    expect(buildOperationsTickerItems(response)).toHaveLength(2);
  });

  it('marks a failed operation source as unavailable instead of showing a false zero', () => {
    const sourceStates: TodayOperationsWorkSourceStates = {
      events: {
        status: 'failed',
        errorCode: '10014',
        errorMessage: '今日事件数据源暂时不可用',
      },
      changes: { status: 'fresh', errorCode: null, errorMessage: null },
      inspections: { status: 'fresh', errorCode: null, errorMessage: null },
      maintenance: { status: 'fresh', errorCode: null, errorMessage: null },
    };

    const cards = buildMaintenanceCards(
      { ...workSummary, todayEvents: 0, keyEvents: 0 },
      PANORAMA_MAINTENANCE_CARDS,
      sourceStates,
    );

    expect(cards.find((item) => item.key === 'events')).toMatchObject({
      sourceUnavailable: true,
      rows: [
        { label: '今日事件', value: '--' },
        { label: '重点事件', value: '--' },
      ],
      footer: '今日事件数据源暂时不可用',
    });
    expect(cards.find((item) => item.key === 'changes')).toMatchObject({
      sourceUnavailable: false,
      count: workSummary.todayChanges,
    });
  });

  it('rotates concrete focus records in priority order and de-duplicates by id', () => {
    const keyEvent = workItem({
      id: 'event-key',
      code: 'SJ260720-401',
      title: 'D楼柴发排烟管道卡箍断裂',
      summary: '当前已隔离，等待备件更换',
      status: '进行中',
      building: 'D楼---',
      specialty: '消防—',
      isKey: true,
    });
    const otherEvent = workItem({
      id: 'event-other',
      code: 'SJ260720-402',
      title: 'E楼空调压差告警',
      status: '进行中',
      building: 'E楼—',
      specialty: '暖通---',
    });
    const keyChange = workItem({
      id: 'change-key',
      code: 'BG260720-101',
      title: 'A楼配电系统重点变更---',
      status: '进行中',
      building: 'A楼---',
      specialty: '电气—',
      isKey: true,
    });
    const otherChange = workItem({
      id: 'change-other',
      code: 'BG260720-102',
      title: 'B楼监控策略调整',
      status: '持续跟踪',
      building: 'B楼---',
      specialty: '弱电—',
    });
    const response = {
      operations: workSummary,
      details: {
        events: [keyEvent, otherEvent],
        changes: [keyChange, otherChange],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [keyEvent, otherEvent, keyEvent],
        activeChanges: [keyChange, otherChange, keyChange],
      },
    } as unknown as TodayOperationsOverviewResponse;

    expect(buildOperationsTickerItems(response)).toEqual([
      {
        key: 'key-event-event-key',
        label: '重点事件 · SJ260720-401',
        detail:
          'D楼柴发排烟管道卡箍断裂 · 当前已隔离，等待备件更换 · 进行中 · D楼 / 消防',
        tone: 'alert',
        isKey: true,
      },
      {
        key: 'key-change-change-key',
        label: '重点变更 · BG260720-101',
        detail: 'A楼配电系统重点变更 · 进行中 · A楼 / 电气',
        tone: 'warning',
        isKey: true,
      },
      {
        key: 'pending-event-event-other',
        label: '未完成事件 · SJ260720-402',
        detail: 'E楼空调压差告警 · 进行中 · E楼 / 暖通',
        tone: 'alert',
      },
      {
        key: 'active-change-change-other',
        label: '进行中变更 · BG260720-102',
        detail: 'B楼监控策略调整 · B楼 / 弱电',
        tone: 'warning',
      },
    ]);
  });

  it('keeps closed and unseen today events alongside focus changes without duplicating pending events', () => {
    const sharedPendingEvent = workItem({
      id: 'event-shared',
      code: 'SJ260720-404',
      title: 'A楼告警持续处置',
      status: '处理中',
    });
    const closedEvent = workItem({
      id: 'event-closed-to-maintenance',
      code: 'SJ260720-405',
      title: 'B楼空调告警转检修',
      status: '事件闭环转检修中',
    });
    const detailsOnlyEvent = workItem({
      id: 'event-details-only',
      code: 'SJ260720-406',
      title: 'C楼温度告警今日跟进',
      status: '处理中',
    });
    const activeChange = workItem({
      id: 'change-active',
      code: 'BG260720-104',
      title: 'D楼监控策略调整',
      status: '进行中',
    });
    const response = {
      operations: workSummary,
      details: {
        events: [sharedPendingEvent, closedEvent, detailsOnlyEvent],
        changes: [activeChange],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [sharedPendingEvent],
        activeChanges: [activeChange],
      },
    } as unknown as TodayOperationsOverviewResponse;

    const tickerItems = buildOperationsTickerItems(response);

    expect(tickerItems.map((item) => item.key)).toEqual([
      'pending-event-event-shared',
      'active-change-change-active',
      'closed-event-event-closed-to-maintenance',
      'today-event-event-details-only',
    ]);
    expect(
      tickerItems.filter((item) => item.key.endsWith('-event-shared')),
    ).toHaveLength(1);
  });

  it('does not de-duplicate matching ids across different work domains', () => {
    const event = workItem({
      id: 'shared-record-id',
      code: 'SJ260730-001',
      title: 'A楼事件',
      status: '处理中',
    });
    const change = workItem({
      id: 'shared-record-id',
      code: 'BG260730-001',
      title: 'B楼变更',
      status: '进行中',
    });
    const response = {
      operations: workSummary,
      details: {
        events: [event],
        changes: [change],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [event],
        activeChanges: [change],
      },
    } as unknown as TodayOperationsOverviewResponse;

    expect(
      buildOperationsTickerItems(response).map((item) => item.key),
    ).toEqual([
      'pending-event-shared-record-id',
      'active-change-shared-record-id',
    ]);
  });

  it('uses concrete inspection, maintenance, and closed records only when focus work is quiet', () => {
    const response = {
      operations: {
        ...workSummary,
        keyEvents: 0,
        keyChanges: 0,
        pendingEvents: 0,
        activeChanges: 0,
      },
      details: {
        events: [
          workItem({
            id: 'event-closed',
            code: 'SJ260720-403',
            title: 'C楼水浸告警已恢复',
            status: '已结束',
            building: 'C楼',
          }),
          workItem({
            id: 'event-pending',
            title: '仍在处置的事件',
            status: '待处理',
          }),
          workItem({
            id: 'event-not-closed',
            title: '尚未闭环的事件',
            status: '未闭环',
          }),
        ],
        changes: [
          workItem({
            id: 'change-closed',
            code: 'BG260720-103',
            title: 'D楼监控变更已完成',
            status: '已结束',
            building: 'D楼',
          }),
          workItem({
            id: 'change-active',
            title: '仍在执行的变更',
            status: '执行中',
          }),
          workItem({
            id: 'change-incomplete',
            title: '尚未完成的变更',
            status: '未完成',
          }),
        ],
        inspections: [
          workItem({
            id: 'inspection-1',
            title: 'E楼冷机检修',
            status: '进行中',
            building: 'E楼',
            specialty: '暖通',
          }),
          workItem({
            id: 'inspection-cancelled',
            title: '已取消检修',
            status: '已取消',
          }),
          workItem({
            id: 'inspection-not-started',
            title: '未开始检修',
            status: '未开始',
          }),
        ],
        maintenance: [
          workItem({
            id: 'maintenance-1',
            title: 'A楼高压柜年度维保',
            status: '进行中',
            building: 'A楼',
            specialty: '电气',
          }),
          workItem({
            id: 'maintenance-cancelled',
            title: '已取消维保',
            status: '取消',
          }),
          workItem({
            id: 'maintenance-complete',
            title: '已完成维保',
            status: '已完成',
          }),
        ],
      },
      focusDetails: {
        pendingEvents: [],
        activeChanges: [],
      },
    } as unknown as TodayOperationsOverviewResponse;

    expect(
      buildOperationsTickerItems(response).map((item) => item.key),
    ).toEqual([
      'inspection-inspection-1',
      'maintenance-maintenance-1',
      'closed-event-event-closed',
      'closed-change-change-closed',
    ]);
  });

  it('keeps network-freeze and other matters in the ticker input', () => {
    const response = {
      operations: workSummary,
      details: {
        events: [],
        changes: [],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [],
        activeChanges: [],
      },
    } as unknown as TodayOperationsOverviewResponse;
    const cards = PANORAMA_MAINTENANCE_CARDS.map((card) => {
      if (card.key === 'network-freeze') {
        return {
          ...card,
          rows: [
            { label: '今日封网', value: '1 个' },
            { label: '未来7天封网', value: '2 个' },
          ],
        };
      }
      if (card.key === 'other-items') {
        return {
          ...card,
          rows: [
            { label: '今日施工', value: '1 项' },
            { label: '其他事宜', value: '1 项' },
          ],
        };
      }
      return card;
    });

    expect(buildOperationsTickerItems(response, cards)).toEqual([
      {
        key: 'network-freeze',
        label: '封网安排 · 3 项',
        detail: '今日 1 项，未来7天 2 项',
        tone: 'warning',
      },
      {
        key: 'other-items',
        label: '其他事宜 · 2 项',
        detail: '今日施工 1 项，其他事宜 1 项',
        tone: 'info',
      },
    ]);
  });

  it('keeps a legacy overview payload without focus details renderable', () => {
    const legacyResponse = {
      operations: workSummary,
      details: {
        events: [
          workItem({
            id: 'legacy-closed-event',
            title: '旧缓存中的已闭环事件',
            status: '已结束',
          }),
        ],
        changes: [],
        inspections: [],
        maintenance: [],
      },
    } as TodayOperationsOverviewResponse;

    expect(buildOperationsTickerItems(legacyResponse)).toMatchObject([
      {
        key: 'closed-event-legacy-closed-event',
        label: '已闭环事件 · 旧缓存中的已闭环事件',
      },
    ]);
  });

  it('keeps real zero values instead of falling back to the static fixtures', () => {
    const empty = {
      todayEvents: 0,
      pendingEvents: 0,
      priorPendingEvents: 0,
      closedTodayEvents: 0,
      keyEvents: 0,
      todayChanges: 0,
      activeChanges: 0,
      priorActiveChanges: 0,
      keyChanges: 0,
      todayInspections: 0,
      activeInspections: 0,
      todayMaintenance: 0,
      activeMaintenance: 0,
    } as unknown as TodayOperationsWorkSummary;
    const cards = buildMaintenanceCards(empty, PANORAMA_MAINTENANCE_CARDS);
    const response = {
      operations: empty,
      details: {
        events: [],
        changes: [],
        inspections: [],
        maintenance: [],
      },
      focusDetails: {
        pendingEvents: [],
        activeChanges: [],
      },
    } as unknown as TodayOperationsOverviewResponse;

    for (const sourceStatus of ['partial', 'stale'] as const) {
      const unavailableTicker = buildOperationsTickerItems({
        ...response,
        sourceStatus,
      });
      expect(
        unavailableTicker.some((item) => item.label === '今日运行平稳'),
      ).toBe(false);
      expect(unavailableTicker[0].tone).toBe('warning');
    }
    expect(cards.slice(0, 4).map((item) => item.count)).toEqual([0, 0, 0, 0]);
    expect(buildOperationsTickerItems(response)).toEqual([
      {
        key: 'stable',
        label: '今日运行平稳',
        detail: '暂无需要重点播报的运维事项',
        tone: 'success',
      },
    ]);
  });
});
