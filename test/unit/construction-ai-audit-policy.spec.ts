import {
  buildConstructionAiAuditProblemEntries,
  resolveConstructionAttachmentAuditPresentation,
  resolveConstructionLifecycleAuditPolicy,
  resolveConstructionMaterialSubmissionState,
} from '../../client/src/pages/ConstructionManagement/ai-audit-policy';

describe('construction AI audit policy', () => {
  it('keeps attachment files but hides historical AI issue state when disabled', () => {
    expect(
      resolveConstructionAttachmentAuditPresentation({
        enabled: false,
        count: 2,
        hasAiIssue: true,
        aiFeedbacks: ['AI识别异常'],
      }),
    ).toEqual({
      status: 'complete',
      feedbacks: [],
    });

    expect(
      resolveConstructionAttachmentAuditPresentation({
        enabled: true,
        count: 2,
        hasAiIssue: true,
        aiFeedbacks: ['AI识别异常'],
      }),
    ).toEqual({
      status: 'issue',
      feedbacks: ['AI识别异常'],
    });
  });

  it('excludes all AI problem entries when disabled and restores them when enabled', () => {
    const input = {
      isolationFeedback: '挂牌隔离AI不通过',
      closingFeedback: '收尾AI不通过',
      attachmentIssues: [
        {
          label: '动火作业票',
          feedback: '附件AI异常',
        },
      ],
      aiIssues: ['综合AI异常'],
    };

    expect(
      buildConstructionAiAuditProblemEntries({
        ...input,
        enabled: false,
      }),
    ).toEqual([]);
    expect(
      buildConstructionAiAuditProblemEntries({
        ...input,
        enabled: true,
      }),
    ).toEqual([
      ['挂牌隔离反馈', '挂牌隔离AI不通过'],
      ['收尾反馈', '收尾AI不通过'],
      ['动火作业票审核', '附件AI异常'],
      ['AI识别问题', '综合AI异常'],
    ]);
  });

  it('ignores material AI issues only while the switch is disabled', () => {
    const common = {
      workflowClosed: false,
      ehsNotified: true,
      requiredCount: 4,
      uploadedCount: 4,
      aiIssueCount: 1,
    };

    expect(
      resolveConstructionMaterialSubmissionState({
        ...common,
        enabled: false,
      }),
    ).toEqual({
      status: '材料已提交',
      tone: 'done',
      passed: true,
    });
    expect(
      resolveConstructionMaterialSubmissionState({
        ...common,
        enabled: true,
      }),
    ).toEqual({
      status: '材料需复核 4/4',
      tone: 'issue',
      passed: false,
    });
  });

  it('preserves manual lifecycle blocks while gating only AI findings', () => {
    const disabled = resolveConstructionLifecycleAuditPolicy({
      enabled: false,
      applicationAiIssueCount: 2,
      prepareAiIssueCount: 3,
      isolationAiIssue: true,
      isolationManualPassed: false,
      isolationManualIssue: true,
      processManualIssue: true,
      closingAiIssue: true,
      closingApprovalRejected: true,
    });

    expect(disabled).toEqual({
      applicationIssueCount: 0,
      prepareIssueCount: 0,
      isolationBlocked: true,
      processBlocked: true,
      closeBlocked: true,
    });

    expect(
      resolveConstructionLifecycleAuditPolicy({
        enabled: false,
        applicationAiIssueCount: 2,
        prepareAiIssueCount: 3,
        isolationAiIssue: true,
        isolationManualPassed: false,
        isolationManualIssue: false,
        processManualIssue: false,
        closingAiIssue: true,
        closingApprovalRejected: false,
      }),
    ).toEqual({
      applicationIssueCount: 0,
      prepareIssueCount: 0,
      isolationBlocked: false,
      processBlocked: false,
      closeBlocked: false,
    });

    expect(
      resolveConstructionLifecycleAuditPolicy({
        enabled: true,
        applicationAiIssueCount: 2,
        prepareAiIssueCount: 3,
        isolationAiIssue: true,
        isolationManualPassed: false,
        isolationManualIssue: false,
        processManualIssue: false,
        closingAiIssue: true,
        closingApprovalRejected: false,
      }),
    ).toEqual({
      applicationIssueCount: 2,
      prepareIssueCount: 3,
      isolationBlocked: true,
      processBlocked: false,
      closeBlocked: true,
    });
  });

  it('lets an explicit isolation manual pass override historical AI findings', () => {
    expect(
      resolveConstructionLifecycleAuditPolicy({
        enabled: true,
        applicationAiIssueCount: 0,
        prepareAiIssueCount: 0,
        isolationAiIssue: true,
        isolationManualPassed: true,
        isolationManualIssue: false,
        processManualIssue: false,
        closingAiIssue: false,
        closingApprovalRejected: false,
      }).isolationBlocked,
    ).toBe(false);
  });
});
