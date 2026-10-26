import type {
  ConstructionAttachmentFile,
  ConstructionAttachmentGroup,
  ConstructionFollowupItem,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
} from '../../shared/api.interface';
import {
  overlayConstructionAttachmentTombstones,
  reconcileConstructionAttachmentTombstones,
  registerConstructionAttachmentTombstone,
  revokeConstructionAttachmentTombstone,
  selectConstructionAttachmentTombstones,
} from '../../client/src/pages/ConstructionManagement/attachment-tombstones';

function attachment(fileToken: string): ConstructionAttachmentFile {
  return {
    fileToken,
    name: `${fileToken}.jpg`,
    size: 100,
  };
}

function attachmentGroup(
  field: string,
  label: string,
  fileTokens: string[],
): ConstructionAttachmentGroup {
  return {
    field,
    label,
    count: fileTokens.length,
    files: fileTokens.map(attachment),
    status: fileTokens.length > 0 ? 'complete' : 'empty',
    feedback: null,
  };
}

function followup(
  recordId: string,
  attachments: ConstructionAttachmentGroup[],
): ConstructionFollowupItem {
  return {
    recordId,
    title: recordId,
    constructionCode: 'SG-1',
    workContent: '测试施工',
    workTypes: ['一般作业'],
    overviewRecordIds: ['project-1'],
    constructionDay: 1,
    isLatest: true,
    followupStaff: null,
    followupStaffMembers: [],
    completed: null,
    dailyPersonnelCheck: null,
    isolationCompliant: null,
    isolationFeedback: null,
    processFeedback: null,
    closingFeedback: null,
    closingApproval: null,
    completionChecklist: [],
    followupDate: '2026-07-24',
    createdAt: null,
    updatedAt: null,
    recordUrl: null,
    attachments,
    aiIssues: [],
  };
}

function overview(
  recordId: string,
  itemFollowup: ConstructionFollowupItem,
): ConstructionOverviewItem {
  return {
    recordId,
    constructionCode: 'SG-1',
    workContent: '测试施工',
    building: 'A楼',
    specialty: '其他',
    contractorType: '外部',
    workTypes: ['一般作业'],
    relatedWorkType: null,
    workflow: '施工中',
    planStartTime: null,
    planEndTime: null,
    remainingDays: null,
    approval: {
      supervisor: null,
      ehsNotified: null,
      ehs: null,
      credential: null,
      depositConfirmation: null,
      parkSync: null,
      depositPaid: null,
    },
    deposit: {
      amount: null,
      deducted: null,
      balance: null,
    },
    managers: {
      supervisor: null,
      safety: null,
      park: null,
      applicant: null,
      engineer: null,
    },
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    recordUrl: null,
    applicationAttachments: [],
    constructionIssues: [attachment('issue-1'), attachment('issue-2')],
    completionChecklistArchive: [attachment('checklist-1')],
    depositAgreementFiles: [attachment('agreement-1')],
    depositTransferFiles: [attachment('transfer-1')],
    crewMembers: [],
    followups: [itemFollowup],
    latestFollowup: itemFollowup,
  };
}

function response(): ConstructionManagementResponse {
  const itemFollowup = followup('followup-1', [
    attachmentGroup('施工过程照片', '施工过程照片', ['process-1', 'process-2']),
    attachmentGroup('每日收尾照片', '每日收尾照片', ['closing-1']),
  ]);
  return {
    generatedAt: '2026-07-24T00:00:00.000Z',
    summary: {
      total: 1,
      active: 1,
      pendingApproval: 0,
      endingSoon: 0,
      attachmentIssues: 0,
      completedFollowups: 0,
      latestUpdatedAt: null,
    },
    items: [overview('project-1', itemFollowup)],
    followups: [itemFollowup],
    imageAuditStatus: {
      configured: false,
      provider: '',
      model: null,
      baseUrl: null,
      supportsImageInput: false,
      message: '',
    },
    sectionStatus: {
      overview: { configured: true },
      followups: { configured: true },
    },
  };
}

