import type {
  ConstructionAttachmentFile,
  ConstructionAttachmentGroup,
  ConstructionFollowupItem,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
} from '../../../../shared/api.interface';

export interface ConstructionAttachmentTombstone {
  source: 'followup' | 'overview';
  recordId: string;
  fieldKey: string;
  fileToken: string;
}

export interface ConstructionAttachmentTombstoneTarget {
  recordId: string;
  fieldKey: string;
  fileToken: string;
}

export interface ConstructionAttachmentTombstoneReconciliation {
  pending: ConstructionAttachmentTombstone[];
  confirmed: ConstructionAttachmentTombstone[];
}

const FOLLOWUP_ATTACHMENT_LABELS: Record<string, readonly string[]> = {
  applicationFiles: ['施工作业申请单', '施工申请作业单', '施工申请单'],
  crewRosterFiles: [
    '施工人员名单',
    '施工人员信息表--初始',
    '施工人员名册--迭代',
    '施工人员增删名单',
  ],
  dailyPersonnelChecklistFiles: ['每日人员核查清单'],
  trainingPhotoFiles: ['入场培训照片', '培训照片'],
  entryTrainingSignInFiles: ['入场培训签到表'],
  entryTrainingAssessmentFiles: ['入场培训考核'],
  safetyNoticePhotoFiles: ['安全告知书', '安全告知书照片'],
  temporaryPowerRiskDisclosureFiles: [
    '临电作业风险交底单',
    '临时用电风险交底单',
  ],
  temporaryPowerTrainingSignInFiles: ['临电作业培训签到表', '临时用电培训签到'],
  temporaryPowerTrainingAssessmentFiles: [
    '临电作业培训考核',
    '临时用电培训考核',
  ],
  hotWorkRiskDisclosureFiles: ['动火作业风险交底单', '动火风险交底单'],
  hotWorkTrainingSignInFiles: ['动火作业培训签到表', '动火培训签到'],
  hotWorkTrainingAssessmentFiles: ['动火作业培训考核', '动火培训考核'],
  heightWorkRiskDisclosureFiles: ['高处作业风险交底单', '高处风险交底单'],
  heightWorkTrainingSignInFiles: ['高处作业培训签到表', '高处培训签到'],
  heightWorkTrainingAssessmentFiles: ['高处作业培训考核', '高处培训考核'],
  confinedSpaceRiskDisclosureFiles: [
    '受限空间作业风险交底单',
    '受限空间风险交底单',
  ],
  confinedSpaceTrainingSignInFiles: [
    '受限空间作业培训签到表',
    '受限空间培训签到',
  ],
  confinedSpaceTrainingAssessmentFiles: [
    '受限空间作业培训考核',
    '受限空间培训考核',
  ],
  excavationRiskDisclosureFiles: [
    '开挖动土作业风险交底单',
    '开挖动土风险交底单',
    '动土风险交底单',
  ],
  excavationTrainingSignInFiles: [
    '开挖动土作业培训签到表',
    '开挖动土培训签到',
    '动土培训签到',
  ],
  excavationTrainingAssessmentFiles: [
    '开挖动土作业培训考核',
    '开挖动土培训考核',
    '动土培训考核',
  ],
  liftingRiskDisclosureFiles: ['吊装作业风险交底单', '吊装风险交底单'],
  liftingTrainingSignInFiles: ['吊装作业培训签到表', '吊装培训签到'],
  liftingTrainingAssessmentFiles: ['吊装作业培训考核', '吊装培训考核'],
  fireSystemShutdownRiskDisclosureFiles: [
    '消防系统关闭作业风险交底单',
    '消防系统关闭风险交底单',
  ],
  fireSystemShutdownTrainingSignInFiles: [
    '消防系统关闭作业培训签到表',
    '消防系统关闭培训签到',
  ],
  fireSystemShutdownTrainingAssessmentFiles: [
    '消防系统关闭作业培训考核',
    '消防系统关闭培训考核',
  ],
  confinedSpacePermitFiles: [
    '受限空间作业票',
    '受限空间许可证',
    '受限空间作业许可证',
  ],
  temporaryPowerPermitFiles: ['临时用电作业票', '临时用电作业许可证'],
  hotWorkPermitFiles: ['动火作业票', '动火许可证', '动火作业许可证'],
  heightWorkPermitFiles: ['高处作业票', '高处作业许可证'],
  excavationPermitFiles: [
    '开挖动土作业票',
    '开挖动土作业许可',
    '开挖动土作业许可证',
  ],
  liftingPermitFiles: [
    '吊装作业票',
    '吊装作业单',
    '吊装作业许可',
    '吊装作业许可证',
  ],
  fireSystemShutdownPermitFiles: [
    '消防系统关闭作业票',
    '消防系统关闭作业许可证',
  ],
  isolationPhotoFiles: ['挂牌与隔离照片'],
  processPhotoFiles: ['施工过程照片'],
  closingPhotoFiles: ['每日收尾照片', '施工收尾照片'],
  inspectionFormFiles: ['施工检查表', '每日收尾检查表'],
};

