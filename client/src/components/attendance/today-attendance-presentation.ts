import type { TodayAttendanceEntry } from '@shared/today-attendance.interface';

export interface TodayAttendanceAnomalyView {
  entryKey: string;
  building: string;
  name: string;
  card: '上班卡' | '下班卡';
  punchStatus?: '补卡后正常';
  anomaly: string;
}

export interface TodayAttendancePersonAnomalies {
  name: string;
  anomalies: Array<
    Pick<
      TodayAttendanceAnomalyView,
      'entryKey' | 'card' | 'punchStatus' | 'anomaly'
    >
  >;
}

export interface TodayAttendanceBuildingAnomalies {
  building: string;
  count: number;
  people: TodayAttendancePersonAnomalies[];
}

export function formatTodayAttendanceAnomaly(
  entry: TodayAttendanceEntry,
): TodayAttendanceAnomalyView {
  const normalized = normalizeAnomaly(entry.reason);
  return {
    entryKey: entry.key,
    building: entry.building || '园区',
    name: entry.name,
    card: entry.direction === 'OffDuty' ? '下班卡' : '上班卡',
    ...(normalized.punchStatus ? { punchStatus: normalized.punchStatus } : {}),
    anomaly: `${/加班/.test(entry.shiftLabel) ? `加班 ${entry.expectedAt.slice(11, 16)} ` : ''}${normalized.anomaly}`,
  };
}

export function getTodayAttendanceCardLabel(
  anomalyCount: number,
  dayLabel = '今日',
): string {
  return anomalyCount > 0
    ? `${dayLabel}考勤异常 ${anomalyCount} 人`
    : `${dayLabel}考勤正常`;
}

export function groupTodayAttendanceAnomalies(
  anomalies: readonly TodayAttendanceAnomalyView[],
): TodayAttendanceBuildingAnomalies[] {
  const buildings = new Map<
    string,
    Map<string, TodayAttendancePersonAnomalies['anomalies']>
  >();
  anomalies.forEach((item) => {
    const people = buildings.get(item.building) || new Map();
    const person = people.get(item.name) || [];
    person.push({
      entryKey: item.entryKey,
      card: item.card,
      ...(item.punchStatus ? { punchStatus: item.punchStatus } : {}),
      anomaly: item.anomaly,
    });
    people.set(item.name, person);
    buildings.set(item.building, people);
  });
  return [...buildings.entries()]
    .sort(([left], [right]) => compareBuilding(left, right))
    .map(([building, people]) => ({
      building,
      count: [...people.values()].reduce(
        (total, personAnomalies) => total + personAnomalies.length,
        0,
      ),
      people: [...people.entries()].map(([name, personAnomalies]) => ({
        name,
        anomalies: personAnomalies,
      })),
    }));
}

function compareBuilding(left: string, right: string): number {
  const order = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (
      (leftIndex === -1 ? order.length : leftIndex) -
      (rightIndex === -1 ? order.length : rightIndex)
    );
  }
  return left.localeCompare(right, 'zh-CN');
}

function normalizeAnomaly(reason: string | undefined): {
  punchStatus?: '补卡后正常';
  anomaly: string;
} {
  const value = String(reason || '').trim();
  if (!value || /未查询到有效打卡|未打卡|NotSigned/iu.test(value)) {
    return { anomaly: '未打卡' };
  }
  if (/迟到/iu.test(value)) return { anomaly: value };
  if (/补卡未提供举证照片/iu.test(value)) {
    return { punchStatus: '补卡后正常', anomaly: '' };
  }
  if (/补卡审批未通过/iu.test(value)) return { anomaly: '补卡未通过' };
  if (/补卡举证未核验/iu.test(value)) {
    return { punchStatus: '补卡后正常', anomaly: '' };
  }
  return { anomaly: value };
}
