export type CampusOperationsReportShift = 'white' | 'night';

export interface CampusOperationsPreviousShift {
  date: string;
  shift: CampusOperationsReportShift;
  shiftLabel: '白班' | '夜班';
}

export function resolvePreviousCampusOperationsShift(
  reportDate: string,
  reportShift: CampusOperationsReportShift,
): CampusOperationsPreviousShift | null {
  const normalizedDate = String(reportDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    return null;
  }

  const [year, month, day] = normalizedDate
    .split('-')
    .map((part) => Number(part));
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== normalizedDate
  ) {
    return null;
  }

  if (reportShift === 'night') {
    return {
      date: normalizedDate,
      shift: 'white',
      shiftLabel: '白班',
    };
  }

  if (reportShift !== 'white') {
    return null;
  }

  parsedDate.setUTCDate(parsedDate.getUTCDate() - 1);
  return {
    date: parsedDate.toISOString().slice(0, 10),
    shift: 'night',
    shiftLabel: '夜班',
  };
}
