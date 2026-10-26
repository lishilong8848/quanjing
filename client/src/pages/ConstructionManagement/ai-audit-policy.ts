export type ConstructionAttachmentAuditStatus =
  | 'issue'
  | 'complete'
  | 'empty';

export interface ConstructionAttachmentAuditPresentation {
  status: ConstructionAttachmentAuditStatus;
  feedbacks: string[];
}

export function resolveConstructionAttachmentAuditPresentation({
  enabled,
  count,
  hasAiIssue,
  aiFeedbacks,
}: {
  enabled?: boolean;
  count: number;
  hasAiIssue: boolean;
  aiFeedbacks: readonly string[];
}): ConstructionAttachmentAuditPresentation {
  const aiAuditEnabled = enabled === true;
  return {
    status:
      aiAuditEnabled && hasAiIssue
        ? 'issue'
        : count > 0
          ? 'complete'
          : 'empty',
    feedbacks: aiAuditEnabled ? Array.from(new Set(aiFeedbacks)) : [],
  };
}

export type ConstructionAiAuditProblemEntry = readonly [
  label: string,
  detail: string | null | undefined,
];

export function buildConstructionAiAuditProblemEntries({
  enabled,
  isolationFeedback,
  closingFeedback,
  attachmentIssues,
  aiIssues,
}: {
  enabled?: boolean;
  isolationFeedback?: string | null;
  closingFeedback?: string | null;
  attachmentIssues: readonly {
    label: string;
    feedback?: string | null;
  }[];
  aiIssues: readonly string[];
}): ConstructionAiAuditProblemEntry[] {
  if (enabled !== true) {
    return [];
  }

  return [
    ['挂牌隔离反馈', isolationFeedback],
    ['收尾反馈', closingFeedback],
    ...attachmentIssues.map(
      (attachment) =>
        [`${attachment.label}审核`, attachment.feedback] as const,
    ),
    ...aiIssues.map((issue) => ['AI识别问题', issue] as const),
  ];
}

export type ConstructionApprovalMaterialTone =
  | 'done'
  | 'issue'
  | 'pending'
  | 'active';

export interface ConstructionMaterialSubmissionState {
  status: string;
  tone: ConstructionApprovalMaterialTone;
  passed: boolean;
}

export function resolveConstructionMaterialSubmissionState({
  enabled,
  workflowClosed,
  ehsNotified,
  requiredCount,
  uploadedCount,
  aiIssueCount,
}: {
  enabled?: boolean;
  workflowClosed: boolean;
  ehsNotified: boolean;
  requiredCount: number;
  uploadedCount: number;
  aiIssueCount: number;
}): ConstructionMaterialSubmissionState {
  if (workflowClosed) {
    return { status: '材料已提交', tone: 'done', passed: true };
  }
  if (!ehsNotified) {
    return { status: '待EHS知会', tone: 'pending', passed: false };
  }
  if (requiredCount === 0) {
    return { status: '无附件要求', tone: 'done', passed: true };
  }

  const effectiveAiIssueCount = enabled === true ? aiIssueCount : 0;
  if (effectiveAiIssueCount > 0) {
    return {
      status: `材料需复核 ${uploadedCount}/${requiredCount}`,
      tone: 'issue',
      passed: false,
    };
  }
  if (uploadedCount === requiredCount) {
    return { status: '材料已提交', tone: 'done', passed: true };
  }
  return {
    status: `待提交材料 ${uploadedCount}/${requiredCount}`,
    tone: 'active',
    passed: false,
  };
}

export interface ConstructionLifecycleAuditPolicy {
  applicationIssueCount: number;
  prepareIssueCount: number;
  isolationBlocked: boolean;
  processBlocked: boolean;
  closeBlocked: boolean;
}

export function resolveConstructionLifecycleAuditPolicy({
  enabled,
  applicationAiIssueCount,
  prepareAiIssueCount,
  isolationAiIssue,
  isolationManualPassed,
  isolationManualIssue,
  processManualIssue,
  closingAiIssue,
  closingApprovalRejected,
}: {
  enabled?: boolean;
  applicationAiIssueCount: number;
  prepareAiIssueCount: number;
  isolationAiIssue: boolean;
  isolationManualPassed: boolean;
  isolationManualIssue: boolean;
  processManualIssue: boolean;
  closingAiIssue: boolean;
  closingApprovalRejected: boolean;
}): ConstructionLifecycleAuditPolicy {
  const aiAuditEnabled = enabled === true;
  return {
    applicationIssueCount: aiAuditEnabled ? applicationAiIssueCount : 0,
    prepareIssueCount: aiAuditEnabled ? prepareAiIssueCount : 0,
    isolationBlocked:
      isolationManualIssue ||
      (aiAuditEnabled && !isolationManualPassed && isolationAiIssue),
    processBlocked: processManualIssue,
    closeBlocked:
      closingApprovalRejected || (aiAuditEnabled && closingAiIssue),
  };
}
