import { createCalendarFollowUpStore } from '../../client/src/pages/MonthlySchedule/use-calendar-follow-ups';
import { indexExceptionFollowUpItems } from '../../shared/exception-follow-up-match';
const range = { start: '2026-10-01', end: '2026-10-31' };
const response = { date: range.start, range, items: [], total: 0 };
describe('calendar follow-up read coordination', () => {
  it('uses one range read and does not refetch the same cached range', async () => {
    const fetch = jest.fn().mockResolvedValue(response);
    const store = createCalendarFollowUpStore(fetch);
    await store.load(range);
    await store.load(range);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.read().loading).toBe(false);
  });
  it('joins duplicate concurrent reads', async () => {
    let resolve: any;
    const fetch = jest.fn(() => new Promise((r) => (resolve = r)));
    const store = createCalendarFollowUpStore(fetch);
    const first = store.load(range),
      second = store.load(range);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(response);
    await Promise.all([first, second]);
  });
  it('keeps local records when an older read finishes after a mutation', async () => {
    let resolve: any;
    const store = createCalendarFollowUpStore(
      () => new Promise((r) => (resolve = r)),
    );
    const pending = store.load(range);
    const item = {
      recordId: 'confirmed',
      date: '2026-10-15',
      abnormalLabel: '冲突',
      detail: '变更',
      detailedContent: '冲突：变更',
      handling: '已跟进',
      matchKey: 'key',
    };
    store.setIndex(() => indexExceptionFollowUpItems([item as any]));
    resolve(response);
    await pending;
    expect(
      Object.values(store.read().index)
        .flat()
        .some((i: any) => i.recordId === 'confirmed'),
    ).toBe(true);
    expect(store.read().error).toBeTruthy();
  });
  it('read failure does not fabricate a completed/normal state', async () => {
    const store = createCalendarFollowUpStore(() =>
      Promise.reject(Error('network')),
    );
    await store.load(range);
    expect(store.read().error).toBeTruthy();
    expect(store.read().loading).toBe(false);
    expect(store.read().index).toEqual({});
  });
  it('rejects mismatched range and cross-range source records', async () => {
    const store = createCalendarFollowUpStore(() =>
      Promise.resolve({ ...response, range: { ...range, end: '2026-11-30' } }),
    );
    await store.load(range);
    expect(store.read().error).toBeTruthy();
  });
});