const OVERVIEW_FILE_PROPERTIES = {
  constructionIssueFiles: 'constructionIssues',
  completionChecklistArchiveFiles: 'completionChecklistArchive',
  depositAgreementFiles: 'depositAgreementFiles',
  depositTransferFiles: 'depositTransferFiles',
} as const satisfies Record<
  string,
  | 'constructionIssues'
  | 'completionChecklistArchive'
  | 'depositAgreementFiles'
  | 'depositTransferFiles'
>;

export function getConstructionAttachmentTombstoneKey(
  target: ConstructionAttachmentTombstoneTarget,
): string {
  return JSON.stringify([target.recordId, target.fieldKey, target.fileToken]);
}

export function registerConstructionAttachmentTombstone(
  current: readonly ConstructionAttachmentTombstone[],
  tombstone: ConstructionAttachmentTombstone,
): ConstructionAttachmentTombstone[] {
  const key = getConstructionAttachmentTombstoneKey(tombstone);
  return [
    ...current.filter(
      (candidate) => getConstructionAttachmentTombstoneKey(candidate) !== key,
    ),
    { ...tombstone },
  ];
}

export function revokeConstructionAttachmentTombstone(
  current: readonly ConstructionAttachmentTombstone[],
  target: ConstructionAttachmentTombstoneTarget,
): ConstructionAttachmentTombstone[] {
  const key = getConstructionAttachmentTombstoneKey(target);
  return current.filter(
    (candidate) => getConstructionAttachmentTombstoneKey(candidate) !== key,
  );
}

export function selectConstructionAttachmentTombstones(
  current: readonly ConstructionAttachmentTombstone[],
  filter: Partial<
    Pick<ConstructionAttachmentTombstone, 'source' | 'recordId' | 'fieldKey'>
  > = {},
): ConstructionAttachmentTombstone[] {
  return current.filter(
    (tombstone) =>
      (filter.source === undefined || tombstone.source === filter.source) &&
      (filter.recordId === undefined ||
        tombstone.recordId === filter.recordId) &&
      (filter.fieldKey === undefined || tombstone.fieldKey === filter.fieldKey),
  );
}

function groupMatchesFieldKey(
  group: Pick<ConstructionAttachmentGroup, 'field' | 'label'>,
  fieldKey: string,
): boolean {
  const groupField = String(group.field || '').trim();
  const groupLabel = String(group.label || '').trim();
  if (groupField === fieldKey || groupLabel === fieldKey) {
    return true;
  }
  return (FOLLOWUP_ATTACHMENT_LABELS[fieldKey] || []).some(
    (candidate) =>
      groupField === candidate ||
      groupLabel === candidate ||
      (groupField &&
        (groupField.includes(candidate) || candidate.includes(groupField))) ||
      (groupLabel &&
        (groupLabel.includes(candidate) || candidate.includes(groupLabel))),
  );
}

function overlayAttachmentGroups(
  groups: readonly ConstructionAttachmentGroup[],
  tombstones: readonly ConstructionAttachmentTombstone[],
): ConstructionAttachmentGroup[] {
  let changed = false;
  const next = groups.map((group) => {
    const removedTokens = new Set(
      tombstones
        .filter((tombstone) => groupMatchesFieldKey(group, tombstone.fieldKey))
        .map((tombstone) => tombstone.fileToken),
    );
    if (
      removedTokens.size === 0 ||
      !group.files.some((file) => removedTokens.has(file.fileToken))
    ) {
      return group;
    }
    changed = true;
    const files = group.files.filter(
      (file) => !removedTokens.has(file.fileToken),
    );
    return {
      ...group,
      count: files.length,
      files,
      status: files.length > 0 ? group.status : ('empty' as const),
    };
  });
  return changed ? next : (groups as ConstructionAttachmentGroup[]);
}

function overlayFollowup(
  item: ConstructionFollowupItem,
  tombstones: readonly ConstructionAttachmentTombstone[],
): ConstructionFollowupItem {
  const matching = tombstones.filter(
    (tombstone) =>
      tombstone.source === 'followup' && tombstone.recordId === item.recordId,
  );
  if (matching.length === 0) {
    return item;
  }
  const attachments = overlayAttachmentGroups(item.attachments, matching);
  return attachments === item.attachments
    ? item
    : {
        ...item,
        attachments,
      };
}

function filterFiles(
  files: readonly ConstructionAttachmentFile[],
  removedTokens: ReadonlySet<string>,
): ConstructionAttachmentFile[] {
  if (!files.some((file) => removedTokens.has(file.fileToken))) {
    return files as ConstructionAttachmentFile[];
  }
  return files.filter((file) => !removedTokens.has(file.fileToken));
}

