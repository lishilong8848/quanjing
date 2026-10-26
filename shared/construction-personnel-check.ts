import type { ConstructionCrewMemberItem } from './api.interface';

export interface ConstructionCrewAuthorizationSummary {
  totalCount: number;
  authorizedCount: number;
  expiredCount: number;
  pendingCount: number;
  missingCount: number;
  notice: string | null;
  authorizedMembers: ConstructionCrewMemberItem[];
}

export function getConstructionCrewAuthorizationSummary(
  crewMembers: readonly ConstructionCrewMemberItem[],
): ConstructionCrewAuthorizationSummary {
  const authorizedMembers: ConstructionCrewMemberItem[] = [];
  let expiredCount = 0;
  let pendingCount = 0;
  let missingCount = 0;

  crewMembers.forEach((member) => {
    if (member.authorizationStatus === '授权有效') {
      authorizedMembers.push(member);
      return;
    }
    if (member.authorizationStatus === '已过期') {
      expiredCount += 1;
      return;
    }
    if (member.authorizationStatus === '未开始') {
      pendingCount += 1;
      return;
    }
    missingCount += 1;
  });

  const totalCount = crewMembers.length;
  let notice: string | null = null;
  if (totalCount > 0 && expiredCount === totalCount) {
    notice = '该项目授权人员已过期，需更新授权';
  } else if (totalCount > 0 && authorizedMembers.length === 0) {
    notice = '该项目暂无授权有效人员，需更新人员授权';
  } else {
    const issues = [
      expiredCount > 0
        ? `${expiredCount} 名人员授权已过期，暂不可参与今日核查`
        : '',
      pendingCount > 0
        ? `${pendingCount} 名人员授权尚未生效，暂不可参与今日核查`
        : '',
      missingCount > 0
        ? `${missingCount} 名人员未设置授权，暂不可参与今日核查`
        : '',
    ].filter(Boolean);
    if (issues.length > 0) {
      notice = `该项目有 ${issues.join('；')}`;
    }
  }

  return {
    totalCount,
    authorizedCount: authorizedMembers.length,
    expiredCount,
    pendingCount,
    missingCount,
    notice,
    authorizedMembers,
  };
}

export function buildDailyPersonnelCheckText(
  crewMembers: ConstructionCrewMemberItem[],
  checkedIds: string[],
  fallbackText: string,
) {
  if (crewMembers.length === 0) {
    return fallbackText.trim();
  }

  const checkedSet = new Set(checkedIds);
  const present = crewMembers.filter(
    (member) =>
      member.authorizationStatus === '授权有效' &&
      checkedSet.has(member.recordId),
  );

  if (present.length === 0) {
    return '';
  }

  const presentSummary = present
    .map((member) =>
      member.certificateSummary
        ? `${member.name}（${member.certificateSummary}）`
        : member.name,
    )
    .join('、');

  return [
    '已核对施工人员台账',
    `今日参与施工（${present.length}人）：${presentSummary}`,
  ].join('；');
}
