import type { MeetingSummary } from '../../../../shared/meeting-management.interface';
import { filterMeetings, sortMeetings } from './model';

export const isTrainingBuilding = (label: string) => /(?:楼|栋)$/.test(label);
export const trainingAttendance = (row: MeetingSummary) =>
  typeof row.participantCount === 'number' &&
  Number.isInteger(row.participantCount) &&
  row.participantCount >= 0
    ? row.participantCount
    : null;
export const completedTraining = (row: MeetingSummary) =>
  ['会议已结束', '会议评分中'].includes(row.status || '');

export interface TrainingFilters {
  query?: string;
  year?: string;
  subtype?: string;
  specialty?: string;
  building?: string;
  presenter?: string;
  content?: string;
}
export function filterTraining(
  rows: MeetingSummary[],
  filters: TrainingFilters,
) {
  return filterMeetings(rows, filters).filter(
    (row) =>
      (!filters.subtype || row.subtype === filters.subtype) &&
      (!filters.specialty || row.specialties?.includes(filters.specialty)) &&
      (!filters.building || row.specialties?.includes(filters.building)) &&
      (!filters.presenter ||
        row.presenters?.some((p) => p.id === filters.presenter)),
  );
}
export function trainingInsights(input: MeetingSummary[]) {
  const rows = sortMeetings(input);
  const completed = rows.filter(completedTraining);
  const attended = completed.filter((row) => trainingAttendance(row) !== null);
  const people = [
    ...new Map(
      rows.flatMap((r) => r.presenters || []).map((p) => [p.id, p]),
    ).values(),
  ];
  const professionalNames = [
    ...new Set(
      rows
        .flatMap((r) => r.specialties || [])
        .filter((label) => !isTrainingBuilding(label)),
    ),
  ];
  const groups = professionalNames
    .map((label) => ({
      label,
      rows: rows.filter((r) => r.specialties?.includes(label)),
    }))
    .sort(
      (a, b) =>
        b.rows.length - a.rows.length ||
        a.label.localeCompare(b.label, 'zh-CN'),
    );
  const ungrouped = rows.filter(
    (r) => !(r.specialties || []).some((label) => !isTrainingBuilding(label)),
  );
  const ranking = [
    ...new Map(
      completed.flatMap((r) => r.presenters || []).map((p) => [p.id, p]),
    ).values(),
  ].map((person) => {
    const shares = completed.filter((r) =>
      r.presenters?.some((p) => p.id === person.id),
    );
    const known = shares.filter((r) => trainingAttendance(r) !== null);
    return {
      person,
      rows: shares,
      shares: shares.length,
      participants: known.length
        ? known.reduce((sum, r) => sum + trainingAttendance(r)!, 0)
        : null,
      missingAttendance: shares.length - known.length,
    };
  });
  return {
    rows,
    completed,
    attended,
    people,
    groups,
    ungrouped,
    ranking,
    participants: attended.length
      ? attended.reduce((sum, r) => sum + trainingAttendance(r)!, 0)
      : null,
    missingAttendance: completed.length - attended.length,
    timeline: [
      ...new Set(rows.map((r) => r.date?.slice(0, 7) || '日期未填写')),
    ].map((month) => ({
      month,
      rows: rows.filter((r) => (r.date?.slice(0, 7) || '日期未填写') === month),
    })),
  };
}
export function rankTrainingPeople(
  ranking: ReturnType<typeof trainingInsights>['ranking'],
  dimension: 'participants' | 'shares',
) {
  return [...ranking].sort(
    (a, b) =>
      (b[dimension] ?? -1) - (a[dimension] ?? -1) ||
      b.shares - a.shares ||
      a.person.name.localeCompare(b.person.name, 'zh-CN') ||
      a.person.id.localeCompare(b.person.id),
  );
}
