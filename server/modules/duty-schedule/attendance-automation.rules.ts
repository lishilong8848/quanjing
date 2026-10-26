export type AttendanceDirection = 'OnDuty' | 'OffDuty';
export type AttendanceScheduleStatus =
  | 'on_duty'
  | 'substitute'
  | 'vacancy_substitute'
  | 'overtime'
  | 'leave'
  | 'time_off'
  | 'travel';

export interface AttendanceExpectation {
  key: string;
  name: string;
  building: string;
  shiftLabel: string;
  direction: AttendanceDirection;
  expectedAt: string;
  status: AttendanceScheduleStatus;
}

export interface DingTalkAttendanceResult {
  expectationKey: string;
  timeResult: string | null;
  userCheckTime: string | null;
  userId?: string;
  baseCheckTime?: number | string | null;
  sourceType?: string | null;
  correctionEvidenceStatus?:
    | 'present'
    | 'missing'
    | 'pending'
    | 'rejected'
    | 'unavailable';
}

export interface AttendanceAnomaly extends AttendanceExpectation {
  reason:
    | '未打卡'
    | '未查询到有效打卡'
    | '迟到'
    | '早退'
    | '旷工'
    | '补卡未提供举证照片'
    | '补卡审批未通过'
    | '补卡举证未核验'
    | '考勤结果异常';
}

export interface AttendanceClassification {
  anomalies: AttendanceAnomaly[];
  excluded: AttendanceExpectation[];
  normal: AttendanceExpectation[];
}

const EXCLUDED_STATUSES = new Set<AttendanceScheduleStatus>([
  'leave',
  'time_off',
  'travel',
]);

export function classifyAttendanceExpectations(
  expectations: readonly AttendanceExpectation[],
  results: readonly DingTalkAttendanceResult[],
): AttendanceClassification {
  const resultsByExpectation = new Map<string, DingTalkAttendanceResult[]>();
  results.forEach((result) => {
    const current = resultsByExpectation.get(result.expectationKey) ?? [];
    current.push(result);
    resultsByExpectation.set(result.expectationKey, current);
  });

  const classification: AttendanceClassification = {
    anomalies: [],
    excluded: [],
    normal: [],
  };

  expectations.forEach((expectation) => {
    if (EXCLUDED_STATUSES.has(expectation.status)) {
      classification.excluded.push(expectation);
      return;
    }
    const matched = resultsByExpectation.get(expectation.key) ?? [];
    if (matched.length === 0) {
      classification.anomalies.push({
        ...expectation,
        reason: '未查询到有效打卡',
      });
      return;
    }
    const normal = matched.find((result) => result.timeResult === 'Normal');
    if (normal) {
      const correctionAnomaly = correctionAnomalyReason(normal);
      if (correctionAnomaly) {
        classification.anomalies.push({
          ...expectation,
          reason: correctionAnomaly,
        });
        return;
      }
      classification.normal.push(expectation);
      return;
    }
    classification.anomalies.push({
      ...expectation,
      reason: resolveAnomalyReason(matched),
    });
  });

  return classification;
}

function correctionAnomalyReason(
  result: DingTalkAttendanceResult,
): AttendanceAnomaly['reason'] | null {
  if (!/APPROVE/iu.test(result.sourceType || '')) return null;
  if (
    result.correctionEvidenceStatus === 'pending' ||
    result.correctionEvidenceStatus === 'rejected'
  ) {
    return '补卡审批未通过';
  }
  // 举证附件是否已同步属于技术同步状态，不应改变已通过补卡的考勤结论。
  return null;
}

function resolveAnomalyReason(
  results: readonly DingTalkAttendanceResult[],
): AttendanceAnomaly['reason'] {
  const statuses = new Set(results.map((result) => result.timeResult));
  if (statuses.has('NotSigned')) return '未打卡';
  if (statuses.has('Absenteeism')) return '旷工';
  if (statuses.has('SeriousLate') || statuses.has('Late')) return '迟到';
  if (statuses.has('EarlyLeave') || statuses.has('Early')) return '早退';
  if (results.every((result) => !result.userCheckTime)) {
    return '未查询到有效打卡';
  }
  return '考勤结果异常';
}
