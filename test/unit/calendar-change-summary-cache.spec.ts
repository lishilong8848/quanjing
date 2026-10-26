import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCalendarDaySummaryCache,
  reuseSameDateValue,
} from '../../client/src/pages/MonthlySchedule/calendar-change-summary-cache';

describe('calendar day summary cache', () => {
  it('calculates each day once within the same snapshot', () => {
    const calculate = jest.fn((date: string) => ({ date, conflicts: 1 }));
    const read = createCalendarDaySummaryCache(calculate);
    const first = read('2026-10-15');
    expect(read('2026-10-15')).toBe(first);
    expect(read('2026-10-16')).not.toBe(first);
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it.each(['changes', 'sealings', 'staff conflicts', 'follow-ups'])(
    'does not carry results into a new %s snapshot',
    () => {
      const oldRead = createCalendarDaySummaryCache(() => ({ conflicts: 1 }));
      const oldResult = oldRead('2026-10-15');
      const newRead = createCalendarDaySummaryCache(() => ({ conflicts: 0 }));
      expect(newRead('2026-10-15')).not.toBe(oldResult);
      expect(newRead('2026-10-15').conflicts).toBe(0);
    },
  );

  it('bounds retained days to two six-week calendars', () => {
    const calculate = jest.fn((date: string) => date);
    const read = createCalendarDaySummaryCache(calculate);
    const dateKey = (offset: number) =>
      new Date(Date.UTC(2026, 6, 1 + offset)).toISOString().slice(0, 10);
    read(dateKey(0));
    for (let day = 1; day <= 84; day++) read(dateKey(day));
    expect(calculate).toHaveBeenCalledTimes(85);
    read(dateKey(0));
    expect(calculate).toHaveBeenCalledTimes(86);
  });

  it('does not cache failures or silently produce a normal state', () => {
    const calculate = jest
      .fn()
      .mockImplementationOnce(() => {
        throw Error('invalid snapshot');
      })
      .mockReturnValue({ conflicts: 1 });
    const read = createCalendarDaySummaryCache(calculate);
    expect(() => read('2026-10-15')).toThrow('invalid snapshot');
    expect(read('2026-10-15')).toEqual({ conflicts: 1 });
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it('caches falsy values without treating them as a miss', () => {
    const calculate = jest.fn(() => undefined);
    const read = createCalendarDaySummaryCache(calculate);
    read('2026-10-15');
    read('2026-10-15');
    expect(calculate).toHaveBeenCalledTimes(1);
  });

  it('reuses only equal timestamps, keeping different time/date values unchanged', () => {
    const current = new Date('2026-10-15T00:00:00+08:00');
    expect(reuseSameDateValue(current, new Date(current))).toBe(current);
    const changed = new Date('2026-10-16T00:00:00+08:00');
    expect(reuseSameDateValue(current, changed)).toBe(changed);
    const changedTime = new Date('2026-10-15T08:00:00+08:00');
    expect(reuseSameDateValue(current, changedTime)).toBe(changedTime);
  });

  it('rebuilds the page cache for every relevant data version', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const start = source.indexOf('const getCalendarChangeInfoByDate =');
    const end = source.indexOf('\n  useEffect(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const resolver = source.slice(start, end);
    expect(resolver).toContain('useMemo');
    expect(resolver).toContain('createCalendarDaySummaryCache');
    expect(resolver).toContain(
      '[changes, getSealingsByDate, getStaffConsecutiveConflictsByDate, exceptionFollowUpsByKey]',
    );
    expect(source).toContain('reuseSameDateValue(current, date)');
  });

  it('does not reuse an invalid Date as if it were a valid selection', () => {
    const current = new Date('invalid');
    const next = new Date('invalid');
    expect(reuseSameDateValue(current, next)).toBe(next);
    const valid = new Date('2026-10-15T00:00:00+08:00');
    expect(reuseSameDateValue(valid, next)).toBe(next);
  });
});
