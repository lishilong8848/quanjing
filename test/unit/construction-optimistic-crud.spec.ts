import type {
  ConstructionFollowupItem,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
} from '../../shared/api.interface';
import {
  applyOptimisticProjectPatch,
  applyProjectTombstones,
  applyOptimisticFollowupPatch,
  appendTemporaryProject,
  captureFollowupFieldSnapshot,
  captureProjectFieldSnapshot,
  createTemporaryConstructionProject,
  isFollowupPatchConfirmed,
  isProjectPatchConfirmed,
  rebaseConstructionDataAfterOptimisticFailure,
  replaceTemporaryProjectRecordId,
  restoreFollowupFieldSnapshot,
  restoreProjectFieldSnapshot,
} from '../../client/src/pages/ConstructionManagement/optimistic-crud';
import { createConstructionMutationCoordinator } from '../../client/src/pages/ConstructionManagement/mutation-coordinator';

function createFollowup(
  overrides: Partial<ConstructionFollowupItem> = {},
): ConstructionFollowupItem {
  return {
    recordId: 'followup-1',
    title: '2026-07-24 follow-up',
    constructionCode: 'NT-001',
    workContent: 'Replace air-conditioning unit',
    workTypes: ['hot-work'],
    dailyWorkTypesConfirmed: false,
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
    depositPaid: null,
    roomManagerSync: null,
    completionChecklist: [],
    followupDate: '2026-07-24',
    createdAt: '2026-07-24T08:00:00.000Z',
    updatedAt: '2026-07-24T08:00:00.000Z',
    recordUrl: null,
    attachments: [],
    aiIssues: [],
    ...overrides,
  };
}

function createProject(
  overrides: Partial<ConstructionOverviewItem> = {},
): ConstructionOverviewItem {
  return {
    recordId: 'project-1',
    constructionCode: 'NT-001',
    workContent: 'Replace air-conditioning unit',
    building: 'A',
    specialty: 'HVAC',
    contractorType: 'external',
    workTypes: ['hot-work'],
    relatedWorkType: null,
    workflow: null,
    planStartTime: '2026-07-24T08:00:00.000Z',
    planEndTime: '2026-07-25T18:00:00.000Z',
    remainingDays: 2,
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
    constructionIssues: [],
    completionChecklistArchive: [],
    depositAgreementFiles: [],
    depositTransferFiles: [],
    crewMembers: [],
    followups: [],
    latestFollowup: null,
    ...overrides,
  };
}

