import { buildYesterdayAttendanceAnomalies } from './today-operations-attendance-anomaly';

describe('buildYesterdayAttendanceAnomalies', () => {
  it('creates an explicit data-source anomaly when the required 00:30 summary is missing', () => {
    const anomalies = buildYesterdayAttendanceAnomalies({
      businessDate: '2026-08-30',
      summaryDate: '2026-08-29',
      effectiveFrom: '2026-08-27',
      summary: null,
      summaryError: 'summary file missing',
      detectedAt: '2026-08-30T00:30:00.000Z',
      required: true,
    } as any);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      metricLabel: '昨日考勤数据异常',
      dataDate: '2026-08-29',
    });
    expect(JSON.stringify(anomalies)).not.toContain('待核对');
  });

  it('does not require a summary before the effective boundary', () => {
    const anomalies = buildYesterdayAttendanceAnomalies({
      businessDate: '2026-08-27',
      summaryDate: '2026-08-26',
      effectiveFrom: '2026-08-27',
      summary: null,
      detectedAt: '2026-08-27T00:30:00.000Z',
      required: true,
    } as any);

    expect(anomalies).toEqual([]);
  });
});
