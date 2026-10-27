import {
  formatTodayAttendanceAnomaly,
  getTodayAttendanceCardLabel,
  groupTodayAttendanceAnomalies,
} from '../../client/src/components/attendance/today-attendance-presentation';

describe('today attendance anomaly presentation', () => {
  it('keeps one anomaly to four concise business fields', () => {
    expect(
      formatTodayAttendanceAnomaly({
        key: 'h-zhi-on',
        name: '支佳伟',
        building: 'H楼',
        shiftLabel: '夜班',
        direction: 'OnDuty',
        expectedAt: '2026-09-05 09:00:00',
        status: 'anomaly',
        reason: '未查询到有效打卡',
      }),
    ).toEqual({
      entryKey: 'h-zhi-on',
      building: 'H楼',
      name: '支佳伟',
      card: '上班卡',
      anomaly: '未打卡',
    });
  });

  it('preserves a concrete late duration and labels off-duty cards', () => {
    expect(
      formatTodayAttendanceAnomaly({
        key: 'c-cao-off',
        name: '曹毅',
        building: 'C楼',
        shiftLabel: '白班',
        direction: 'OffDuty',
        expectedAt: '2026-09-05 18:00:00',
        status: 'anomaly',
        reason: '迟到 8 分钟',
      }),
    ).toMatchObject({ card: '下班卡', anomaly: '迟到 8 分钟' });
  });

  it('shows an effective correction as normal without inventing an evidence status', () => {
    expect(
      formatTodayAttendanceAnomaly({
        key: 'd-li-on',
        name: '李金花',
        building: 'D楼',
        shiftLabel: '白班',
        direction: 'OnDuty',
        expectedAt: '2026-09-14 09:00:00',
        status: 'anomaly',
        reason: '补卡举证未核验',
      }),
    ).toEqual({
      entryKey: 'd-li-on',
      building: 'D楼',
      name: '李金花',
      card: '上班卡',
      punchStatus: '补卡后正常',
      anomaly: '',
    });
  });

  it('uses one short normal-state sentence', () => {
    expect(getTodayAttendanceCardLabel(0)).toBe('今日考勤正常');
  });

  it('labels previous-day results so they cannot be mistaken for today', () => {
    expect(getTodayAttendanceCardLabel(2, '昨日（2026-09-05）')).toBe(
      '昨日（2026-09-05）考勤异常 2 人',
    );
  });

  it('groups the same building and person while preserving distinct card tags', () => {
    const grouped = groupTodayAttendanceAnomalies([
      {
        entryKey: 'h-zhi-on',
        building: 'H楼',
        name: '支佳伟',
        card: '上班卡',
        anomaly: '迟到 8 分钟',
      },
      {
        entryKey: 'h-zhi-off',
        building: 'H楼',
        name: '支佳伟',
        card: '下班卡',
        anomaly: '未打卡',
      },
      {
        entryKey: 'h-zhou-on',
        building: 'H楼',
        name: '周庆庆',
        card: '上班卡',
        anomaly: '未打卡',
      },
    ]);

    expect(grouped).toEqual([
      {
        building: 'H楼',
        count: 3,
        people: [
          {
            name: '支佳伟',
            anomalies: [
              {
                entryKey: 'h-zhi-on',
                card: '上班卡',
                anomaly: '迟到 8 分钟',
              },
              {
                entryKey: 'h-zhi-off',
                card: '下班卡',
                anomaly: '未打卡',
              },
            ],
          },
          {
            name: '周庆庆',
            anomalies: [
              {
                entryKey: 'h-zhou-on',
                card: '上班卡',
                anomaly: '未打卡',
              },
            ],
          },
        ],
      },
    ]);
  });
});