describe('施工管理 attachment tombstones', () => {
  it('以 recordId + fieldKey + fileToken 独立登记，并可按单 token 撤销失败删除', () => {
    let registry = registerConstructionAttachmentTombstone([], {
      source: 'followup',
      recordId: 'followup-1',
      fieldKey: 'processPhotoFiles',
      fileToken: 'process-1',
    });
    registry = registerConstructionAttachmentTombstone(registry, {
      source: 'followup',
      recordId: 'followup-1',
      fieldKey: 'processPhotoFiles',
      fileToken: 'process-2',
    });

    const afterFailure = revokeConstructionAttachmentTombstone(registry, {
      recordId: 'followup-1',
      fieldKey: 'processPhotoFiles',
      fileToken: 'process-1',
    });

    expect(selectConstructionAttachmentTombstones(afterFailure)).toEqual([
      expect.objectContaining({ fileToken: 'process-2' }),
    ]);
    expect(registry).toHaveLength(2);
  });

  it('弹窗关闭后仍从 followup 和 overview 响应不可变地遮罩 token', () => {
    const source = response();
    const originalItem = source.items[0];
    const originalFollowup = source.followups[0];
    let registry = registerConstructionAttachmentTombstone([], {
      source: 'followup',
      recordId: 'followup-1',
      fieldKey: 'processPhotoFiles',
      fileToken: 'process-1',
    });
    registry = registerConstructionAttachmentTombstone(registry, {
      source: 'overview',
      recordId: 'project-1',
      fieldKey: 'constructionIssueFiles',
      fileToken: 'issue-1',
    });

    const overlaid = overlayConstructionAttachmentTombstones(source, registry);

    expect(
      overlaid.followups[0].attachments[0].files.map((file) => file.fileToken),
    ).toEqual(['process-2']);
    expect(
      overlaid.items[0].followups[0].attachments[0].files.map(
        (file) => file.fileToken,
      ),
    ).toEqual(['process-2']);
    expect(
      overlaid.items[0].latestFollowup?.attachments[0].files.map(
        (file) => file.fileToken,
      ),
    ).toEqual(['process-2']);
    expect(
      overlaid.items[0].constructionIssues.map((file) => file.fileToken),
    ).toEqual(['issue-2']);
    expect(source.items[0]).toBe(originalItem);
    expect(source.followups[0]).toBe(originalFollowup);
    expect(
      source.followups[0].attachments[0].files.map((file) => file.fileToken),
    ).toEqual(['process-1', 'process-2']);
    expect(
      source.items[0].constructionIssues.map((file) => file.fileToken),
    ).toEqual(['issue-1', 'issue-2']);
  });

  it('普通读取仅清理已确认消失的 token，仍存在或未找到记录的 tombstone 继续保留', () => {
    const current = response();
    let registry = registerConstructionAttachmentTombstone([], {
      source: 'followup',
      recordId: 'followup-1',
      fieldKey: 'processPhotoFiles',
      fileToken: 'process-1',
    });
    registry = registerConstructionAttachmentTombstone(registry, {
      source: 'followup',
      recordId: 'followup-1',
      fieldKey: 'processPhotoFiles',
      fileToken: 'process-gone',
    });
    registry = registerConstructionAttachmentTombstone(registry, {
      source: 'overview',
      recordId: 'missing-project',
      fieldKey: 'constructionIssueFiles',
      fileToken: 'unknown',
    });

    const result = reconcileConstructionAttachmentTombstones(registry, current);

    expect(result.confirmed.map((item) => item.fileToken)).toEqual([
      'process-gone',
    ]);
    expect(result.pending.map((item) => item.fileToken)).toEqual([
      'process-1',
      'unknown',
    ]);
  });

  it('顶层与项目内跟进副本暂时不一致时，只要任一副本仍有 token 就不确认删除', () => {
    const current = response();
    current.followups = [
      followup('followup-1', [
        attachmentGroup('施工过程照片', '施工过程照片', ['process-2']),
      ]),
    ];
    const registry = registerConstructionAttachmentTombstone([], {
      source: 'followup',
      recordId: 'followup-1',
      fieldKey: 'processPhotoFiles',
      fileToken: 'process-1',
    });

    const result = reconcileConstructionAttachmentTombstones(registry, current);

    expect(result.confirmed).toEqual([]);
    expect(result.pending).toEqual([
      expect.objectContaining({ fileToken: 'process-1' }),
    ]);
  });

  it('overview 的完工清单和质保金附件字段也可按 token 遮罩', () => {
    const source = response();
    let registry = registerConstructionAttachmentTombstone([], {
      source: 'overview',
      recordId: 'project-1',
      fieldKey: 'completionChecklistArchiveFiles',
      fileToken: 'checklist-1',
    });
    registry = registerConstructionAttachmentTombstone(registry, {
      source: 'overview',
      recordId: 'project-1',
      fieldKey: 'depositAgreementFiles',
      fileToken: 'agreement-1',
    });
    registry = registerConstructionAttachmentTombstone(registry, {
      source: 'overview',
      recordId: 'project-1',
      fieldKey: 'depositTransferFiles',
      fileToken: 'transfer-1',
    });

    const overlaid = overlayConstructionAttachmentTombstones(source, registry);

    expect(overlaid.items[0].completionChecklistArchive).toEqual([]);
    expect(overlaid.items[0].depositAgreementFiles).toEqual([]);
    expect(overlaid.items[0].depositTransferFiles).toEqual([]);
  });
});