function createData(
  items: ConstructionOverviewItem[] = [createProject()],
  followups: ConstructionFollowupItem[] = [],
): ConstructionManagementResponse {
  return {
    generatedAt: '2026-07-24T09:00:00.000Z',
    summary: {
      total: items.length,
      active: items.length,
      pendingApproval: 0,
      endingSoon: 0,
      attachmentIssues: 0,
      completedFollowups: 0,
      latestUpdatedAt: null,
    },
    items,
    followups,
    imageAuditStatus: {
      configured: false,
      provider: 'none',
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

describe('construction optimistic CRUD', () => {
  it('optimistically updates supplemental project and initial follow-up fields', () => {
    const initialFollowup = createFollowup({
      workTypes: ['general-work'],
      depositPaid: '否',
    });
    const originalProject = createProject({
      workTypes: ['general-work'],
      approval: {
        ...createProject().approval,
        depositPaid: '否',
      },
      deposit: {
        amount: null,
        deducted: null,
        balance: null,
      },
      followups: [initialFollowup],
      latestFollowup: initialFollowup,
    });
    const data = createData([originalProject], [initialFollowup]);
    const optimisticAttachments = [
      {
        field: '申请材料',
        label: '申请材料',
        count: 1,
        files: [
          {
            fileToken: 'optimistic:mutation-1:applicationFiles:0',
            name: 'application.docx',
            size: 1024,
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        ],
        status: 'complete' as const,
        feedback: null,
      },
    ];

    const withFollowup = applyOptimisticFollowupPatch(data, {
      projectRecordId: 'project-1',
      followupRecordId: 'followup-1',
      followupDate: '2026-07-24',
      fields: {
        workTypes: ['hot-work'],
        depositPaid: '是',
        attachments: optimisticAttachments,
      },
    });
    const result = applyOptimisticProjectPatch(withFollowup, {
      projectRecordId: 'project-1',
      fields: {
        workTypes: ['hot-work'],
        approval: {
          ...originalProject.approval,
          depositPaid: '是',
        },
        deposit: {
          amount: 10000,
          deducted: 1000,
          balance: 9000,
        },
      },
    });

    expect(result.items[0]).toMatchObject({
      workTypes: ['hot-work'],
      approval: { depositPaid: '是' },
      deposit: { amount: 10000, deducted: 1000, balance: 9000 },
    });
    expect(result.items[0].followups[0]).toMatchObject({
      workTypes: ['hot-work'],
      depositPaid: '是',
      attachments: optimisticAttachments,
    });
  });

  it('creates a supplemental optimistic record without merging the same-day daily record', () => {
    const dailyFollowup = createFollowup({
      recordId: 'daily-followup',
      dailyWorkTypesConfirmed: true,
      workTypes: ['general-work'],
      followupDate: '2026-07-24',
    });
    const data = createData(
      [
        createProject({
          followups: [dailyFollowup],
          latestFollowup: dailyFollowup,
        }),
      ],
      [dailyFollowup],
    );

    const result = applyOptimisticFollowupPatch(data, {
      projectRecordId: 'project-1',
      followupRecordId: null,
      followupDate: '2026-07-24',
      optimisticRecordId: 'optimistic:supplemental:mutation-1',
      allowDateFallback: false,
      fields: {
        workTypes: ['hot-work'],
        depositPaid: '是',
      },
    });

    expect(result.items[0].followups).toHaveLength(2);
    expect(
      result.items[0].followups.find(
        (followup) => followup.recordId === 'daily-followup',
      ),
    ).toMatchObject({
      dailyWorkTypesConfirmed: true,
      workTypes: ['general-work'],
      depositPaid: null,
    });
    expect(result.items[0].followups[0]).toMatchObject({
      recordId: 'optimistic:supplemental:mutation-1',
      workTypes: ['hot-work'],
      depositPaid: '是',
    });
  });

  it('updates work types and their daily confirmation everywhere', () => {
    const followup = createFollowup();
    const data = createData(
      [
        createProject({
          followups: [followup],
          latestFollowup: followup,
        }),
      ],
      [followup],
    );

    const result = applyOptimisticFollowupPatch(data, {
      projectRecordId: 'project-1',
      followupRecordId: 'followup-1',
      followupDate: '2026-07-24',
      fields: {
        workTypes: ['hot-work', 'height-work'],
        dailyWorkTypesConfirmed: true,
      },
    });

    expect(result.items[0].followups[0]).toMatchObject({
      workTypes: ['hot-work', 'height-work'],
      dailyWorkTypesConfirmed: true,
    });
    expect(result.items[0].latestFollowup).toMatchObject({
      workTypes: ['hot-work', 'height-work'],
      dailyWorkTypesConfirmed: true,
    });
    expect(result.followups[0]).toMatchObject({
      workTypes: ['hot-work', 'height-work'],
      dailyWorkTypesConfirmed: true,
    });
    expect(data.items[0].followups[0]).toMatchObject({
      workTypes: ['hot-work'],
      dailyWorkTypesConfirmed: false,
    });
  });

  it('creates an optimistic follow-up for a personnel check on an empty day', () => {
    const data = createData();

    const result = applyOptimisticFollowupPatch(data, {
      projectRecordId: 'project-1',
      followupRecordId: null,
      followupDate: '2026-07-24',
      optimisticRecordId: 'optimistic:personnel-check-1',
      fields: {
        dailyPersonnelCheck: 'All six workers verified',
        followupStaffMembers: [{ id: 'staff-1', name: 'Inspector A' }],
      },
    });

    expect(result.items[0].followups).toHaveLength(1);
    expect(result.items[0].followups[0]).toMatchObject({
      recordId: 'optimistic:personnel-check-1',
      constructionCode: 'NT-001',
      workContent: 'Replace air-conditioning unit',
      overviewRecordIds: ['project-1'],
      followupDate: '2026-07-24',
      dailyWorkTypesConfirmed: false,
      dailyPersonnelCheck: 'All six workers verified',
      followupStaffMembers: [{ id: 'staff-1', name: 'Inspector A' }],
      attachments: [],
      completionChecklist: [],
      aiIssues: [],
    });
    expect(result.items[0].latestFollowup).toEqual(
      result.items[0].followups[0],
    );
    expect(result.followups).toEqual([result.items[0].followups[0]]);
    expect(data.items[0].followups).toEqual([]);
    expect(data.followups).toEqual([]);
  });

  it.each([
    ['Shanghai ISO', '2026-07-24T00:00:00.000+08:00'],
    ['UTC ISO', '2026-07-23T16:00:00.000Z'],
    ['13-digit timestamp', '1784822400000'],
    ['10-digit timestamp', '1784822400'],
  ])(
    'matches %s follow-up dates by their Shanghai calendar day',
    (_label, existingDate) => {
      const followup = createFollowup({ followupDate: existingDate });
      const data = createData(
        [
          createProject({
            followups: [followup],
            latestFollowup: followup,
          }),
        ],
        [followup],
      );

      const result = applyOptimisticFollowupPatch(data, {
        projectRecordId: 'project-1',
        followupDate: '2026-07-24',
        optimisticRecordId: 'optimistic:must-not-be-created',
        fields: { dailyPersonnelCheck: 'Existing record updated' },
      });

      expect(result.items[0].followups).toHaveLength(1);
      expect(result.items[0].followups[0]).toMatchObject({
        recordId: 'followup-1',
        dailyPersonnelCheck: 'Existing record updated',
      });
      expect(result.items[0].latestFollowup?.recordId).toBe('followup-1');
      expect(result.followups).toHaveLength(1);
      expect(result.followups[0].recordId).toBe('followup-1');
    },
  );

  it.each([
    [
      'createdAt when followupDate is absent',
      {
        followupDate: null,
        createdAt: '2026-07-23T16:00:00.000Z',
        updatedAt: '2026-07-22T16:00:00.000Z',
      },
    ],
    [
      'updatedAt when createdAt is invalid',
      {
        followupDate: null,
        createdAt: 'invalid-created-at',
        updatedAt: '2026-07-23T16:00:00.000Z',
      },
    ],
  ])('matches %s as the follow-up date fallback', (_label, overrides) => {
    const followup = createFollowup(overrides);
    const data = createData(
      [
        createProject({
          followups: [followup],
          latestFollowup: followup,
        }),
      ],
      [followup],
    );

    const result = applyOptimisticFollowupPatch(data, {
      projectRecordId: 'project-1',
      followupDate: '2026-07-24',
      optimisticRecordId: 'optimistic:must-not-be-created',
      fields: { processFeedback: 'Updated existing record' },
    });

    expect(result.items[0].followups).toHaveLength(1);
    expect(result.items[0].followups[0]).toMatchObject({
      recordId: 'followup-1',
      processFeedback: 'Updated existing record',
    });
    expect(result.items[0].latestFollowup?.recordId).toBe('followup-1');
    expect(result.followups).toHaveLength(1);
    expect(result.followups[0].recordId).toBe('followup-1');
  });

  it('restores only snapshotted fields and preserves concurrent feedback', () => {
    const followup = createFollowup({
      isolationFeedback: 'Original isolation note',
      processFeedback: 'Original process note',
    });
    const data = createData(
      [
        createProject({
          followups: [followup],
          latestFollowup: followup,
        }),
      ],
      [followup],
    );
    const patch = {
      projectRecordId: 'project-1',
      followupRecordId: 'followup-1',
      followupDate: '2026-07-24',
      fields: {
        isolationFeedback: 'Optimistic isolation note',
      },
    };
    const snapshot = captureFollowupFieldSnapshot(data, patch);
    const optimistic = applyOptimisticFollowupPatch(data, patch);
    const concurrentFollowup = {
      ...optimistic.items[0].followups[0],
      processFeedback: 'Concurrent process note',
    };
    const concurrent: ConstructionManagementResponse = {
      ...optimistic,
      items: [
        {
          ...optimistic.items[0],
          followups: [concurrentFollowup],
          latestFollowup: concurrentFollowup,
        },
      ],
      followups: [concurrentFollowup],
    };

    const restored = restoreFollowupFieldSnapshot(concurrent, snapshot);

    expect(restored.items[0].followups[0]).toMatchObject({
      isolationFeedback: 'Original isolation note',
      processFeedback: 'Concurrent process note',
    });
    expect(restored.items[0].latestFollowup).toMatchObject({
      isolationFeedback: 'Original isolation note',
      processFeedback: 'Concurrent process note',
    });
    expect(restored.followups[0]).toMatchObject({
      isolationFeedback: 'Original isolation note',
      processFeedback: 'Concurrent process note',
    });
  });

  it('removes the optimistic follow-up when the original record did not exist', () => {
    const data = createData();
    const patch = {
      projectRecordId: 'project-1',
      followupDate: '2026-07-24',
      optimisticRecordId: 'optimistic:new-followup',
      fields: {
        dailyPersonnelCheck: 'Optimistic personnel result',
      },
    };
    const snapshot = captureFollowupFieldSnapshot(data, patch);
    const optimistic = applyOptimisticFollowupPatch(data, patch);

    const restored = restoreFollowupFieldSnapshot(optimistic, snapshot);

    expect(snapshot.existed).toBe(false);
    expect(restored.items[0].followups).toEqual([]);
    expect(restored.items[0].latestFollowup).toBeNull();
    expect(restored.followups).toEqual([]);
  });

  it('rolls back only the captured optimistic id after a real record appears', () => {
    const data = createData();
    const patch = {
      projectRecordId: 'project-1',
      followupRecordId: 'real-followup-after-refresh',
      followupDate: '2026-07-24',
      optimisticRecordId: 'unsafe-non-optimistic-id',
      fields: {
        dailyPersonnelCheck: 'Optimistic personnel result',
      },
    };
    const snapshot = captureFollowupFieldSnapshot(data, patch);
    const optimistic = applyOptimisticFollowupPatch(data, patch);
    const optimisticFollowup = optimistic.items[0].followups[0];
    const realFollowup = createFollowup({
      recordId: 'real-followup-after-refresh',
      dailyPersonnelCheck: 'Confirmed by server',
    });
    const refreshed: ConstructionManagementResponse = {
      ...optimistic,
      items: [
        {
          ...optimistic.items[0],
          followups: [realFollowup, optimisticFollowup],
          latestFollowup: realFollowup,
        },
      ],
      followups: [realFollowup, optimisticFollowup],
    };

    const restored = restoreFollowupFieldSnapshot(refreshed, snapshot);

    expect(snapshot.existed).toBe(false);
    expect(snapshot.createdOptimisticRecordId).toBe(
      'optimistic:project-1:2026-07-24',
    );
    expect(optimisticFollowup.recordId).toBe(
      snapshot.createdOptimisticRecordId,
    );
    expect(restored.items[0].followups).toEqual([realFollowup]);
    expect(restored.items[0].latestFollowup).toBe(realFollowup);
    expect(restored.followups).toEqual([realFollowup]);
  });

  it('confirms work types and staff members using normalized set semantics', () => {
    const followup = createFollowup({
      workTypes: ['height-work', 'hot-work', 'hot-work'],
      followupStaffMembers: [
        { id: ' staff-2 ', name: ' Inspector B ' },
        { id: 'staff-1', name: 'Inspector A' },
      ],
    });
    const data = createData(
      [
        createProject({
          followups: [followup],
          latestFollowup: followup,
        }),
      ],
      [followup],
    );

    expect(
      isFollowupPatchConfirmed(data, {
        projectRecordId: 'project-1',
        followupDate: '2026-07-24',
        fields: {
          workTypes: [' hot-work ', 'height-work'],
          followupStaffMembers: [
            { id: 'staff-1', name: 'Inspector A' },
            { id: 'staff-2', name: 'Inspector B' },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isFollowupPatchConfirmed(data, {
        projectRecordId: 'project-1',
        followupDate: '2026-07-24',
        fields: {
          workTypes: ['hot-work', 'height-work'],
          followupStaffMembers: [
            { id: 'staff-1', name: 'Inspector A' },
            { id: 'staff-2', name: 'Changed name' },
          ],
        },
      }),
    ).toBe(false);
  });

  it('confirms derived staff text and members regardless of ordering', () => {
    const followup = createFollowup({
      followupStaff: '张三、李四',
      followupStaffMembers: [
        { id: 'staff-2', name: '李四' },
        { id: 'staff-1', name: '张三' },
      ],
    });
    const data = createData(
      [
        createProject({
          followups: [followup],
          latestFollowup: followup,
        }),
      ],
      [followup],
    );

    expect(
      isFollowupPatchConfirmed(data, {
        projectRecordId: 'project-1',
        followupRecordId: 'followup-1',
        followupDate: '2026-07-24',
        fields: {
          followupStaff: '李四、张三',
          followupStaffMembers: [
            { id: 'staff-1', name: '张三' },
            { id: 'staff-2', name: '李四' },
          ],
        },
      }),
    ).toBe(true);
  });

  it('confirms only the explicitly accepted same-day follow-up record', () => {
    const realA = createFollowup({
      recordId: 'real-a',
      processFeedback: '已确认',
    });
    const realB = createFollowup({
      recordId: 'real-b',
      processFeedback: '待同步',
    });
    const data = createData(
      [
        createProject({
          followups: [realA, realB],
          latestFollowup: realB,
        }),
      ],
      [realA, realB],
    );
    const acceptedPatch = {
      projectRecordId: 'project-1',
      followupRecordId: 'real-b',
      followupDate: '2026-07-24',
      fields: {
        processFeedback: '已确认',
      },
    };

    expect(isFollowupPatchConfirmed(data, acceptedPatch)).toBe(false);

    const confirmedRealB = createFollowup({
      ...realB,
      processFeedback: '已确认',
    });
    const confirmedData = createData(
      [
        createProject({
          followups: [realA, confirmedRealB],
          latestFollowup: confirmedRealB,
        }),
      ],
      [realA, confirmedRealB],
    );
    expect(
      isFollowupPatchConfirmed(confirmedData, acceptedPatch),
    ).toBe(true);
  });

  it('rebases cascading failures from authority without leaving ghost follow-ups', () => {
    const authoritative = createData([
      createProject(),
      createProject({ recordId: 'project-2' }),
    ]);
    const coordinator =
      createConstructionMutationCoordinator<ConstructionManagementResponse>();
    const workTypePatch = {
      projectRecordId: 'project-1',
      followupDate: '2026-07-24',
      optimisticRecordId: 'optimistic:work-type-a',
      fields: {
        workTypes: ['hot-work'],
        dailyWorkTypesConfirmed: true,
      },
    };
    const personnelPatch = {
      projectRecordId: 'project-1',
      followupRecordId: 'optimistic:work-type-a',
      followupDate: '2026-07-24',
      optimisticRecordId: 'optimistic:personnel-b',
      fields: {
        dailyPersonnelCheck: 'Personnel checked',
      },
    };
    const independentPatch = {
      projectRecordId: 'project-2',
      followupDate: '2026-07-24',
      optimisticRecordId: 'optimistic:independent-c',
      fields: {
        processFeedback: 'Independent pending layer',
      },
    };
    coordinator.begin({
      key: 'work-type-a',
      apply: (value) => applyOptimisticFollowupPatch(value, workTypePatch),
      matches: () => false,
    });
    coordinator.begin({
      key: 'personnel-b',
      apply: (value) => applyOptimisticFollowupPatch(value, personnelPatch),
      matches: () => false,
    });
    coordinator.begin({
      key: 'independent-c',
      apply: (value) => applyOptimisticFollowupPatch(value, independentPatch),
      matches: () => false,
    });

    const visible = coordinator.applyPending(authoritative);
    coordinator.finish('work-type-a');
    const afterWorkTypeFailure =
      rebaseConstructionDataAfterOptimisticFailure(
        authoritative,
        visible,
        (value) => coordinator.applyPending(value),
      );
    expect(afterWorkTypeFailure.items[0].followups).toHaveLength(1);

    coordinator.finish('personnel-b');
    const afterPersonnelFailure =
      rebaseConstructionDataAfterOptimisticFailure(
        authoritative,
        afterWorkTypeFailure,
        (value) => coordinator.applyPending(value),
      );

    expect(afterPersonnelFailure.items[0].followups).toEqual([]);
    expect(afterPersonnelFailure.items[0].latestFollowup).toBeNull();
    expect(
      afterPersonnelFailure.followups.filter((followup) =>
        followup.overviewRecordIds.includes('project-1'),
      ),
    ).toEqual([]);
    expect(afterPersonnelFailure.items[1].followups).toHaveLength(1);
    expect(afterPersonnelFailure.items[1].followups[0]).toMatchObject({
      recordId: 'optimistic:independent-c',
      processFeedback: 'Independent pending layer',
    });
    expect(afterPersonnelFailure.followups).toEqual([
      afterPersonnelFailure.items[1].followups[0],
    ]);
  });

  it('restores supplemental project and follow-up fields together without authority', () => {
    const initialFollowup = createFollowup({
      workTypes: ['general-work'],
      depositPaid: '否',
    });
    const originalProject = createProject({
      workTypes: ['general-work'],
      approval: {
        ...createProject().approval,
        depositPaid: '否',
      },
      followups: [initialFollowup],
      latestFollowup: initialFollowup,
    });
    const data = createData([originalProject], [initialFollowup]);
    const followupPatch = {
      projectRecordId: 'project-1',
      followupRecordId: 'followup-1',
      followupDate: '2026-07-24',
      fields: {
        workTypes: ['hot-work'],
        depositPaid: '是',
      },
    };
    const projectPatch = {
      projectRecordId: 'project-1',
      fields: {
        workTypes: ['hot-work'],
        approval: {
          ...originalProject.approval,
          depositPaid: '是',
        },
      },
    };
    const followupSnapshot = captureFollowupFieldSnapshot(data, followupPatch);
    const projectSnapshot = captureProjectFieldSnapshot(data, projectPatch);
    const optimistic = applyOptimisticProjectPatch(
      applyOptimisticFollowupPatch(data, followupPatch),
      projectPatch,
    );

    const restored = rebaseConstructionDataAfterOptimisticFailure(
      null,
      optimistic,
      (value) => value,
      followupSnapshot,
      projectSnapshot,
    );

    expect(restored.items[0].workTypes).toEqual(['general-work']);
    expect(restored.items[0].approval.depositPaid).toBe('否');
    expect(restored.items[0].followups[0]).toMatchObject({
      workTypes: ['general-work'],
      depositPaid: '否',
    });
  });

  it('uses tombstones to keep stale project data hidden', () => {
    const staleData = createData([
      createProject({ recordId: 'deleted-project' }),
      createProject({ recordId: 'surviving-project' }),
    ]);
    const originalItems = staleData.items.slice();

    const result = applyProjectTombstones(
      staleData,
      new Set(['deleted-project']),
    );

    expect(result.items.map((item) => item.recordId)).toEqual([
      'surviving-project',
    ]);
    expect(result.summary.total).toBe(1);
    expect(staleData.items).toEqual(originalItems);
    expect(staleData.items).toHaveLength(2);
  });

  it('never lets the project total become negative when tombstones hide stale items', () => {
    const staleData = createData([
      createProject({ recordId: 'deleted-project' }),
    ]);
    staleData.summary.total = 0;

    const result = applyProjectTombstones(
      staleData,
      new Set(['deleted-project', 'already-absent']),
    );

    expect(result.summary.total).toBe(0);
    expect(result.summary.active).toBe(staleData.summary.active);
  });

  it('creates and prepends a temporary project only once', () => {
    const temporary = createTemporaryConstructionProject({
      mutationId: 'create-1',
      workContent: 'Install new containment',
      building: 'D楼',
      specialty: '电气',
      workTypes: ['height-work'],
      contractorType: '外部',
      relatedWorkType: '维护',
      planStartTime: '2026-07-26T08:00:00.000Z',
      planEndTime: '2026-07-27T18:00:00.000Z',
    });
    const data = createData([createProject()]);

    const appended = appendTemporaryProject(data, temporary);
    const duplicated = appendTemporaryProject(appended, temporary);

    expect(temporary).toMatchObject({
      recordId: 'optimistic:create-1',
      constructionCode: null,
      workContent: 'Install new containment',
      building: 'D楼',
      specialty: '电气',
      workTypes: ['height-work'],
      contractorType: '外部',
      relatedWorkType: '维护',
      planStartTime: '2026-07-26T08:00:00.000Z',
      planEndTime: '2026-07-27T18:00:00.000Z',
      latestFollowup: null,
      followups: [],
      applicationAttachments: [],
      crewMembers: [],
    });
    expect(appended.items[0]).toBe(temporary);
    expect(appended.summary.total).toBe(2);
    expect(duplicated.items).toHaveLength(2);
    expect(duplicated.summary.total).toBe(2);
    expect(data.items).toHaveLength(1);
    expect(data.summary.total).toBe(1);
  });

  it('applies a project workflow patch immutably without disturbing other projects', () => {
    const target = createProject({ recordId: 'target-project' });
    const other = createProject({
      recordId: 'other-project',
      workflow: '施工中',
    });
    const data = createData([target, other]);

    const result = applyOptimisticProjectPatch(data, {
      projectRecordId: 'target-project',
      fields: { workflow: '已终止' },
    });

    expect(result).not.toBe(data);
    expect(result.items[0]).toMatchObject({
      recordId: 'target-project',
      workflow: '已终止',
    });
    expect(result.items[0]).not.toBe(target);
    expect(result.items[1]).toBe(other);
    expect(data.items[0].workflow).toBeNull();
  });

  it('captures and restores only the patched project workflow field', () => {
    const target = createProject({
      recordId: 'target-project',
      workflow: '施工中',
    });
    const data = createData([target]);
    const patch = {
      projectRecordId: 'target-project',
      fields: { workflow: '已终止' },
    } as const;
    const snapshot = captureProjectFieldSnapshot(data, patch);
    const patched = applyOptimisticProjectPatch(data, patch);

    const restored = restoreProjectFieldSnapshot(patched, snapshot);

    expect(snapshot).toEqual({
      projectRecordId: 'target-project',
      existed: true,
      fields: { workflow: '施工中' },
    });
    expect(restored.items[0].workflow).toBe('施工中');
    expect(patched.items[0].workflow).toBe('已终止');
  });

  it('patches and restores only supplemental nested project fields', () => {
    const project = createProject({
      approval: {
        ...createProject().approval,
        supervisor: 'approved',
        depositPaid: '否',
      },
      deposit: {
        amount: 5000,
        deducted: 500,
        balance: 4500,
      },
    });
    const data = createData([project]);
    const patch = {
      projectRecordId: 'project-1',
      fields: {
        workTypes: ['hot-work'],
        approval: { depositPaid: '是' },
        deposit: { amount: 10000, deducted: 1000, balance: 9000 },
      },
    };
    const snapshot = captureProjectFieldSnapshot(data, patch);
    const optimistic = applyOptimisticProjectPatch(data, patch);
    const concurrent = {
      ...optimistic,
      items: [
        {
          ...optimistic.items[0],
          approval: {
            ...optimistic.items[0].approval,
            ehs: 'concurrently-approved',
          },
        },
      ],
    };

    expect(optimistic.items[0].approval).toMatchObject({
      supervisor: 'approved',
      depositPaid: '是',
    });
    const restored = restoreProjectFieldSnapshot(concurrent, snapshot);
    expect(restored.items[0]).toMatchObject({
      workTypes: ['hot-work'],
      approval: {
        supervisor: 'approved',
        ehs: 'concurrently-approved',
        depositPaid: '否',
      },
      deposit: {
        amount: 5000,
        deducted: 500,
        balance: 4500,
      },
    });
  });

  it('confirms a project patch against the exact project record id', () => {
    const data = createData([
      createProject({
        recordId: 'target-project',
        workflow: '施工中',
      }),
      createProject({
        recordId: 'other-project',
        workflow: '已终止',
      }),
    ]);
    const patch = {
      projectRecordId: 'target-project',
      fields: { workflow: '已终止' },
    } as const;

    expect(isProjectPatchConfirmed(data, patch)).toBe(false);
    expect(
      isProjectPatchConfirmed(
        applyOptimisticProjectPatch(data, patch),
        patch,
      ),
    ).toBe(true);
  });

  it('replaces a temporary project id and only its follow-up links', () => {
    const temporaryId = 'optimistic:create-1';
    const temporaryFollowup = createFollowup({
      recordId: 'temporary-followup',
      overviewRecordIds: [temporaryId, 'shared-project'],
    });
    const temporaryProject = createTemporaryConstructionProject({
      mutationId: 'create-1',
      workContent: 'Install new containment',
      workTypes: ['height-work'],
      planStartTime: '2026-07-26T08:00:00.000Z',
      planEndTime: '2026-07-27T18:00:00.000Z',
    });
    temporaryProject.followups = [temporaryFollowup];
    temporaryProject.latestFollowup = temporaryFollowup;
    const otherProject = createProject({ recordId: 'other-project' });
    const unrelatedFollowup = createFollowup({
      recordId: 'unrelated-followup',
      overviewRecordIds: ['other-project'],
    });
    const data = createData(
      [temporaryProject, otherProject],
      [temporaryFollowup, unrelatedFollowup],
    );

    const result = replaceTemporaryProjectRecordId(
      data,
      temporaryId,
      'real-project-1',
    );

    expect(result.items[0].recordId).toBe('real-project-1');
    expect(result.items[0].followups[0].overviewRecordIds).toEqual([
      'real-project-1',
      'shared-project',
    ]);
    expect(result.items[0].latestFollowup?.overviewRecordIds).toEqual([
      'real-project-1',
      'shared-project',
    ]);
    expect(result.followups[0].overviewRecordIds).toEqual([
      'real-project-1',
      'shared-project',
    ]);
    expect(result.items[1]).toBe(otherProject);
    expect(result.followups[1]).toBe(unrelatedFollowup);
    expect(data.items[0].recordId).toBe(temporaryId);
    expect(data.followups[0].overviewRecordIds).toContain(temporaryId);
  });

  it('deduplicates an authoritative project that races with its temporary item', () => {
    const temporaryId = 'optimistic:create-race';
    const realId = 'real-project-race';
    const temporaryDuplicateById = createFollowup({
      recordId: 'shared-followup',
      followupDate: '2026-07-25',
      processFeedback: 'Temporary shared value',
      overviewRecordIds: [temporaryId],
    });
    const temporaryDuplicateByDate = createFollowup({
      recordId: 'optimistic:same-day-followup',
      followupDate: '2026-07-23T16:00:00.000Z',
      processFeedback: 'Temporary same-day value',
      overviewRecordIds: [temporaryId],
    });
    const temporaryUniqueFollowup = createFollowup({
      recordId: 'temporary-unique-followup',
      followupDate: '2026-07-26',
      processFeedback: 'Temporary unique value',
      overviewRecordIds: [temporaryId],
    });
    const temporaryProject = createTemporaryConstructionProject({
      mutationId: 'create-race',
      workContent: 'Optimistic work content',
      workTypes: ['hot-work'],
      planStartTime: '2026-07-26T08:00:00.000Z',
      planEndTime: '2026-07-27T18:00:00.000Z',
    });
    temporaryProject.followups = [
      temporaryDuplicateById,
      temporaryDuplicateByDate,
      temporaryUniqueFollowup,
    ];
    temporaryProject.latestFollowup = temporaryUniqueFollowup;
    const authoritativeById = createFollowup({
      recordId: 'shared-followup',
      followupDate: '2026-07-25',
      processFeedback: 'Authoritative shared value',
      overviewRecordIds: [realId],
    });
    const authoritativeByDate = createFollowup({
      recordId: 'real-same-day-followup',
      followupDate: '2026-07-24',
      processFeedback: 'Authoritative same-day value',
      overviewRecordIds: [realId],
    });
    const authoritativeProject = createProject({
      recordId: realId,
      workContent: 'Authoritative work content',
      followups: [authoritativeById, authoritativeByDate],
      latestFollowup: authoritativeByDate,
    });
    const data = createData(
      [temporaryProject, authoritativeProject],
      [
        temporaryDuplicateById,
        authoritativeById,
        temporaryDuplicateByDate,
        authoritativeByDate,
        temporaryUniqueFollowup,
      ],
    );

    const result = replaceTemporaryProjectRecordId(
      data,
      temporaryId,
      realId,
    );

    expect(result.items).toHaveLength(1);
    const reconciledProject = result.items[0];
    expect(reconciledProject).toMatchObject({
      recordId: realId,
      workContent: 'Authoritative work content',
    });
    expect(
      reconciledProject.followups.map((followup) => ({
        recordId: followup.recordId,
        processFeedback: followup.processFeedback,
        overviewRecordIds: followup.overviewRecordIds,
      })),
    ).toEqual([
      {
        recordId: 'shared-followup',
        processFeedback: 'Authoritative shared value',
        overviewRecordIds: [realId],
      },
      {
        recordId: 'real-same-day-followup',
        processFeedback: 'Authoritative same-day value',
        overviewRecordIds: [realId],
      },
      {
        recordId: 'temporary-unique-followup',
        processFeedback: 'Temporary unique value',
        overviewRecordIds: [realId],
      },
    ]);
    expect(reconciledProject.latestFollowup).toBe(
      reconciledProject.followups[2],
    );
    expect(result.followups).toHaveLength(3);
    expect(result.followups).toEqual(reconciledProject.followups);
    result.followups.forEach((followup, index) => {
      expect(followup).toBe(reconciledProject.followups[index]);
    });
    expect(result.summary.total).toBe(1);
    expect(data.items).toHaveLength(2);
    expect(data.summary.total).toBe(2);
    expect(data.items[0].followups).toHaveLength(3);
    expect(data.items[1].followups).toHaveLength(2);
  });

  it('preserves distinct authoritative follow-ups on the same Shanghai day', () => {
    const temporaryId = 'optimistic:same-day-authoritative';
    const realId = 'real-same-day-authoritative';
    const temporaryProject = createTemporaryConstructionProject({
      mutationId: 'same-day-authoritative',
      workContent: 'Optimistic project',
      workTypes: [],
      planStartTime: '2026-07-24T08:00:00.000Z',
      planEndTime: '2026-07-24T18:00:00.000Z',
    });
    const authoritativeA = createFollowup({
      recordId: 'real-a',
      followupDate: '2026-07-24',
      processFeedback: 'Authoritative A',
      overviewRecordIds: [realId],
    });
    const authoritativeB = createFollowup({
      recordId: 'real-b',
      followupDate: '2026-07-23T16:00:00.000Z',
      processFeedback: 'Authoritative B',
      overviewRecordIds: [realId],
    });
    const authoritativeProject = createProject({
      recordId: realId,
      followups: [authoritativeA, authoritativeB],
      latestFollowup: authoritativeB,
    });
    const data = createData(
      [temporaryProject, authoritativeProject],
      [authoritativeA, authoritativeB],
    );

    const result = replaceTemporaryProjectRecordId(
      data,
      temporaryId,
      realId,
    );

    const reconciledProject = result.items[0];
    expect(
      reconciledProject.followups.map((followup) => followup.recordId),
    ).toEqual(['real-a', 'real-b']);
    expect(reconciledProject.latestFollowup).toBe(
      reconciledProject.followups[1],
    );
    expect(result.followups).toHaveLength(2);
    expect(result.followups[0]).toBe(reconciledProject.followups[0]);
    expect(result.followups[1]).toBe(reconciledProject.followups[1]);
  });

  it('reconciles a temporary daily follow-up only with the unique daily-compatible record on the same day', () => {
    const temporaryId = 'optimistic:daily-and-supplemental';
    const realId = 'real-daily-and-supplemental';
    const temporaryDaily = createFollowup({
      recordId: 'optimistic:daily-followup',
      followupDate: '2026-07-24',
      dailyWorkTypesConfirmed: true,
      processFeedback: 'Optimistic daily progress',
      overviewRecordIds: [temporaryId, 'temporary-daily-owner'],
    });
    const temporaryProject = createTemporaryConstructionProject({
      mutationId: 'daily-and-supplemental',
      workContent: 'Optimistic project',
      workTypes: ['hot-work'],
      planStartTime: '2026-07-24T08:00:00.000Z',
      planEndTime: '2026-07-24T18:00:00.000Z',
    });
    temporaryProject.followups = [temporaryDaily];
    temporaryProject.latestFollowup = temporaryDaily;
    const authoritativeSupplemental = createFollowup({
      recordId: 'real-supplemental-followup',
      followupDate: '2026-07-24',
      dailyWorkTypesConfirmed: false,
      processFeedback: null,
      overviewRecordIds: [realId],
      attachments: [
        {
          field: 'applicationFiles',
          label: '施工作业申请单',
          count: 1,
          files: [
            {
              fileToken: 'application-token',
              name: 'application.pdf',
              size: 128,
            },
          ],
          status: 'complete',
          feedback: null,
        },
      ],
    });
    const authoritativeDaily = createFollowup({
      recordId: 'real-daily-followup',
      followupDate: '2026-07-23T16:00:00.000Z',
      dailyWorkTypesConfirmed: true,
      processFeedback: 'Authoritative daily progress',
      overviewRecordIds: [realId],
    });
    const authoritativeProject = createProject({
      recordId: realId,
      followups: [authoritativeSupplemental, authoritativeDaily],
      latestFollowup: authoritativeDaily,
    });
    const data = createData(
      [temporaryProject, authoritativeProject],
      [authoritativeSupplemental, authoritativeDaily, temporaryDaily],
    );

    const result = replaceTemporaryProjectRecordId(
      data,
      temporaryId,
      realId,
    );

    const reconciledProject = result.items[0];
    expect(
      reconciledProject.followups.map((followup) => followup.recordId),
    ).toEqual(['real-supplemental-followup', 'real-daily-followup']);
    expect(reconciledProject.followups[0].overviewRecordIds).toEqual([realId]);
    expect(reconciledProject.followups[1].overviewRecordIds).toEqual([
      realId,
      'temporary-daily-owner',
    ]);
    expect(reconciledProject.latestFollowup).toBe(
      reconciledProject.followups[1],
    );
    expect(result.followups).toHaveLength(2);
    expect(result.followups[0]).toBe(reconciledProject.followups[0]);
    expect(result.followups[1]).toBe(reconciledProject.followups[1]);
  });

  it('keeps a temporary daily follow-up when multiple daily-compatible records share its date', () => {
    const temporaryId = 'optimistic:ambiguous-daily';
    const realId = 'real-ambiguous-daily';
    const temporaryDaily = createFollowup({
      recordId: 'optimistic:ambiguous-daily-followup',
      followupDate: '2026-07-24',
      dailyWorkTypesConfirmed: true,
      processFeedback: 'Optimistic daily progress',
      overviewRecordIds: [temporaryId],
    });
    const temporaryProject = createTemporaryConstructionProject({
      mutationId: 'ambiguous-daily',
      workContent: 'Optimistic project',
      workTypes: ['hot-work'],
      planStartTime: '2026-07-24T08:00:00.000Z',
      planEndTime: '2026-07-24T18:00:00.000Z',
    });
    temporaryProject.followups = [temporaryDaily];
    temporaryProject.latestFollowup = temporaryDaily;
    const authoritativeDailyA = createFollowup({
      recordId: 'real-daily-a',
      followupDate: '2026-07-24',
      dailyWorkTypesConfirmed: true,
      processFeedback: 'Authoritative daily A',
      overviewRecordIds: [realId],
    });
    const authoritativeDailyB = createFollowup({
      recordId: 'real-daily-b',
      followupDate: '2026-07-23T16:00:00.000Z',
      dailyWorkTypesConfirmed: true,
      closingFeedback: 'Authoritative daily B',
      overviewRecordIds: [realId],
    });
    const authoritativeProject = createProject({
      recordId: realId,
      followups: [authoritativeDailyA, authoritativeDailyB],
      latestFollowup: authoritativeDailyB,
    });
    const data = createData(
      [temporaryProject, authoritativeProject],
      [authoritativeDailyA, authoritativeDailyB, temporaryDaily],
    );

    const result = replaceTemporaryProjectRecordId(
      data,
      temporaryId,
      realId,
    );

    const reconciledProject = result.items[0];
    expect(
      reconciledProject.followups.map((followup) => followup.recordId),
    ).toEqual([
      'real-daily-a',
      'real-daily-b',
      'optimistic:ambiguous-daily-followup',
    ]);
    expect(reconciledProject.latestFollowup).toBe(
      reconciledProject.followups[2],
    );
    expect(result.followups).toHaveLength(3);
    result.followups.forEach((followup, index) => {
      expect(followup).toBe(reconciledProject.followups[index]);
    });
  });

  it('does not mutate input objects or disturb another project on the same day', () => {
    const targetFollowup = createFollowup();
    const unrelatedFollowup = createFollowup({
      recordId: 'other-followup',
      overviewRecordIds: ['other-project'],
      processFeedback: 'Keep this value',
    });
    const data = createData(
      [
        createProject({
          followups: [targetFollowup],
          latestFollowup: targetFollowup,
        }),
        createProject({
          recordId: 'other-project',
          followups: [unrelatedFollowup],
          latestFollowup: unrelatedFollowup,
        }),
      ],
      [targetFollowup, unrelatedFollowup],
    );
    const patch = {
      projectRecordId: 'project-1',
      followupRecordId: 'followup-1',
      followupDate: '2026-07-24',
      fields: {
        attachments: [
          {
            field: 'photos',
            label: 'Site photos',
            count: 0,
            files: [],
            status: 'empty' as const,
            feedback: null,
          },
        ],
      },
    };
    const originalData = JSON.stringify(data);
    const originalPatch = JSON.stringify(patch);

    const result = applyOptimisticFollowupPatch(data, patch);

    expect(JSON.stringify(data)).toBe(originalData);
    expect(JSON.stringify(patch)).toBe(originalPatch);
    expect(result.followups).toContain(unrelatedFollowup);
    expect(result.items[1]).toBe(data.items[1]);
  });

  it('prefers a follow-up record id before falling back to its date', () => {
    const sameDayFirst = createFollowup({
      recordId: 'same-day-first',
      processFeedback: 'First record',
    });
    const target = createFollowup({
      recordId: 'target-record',
      processFeedback: 'Target record',
    });
    const data = createData(
      [
        createProject({
          followups: [sameDayFirst, target],
          latestFollowup: target,
        }),
      ],
      [sameDayFirst, target],
    );

    const result = applyOptimisticFollowupPatch(data, {
      projectRecordId: 'project-1',
      followupRecordId: 'target-record',
      followupDate: '2026-07-24',
      fields: { processFeedback: 'Updated target' },
    });

    expect(result.items[0].followups[0]).toBe(sameDayFirst);
    expect(result.items[0].followups[1]).toMatchObject({
      recordId: 'target-record',
      processFeedback: 'Updated target',
    });
    expect(result.items[0].latestFollowup).toMatchObject({
      recordId: 'target-record',
      processFeedback: 'Updated target',
    });
    expect(result.followups[0]).toBe(sameDayFirst);
    expect(result.followups[1]).toMatchObject({
      recordId: 'target-record',
      processFeedback: 'Updated target',
    });
  });
});
