import {
  filterTemporarilyDeletedProjectItems,
  getDefaultExpandedProjectIds,
  getVisibleProjectItems,
  sortProjectItemsByCreatedAtDesc,
} from '../../client/src/pages/ConstructionManagement/project-expansion';

describe('construction project expansion', () => {
  it('does not default expand archived projects', () => {
    const expandedIds = getDefaultExpandedProjectIds(
      [
        { recordId: 'archived', archived: true },
        { recordId: 'active', archived: false },
      ],
      new Set(['archived']),
      false,
    );

    expect(Array.from(expandedIds)).toEqual(['active']);
  });

  it('filters temporarily deleted projects without mutating source items', () => {
    const items = [
      { recordId: 'visible', archived: false },
      { recordId: 'deleted', archived: false },
    ];

    const visibleItems = filterTemporarilyDeletedProjectItems(
      items,
      new Set(['deleted']),
    );

    expect(visibleItems.map((item) => item.recordId)).toEqual(['visible']);
    expect(items.map((item) => item.recordId)).toEqual(['visible', 'deleted']);
  });

  it('limits visible project items without mutating source items', () => {
    const items = [
      { recordId: 'first', archived: false },
      { recordId: 'second', archived: false },
      { recordId: 'third', archived: false },
    ];

    const visibleItems = getVisibleProjectItems(items, 2);

    expect(visibleItems.map((item) => item.recordId)).toEqual([
      'first',
      'second',
    ]);
    expect(items.map((item) => item.recordId)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('sorts project items by creation time from newest to oldest', () => {
    const items = [
      {
        recordId: 'old',
        workContent: '旧项目',
        createdAt: '2026-06-01T09:00:00+08:00',
        updatedAt: '2026-06-09T09:00:00+08:00',
        planStartTime: '2026-06-20T09:00:00+08:00',
      },
      {
        recordId: 'new',
        workContent: '新项目',
        createdAt: '2026-06-08T09:00:00+08:00',
        updatedAt: '2026-06-08T09:00:00+08:00',
        planStartTime: '2026-06-10T09:00:00+08:00',
      },
      {
        recordId: 'middle',
        workContent: '中间项目',
        createdAt: '2026-06-04T09:00:00+08:00',
        updatedAt: '2026-06-04T09:00:00+08:00',
        planStartTime: '2026-06-15T09:00:00+08:00',
      },
    ];

    const sorted = sortProjectItemsByCreatedAtDesc(items);

    expect(sorted.map((item) => item.recordId)).toEqual([
      'new',
      'middle',
      'old',
    ]);
    expect(items.map((item) => item.recordId)).toEqual([
      'old',
      'new',
      'middle',
    ]);
  });
});