function overlayOverview(
  item: ConstructionOverviewItem,
  tombstones: readonly ConstructionAttachmentTombstone[],
): ConstructionOverviewItem {
  const matching = tombstones.filter(
    (tombstone) =>
      tombstone.source === 'overview' && tombstone.recordId === item.recordId,
  );
  let next = item;
  matching.forEach((tombstone) => {
    const property =
      OVERVIEW_FILE_PROPERTIES[
        tombstone.fieldKey as keyof typeof OVERVIEW_FILE_PROPERTIES
      ];
    if (property) {
      const currentFiles = next[property];
      const files = filterFiles(currentFiles, new Set([tombstone.fileToken]));
      if (files !== currentFiles) {
        next = {
          ...next,
          [property]: files,
        };
      }
      return;
    }
    const applicationAttachments = overlayAttachmentGroups(
      next.applicationAttachments,
      [tombstone],
    );
    if (applicationAttachments !== next.applicationAttachments) {
      next = {
        ...next,
        applicationAttachments,
      };
    }
  });
  return next;
}

export function overlayConstructionAttachmentTombstones(
  data: ConstructionManagementResponse,
  tombstones: readonly ConstructionAttachmentTombstone[],
): ConstructionManagementResponse {
  if (tombstones.length === 0) {
    return data;
  }
  let changed = false;
  const followups = data.followups.map((followup) => {
    const next = overlayFollowup(followup, tombstones);
    changed ||= next !== followup;
    return next;
  });
  const items = data.items.map((item) => {
    let next = overlayOverview(item, tombstones);
    const followups = next.followups.map((followup) =>
      overlayFollowup(followup, tombstones),
    );
    const latestFollowup = next.latestFollowup
      ? overlayFollowup(next.latestFollowup, tombstones)
      : null;
    if (
      followups.some((followup, index) => followup !== next.followups[index]) ||
      latestFollowup !== next.latestFollowup
    ) {
      next = {
        ...next,
        followups,
        latestFollowup,
      };
    }
    changed ||= next !== item;
    return next;
  });

  return changed
    ? {
        ...data,
        items,
        followups,
      }
    : data;
}

function findFollowupsByRecordId(
  data: ConstructionManagementResponse,
  recordId: string,
): ConstructionFollowupItem[] {
  return [
    ...data.followups.filter((followup) => followup.recordId === recordId),
    ...data.items.flatMap((item) => [
      ...item.followups.filter((followup) => followup.recordId === recordId),
      ...(item.latestFollowup?.recordId === recordId
        ? [item.latestFollowup]
        : []),
    ]),
  ];
}

function getTombstonePresence(
  data: ConstructionManagementResponse,
  tombstone: ConstructionAttachmentTombstone,
): 'present' | 'missing' | 'unknown' {
  if (tombstone.source === 'followup') {
    const followups = findFollowupsByRecordId(data, tombstone.recordId);
    if (followups.length === 0) {
      return 'unknown';
    }
    const matchingGroups = followups.flatMap((followup) =>
      followup.attachments.filter((group) =>
        groupMatchesFieldKey(group, tombstone.fieldKey),
      ),
    );
    if (matchingGroups.length === 0) {
      return 'unknown';
    }
    return matchingGroups.some((group) =>
      group.files.some((file) => file.fileToken === tombstone.fileToken),
    )
      ? 'present'
      : 'missing';
  }

  const overview = data.items.find(
    (item) => item.recordId === tombstone.recordId,
  );
  if (!overview) {
    return 'unknown';
  }
  const property =
    OVERVIEW_FILE_PROPERTIES[
      tombstone.fieldKey as keyof typeof OVERVIEW_FILE_PROPERTIES
    ];
  if (property) {
    return overview[property].some(
      (file) => file.fileToken === tombstone.fileToken,
    )
      ? 'present'
      : 'missing';
  }
  const matchingGroups = overview.applicationAttachments.filter((group) =>
    groupMatchesFieldKey(group, tombstone.fieldKey),
  );
  if (matchingGroups.length === 0) {
    return 'unknown';
  }
  return matchingGroups.some((group) =>
    group.files.some((file) => file.fileToken === tombstone.fileToken),
  )
    ? 'present'
    : 'missing';
}

export function reconcileConstructionAttachmentTombstones(
  current: readonly ConstructionAttachmentTombstone[],
  authoritativeData: ConstructionManagementResponse,
): ConstructionAttachmentTombstoneReconciliation {
  const pending: ConstructionAttachmentTombstone[] = [];
  const confirmed: ConstructionAttachmentTombstone[] = [];
  current.forEach((tombstone) => {
    if (getTombstonePresence(authoritativeData, tombstone) === 'missing') {
      confirmed.push(tombstone);
    } else {
      pending.push(tombstone);
    }
  });
  return { pending, confirmed };
}
