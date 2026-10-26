import {
  buildCalendarChangeFollowUpTarget,
  projectCalendarChangeFollowUp,
} from '../../client/src/pages/MonthlySchedule/calendar-change-follow-up';
import {
  indexExceptionFollowUpItems,
  removeExceptionFollowUpItemFromIndex,
} from '../../shared/exception-follow-up-match';
import type { ExceptionFollowUpItem } from '../../shared/api.interface';
const date = '2026-10-15';
const item = {
  change: {
    id: 'change1',
    title: 'B楼维护变更',
    executor: null,
    buildings: ['B楼'],
    level: '超低',
    startDate: '2026-10-15T09:00:00+08:00',
    endDate: '2026-10-15T18:00:00+08:00',
  },
  windows: [],
  conflictSealings: [{ sealingName: '双十一封网' }],
  reminderSealings: [],
  overlapChanges: [],
};
function follow(recordId = 'record1', overrides = {}) {
  const target = buildCalendarChangeFollowUpTarget(date, item);
  return {
    ...target,
    recordId,
    typeLabel: '封网/变更',
    detailedContent: `冲突：${target.detail}`,
    handling: '日期调整不冲突',
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as ExceptionFollowUpItem;
}
describe('calendar follow-up is independent of conflict facts', () => {
  it('preserves unfollowed conflict and original evidence', () => {
    const result = projectCalendarChangeFollowUp(date, item, {});
    expect(result.status).toBe('conflict');
    expect(result.hasConflict).toBe(true);
    expect(result.rawConflict).toBe(true);
  });
  it('saved follow-up suppresses conflict presentation without changing raw facts', () => {
    const before = JSON.stringify(item);
    const result = projectCalendarChangeFollowUp(
      date,
      item,
      indexExceptionFollowUpItems([follow()]),
    );
    expect(result.status).toBe('followed-up');
    expect(result.hasConflict).toBe(false);
    expect(result.rawConflict).toBe(true);
    expect(result.followUps).toHaveLength(1);
    expect(JSON.stringify(item)).toBe(before);
    expect(result.status).not.toBe('normal');
  });
  it('pending optimistic record cannot suppress an unreviewed conflict', () => {
    const result = projectCalendarChangeFollowUp(
      date,
      item,
      indexExceptionFollowUpItems([follow('optimistic-follow-up-123')]),
    );
    expect(result.status).toBe('conflict');
    expect(result.syncing).toBe(true);
    expect(result.hasConflict).toBe(true);
  });
  it('restores conflict after deleting the last record, but not a sibling record', () => {
    const a = follow(),
      b = follow('record2');
    let index = indexExceptionFollowUpItems([a, b]);
    index = removeExceptionFollowUpItemFromIndex(index, a);
    expect(projectCalendarChangeFollowUp(date, item, index).status).toBe(
      'followed-up',
    );
    index = removeExceptionFollowUpItemFromIndex(index, b);
    expect(projectCalendarChangeFollowUp(date, item, index).status).toBe(
      'conflict',
    );
  });
  it('does not inherit follow-up from another date or another business object', () => {
    const index = indexExceptionFollowUpItems([follow()]);
    expect(
      projectCalendarChangeFollowUp('2026-10-16', item, index).status,
    ).toBe('conflict');
    expect(
      projectCalendarChangeFollowUp(
        date,
        { ...item, change: { ...item.change, title: '另一变更' } },
        index,
      ).status,
    ).toBe('conflict');
  });
  it('does not approve an empty handling or schedule-risk record', () => {
    for (const overrides of [{ handling: '' }, { type: 'schedule' }])
      expect(
        projectCalendarChangeFollowUp(
          date,
          item,
          indexExceptionFollowUpItems([follow('record', overrides)]),
        ).hasConflict,
      ).toBe(true);
  });
  it('a changed execution window does not reuse previous confirmation', () => {
    const index = indexExceptionFollowUpItems([follow()]);
    const changed = {
      ...item,
      windows: [
        {
          start: new Date('2026-10-15T10:00:00+08:00'),
          end: new Date('2026-10-15T20:00:00+08:00'),
          source: 'planned',
        },
      ],
    };
    expect(projectCalendarChangeFollowUp(date, changed, index).status).toBe(
      'conflict',
    );
  });
  it('matches the original normalized punctuation contract', () => {
    const saved = follow();
    saved.detail = saved.detail.replace(/；/g, ' ').replace(/，/g, ' ');
    saved.detailedContent = `冲突：${saved.detail}`;
    saved.matchKey = 'legacy-key';
    expect(
      projectCalendarChangeFollowUp(
        date,
        item,
        indexExceptionFollowUpItems([saved]),
      ).status,
    ).toBe('followed-up');
  });
  it('same-day mixed records retain the pending conflict count', () => {
    const other = {
      ...item,
      change: { ...item.change, id: 'change2', title: '另一变更' },
    };
    const index = indexExceptionFollowUpItems([follow()]);
    const results = [item, other].map((v) =>
      projectCalendarChangeFollowUp(date, v, index),
    );
    expect(results.filter((v) => v.hasConflict)).toHaveLength(1);
    expect(results.filter((v) => v.status === 'followed-up')).toHaveLength(1);
  });
});
