import type {
  ConstructionFollowupItem,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
} from './api.interface';

export const CONSTRUCTION_MANAGEMENT_TRANSPORT =
  'normalized-followups-v1' as const;

export type CompactConstructionOverviewItem = Omit<
  ConstructionOverviewItem,
  'followups' | 'latestFollowup'
>;

export type CompactConstructionManagementResponse = Omit<
  ConstructionManagementResponse,
  'items'
> & {
  transport: typeof CONSTRUCTION_MANAGEMENT_TRANSPORT;
  items: CompactConstructionOverviewItem[];
};

export type ConstructionManagementTransportResponse =
  | ConstructionManagementResponse
  | CompactConstructionManagementResponse;

export function compactConstructionManagementResponse(
  response: ConstructionManagementResponse,
): CompactConstructionManagementResponse {
  return {
    ...response,
    transport: CONSTRUCTION_MANAGEMENT_TRANSPORT,
    items: response.items.map(({ followups, latestFollowup, ...item }) => {
      void followups;
      void latestFollowup;
      return item;
    }),
  };
}

export function expandConstructionManagementResponse(
  response: ConstructionManagementTransportResponse,
): ConstructionManagementResponse {
  if (!isCompactConstructionManagementResponse(response)) {
    return response;
  }

  const followupsByOverviewId = new Map<string, ConstructionFollowupItem[]>();
  const followupsByCode = new Map<string, ConstructionFollowupItem[]>();

  for (const followup of response.followups) {
    for (const overviewRecordId of followup.overviewRecordIds) {
      appendToGroup(followupsByOverviewId, overviewRecordId, followup);
    }
    if (followup.constructionCode) {
      appendToGroup(followupsByCode, followup.constructionCode, followup);
    }
  }

  const items = response.items.map((item): ConstructionOverviewItem => {
    const linkedFollowups = dedupeFollowups([
      ...(followupsByOverviewId.get(item.recordId) || []),
      ...(item.constructionCode
        ? followupsByCode.get(item.constructionCode) || []
        : []),
    ]);

    return {
      ...item,
      followups: linkedFollowups,
      latestFollowup:
        linkedFollowups.find((followup) => followup.isLatest) ||
        linkedFollowups[0] ||
        null,
    };
  });
  const { transport, ...expanded } = response;
  return {
    ...expanded,
    items,
  };
}

function isCompactConstructionManagementResponse(
  response: ConstructionManagementTransportResponse,
): response is CompactConstructionManagementResponse {
  return (
    'transport' in response &&
    response.transport === CONSTRUCTION_MANAGEMENT_TRANSPORT
  );
}

function appendToGroup(
  groups: Map<string, ConstructionFollowupItem[]>,
  key: string,
  followup: ConstructionFollowupItem,
): void {
  const group = groups.get(key);
  if (group) {
    group.push(followup);
    return;
  }
  groups.set(key, [followup]);
}

function dedupeFollowups(
  followups: ConstructionFollowupItem[],
): ConstructionFollowupItem[] {
  const seen = new Set<string>();
  return followups.filter((followup) => {
    if (seen.has(followup.recordId)) return false;
    seen.add(followup.recordId);
    return true;
  });
}
