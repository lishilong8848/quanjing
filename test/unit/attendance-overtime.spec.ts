import { buildApprovedOvertimeExpectations } from '../../server/modules/duty-schedule/attendance-overtime';
import { matchDingTalkResultsToExpectations } from '../../server/modules/duty-schedule/attendance-automation.expectations';

const record = (fields: Record<string, unknown> = {}) => ({
  record_id: 'rec-overtime',
  fields: {
    加班审批: '同意',
    加班流程进展: '已审批',
    加班工作流状态: '已审批',
    加班人员: [{ id: 'ou_employee', name: '测试甲' }],
    加班人员姓名: '测试甲',
    机楼: 'H楼',
    加班开始时间: Date.parse('2026-09-08T09:00:00+08:00'),
    加班结束时间: Date.parse('2026-09-08T18:00:00+08:00'),
    ...fields,
  },
});

describe('approved independent overtime attendance', () => {
  it('compares an overtime punch with its approved time, not DingTalk normal-shift status', () => {
    const expectations = buildApprovedOvertimeExpectations(
      [record()],
      '2026-09-08',
    );
    const results = matchDingTalkResultsToExpectations(
      expectations,
      [{ userId: 'u1', name: '测试甲' }],
      [
        {
          userId: 'u1',
          checkType: 'OnDuty',
          baseCheckTime: '2026-09-08 09:00:00',
          userCheckTime: '2026-09-08 09:10:00',
          timeResult: 'Normal',
        },
      ] as never,
    );
    expect(results[0].timeResult).toBe('Late');
  });
  it('creates punch expectations without any substitute or scheduled shift', () => {
    const events = buildApprovedOvertimeExpectations([record()], '2026-09-08');
    expect(
      events.map((e) => [e.name, e.building, e.direction, e.expectedAt]),
    ).toEqual([
      ['测试甲', 'H楼', 'OnDuty', '2026-09-08 09:00:00'],
      ['测试甲', 'H楼', 'OffDuty', '2026-09-08 18:00:00'],
    ]);
    expect(events.every((e) => e.status === 'overtime')).toBe(true);
  });
  it('does not include pending or rejected applications', () => {
    expect(
      buildApprovedOvertimeExpectations(
        [record({ 加班审批: '驳回' }), record({ 加班审批: '' })],
        '2026-09-08',
      ),
    ).toEqual([]);
  });
  it('replaces the planned window with confirmed actual time and cancels zero-hour overtime', () => {
    const fields = {
      加班流程进展: '已确认',
      加班工作流状态: '已确认',
      加班确认: '确认',
      实际加班开始时间: Date.parse('2026-09-08T10:00:00+08:00'),
      实际加班结束时间: Date.parse('2026-09-08T12:00:00+08:00'),
      实际加班时长: 2,
    };
    expect(
      buildApprovedOvertimeExpectations([record(fields)], '2026-09-08').map(
        (e) => e.expectedAt,
      ),
    ).toEqual(['2026-09-08 10:00:00', '2026-09-08 12:00:00']);
    expect(
      buildApprovedOvertimeExpectations(
        [record({ ...fields, 实际加班时长: 0 })],
        '2026-09-08',
      ),
    ).toEqual([]);
  });
  it('splits overnight punches across calendar dates without inventing daily punches in between', () => {
    const overnight = record({
      加班开始时间: Date.parse('2026-09-07T20:00:00+08:00'),
      加班结束时间: Date.parse('2026-09-08T08:00:00+08:00'),
    });
    expect(
      buildApprovedOvertimeExpectations([overnight], '2026-09-07').map((e) => [
        e.direction,
        e.shiftLabel,
      ]),
    ).toEqual([['OnDuty', '夜班加班']]);
    expect(
      buildApprovedOvertimeExpectations([overnight], '2026-09-08').map(
        (e) => e.direction,
      ),
    ).toEqual(['OffDuty']);
  });
  it('does not flag an overtime punch that is not due at the scheduled cutoff', () => {
    expect(
      buildApprovedOvertimeExpectations(
        [record()],
        '2026-09-08',
        '09:30:59',
      ).map((e) => e.direction),
    ).toEqual(['OnDuty']);
  });
  it('fails closed on malformed approved records instead of silently omitting people', () => {
    expect(() =>
      buildApprovedOvertimeExpectations(
        [record({ 加班开始时间: '' })],
        '2026-09-08',
      ),
    ).toThrow('加班');
    expect(() =>
      buildApprovedOvertimeExpectations([record({ 机楼: '' })], '2026-09-08'),
    ).toThrow('加班');
  });
});
