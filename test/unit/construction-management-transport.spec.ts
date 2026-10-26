import type {
  ConstructionFollowupItem,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
} from '../../shared/api.interface';
import {
  compactConstructionManagementResponse,
  expandConstructionManagementResponse,
} from '../../shared/construction-management-transport';

function followup(
  recordId: string,
  options: {
    constructionCode?: string | null;
    overviewRecordIds?: string[];
    isLatest?: boolean;
  } = {},
): ConstructionFollowupItem {
  return {
    recordId,
    constructionCode: options.constructionCode ?? null,
    overviewRecordIds: options.overviewRecordIds ?? [],
    isLatest: options.isLatest ?? false,
  } as ConstructionFollowupItem;
}

function overview(
  recordId: string,
  constructionCode: string | null,
  followups: ConstructionFollowupItem[],
): ConstructionOverviewItem {
  return {
    recordId,
    constructionCode,
    followups,
    latestFollowup:
      followups.find((item) => item.isLatest) || followups[0] || null,
  } as ConstructionOverviewItem;
}

describe('construction management transport', () => {
  it('normalizes duplicated followups on the wire and restores the existing client contract', () => {
    const linkedById = followup('followup-by-id', {
      constructionCode: 'SG-001',
      overviewRecordIds: ['overview-1'],
      isLatest: true,
    });
    const linkedByCode = followup('followup-by-code', {
      constructionCode: 'SG-001',
    });
    const orphan = followup('orphan-followup', {
      constructionCode: 'SG-ORPHAN',
    });
    const response = {
      generatedAt: '2026-07-27T00:00:00.000Z',
      summary: {},
      items: [
        overview('overview-1', 'SG-001', [linkedById, linkedByCode]),
        overview('overview-2', 'SG-002', []),
      ],
      followups: [linkedById, linkedByCode, orphan],
      imageAuditStatus: {},
      sectionStatus: {},
    } as ConstructionManagementResponse;

    const compact = compactConstructionManagementResponse(response);
    const serialized = JSON.stringify(compact);

    expect(compact.transport).toBe('normalized-followups-v1');
    expect(compact.items[0]).not.toHaveProperty('followups');
    expect(compact.items[0]).not.toHaveProperty('latestFollowup');
    expect(serialized.match(/"recordId":"followup-by-id"/g)).toHaveLength(1);
    expect(serialized.match(/"recordId":"orphan-followup"/g)).toHaveLength(1);

    const expanded = expandConstructionManagementResponse(
      JSON.parse(serialized),
    );

    expect(expanded).toEqual(response);
    expect(expanded.items[0].followups[0]).toBe(expanded.followups[0]);
    expect(expanded.items[0].latestFollowup).toBe(expanded.followups[0]);
    expect(expanded.followups.map((item) => item.recordId)).toContain(
      'orphan-followup',
    );
  });

  it('leaves the legacy full response untouched for rolling deployments', () => {
    const response = {
      generatedAt: '2026-07-27T00:00:00.000Z',
      summary: {},
      items: [],
      followups: [],
      imageAuditStatus: {},
      sectionStatus: {},
    } as ConstructionManagementResponse;

    expect(expandConstructionManagementResponse(response)).toBe(response);
  });
});
