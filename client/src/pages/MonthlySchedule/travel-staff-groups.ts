export interface TravelStaffGroupDetail {
  id: string;
  staffName: string;
  startDate: string;
  endDate: string;
  dates: string[];
  recordCount: number;
}

export interface TravelStaffGroup<TDetail extends TravelStaffGroupDetail = TravelStaffGroupDetail> {
  id: string;
  staffName: string;
  startDate: string;
  endDate: string;
  dates: string[];
  recordCount: number;
  segmentCount: number;
  details: TDetail[];
}

export function buildTravelStaffGroups<TDetail extends TravelStaffGroupDetail>(
  details: TDetail[],
): TravelStaffGroup<TDetail>[] {
  const byStaffName = new Map<string, TDetail[]>();

  details.forEach((detail) => {
    const staffName = detail.staffName.trim();
    if (!staffName) {
      return;
    }

    byStaffName.set(staffName, [...(byStaffName.get(staffName) || []), detail]);
  });

  return [...byStaffName.entries()]
    .map(([staffName, staffDetails]) => {
      const sortedDetails = [...staffDetails].sort((a, b) => {
        const startCompare = a.startDate.localeCompare(b.startDate);
        if (startCompare !== 0) return startCompare;
        return a.endDate.localeCompare(b.endDate);
      });
      const dates = Array.from(
        new Set(sortedDetails.flatMap((detail) => detail.dates)),
      ).sort();

      return {
        id: staffName,
        staffName,
        startDate: dates[0] || sortedDetails[0]?.startDate || '',
        endDate: dates[dates.length - 1] || sortedDetails[sortedDetails.length - 1]?.endDate || '',
        dates,
        recordCount: sortedDetails.reduce((total, detail) => total + detail.recordCount, 0),
        segmentCount: sortedDetails.length,
        details: sortedDetails,
      };
    })
    .sort((a, b) => {
      const startCompare = a.startDate.localeCompare(b.startDate);
      if (startCompare !== 0) return startCompare;
      return a.staffName.localeCompare(b.staffName, 'zh-CN');
    });
}
