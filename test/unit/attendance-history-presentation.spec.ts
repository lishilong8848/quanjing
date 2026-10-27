import type { AttendanceHistoryItem } from '../../shared/attendance-history.interface';
import {
  buildAttendanceHistoryRankings,
  filterAttendanceHistoryItems,
  getDefaultAttendanceHistoryRange,
  groupAttendanceHistoryItems,
} from '../../client/src/components/attendance/attendance-history-presentation';

const items: AttendanceHistoryItem[] = [
  {
    key: 'h-1',
    date: '2026-09-03',
    building: 'H楼',
    name: '张三',
    shiftLabel: '白班',
    direction: 'OnDuty',
    expectedAt: '2026-09-03 09:00',
    reason: '迟到',
    category: 'late',
    categoryLabel: '迟到',
  },
  {
    key: 'b-3',
    date: '2026-09-06',
    building: 'B楼',
    name: '王五',
    shiftLabel: '夜班',
    direction: 'OffDuty',
    expectedAt: '2026-09-06 09:00',
    reason: '补卡后正常',
    category: 'corrected',
    categoryLabel: '补卡后正常',
  },
  {
    key: 'b-1',
    date: '2026-09-04',
    building: 'B楼',
    name: '李四',
    shiftLabel: '白班',
    direction: 'OffDuty',
    expectedAt: '2026-09-04 18:00',
    reason: '早退',
    category: 'early',
    categoryLabel: '早退',
  },
  {
    key: 'b-2',
    date: '2026-09-05',
    building: 'B楼',
    name: '王五',
    shiftLabel: '夜班',
    direction: 'OnDuty',
    expectedAt: '2026-09-05 18:00',
    reason: '未打卡',
    category: 'missing',
    categoryLabel: '未打卡且未补卡',
  },
];

describe('attendance history presentation', () => {
  it('默认查询上海时区的当月 1 日至今日', () => {
    expect(
      getDefaultAttendanceHistoryRange(new Date('2026-08-31T16:30:00.000Z')),
    ).toEqual({ from: '2026-09-01', through: '2026-09-01' });
  });

  it('按楼栋分组并遵循业务楼栋顺序', () => {
    expect(groupAttendanceHistoryItems(items, 'building')).toEqual([
      {
        key: 'B楼',
        label: 'B楼',
        count: 3,
        items: [items[1], items[2], items[3]],
      },
      { key: 'H楼', label: 'H楼', count: 1, items: [items[0]] },
    ]);
  });

  it('按类别分组并只展示有数据的类别', () => {
    expect(groupAttendanceHistoryItems(items, 'category')).toEqual([
      { key: 'late', label: '迟到', count: 1, items: [items[0]] },
      { key: 'early', label: '早退', count: 1, items: [items[2]] },
      {
        key: 'missing',
        label: '未打卡且未补卡',
        count: 1,
        items: [items[3]],
      },
      {
        key: 'corrected',
        label: '补卡后正常',
        count: 1,
        items: [items[1]],
      },
    ]);
  });

  it('按状态即时筛选并让排行只比较同类项', () => {
    const missing = filterAttendanceHistoryItems(items, 'missing');
    expect(missing).toEqual([items[3]]);
    expect(buildAttendanceHistoryRankings(missing)).toEqual({
      people: [{ name: '王五', buildings: ['B楼'], count: 1 }],
      buildings: [{ building: 'B楼', peopleCount: 1, count: 1 }],
    });
  });
});
