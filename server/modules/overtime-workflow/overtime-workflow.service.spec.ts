import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivePersonnelDirectory } from '../bitable-sync/active-personnel-directory';
import { OvertimeWorkflowService as ActualOvertimeWorkflowService } from './overtime-workflow.service';
import { withSyntheticBusinessIdentity } from '../../../test/unit/synthetic-business-identity.fixture';
const OvertimeWorkflowService = withSyntheticBusinessIdentity(ActualOvertimeWorkflowService, 3);
type OvertimeWorkflowService = ActualOvertimeWorkflowService;
import {
  OvertimeWorkflowStore,
  stableOvertimeMessageUuid,
} from './overtime-workflow.store';

const SNAPSHOT = {
  recordId: 'rec_overtime_1',
  applicantName: '张三',
  applicantOpenId: 'ou_applicant',
  building: 'A楼',
  position: '运维值班员',
  plannedStartAt: '2026-08-13T09:00:00+08:00',
  plannedEndAt: '2026-08-13T17:00:00+08:00',
  plannedHours: 8,
  reason: '设备保障',
};

const IMPACT = {
  rawHours: 8,
  payableHours: 8,
  conflictingSchedules: [],
  isWholeHour: true,
  invalidRangeReason: null,
  canSubmit: true,
};

const orgRecords = [
  {
    name: 'A楼值班账号',
    openId: 'ou_duty_account',
    position: '值班账号',
    buildings: ['A楼'],
    supervisorNames: ['施小东'],
  },
  {
    name: '设施运维经理岗',
    openId: 'ou_manager_duty',
    position: '设施运维经理',
    buildings: [],
    supervisorNames: ['梅冰冰', '马进宇'],
  },
];

const activeDirectory: ActivePersonnelDirectory = {
  personnel: [
    {
      recordId: 'p1',
      name: '张三',
      openId: 'ou_applicant',
      employeeNo: '001',
      position: '运维值班员',
      systemPosition: '',
      buildings: ['A'],
    },
    {
      recordId: 'p2',
      name: '施小东',
      openId: 'ou_supervisor',
      employeeNo: '002',
      position: '设施运维主管',
      systemPosition: '',
      buildings: ['A'],
    },
    {
      recordId: 'p3',
      name: '梅冰冰',
      openId: 'ou_manager_1',
      employeeNo: '003',
      position: '设施运维经理',
      systemPosition: '运维经理',
      buildings: [],
    },
    {
      recordId: 'p4',
      name: '马进宇',
      openId: 'ou_manager_2',
      employeeNo: '004',
      position: '设施运维副经理',
      systemPosition: '运维经理',
      buildings: [],
    },
  ],
  managers: [],
  snapshot: { fetchedAt: 1, expiresAt: 2, stale: false },
  quality: {
    sourceRecordCount: 4,
    activeRecordCount: 4,
    inactiveRecordCount: 0,
    usablePersonnelCount: 4,
    managerCount: 2,
    missingNameCount: 0,
    missingOpenIdCount: 0,
    duplicateOpenIdCount: 0,
    missingBuildingCount: 0,
  },
};
activeDirectory.managers = activeDirectory.personnel.slice(2);

