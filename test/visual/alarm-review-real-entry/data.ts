import type { TodayOperationsAlarmDashboardQuery, TodayOperationsAlarmDashboardResponse, TodayOperationsAlarmItem, TodayOperationsAlarmTagIssueCode } from '../../../shared/today-operations-alarm.interface';
import type { TodayOperationsOverviewResponse } from '../../../shared/today-operations-overview.interface';
import type { TodayOperationsKpiResponse } from '../../../shared/today-operations-kpi.interface';
import type { TodayAttendanceSnapshot } from '../../../shared/today-attendance.interface';

const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const at = `${date}T09:00:00+08:00`;
const issueCounts = () => ({ missing: 0, format: 0, pending: 0, vague: 0, nonOfficial: 0, semantic: 0 });
export const personnel = [
  { recordId: 'recSyntheticPersonA', name: '合成李明', openId: 'ou_synthetic_a', buildings: ['A'], position: '合成电气工程师' },
  { recordId: 'recSyntheticPersonB', name: '合成李明华长姓名验收', openId: 'ou_synthetic_b', buildings: ['B'], position: '合成暖通工程师' },
];
export const items: TodayOperationsAlarmItem[] = ['recSyntheticAlarmA', 'recSyntheticAlarmB', 'recSyntheticAlarmC'].map((id, index) => ({
  id, description: ['合成电池内阻过高报警', '合成蜂鸣器告警', '合成漏水检测告警'][index], building: index ? 'B楼' : 'A楼',
  level: '次要', expectation: 'unexpected', occurredAt: at, acceptedAt: at, handlingDescription: '合成现场查看',
  owner: '合成责任人', confirmationStatus: '已确认', handlingStatus: '已关闭', processingStatus: '已处理', recoveryStatus: '已恢复',
  createdAt: at, location: '合成电池室', alarmCategory: '合成报警', monitorObject: 'SYNTHETIC-LEAK',
  acceptanceDescription: '人员已前往现场查看', confirmationDescription: '合成现场恢复',
  tagIssues: [{ code: index ? 'vague' : 'missing', side: 'acceptance', label: index ? '设备故障未说明原因' : '描述漏填', reason: '合成异常说明', source: 'rule' }],
}));
export function alarms(query: TodayOperationsAlarmDashboardQuery): TodayOperationsAlarmDashboardResponse {
  let selected = items.filter(item => !query.building || item.building === query.building);
  for (const field of ['level', 'processingStatus', 'recoveryStatus'] as const) if (query[field]) selected = selected.filter(item => item[field] === query[field]);
  if (query.status) selected = selected.filter(item => item.handlingStatus === query.status);
  if (query.tagIssueCode) selected = selected.filter(item => item.tagIssues.some(issue => issue.code === query.tagIssueCode));
  if (query.q) selected = selected.filter(item => `${item.description} ${item.location}`.includes(query.q!));
  if (query.metric === 'expected' || query.metric === 'unclassified') selected = [];
  const page = Math.max(1, Number(query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
  const byType = issueCounts(); items.forEach(item => item.tagIssues.forEach(issue => byType[issue.code]++));
  const points = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].map(building => ({ building: building as 'A楼', expected: 0, unexpected: items.filter(item => item.building === building).length, unclassified: 0, total: items.filter(item => item.building === building).length }));
  return {
    window: { timeZone: 'Asia/Shanghai', startDate: date, endDateExclusive: date, yesterdayDate: date },
    summary: { sevenDayTotal: 3, expectedTotal: 0, unexpectedTotal: 3, unclassifiedTotal: 0, yesterdayTotal: 3, yesterdayExpectedTotal: 0, yesterdayUnexpectedTotal: 3, yesterdayUnclassifiedTotal: 0, dayBeforeYesterdayTotal: 0, pendingTotal: 0, doubleUnhandledTotal: 0, excludedBuildingTotal: 0, tagAnomalyTotal: 3, tagAnomalyByType: byType,
      tagAnomalyByBuilding: ['A楼', 'B楼'].map(building => ({ building, total: items.filter(item => item.building === building).length, byType: Object.fromEntries(Object.keys(issueCounts()).map(code => [code, items.filter(item => item.building === building && item.tagIssues.some(issue => issue.code === code as TodayOperationsAlarmTagIssueCode)).length])) as ReturnType<typeof issueCounts> })) },
    sevenDayByBuilding: points, yesterdayByBuilding: points,
    options: { buildings: ['A楼', 'B楼'], levels: ['次要'], statuses: ['已关闭'], processingStatuses: ['已处理'], recoveryStatuses: ['已恢复'] },
    page: { page, pageSize, total: selected.length, totalPages: Math.max(1, Math.ceil(selected.length / pageSize)), items: selected.slice((page - 1) * pageSize, page * pageSize) },
    sourceUpdatedAt: at, syncedAt: at, sourceStatus: 'fresh', dataStatus: 'ready', warnings: [], tagReview: { state: 'ready', connection: 'online', reviewed: 3, total: 3 },
  };
}
export const overview: TodayOperationsOverviewResponse = {
  businessDate: date, syncedAt: at, sourceStatus: 'fresh',
  rackSummary: { usageRate: 50, online: 5, total: 10, buildingUsages: [], buildingLoads: [], poweredOnThisWeek: 0, poweredOffThisWeek: 0, poweredOnWeekDelta: 0, poweredOffWeekDelta: 0, weekStartDate: date, capacityDate: date, loadDate: date },
  operations: { todayEvents: 0, pendingEvents: 0, priorPendingEvents: 0, closedTodayEvents: 0, keyEvents: 0, todayChanges: 0, activeChanges: 0, priorActiveChanges: 0, keyChanges: 0, todayInspections: 0, activeInspections: 0, todayMaintenance: 0, activeMaintenance: 0 },
  details: { events: [], changes: [], inspections: [], maintenance: [] }, focusDetails: { pendingEvents: [], activeChanges: [] },
  sourceStates: { events: { status: 'fresh', errorCode: null, errorMessage: null }, changes: { status: 'fresh', errorCode: null, errorMessage: null }, inspections: { status: 'fresh', errorCode: null, errorMessage: null }, maintenance: { status: 'fresh', errorCode: null, errorMessage: null } },
};
const metric = (value: number) => ({ value, previousValue: value, date });
export const kpis: TodayOperationsKpiResponse = { sourceStatus: 'fresh', syncedAt: at,
  metrics: { safeOperationDays: metric(10), onDutyPeople: metric(2), averagePue: metric(1.2), itLoadRate: metric(50), electricityKwh: metric(1000), waterTons: metric(100) },
  details: { onDutyPeople: { scope: 'daily_shifts', date, buildings: [], total: 0, whiteShiftTotal: 0, nightShiftTotal: 0, shifts: { white: { shift: 'white', shiftLabel: '白班', total: 0, buildings: [] }, night: { shift: 'night', shiftLabel: '夜班', total: 0, buildings: [] } } } },
};
export const attendance: TodayAttendanceSnapshot = { date, displayScope: 'today', fetchedAt: at, sourceStatus: 'fresh', checkedTasks: [], summary: { expected: 0, normal: 0, anomaly: 0, excluded: 0 }, entries: [], runStatus: { state: 'completed', scheduledAt: at } };
export const campus = { transformerRows: [], buildingMetrics: [], target: { businessDate: date, shift: 'white' }, fetchedAt: at };
export const sealing = { sealings: [], total: 0, sourceStatus: 'fresh' };
