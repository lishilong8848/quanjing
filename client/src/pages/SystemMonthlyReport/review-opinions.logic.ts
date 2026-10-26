import type {
  SystemMonthlyReportReviewOpinion,
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportScheduleItem,
} from '@shared/system-monthly-report.interface';

export interface SystemMonthlyReportReviewOpinionRow {
  room: string;
  initial: SystemMonthlyReportReviewOpinion | null;
  recheck: SystemMonthlyReportReviewOpinion | null;
}

export function buildSystemMonthlyReportReviewOpinionModel(
  roomNames: string[],
  opinions: SystemMonthlyReportReviewOpinion[],
  schedule: SystemMonthlyReportScheduleItem[],
  year: number,
  month: number,
) {
  const reviewerByRoomRound = new Map(
    schedule
      .filter((item) => item.year === year && item.month === month)
      .map((item) => [`${item.room}\u001f${item.round}`, item.reviewer]),
  );
  const latest = new Map<string, SystemMonthlyReportReviewOpinion>();
  for (const opinion of opinions) {
    if (opinion.year !== year || opinion.month !== month) continue;
    const key = `${opinion.room}\u001f${opinion.round}`;
    const previous = latest.get(key);
    if (!previous || opinion.submittedAt > previous.submittedAt)
      latest.set(key, opinion);
  }
  const allRooms = Array.from(
    new Set([
      ...roomNames,
      ...Array.from(latest.values()).map((item) => item.room),
    ]),
  );
  const opinionFor = (room: string, round: SystemMonthlyReportReviewRound) => {
    const opinion = latest.get(`${room}\u001f${round}`);
    if (!opinion) return null;
    return opinion.reviewer
      ? opinion
      : {
          ...opinion,
          reviewer: reviewerByRoomRound.get(`${room}\u001f${round}`) || null,
        };
  };
  const rows = allRooms.map((room) => ({
    room,
    initial: opinionFor(room, 'initial'),
    recheck: opinionFor(room, 'recheck'),
  }));
  return {
    rows,
    summary: {
      totalRooms: rows.length,
      initialReviewedRooms: rows.filter((row) => Boolean(row.initial)).length,
      recheckReviewedRooms: rows.filter((row) => Boolean(row.recheck)).length,
      issueRooms: rows.filter(
        (row) =>
          row.initial?.conclusion === 'has_issues' ||
          row.recheck?.conclusion === 'has_issues',
      ).length,
    },
  };
}