describe('OvertimeWorkflowService', () => {
  jest.setTimeout(15_000);
  let directory = '';
  let store: OvertimeWorkflowStore;
  let gateway: {
    fetchOrganizationRoutingRecords: jest.Mock;
    sendInteractiveCard: jest.Mock;
    patchInteractiveCard: jest.Mock;
    readOvertimeRecord: jest.Mock;
    readOvertimeRecordIfExists: jest.Mock;
    updateOvertimeRecord: jest.Mock;
    issueConfirmationTicket: jest.Mock;
    verifyConfirmationTicket: jest.Mock;
    buildConfirmationUrl: jest.Mock;
  };
  let personnel: { getCachedActivePersonnelDirectory: jest.Mock };
  let service: OvertimeWorkflowService;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00Z'));
    directory = await mkdtemp(join(tmpdir(), 'overtime-service-'));
    store = new OvertimeWorkflowStore(join(directory, 'ledger.json'));
    gateway = {
      fetchOrganizationRoutingRecords: jest.fn().mockResolvedValue(orgRecords),
      sendInteractiveCard: jest
        .fn()
        .mockImplementation(async (recipient: string) => `om_${recipient}`),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
      readOvertimeRecord: jest.fn().mockResolvedValue({
        recordId: SNAPSHOT.recordId,
        fields: {},
      }),
      readOvertimeRecordIfExists: jest.fn().mockResolvedValue({
        recordId: SNAPSHOT.recordId,
        fields: {},
      }),
      updateOvertimeRecord: jest.fn().mockResolvedValue(undefined),
      issueConfirmationTicket: jest.fn().mockReturnValue('signed-ticket'),
      verifyConfirmationTicket: jest.fn().mockReturnValue({
        recordId: SNAPSHOT.recordId,
        approverOpenId: 'ou_supervisor',
        issuedAt: Date.parse('2026-08-12T00:00:00Z'),
      }),
      buildConfirmationUrl: jest
        .fn()
        .mockReturnValue(
          'https://example.com/overtime-confirmation?overtimeConfirmation=1&recordId=rec_overtime_1&ticket=signed-ticket',
        ),
    };
    personnel = {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(activeDirectory),
    };
    service = new OvertimeWorkflowService(
      store,
      gateway as never,
      personnel as never,
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts the integrated controller request durably without external IO', async () => {
    const result = await service.acceptApplication({
      request: {
        clientMutationId: 'overtime-request-1',
        staffName: '张三',
        startAt: SNAPSHOT.plannedStartAt,
        endAt: SNAPSHOT.plannedEndAt,
        reason: SNAPSHOT.reason,
        expectedImpact: IMPACT,
      },
      result: {
        success: true,
        created: 1,
        recordId: SNAPSHOT.recordId,
        clientMutationId: 'overtime-request-1',
        requestFingerprint: 'fingerprint',
        impact: IMPACT,
        message: 'ok',
      },
    });
    expect(result).toEqual({ created: true });
    expect(gateway.fetchOrganizationRoutingRecords).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect((await store.getApplication(SNAPSHOT.recordId))?.snapshot).toEqual({
      ...SNAPSHOT,
      applicantOpenId: '',
      building: '',
      position: '',
    });
  });

  it('routes using org Base completed by the local personnel directory and sends approval cards', async () => {
    await seedApplication(store);
    await service.runPendingTasks(new Date('2026-08-20T00:00:00.000Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:01.000Z'));

    const application = await store.getApplication(SNAPSHOT.recordId);
    expect(application?.approvers).toEqual([
      expect.objectContaining({ name: '施小东', openId: 'ou_supervisor' }),
    ]);
    expect(application?.managerRecipients.map((entry) => entry.openId)).toEqual(
      ['ou_manager_1', 'ou_manager_2'],
    );
    expect(application?.phase).toBe('approval_pending');
    expect(application?.snapshot).toEqual(
      expect.objectContaining({
        applicantOpenId: 'ou_applicant',
        building: 'A楼',
        position: '运维值班员',
      }),
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_supervisor',
      expect.any(Object),
      'overtime:rec_overtime_1:approval:ou_supervisor',
    );
  });

  it('keeps routing pending when no machine-room manager can be resolved', async () => {
    gateway.fetchOrganizationRoutingRecords.mockResolvedValue([orgRecords[0]]);
    personnel.getCachedActivePersonnelDirectory.mockResolvedValue({
      ...activeDirectory,
      personnel: activeDirectory.personnel.slice(0, 2),
      managers: [],
    });
    await seedApplication(store);
    const result = await service.runPendingTasks(
      new Date('2026-08-20T00:00:00.000Z'),
    );
    expect(result.failed).toBe(1);
    expect((await store.getApplication(SNAPSHOT.recordId))?.phase).toBe(
      'pending_approval',
    );
    expect(
      (await store.listTasks()).find(
        (task) => task.kind === 'route_application',
      )?.status,
    ).toBe('pending');
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.lastError,
    ).toContain('机房经理');
  });

  function configureDisciplineEngineer(
    discipline = '电气',
    leadId = 'ou_professional',
  ) {
    jest.setSystemTime(new Date('2026-08-20T00:00:00Z'));
    const applicant = {
      ...activeDirectory.personnel[0],
      name: '彭怀响',
      position: `${discipline}工程师`,
      buildings: ['D'],
    };
    const supervisor = {
      ...activeDirectory.personnel[1],
      name: '陶必亮',
      buildings: ['D'],
    };
    const professional = {
      ...activeDirectory.personnel[1],
      recordId: 'p_professional',
      name: '周海祥',
      openId: leadId,
      position: `${discipline}专业主管`,
      buildings: ['H'],
    };
    personnel.getCachedActivePersonnelDirectory.mockResolvedValue({
      ...activeDirectory,
      personnel: [
        applicant,
        supervisor,
        ...activeDirectory.managers,
        professional,
        professional,
        {
          ...professional,
          openId: 'ou_other_discipline',
          position: discipline === '电气' ? '暖通主管' : '电气主管',
        },
      ],
    });
    gateway.fetchOrganizationRoutingRecords.mockResolvedValue([
      { ...orgRecords[0], buildings: ['D楼'], supervisorNames: ['陶必亮'] },
      orgRecords[1],
    ]);
  }

  it.each(['电气', '暖通', '弱电', '消防'])(
    'persists %s professional CC separately without changing building approvers',
    async (discipline) => {
      configureDisciplineEngineer(discipline);
      await seedApplication(store);
      await service.runPendingTasks(new Date('2026-08-20T00:00:00Z'));
      const application = await store.getApplication(SNAPSHOT.recordId);
      expect(application?.approvers.map((p) => p.name)).toEqual(['陶必亮']);
      expect(application).toMatchObject({
        professionalRecipients: [
          { openId: 'ou_professional', position: `${discipline}专业主管` },
        ],
      });
      expect(
        gateway.sendInteractiveCard.mock.calls.some(
          ([id]) => id === 'ou_professional',
        ),
      ).toBe(false);
    },
  );

  it('notifies the professional after approval and retries only the failed recipient with the frozen directory snapshot', async () => {
    configureDisciplineEngineer();
    await seedApplication(store);
    await service.runPendingTasks(new Date('2026-08-20T00:00:00Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:01Z'));
    await service.acceptApprovalAction({
      eventId: 'evt_professional',
      recordId: SNAPSHOT.recordId,
      action: 'approve',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_ou_supervisor',
    });
    let failed = false;
    gateway.sendInteractiveCard.mockImplementation(async (id: string) => {
      if (id === 'ou_professional' && !failed) {
        failed = true;
        throw new Error('professional notification temporarily unavailable');
      }
      return `om_${id}`;
    });
    await service.runPendingTasks(new Date('2026-08-20T00:00:02Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:03Z'));
    expect(failed).toBe(true);
    personnel.getCachedActivePersonnelDirectory.mockRejectedValue(
      new Error('directory must not be reloaded'),
    );
    await service.runPendingTasks(new Date('2026-08-20T00:00:10Z'));
    const application = await store.getApplication(SNAPSHOT.recordId);
    expect(
      application?.managerNoticeCards.map((p) => p.recipientOpenId),
    ).toEqual([
      'ou_applicant',
      'ou_manager_1',
      'ou_manager_2',
      'ou_professional',
    ]);
    const professionalSends = gateway.sendInteractiveCard.mock.calls.filter(
      ([id]) => id === 'ou_professional',
    );
    expect(professionalSends).toHaveLength(2);
    expect(professionalSends[0][2]).toBe(professionalSends[1][2]);
    expect(JSON.stringify(professionalSends[1][1])).not.toContain('callback');
    expect(
      gateway.sendInteractiveCard.mock.calls.filter(
        ([id]) => id === 'ou_manager_1',
      ),
    ).toHaveLength(1);
  });

  it('backfills professional CC for a legacy pending application without rerouting its approvers', async () => {
    configureDisciplineEngineer();
    await seedApprovalPending(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      snapshot: {
        ...SNAPSHOT,
        applicantName: '彭怀响',
        position: '电气工程师',
        building: 'D楼',
      },
    });
    await service.acceptApprovalAction({
      eventId: 'evt_legacy_professional',
      recordId: SNAPSHOT.recordId,
      action: 'approve',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_approval_1',
    });
    await service.runPendingTasks(new Date('2026-08-20T00:00:00Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:01Z'));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_professional',
      expect.any(Object),
      `overtime:${SNAPSHOT.recordId}:approval-result:ou_professional`,
    );
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.approvers.map(
        (p) => p.openId,
      ),
    ).toEqual(['ou_supervisor']);
  });

  it('does not notify the professional on rejection', async () => {
    configureDisciplineEngineer();
    await seedApplication(store);
    await service.runPendingTasks(new Date('2026-08-20T00:00:00Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:01Z'));
    await service.acceptApprovalAction({
      eventId: 'evt_professional_reject',
      recordId: SNAPSHOT.recordId,
      action: 'reject',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_ou_supervisor',
    });
    await service.runPendingTasks(new Date('2026-08-20T00:00:02Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:03Z'));
    expect(gateway.sendInteractiveCard.mock.calls.map(([id]) => id)).toEqual([
      'ou_supervisor',
      'ou_applicant',
    ]);
  });

  it('keeps professional CC failure explicit when no matching supervisor account exists', async () => {
    configureDisciplineEngineer('电气', '');
    await seedApplication(store);
    await service.runPendingTasks(new Date('2026-08-20T00:00:00Z'));
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.lastError,
    ).toContain('电气专业主管');
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });

  it('deduplicates professional CC against the existing approval-card holder', async () => {
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      professionalRecipients: [
        {
          name: '施小东',
          openId: 'ou_supervisor',
          position: '电气主管',
          buildings: ['A楼'],
        },
      ],
    });
    await store.enqueueTask(
      {
        businessKey: `overtime:${SNAPSHOT.recordId}:notify-managers`,
        recordId: SNAPSHOT.recordId,
        kind: 'notify_managers',
      },
      new Date('2026-08-12T00:00:00Z'),
    );
    await service.runPendingTasks(new Date('2026-08-12T00:00:01Z'));
    expect(gateway.sendInteractiveCard.mock.calls.map(([id]) => id)).toEqual([
      'ou_applicant',
      'ou_manager_1',
      'ou_manager_2',
    ]);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(
      'om_approval_1',
      expect.any(Object),
    );
  });

  it('persists the first approval quickly and applies Base/manager notice in background', async () => {
    await seedApprovalPending(store);
    const accepted = await service.acceptApprovalAction({
      eventId: 'evt_approve',
      recordId: SNAPSHOT.recordId,
      action: 'approve',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_approval_1',
    });
    expect(accepted).toEqual({
      claimed: true,
      card: expect.any(Object),
    });
    expect(JSON.stringify(accepted.card)).toContain('加班申请审批通过');
    expect(JSON.stringify(accepted.card)).toContain('"disabled":true');
    expect(JSON.stringify(accepted.card)).not.toContain('callback');
    expect(gateway.updateOvertimeRecord).not.toHaveBeenCalled();

    await service.runPendingTasks(new Date('2026-08-20T00:00:00.000Z'));
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({
        加班审批: '同意',
        加班流程进展: '已审批',
        加班工作流状态: '已审批',
        加班审批人: [{ id: 'ou_supervisor' }],
        加班审批时间: expect.any(Number),
        加班工作流错误: '',
      }),
    );
    expect(
      gateway.updateOvertimeRecord.mock.calls.every(
        ([, fields]) =>
          !Object.prototype.hasOwnProperty.call(fields, '审批进度'),
      ),
    ).toBe(true);
    await service.runPendingTasks(new Date('2026-08-20T00:00:01.000Z'));
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_applicant',
      expect.any(Object),
      'overtime:rec_overtime_1:approval-result:ou_applicant',
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_manager_1',
      expect.any(Object),
      'overtime:rec_overtime_1:approval-result:ou_manager_1',
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_manager_2',
      expect.any(Object),
      'overtime:rec_overtime_1:approval-result:ou_manager_2',
    );
    const managerCard = gateway.sendInteractiveCard.mock.calls.find(
      ([recipient]) => recipient === 'ou_manager_1',
    )?.[1];
    expect(JSON.stringify(managerCard)).toContain('施小东');
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.actualApproverName,
    ).toBe('施小东');
    expect(
      gateway.patchInteractiveCard.mock.calls.filter(
        ([messageId]) => messageId === 'om_approval_1',
      ),
    ).toHaveLength(1);
    expect(
      (
        (await store.getApplication(SNAPSHOT.recordId)) as unknown as {
          approvalCardPatches: Array<{ messageId: string }>;
        }
      ).approvalCardPatches.map((entry) => entry.messageId),
    ).toEqual(['om_approval_1']);
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({
        加班经理知会时间: expect.any(Number),
        加班工作流错误: '',
      }),
    );
  });

  it('persists successful approval card patches and retries only failed cards', async () => {
    await seedApprovalPending(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      approvalCards: [
        {
          recipientOpenId: 'ou_supervisor',
          messageId: 'om_approval_1',
          businessKey: `overtime:${SNAPSHOT.recordId}:approval:ou_supervisor`,
        },
        {
          recipientOpenId: 'ou_manager_1',
          messageId: 'om_historical_approval_2',
          businessKey: `overtime:${SNAPSHOT.recordId}:approval:ou_manager_1`,
        },
      ],
    });
    gateway.patchInteractiveCard.mockImplementation(
      async (messageId: string) => {
        if (messageId === 'om_approval_1') {
          throw new Error('historical approval card no longer exists');
        }
      },
    );
    await service.acceptApprovalAction({
      eventId: 'evt_approve_patch_failure',
      recordId: SNAPSHOT.recordId,
      action: 'approve',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_approval_1',
    });

    await service.runPendingTasks(new Date('2026-08-20T00:00:00.000Z'));

    expect((await store.getApplication(SNAPSHOT.recordId))?.phase).toBe(
      'awaiting_confirmation',
    );
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(
      'om_historical_approval_2',
      expect.any(Object),
    );
    expect(
      gateway.patchInteractiveCard.mock.calls.filter(
        ([messageId]) => messageId === 'om_historical_approval_2',
      ),
    ).toHaveLength(1);
    expect(
      gateway.patchInteractiveCard.mock.calls.filter(
        ([messageId]) => messageId === 'om_approval_1',
      ),
    ).toHaveLength(1);
    expect(
      (
        (await store.getApplication(SNAPSHOT.recordId)) as unknown as {
          approvalCardPatches: Array<{ messageId: string }>;
        }
      ).approvalCardPatches.map((entry) => entry.messageId),
    ).toEqual(['om_historical_approval_2']);
    expect((await store.listTasks()).map((task) => task.businessKey)).toEqual(
      expect.arrayContaining([
        `overtime:${SNAPSHOT.recordId}:notify-managers`,
        `overtime-confirm:${SNAPSHOT.recordId}:initial`,
      ]),
    );

    gateway.patchInteractiveCard.mockResolvedValue(undefined);
    await service.runPendingTasks(new Date('2026-08-20T00:00:03.000Z'));

    expect(
      gateway.patchInteractiveCard.mock.calls.filter(
        ([messageId]) => messageId === 'om_historical_approval_2',
      ),
    ).toHaveLength(1);
    expect(
      gateway.patchInteractiveCard.mock.calls.filter(
        ([messageId]) => messageId === 'om_approval_1',
      ),
    ).toHaveLength(2);
    expect(
      (
        (await store.getApplication(SNAPSHOT.recordId)) as unknown as {
          approvalCardPatches: Array<{ messageId: string }>;
        }
      ).approvalCardPatches.map((entry) => entry.messageId),
    ).toEqual(['om_historical_approval_2', 'om_approval_1']);
  });

  it('does not mark manager notification complete until every manager is covered', async () => {
    await seedAwaitingConfirmation(store);
    await store.enqueueTask(
      {
        businessKey: `overtime:${SNAPSHOT.recordId}:notify-managers`,
        recordId: SNAPSHOT.recordId,
        kind: 'notify_managers',
      },
      new Date('2026-08-20T00:00:00.000Z'),
    );
    gateway.sendInteractiveCard.mockImplementation(
      async (recipient: string) => {
        if (recipient === 'ou_manager_2') {
          throw new Error('temporary manager delivery failure');
        }
        return `om_${recipient}`;
      },
    );
    await service.runPendingTasks(new Date('2026-08-20T00:00:00.000Z'));
    expect(
      gateway.updateOvertimeRecord.mock.calls.some(([, fields]) =>
        Object.prototype.hasOwnProperty.call(fields, '加班经理知会时间'),
      ),
    ).toBe(false);
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.managerNoticeCards.map(
        (entry) => entry.recipientOpenId,
      ),
    ).toEqual(['ou_applicant', 'ou_manager_1']);

    gateway.sendInteractiveCard.mockImplementation(
      async (recipient: string) => `om_${recipient}`,
    );
    await service.runPendingTasks(new Date('2026-08-20T00:00:03.000Z'));
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({ 加班经理知会时间: expect.any(Number) }),
    );
  });

  it('updates existing approver cards and sends each uncovered result recipient exactly once', async () => {
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      approvers: activeDirectory.managers.map((entry) => ({
        name: entry.name,
        openId: entry.openId,
        position: entry.position,
        buildings: [],
      })),
      approvalCards: [
        {
          recipientOpenId: 'ou_manager_1',
          messageId: 'om_manager_approval_1',
          businessKey: `overtime:${SNAPSHOT.recordId}:approval:ou_manager_1`,
        },
        {
          recipientOpenId: 'ou_manager_2',
          messageId: 'om_manager_approval_2',
          businessKey: `overtime:${SNAPSHOT.recordId}:approval:ou_manager_2`,
        },
      ],
    });
    await store.enqueueTask(
      {
        businessKey: `overtime:${SNAPSHOT.recordId}:notify-managers`,
        recordId: SNAPSHOT.recordId,
        kind: 'notify_managers',
      },
      new Date('2026-08-20T00:00:00.000Z'),
    );

    await service.runPendingTasks(new Date('2026-08-20T00:00:00.000Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:03.000Z'));

    for (const managerId of ['ou_manager_1', 'ou_manager_2']) {
      expect(
        gateway.sendInteractiveCard.mock.calls.filter(
          ([recipient]) => recipient === managerId,
        ),
      ).toHaveLength(0);
    }
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(
      'om_manager_approval_1',
      expect.any(Object),
    );
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(
      'om_manager_approval_2',
      expect.any(Object),
    );
    expect(
      gateway.sendInteractiveCard.mock.calls.filter(
        ([recipient, , key]) =>
          recipient === 'ou_applicant' &&
          key === `overtime:${SNAPSHOT.recordId}:approval-result:ou_applicant`,
      ),
    ).toHaveLength(1);
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.managerNoticeCards.map(
        (entry) => entry.recipientOpenId,
      ),
    ).toEqual(['ou_applicant']);
  });

  it('notifies the applicant once on rejection and does not notify non-approver managers', async () => {
    await seedApprovalPending(store);
    const accepted = await service.acceptApprovalAction({
      eventId: 'evt_reject_result',
      recordId: SNAPSHOT.recordId,
      action: 'reject',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_approval_1',
    });
    expect(JSON.stringify(accepted.card)).toContain('加班申请审批驳回');

    await service.runPendingTasks(new Date('2026-08-20T00:00:00.000Z'));
    await service.runPendingTasks(new Date('2026-08-20T00:00:03.000Z'));

    expect(
      gateway.sendInteractiveCard.mock.calls.filter(
        ([recipient]) => recipient === 'ou_applicant',
      ),
    ).toHaveLength(1);
    expect(
      gateway.sendInteractiveCard.mock.calls.filter(([recipient]) =>
        ['ou_manager_1', 'ou_manager_2'].includes(recipient),
      ),
    ).toHaveLength(0);
  });

  it('retries terminal approval card updates without resending completed result notices', async () => {
    await seedApprovalPending(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      approvers: [
        ...(await store.getApplication(SNAPSHOT.recordId))!.approvers,
        {
          name: '梅冰冰',
          openId: 'ou_manager_1',
          position: '设施运维经理',
          buildings: [],
        },
      ],
      approvalCards: [
        ...(await store.getApplication(SNAPSHOT.recordId))!.approvalCards,
        {
          recipientOpenId: 'ou_manager_1',
          messageId: 'om_approval_2',
          businessKey: `overtime:${SNAPSHOT.recordId}:approval:ou_manager_1`,
        },
      ],
    });
    let allowSecondCardPatch = false;
    gateway.patchInteractiveCard.mockImplementation(
      async (messageId: string) => {
        if (messageId === 'om_approval_2' && !allowSecondCardPatch) {
          throw new Error('temporary card update failure');
        }
      },
    );
    await service.acceptApprovalAction({
      eventId: 'evt_retry_terminal_cards',
      recordId: SNAPSHOT.recordId,
      action: 'approve',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_approval_1',
    });

    await service.runPendingTasks(new Date('2026-08-20T00:00:00.000Z'));
    expect(
      (await store.listTasks()).find(
        (task) =>
          task.businessKey === `overtime:${SNAPSHOT.recordId}:notify-managers`,
      )?.status,
    ).toBe('pending');
    const applicantSendCount = gateway.sendInteractiveCard.mock.calls.filter(
      ([recipient]) => recipient === 'ou_applicant',
    ).length;

    allowSecondCardPatch = true;
    await service.runPendingTasks(new Date('2026-08-20T00:00:03.000Z'));
    expect(
      (await store.listTasks()).find(
        (task) =>
          task.businessKey === `overtime:${SNAPSHOT.recordId}:notify-managers`,
      )?.status,
    ).toBe('completed');
    expect(
      gateway.sendInteractiveCard.mock.calls.filter(
        ([recipient]) => recipient === 'ou_applicant',
      ),
    ).toHaveLength(applicantSendCount);
  });

  it('sends one initial confirmation at planned end and daily reminders from the next Shanghai day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
    await seedApprovalPending(store);
    await service.acceptApprovalAction({
      eventId: 'evt_initial_confirmation',
      recordId: SNAPSHOT.recordId,
      action: 'approve',
      actorOpenId: 'ou_supervisor',
      messageId: 'om_approval_1',
    });
    await service.runPendingTasks(new Date('2026-08-12T00:00:00.000Z'));
    const initialTask = (await store.listTasks()).find(
      (entry) =>
        entry.businessKey === `overtime-confirm:${SNAPSHOT.recordId}:initial`,
    );
    expect(initialTask?.nextAttemptAt).toBe('2026-08-13T09:00:00.000Z');
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.confirmationCards,
    ).toHaveLength(0);
    await service.runPendingTasks(new Date('2026-08-13T08:59:59.000Z'));
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.confirmationCards,
    ).toHaveLength(0);
    await service.runPendingTasks(new Date('2026-08-13T09:00:00.000Z'));
    const card = gateway.sendInteractiveCard.mock.calls.find(
      ([recipient]) => recipient === 'ou_supervisor',
    )?.[1];
    expect(JSON.stringify(card).match(/确认加班信息/g)).toHaveLength(1);
    expect(JSON.stringify(card)).not.toContain('驳回');
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({
        加班工作流状态: '待确认',
        加班确认最后提醒时间: expect.any(Number),
        加班工作流错误: '',
      }),
    );

    await expect(
      service.enqueueDueConfirmationReminders(
        new Date('2026-08-13T09:01:00.000Z'),
      ),
    ).resolves.toBe(0);
    await expect(
      service.enqueueDueConfirmationReminders(
        new Date('2026-08-14T01:00:00.000Z'),
      ),
    ).resolves.toBe(1);
    await expect(
      service.enqueueDueConfirmationReminders(
        new Date('2026-08-14T01:01:00.000Z'),
      ),
    ).resolves.toBe(0);
    const confirmationTasks = (await store.listTasks()).filter(
      (entry) => entry.kind === 'deliver_confirmation',
    );
    expect(confirmationTasks.map((entry) => entry.businessKey)).toEqual([
      `overtime-confirm:${SNAPSHOT.recordId}:initial`,
      `overtime-confirm:${SNAPSHOT.recordId}:2026-08-14`,
    ]);
    await service.runPendingTasks(new Date('2026-08-14T01:00:00.000Z'));
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.confirmationCards,
    ).toHaveLength(2);
  });

  it('refreshes historical pending confirmation cards with the mobile-safe link and retries only until successful', async () => {
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      confirmationCards: [
        {
          recipientOpenId: 'ou_supervisor',
          messageId: 'om_historical_confirmation',
          businessKey: `overtime-confirm:${SNAPSHOT.recordId}:initial`,
        },
      ],
    });
    gateway.patchInteractiveCard.mockRejectedValueOnce(
      new Error('temporary patch failure'),
    );

    await expect(service.refreshPendingConfirmationCards()).resolves.toEqual({
      refreshed: 0,
      failed: 1,
    });
    await expect(service.refreshPendingConfirmationCards()).resolves.toEqual({
      refreshed: 1,
      failed: 0,
    });
    await expect(service.refreshPendingConfirmationCards()).resolves.toEqual({
      refreshed: 0,
      failed: 0,
    });

    expect(gateway.issueConfirmationTicket).toHaveBeenCalledWith({
      recordId: SNAPSHOT.recordId,
      approverOpenId: 'ou_supervisor',
    });
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(gateway.patchInteractiveCard.mock.calls.at(-1)?.[1]),
    ).toContain('/overtime-confirmation?');
  });

  it('does not send a confirmation reminder after the Base source record was deleted', async () => {
    await seedAwaitingConfirmation(store);
    const staleRouteTask = await store.takeNextTask(
      new Date('2026-08-14T00:00:00.000Z'),
    );
    await store.completeTask(
      staleRouteTask!.key,
      staleRouteTask!.claimToken,
      new Date('2026-08-14T00:00:00.000Z'),
    );
    await store.enqueueDailyConfirmationReminder(
      SNAPSHOT.recordId,
      'ou_supervisor',
      new Date('2026-08-14T00:01:00.000Z'),
    );
    gateway.readOvertimeRecordIfExists.mockResolvedValue(null);

    await expect(
      service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z')),
    ).resolves.toEqual({ processed: 1, failed: 0 });

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect((await store.getApplication(SNAPSHOT.recordId))?.phase).toBe(
      'source_deleted',
    );
    expect(
      (await store.listTasks()).filter(
        (task) =>
          task.recordId === SNAPSHOT.recordId &&
          ['pending', 'processing'].includes(task.status),
      ),
    ).toEqual([]);
  });

  it('retires orphaned historical cards during startup refresh exactly once', async () => {
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      confirmationCards: [
        {
          recipientOpenId: 'ou_supervisor',
          messageId: 'om_orphaned_confirmation',
          businessKey: `overtime-confirm:${SNAPSHOT.recordId}:initial`,
        },
      ],
    });
    gateway.readOvertimeRecordIfExists.mockResolvedValue(null);

    await expect(service.refreshPendingConfirmationCards()).resolves.toEqual({
      refreshed: 2,
      failed: 0,
    });
    expect(
      gateway.patchInteractiveCard.mock.calls.map(([messageId]) => messageId),
    ).toEqual(['om_approval_1', 'om_orphaned_confirmation']);
    const terminalCard = gateway.patchInteractiveCard.mock.calls[0]?.[1];
    expect(JSON.stringify(terminalCard)).toContain('加班申请已撤销');
    expect(JSON.stringify(terminalCard)).not.toContain('open_url');
    expect((await store.getApplication(SNAPSHOT.recordId))?.phase).toBe(
      'source_deleted',
    );

    gateway.patchInteractiveCard.mockClear();
    await expect(service.refreshPendingConfirmationCards()).resolves.toEqual({
      refreshed: 0,
      failed: 0,
    });
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
    await expect(
      service.enqueueDueConfirmationReminders(
        new Date('2026-08-15T00:00:00.000Z'),
      ),
    ).resolves.toBe(0);
  });

  it('does not enqueue a daily reminder for a deleted Base source record', async () => {
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      confirmationCards: [
        {
          recipientOpenId: 'ou_supervisor',
          messageId: 'om_initial_confirmation',
          businessKey: `overtime-confirm:${SNAPSHOT.recordId}:initial`,
        },
      ],
    });
    gateway.readOvertimeRecordIfExists.mockResolvedValue(null);

    await expect(
      service.enqueueDueConfirmationReminders(
        new Date('2026-08-15T01:00:00.000Z'),
      ),
    ).resolves.toBe(0);

    expect((await store.getApplication(SNAPSHOT.recordId))?.phase).toBe(
      'source_deleted',
    );
    expect(
      (await store.listTasks()).filter(
        (task) =>
          task.businessKey ===
          `overtime-confirm:${SNAPSHOT.recordId}:2026-08-15`,
      ),
    ).toEqual([]);
  });

  it('persists an explicitly selected end through the durable queue without canonicalizing the lunch boundary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    const input = {
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-selected-end',
      actualStartAt: '2026-08-13T11:00:00+08:00',
      actualEndAt: '2026-08-13T13:00:00+08:00',
      actualHours: 1,
      disposition: 'overtime_pay' as const,
    };
    const accepted = await service.submitConfirmation(input);
    expect(accepted.actualEndAt).toBe('2026-08-13T13:00:00.000+08:00');
    expect((await store.getConfirmation(SNAPSHOT.recordId))?.draft).toEqual(
      expect.objectContaining({ actualEndAt: accepted.actualEndAt }),
    );
    const reloadedStore = new OvertimeWorkflowStore(
      join(directory, 'ledger.json'),
    );
    expect(
      (await reloadedStore.getConfirmation(SNAPSHOT.recordId))?.draft,
    ).toEqual(expect.objectContaining({ actualEndAt: accepted.actualEndAt }));
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).resolves.toEqual(
      expect.objectContaining({ actualEndAt: accepted.actualEndAt }),
    );
    await expect(service.submitConfirmation(input)).resolves.toEqual(accepted);
    await expect(
      service.submitConfirmation({
        ...input,
        actualEndAt: '2026-08-13T12:00:00+08:00',
      }),
    ).rejects.toThrow();
    await service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z'));
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({
        实际加班结束时间: Date.parse(input.actualEndAt),
        实际加班时长: 1,
      }),
    );
  });

  it.each([
    ['2026-08-13T10:00:00+08:00', 1],
    ['2026-08-13T11:30:00+08:00', 1],
    ['2026-08-13T14:00:00+08:00', 1],
    ['2026-08-13T13:00:00+08:00', 0],
    ['2027-08-13T13:00:00+08:00', 1],
    ['', 1],
  ])(
    'rejects inconsistent end %s / hours %s before queueing',
    async (actualEndAt, actualHours) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
      await seedAwaitingConfirmation(store);
      const input = {
        recordId: SNAPSHOT.recordId,
        ticket: 'signed-ticket',
        mutationId: 'invalid-end',
        actualStartAt: '2026-08-13T11:00:00+08:00',
        actualEndAt,
        actualHours,
        disposition: actualHours === 0 ? null : ('overtime_pay' as const),
      };
      await expect(service.submitConfirmation(input)).rejects.toThrow();
      expect(await store.getConfirmation(SNAPSHOT.recordId)).toBeNull();
    },
  );

  it('validates the ticket, returns prefilled confirmation and queues exact integer-hour draft', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).resolves.toEqual(
      expect.objectContaining({
        actualStartAt: null,
        actualHours: null,
        disposition: null,
      }),
    );
    expect(gateway.readOvertimeRecord).not.toHaveBeenCalled();

    const accepted = await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-1',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'overtime_pay',
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.actualEndAt).toBe('2026-08-13T17:00:00.000+08:00');
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).resolves.toEqual(
      expect.objectContaining({
        actualStartAt: '2026-08-13T10:00:00.000+08:00',
        actualHours: 6,
        disposition: 'overtime_pay',
      }),
    );
    expect(gateway.updateOvertimeRecord).not.toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({ 实际加班时长: 6 }),
    );
    await service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z'));
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({
        实际加班结束时间: Date.parse('2026-08-13T17:00:00+08:00'),
        实际加班时长: 6,
        确认加班工时: 6,
        加班工时处置: '费用结算',
        加班确认: '确认',
        加班流程进展: '已确认',
        加班工作流状态: '已确认',
        加班确认人: [{ id: 'ou_supervisor' }],
        加班确认时间: expect.any(Number),
        加班工作流错误: '',
      }),
    );
  });

  it('recovers an approved confirmation from the exact Base record when the local ledger is missing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    gateway.readOvertimeRecord.mockResolvedValue({
      recordId: SNAPSHOT.recordId,
      fields: approvedOvertimeBaseFields(),
    });

    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).resolves.toEqual(
      expect.objectContaining({
        recordId: SNAPSHOT.recordId,
        staffName: SNAPSHOT.applicantName,
        building: SNAPSHOT.building,
        position: SNAPSHOT.position,
        plannedStartAt: '2026-08-13T09:00:00.000+08:00',
        plannedEndAt: '2026-08-13T17:00:00.000+08:00',
        plannedHours: SNAPSHOT.plannedHours,
        actualStartAt: null,
        actualHours: null,
        disposition: null,
      }),
    );
    expect(gateway.readOvertimeRecord).toHaveBeenCalledWith(SNAPSHOT.recordId);
    await expect(store.getApplication(SNAPSHOT.recordId)).resolves.toEqual(
      expect.objectContaining({
        phase: 'awaiting_confirmation',
        actualApproverOpenId: 'ou_supervisor',
        actualApproverName: '施小东',
      }),
    );
    await expect(store.listTasks()).resolves.toEqual([]);
  });

  it('does not recover a missing ledger from a terminal or differently approved Base record', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    gateway.readOvertimeRecord.mockResolvedValueOnce({
      recordId: SNAPSHOT.recordId,
      fields: approvedOvertimeBaseFields({
        加班审批人: [{ id: 'ou_manager_1', name: '梅冰冰' }],
      }),
    });
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).rejects.toThrow('当前确认令牌无权访问该加班记录');
    await expect(store.getApplication(SNAPSHOT.recordId)).resolves.toBeNull();

    gateway.readOvertimeRecord.mockResolvedValueOnce({
      recordId: SNAPSHOT.recordId,
      fields: approvedOvertimeBaseFields({
        加班工作流状态: '已确认',
        加班确认: '确认',
      }),
    });
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).rejects.toThrow('当前加班申请不在待确认状态');
    await expect(store.getApplication(SNAPSHOT.recordId)).resolves.toBeNull();
  });

  it('accepts only the exact submit replay after confirmation while detail stays closed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    const submission = {
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-exact-replay',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'overtime_pay' as const,
    };
    await service.submitConfirmation(submission);
    await service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z'));
    const taskCount = (await store.listTasks()).length;
    const confirmationBaseWrites = () =>
      gateway.updateOvertimeRecord.mock.calls.filter(
        ([, fields]) => fields.加班确认 === '确认',
      );
    const baseWriteCount = confirmationBaseWrites().length;

    await expect(service.submitConfirmation(submission)).resolves.toEqual(
      expect.objectContaining({
        accepted: true,
        mutationId: submission.mutationId,
      }),
    );
    await expect(
      service.submitConfirmation({
        ...submission,
        mutationId: 'confirm-different-mutation',
      }),
    ).rejects.toThrow();
    await expect(
      service.submitConfirmation({ ...submission, actualHours: 5 }),
    ).rejects.toThrow();
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).rejects.toThrow('当前加班申请不在待确认状态');
    expect(await store.listTasks()).toHaveLength(taskCount);
    expect(confirmationBaseWrites()).toHaveLength(baseWriteCount);
  });

  it('accepts zero actual hours, keeps end equal to start and clears the Base disposition', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);

    const accepted = await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-zero-hour',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 0,
      disposition: null,
    } as never);

    expect(accepted).toEqual(
      expect.objectContaining({
        actualStartAt: '2026-08-13T10:00:00.000+08:00',
        actualEndAt: '2026-08-13T10:00:00.000+08:00',
        actualHours: 0,
        disposition: null,
      }),
    );
    await service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z'));
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledWith(
      SNAPSHOT.recordId,
      expect.objectContaining({
        实际加班开始时间: Date.parse('2026-08-13T10:00:00+08:00'),
        实际加班结束时间: Date.parse('2026-08-13T10:00:00+08:00'),
        实际加班时长: 0,
        确认加班工时: 0,
        加班工时处置: null,
        加班确认: '确认',
        加班流程进展: '已确认',
        加班工作流状态: '已确认',
      }),
    );
    const applicantResultCalls = gateway.sendInteractiveCard.mock.calls.filter(
      ([recipient]) => recipient === SNAPSHOT.applicantOpenId,
    );
    expect(applicantResultCalls).toHaveLength(1);
    expect(applicantResultCalls[0][2]).toBe(
      `overtime:${SNAPSHOT.recordId}:confirmation-result:${SNAPSHOT.applicantOpenId}`,
    );
    expect(JSON.stringify(applicantResultCalls[0][1])).toContain('加班已取消');
    expect(JSON.stringify(applicantResultCalls[0][1])).toContain('无需处置');
  });

  it('requires a disposition for positive hours and forbids one for zero hours', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);

    await expect(
      service.submitConfirmation({
        recordId: SNAPSHOT.recordId,
        ticket: 'signed-ticket',
        mutationId: 'confirm-positive-without-disposition',
        actualStartAt: '2026-08-13T10:00:00+08:00',
        actualHours: 1,
        disposition: null,
      } as never),
    ).rejects.toThrow('请选择加班工时处置方式');
    await expect(
      service.submitConfirmation({
        recordId: SNAPSHOT.recordId,
        ticket: 'signed-ticket',
        mutationId: 'confirm-zero-with-disposition',
        actualStartAt: '2026-08-13T10:00:00+08:00',
        actualHours: 0,
        disposition: 'compensatory_leave',
      }),
    ).rejects.toThrow('0 工时无需选择加班工时处置方式');
  });

  it('does not coerce a null hour value into a zero-hour cancellation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);

    await expect(
      service.submitConfirmation({
        recordId: SNAPSHOT.recordId,
        ticket: 'signed-ticket',
        mutationId: 'confirm-null-hours',
        actualStartAt: '2026-08-13T10:00:00+08:00',
        actualHours: null,
        disposition: null,
      } as never),
    ).rejects.toThrow('实际加班工时必须是 0 至 72 的整数');
  });

  it('updates confirmation card holders and sends one result to every uncovered deduplicated recipient', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      professionalRecipients: [
        {
          name: '周海祥',
          openId: 'ou_professional',
          position: '电气主管',
          buildings: ['H楼'],
        },
        {
          name: '梅冰冰',
          openId: 'ou_manager_1',
          position: '电气主管',
          buildings: [],
        },
      ],
      approvers: [
        {
          name: '施小东',
          openId: 'ou_supervisor',
          position: '设施运维主管',
          buildings: ['A楼'],
        },
        {
          name: '梅冰冰',
          openId: 'ou_manager_1',
          position: '设施运维经理',
          buildings: [],
        },
      ],
      confirmationCards: [
        {
          recipientOpenId: 'ou_supervisor',
          messageId: 'om_confirmation_supervisor',
          businessKey: `overtime-confirm:${SNAPSHOT.recordId}:initial`,
        },
      ],
    });
    await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-result-fanout',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'compensatory_leave',
    });

    await service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z'));

    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith(
      'om_confirmation_supervisor',
      expect.any(Object),
    );
    expect(
      gateway.sendInteractiveCard.mock.calls.map(([recipient]) => recipient),
    ).toEqual([
      'ou_applicant',
      'ou_manager_1',
      'ou_manager_2',
      'ou_professional',
    ]);
    expect(
      gateway.sendInteractiveCard.mock.calls.map(
        ([, , businessKey]) => businessKey,
      ),
    ).toEqual([
      `overtime:${SNAPSHOT.recordId}:confirmation-result:ou_applicant`,
      `overtime:${SNAPSHOT.recordId}:confirmation-result:ou_manager_1`,
      `overtime:${SNAPSHOT.recordId}:confirmation-result:ou_manager_2`,
      `overtime:${SNAPSHOT.recordId}:confirmation-result:ou_professional`,
    ]);
    const application = await store.getApplication(SNAPSHOT.recordId);
    expect(application?.phase).toBe('confirmed');
    expect(
      application?.confirmationResultCards.map(
        (entry) => entry.recipientOpenId,
      ),
    ).toEqual([
      'ou_applicant',
      'ou_manager_1',
      'ou_manager_2',
      'ou_professional',
    ]);
    expect(
      JSON.stringify(gateway.sendInteractiveCard.mock.calls[0][1]),
    ).toContain('施小东');
  });

  it('retries partial result delivery without rewriting Base or resending successful recipients', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      confirmationCards: [
        {
          recipientOpenId: 'ou_supervisor',
          messageId: 'om_confirmation_supervisor',
          businessKey: `overtime-confirm:${SNAPSHOT.recordId}:initial`,
        },
      ],
    });
    let failManagerTwo = true;
    gateway.sendInteractiveCard.mockImplementation(
      async (recipient: string) => {
        if (recipient === 'ou_manager_2' && failManagerTwo) {
          throw new Error('temporary result delivery failure');
        }
        return `om_${recipient}`;
      },
    );
    await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-result-retry',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'overtime_pay',
    });

    await expect(
      service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z')),
    ).resolves.toEqual({ processed: 1, failed: 1 });
    const afterFailure = await store.getApplication(SNAPSHOT.recordId);
    expect(afterFailure?.phase).toBe('confirmed');
    expect(
      afterFailure?.confirmationResultCards.map(
        (entry) => entry.recipientOpenId,
      ),
    ).toEqual(['ou_applicant', 'ou_manager_1']);
    const baseConfirmationWrites = () =>
      gateway.updateOvertimeRecord.mock.calls.filter(
        ([, fields]) => fields.加班确认 === '确认',
      );
    expect(baseConfirmationWrites()).toHaveLength(1);

    failManagerTwo = false;
    await expect(
      service.runPendingTasks(new Date('2026-08-14T00:01:03.000Z')),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    expect(baseConfirmationWrites()).toHaveLength(1);
    for (const recipient of ['ou_applicant', 'ou_manager_1']) {
      expect(
        gateway.sendInteractiveCard.mock.calls.filter(
          ([target]) => target === recipient,
        ),
      ).toHaveLength(1);
    }
    expect(
      gateway.sendInteractiveCard.mock.calls.filter(
        ([target]) => target === 'ou_manager_2',
      ),
    ).toHaveLength(2);
    expect(
      (
        await store.getApplication(SNAPSHOT.recordId)
      )?.confirmationResultCards.filter(
        (entry) => entry.recipientOpenId === 'ou_manager_2',
      ),
    ).toHaveLength(1);
    expect(
      (await store.listTasks()).find(
        (entry) => entry.kind === 'apply_confirmation',
      )?.status,
    ).toBe('completed');
  });

  it('persists a result intent before send and retries a lost delivered write with the same business key and UUID', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    const originalPatchApplication = store.patchApplication.bind(store);
    let failFirstDeliveredWrite = true;
    jest
      .spyOn(store, 'patchApplication')
      .mockImplementation(async (recordId, patch, options) => {
        if (
          failFirstDeliveredWrite &&
          Object.prototype.hasOwnProperty.call(patch, 'confirmationResultCards')
        ) {
          failFirstDeliveredWrite = false;
          throw new Error('simulated delivered ledger write failure');
        }
        return originalPatchApplication(recordId, patch, options);
      });
    await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-result-outbox-retry',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'overtime_pay',
    });

    await expect(
      service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z')),
    ).resolves.toEqual({ processed: 1, failed: 1 });
    const afterFailure = await store.getApplication(SNAPSHOT.recordId);
    const applicantIntent = afterFailure?.confirmationResultIntents.find(
      (entry) => entry.recipientOpenId === 'ou_applicant',
    );
    expect(applicantIntent).toEqual(
      expect.objectContaining({
        businessKey: `overtime:${SNAPSHOT.recordId}:confirmation-result:ou_applicant`,
        messageUuid: stableOvertimeMessageUuid(
          `overtime:${SNAPSHOT.recordId}:confirmation-result:ou_applicant`,
        ),
      }),
    );
    expect(afterFailure?.confirmationResultCards).toHaveLength(0);

    await expect(
      service.runPendingTasks(new Date('2026-08-14T00:01:03.000Z')),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    const applicantAttempts = gateway.sendInteractiveCard.mock.calls.filter(
      ([recipient]) => recipient === 'ou_applicant',
    );
    expect(applicantAttempts).toHaveLength(2);
    expect(applicantAttempts[0][2]).toBe(applicantAttempts[1][2]);
    expect(stableOvertimeMessageUuid(applicantAttempts[0][2])).toBe(
      applicantIntent?.messageUuid,
    );
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.confirmationResultCards,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipientOpenId: 'ou_applicant' }),
      ]),
    );
  });

  it('does not blindly resend an unresolved result intent after the one-hour Feishu dedupe window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    const originalPatchApplication = store.patchApplication.bind(store);
    let failFirstDeliveredWrite = true;
    jest
      .spyOn(store, 'patchApplication')
      .mockImplementation(async (recordId, patch, options) => {
        if (
          failFirstDeliveredWrite &&
          Object.prototype.hasOwnProperty.call(patch, 'confirmationResultCards')
        ) {
          failFirstDeliveredWrite = false;
          throw new Error('simulated delivered ledger write failure');
        }
        return originalPatchApplication(recordId, patch, options);
      });
    await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-result-outbox-expired',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'overtime_pay',
    });
    await service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z'));
    const applicantSendCount = gateway.sendInteractiveCard.mock.calls.filter(
      ([recipient]) => recipient === 'ou_applicant',
    ).length;

    await expect(
      service.runPendingTasks(new Date('2026-08-14T01:01:01.000Z')),
    ).resolves.toEqual({ processed: 0, failed: 1 });
    expect(
      gateway.sendInteractiveCard.mock.calls.filter(
        ([recipient]) => recipient === 'ou_applicant',
      ),
    ).toHaveLength(applicantSendCount);
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.lastError,
    ).toContain('超过飞书一小时幂等重试窗口');
  });

  it('rechecks the wall clock before send and refuses when work crosses into the Feishu retry safety margin', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    const originalPatchApplication = store.patchApplication.bind(store);
    let failFirstDeliveredWrite = true;
    jest
      .spyOn(store, 'patchApplication')
      .mockImplementation(async (recordId, patch, options) => {
        if (
          failFirstDeliveredWrite &&
          Object.prototype.hasOwnProperty.call(patch, 'confirmationResultCards')
        ) {
          failFirstDeliveredWrite = false;
          throw new Error('simulated delivered ledger write failure');
        }
        return originalPatchApplication(recordId, patch, options);
      });
    await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-result-outbox-safety-margin',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'overtime_pay',
    });
    await service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z'));
    gateway.sendInteractiveCard.mockClear();

    const originalGetConfirmation = store.getConfirmation.bind(store);
    jest
      .spyOn(store, 'getConfirmation')
      .mockImplementation(async (recordId) => {
        const result = await originalGetConfirmation(recordId);
        jest.setSystemTime(new Date('2026-08-14T01:00:30.001Z'));
        return result;
      });
    jest.setSystemTime(new Date('2026-08-14T01:00:29.900Z'));

    await expect(
      service.runPendingTasks(new Date('2026-08-14T01:00:29.900Z')),
    ).resolves.toEqual({ processed: 0, failed: 1 });
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(
      (await store.getApplication(SNAPSHOT.recordId))?.lastError,
    ).toContain('30 秒安全余量');
  });

  it('does not keep daily reminders alive when a historical confirmation card cannot be patched', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    await store.patchApplication(SNAPSHOT.recordId, {
      confirmationCards: [
        {
          recipientOpenId: 'ou_supervisor',
          messageId: 'om_historical_confirmation_1',
          businessKey: `overtime-confirm:${SNAPSHOT.recordId}:initial`,
        },
      ],
    });
    gateway.patchInteractiveCard.mockRejectedValue(
      new Error('historical confirmation card no longer exists'),
    );
    await service.submitConfirmation({
      recordId: SNAPSHOT.recordId,
      ticket: 'signed-ticket',
      mutationId: 'confirm-patch-failure',
      actualStartAt: '2026-08-13T10:00:00+08:00',
      actualHours: 6,
      disposition: 'compensatory_leave',
    });

    await expect(
      service.runPendingTasks(new Date('2026-08-14T00:01:00.000Z')),
    ).resolves.toEqual({ processed: 1, failed: 1 });

    expect((await store.getApplication(SNAPSHOT.recordId))?.phase).toBe(
      'confirmed',
    );
    const firstResultSendCount = gateway.sendInteractiveCard.mock.calls.length;
    const firstBaseWriteCount = gateway.updateOvertimeRecord.mock.calls.filter(
      ([, fields]) => fields.加班确认 === '确认',
    ).length;
    await expect(
      service.enqueueDueConfirmationReminders(
        new Date('2026-08-15T01:00:00.000Z'),
      ),
    ).resolves.toBe(0);

    gateway.patchInteractiveCard.mockResolvedValue(undefined);
    await expect(
      service.runPendingTasks(new Date('2026-08-14T00:01:03.000Z')),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(
      firstResultSendCount,
    );
    expect(
      gateway.updateOvertimeRecord.mock.calls.filter(
        ([, fields]) => fields.加班确认 === '确认',
      ),
    ).toHaveLength(firstBaseWriteCount);
  });

  it('rejects non-hour start values and non-integer hours before touching the store', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    await expect(
      service.submitConfirmation({
        recordId: SNAPSHOT.recordId,
        ticket: 'signed-ticket',
        mutationId: 'confirm-1',
        actualStartAt: '2026-08-13T10:30:00+08:00',
        actualHours: 4.5,
        disposition: 'compensatory_leave',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a ticket actor that is not the actual approver', async () => {
    await seedAwaitingConfirmation(store);
    gateway.verifyConfirmationTicket.mockReturnValue({
      recordId: SNAPSHOT.recordId,
      approverOpenId: 'ou_manager_1',
      issuedAt: Date.now(),
    });
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not allow confirmation before the planned overtime end', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T08:00:00.000Z'));
    await seedAwaitingConfirmation(store);
    await expect(
      service.getConfirmationDetail(SNAPSHOT.recordId, 'signed-ticket'),
    ).rejects.toThrow('加班结束后才能确认实际加班信息');
  });

  it('defaults to enabled and rejects entry points when explicitly disabled', async () => {
    const before = process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED;
    try {
      delete process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED;
      expect(service.isEnabled()).toBe(true);
      process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED = 'off';
      expect(service.isEnabled()).toBe(false);
      await expect(
        service.acceptApplication({
          request: {
            clientMutationId: 'overtime-request-disabled',
            staffName: '张三',
            startAt: SNAPSHOT.plannedStartAt,
            endAt: SNAPSHOT.plannedEndAt,
            reason: SNAPSHOT.reason,
            expectedImpact: IMPACT,
          },
          result: {
            success: true,
            created: 1,
            recordId: SNAPSHOT.recordId,
            clientMutationId: 'overtime-request-disabled',
            requestFingerprint: 'disabled',
            impact: IMPACT,
            message: 'ok',
          },
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      if (before === undefined) {
        delete process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED;
      } else {
        process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED = before;
      }
    }
  });
});

async function seedApplication(store: OvertimeWorkflowStore) {
  await store.acceptApplication(
    { clientMutationId: 'overtime-request-1', snapshot: SNAPSHOT },
    new Date('2026-08-11T23:59:00.000Z'),
  );
}

async function seedApprovalPending(store: OvertimeWorkflowStore) {
  await seedApplication(store);
  await store.patchApplication(SNAPSHOT.recordId, {
    phase: 'approval_pending',
    approvers: [
      {
        name: '施小东',
        openId: 'ou_supervisor',
        position: '设施运维主管',
        buildings: ['A楼'],
      },
    ],
    managerRecipients: activeDirectory.managers.map((entry) => ({
      name: entry.name,
      openId: entry.openId,
      position: entry.position,
      buildings: entry.buildings.map((building) => `${building}楼`),
    })),
    approvalCards: [
      {
        recipientOpenId: 'ou_supervisor',
        messageId: 'om_approval_1',
        businessKey: `overtime:${SNAPSHOT.recordId}:approval:ou_supervisor`,
      },
    ],
  });
}

async function seedAwaitingConfirmation(store: OvertimeWorkflowStore) {
  await seedApprovalPending(store);
  await store.patchApplication(SNAPSHOT.recordId, {
    phase: 'awaiting_confirmation',
    actualApproverOpenId: 'ou_supervisor',
    actualApproverName: '施小东',
    approvedAt: '2026-08-12T00:00:00.000Z',
  });
}

function approvedOvertimeBaseFields(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    加班人员: [{ id: SNAPSHOT.applicantOpenId, name: SNAPSHOT.applicantName }],
    加班人员姓名: SNAPSHOT.applicantName,
    加班开始时间: Date.parse(SNAPSHOT.plannedStartAt),
    加班结束时间: Date.parse(SNAPSHOT.plannedEndAt),
    加班时长: String(SNAPSHOT.plannedHours),
    加班原因: SNAPSHOT.reason,
    加班审批: '同意',
    加班流程进展: '已审批',
    加班工作流状态: '待确认',
    加班审批人: [{ id: 'ou_supervisor', name: '施小东' }],
    加班审批时间: Date.parse('2026-08-12T00:00:00.000Z'),
    ...overrides,
  };
}
