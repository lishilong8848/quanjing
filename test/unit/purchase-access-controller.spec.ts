jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'app',
      app_secret: 'secret',
    })),
    readEnv: jest.fn(() => ''),
  }),
  { virtual: true },
);

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  const setMetadata =
    (key: string, value: unknown) =>
    (...decoratorArguments: unknown[]) => {
      const [target, context, descriptor] = decoratorArguments as [
        object,
        { kind?: string } | string | undefined,
        { value?: object } | undefined,
      ];
      const metadataTarget =
        typeof context === 'object' && context?.kind === 'method'
          ? target
          : descriptor?.value || target;
      Reflect.defineMetadata(key, value, metadataTarget);
    };
  return {
    ...actual,
    Body: decorator,
    Controller: decorator,
    Get: decorator,
    HttpCode: decorator,
    Injectable: decorator,
    Param: decorator,
    Patch: decorator,
    Post: decorator,
    Query: decorator,
    Req: decorator,
    Res: decorator,
    SetMetadata: setMetadata,
    UploadedFiles: decorator,
    UseInterceptors: decorator,
  };
});

jest.mock('@nestjs/platform-express', () => ({
  FileFieldsInterceptor: jest.fn(() => class TestFileFieldsInterceptor {}),
  FilesInterceptor: jest.fn(() => class TestFilesInterceptor {}),
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccessPrincipal,
  AccessRole,
} from '../../shared/access-control.interface';
import { AdminOnlyMetadataKey } from '../../server/common/access/unified-access.decorators';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';

const applicantA: AccessPrincipal = {
  role: 'purchase_applicant',
  purchaseBuilding: 'A楼',
};
const APPLICATION_IDEMPOTENCY_KEY = 'purchase-controller-001';
const APPLICATION_SUBMISSION_FINGERPRINT = 'a'.repeat(64);
const ACCESS_PRINCIPAL_FINGERPRINT = 'A'.repeat(43);
const OTHER_ACCESS_PRINCIPAL_FINGERPRINT = 'B'.repeat(43);

describe('PurchaseInventoryController purchase access gateways', () => {
  let inventoryService: { getDashboard: jest.Mock };
  let deletionService: { deleteRecords: jest.Mock };
  let editService: { updateRecord: jest.Mock };
  let onlineApprovalService: {
    acceptDecision: jest.Mock;
    getDecisionTaskStatus: jest.Mock;
  };
  let applicationService: {
    getOptions: jest.Mock;
    searchCatalog: jest.Mock;
    searchApplicants: jest.Mock;
    resolveApplicantForBuilding: jest.Mock;
    findAcceptedApplication: jest.Mock;
    acceptApplications: jest.Mock;
    getSubmissionTaskStatus: jest.Mock;
    submitApplications: jest.Mock;
  };
  let policy: {
    scopeDashboard: jest.Mock;
    requireApplicantBuilding: jest.Mock;
    assertRequestedBuilding: jest.Mock;
    authorizeDelete: jest.Mock;
    prepareUpdate: jest.Mock;
  };
  let controller: any;

  beforeEach(() => {
    inventoryService = { getDashboard: jest.fn() };
    deletionService = { deleteRecords: jest.fn() };
    editService = { updateRecord: jest.fn() };
    onlineApprovalService = {
      acceptDecision: jest.fn().mockReturnValue({
        pending: true,
        taskId: 'purchase-approval-task-1',
        message: '审批操作已受理，正在后台同步飞书多维表',
      }),
      getDecisionTaskStatus: jest.fn(),
    };
    applicationService = {
      getOptions: jest.fn().mockReturnValue(options()),
      searchCatalog: jest.fn().mockResolvedValue([]),
      searchApplicants: jest.fn().mockResolvedValue([]),
      resolveApplicantForBuilding: jest.fn(),
      findAcceptedApplication: jest.fn().mockReturnValue(null),
      acceptApplications: jest.fn().mockReturnValue({
        pending: true,
        taskId: 'purchase-application-task-1',
        message: '采购申请已受理，正在后台同步飞书多维表',
      }),
      getSubmissionTaskStatus: jest.fn().mockReturnValue({
        success: true,
        task: { id: 'purchase-application-task-1', status: 'running' },
      }),
      submitApplications: jest.fn().mockResolvedValue({ success: true }),
    };
    policy = {
      scopeDashboard: jest.fn(
        (_: AccessPrincipal, dashboard: unknown) => dashboard,
      ),
      requireApplicantBuilding: jest.fn(() => 'A楼'),
      assertRequestedBuilding: jest.fn(
        (principal: AccessPrincipal, value: unknown) => {
          const building = String(value || '').trim();
          if (!['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼'].includes(building)) {
            throw new ForbiddenException();
          }
          if (principal.role === 'purchase_applicant' && building !== 'A楼') {
            throw new ForbiddenException();
          }
          return building;
        },
      ),
      authorizeDelete: jest.fn(
        async (_: AccessPrincipal, value: unknown) => value,
      ),
      prepareUpdate: jest.fn(
        async (_: AccessPrincipal, __: string, value: unknown) => value,
      ),
    };
    const approvalDependencies =
      PurchaseInventoryController.length >= 9 ? [onlineApprovalService] : [];
    controller = new (PurchaseInventoryController as any)(
      inventoryService,
      policy,
      deletionService,
      editService,
      ...approvalDependencies,
      applicationService,
      {},
      {},
      {},
    );
  });

  it('requires a guard-provided principal before reading protected data', async () => {
    await expect(controller.getDashboard({})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inventoryService.getDashboard).not.toHaveBeenCalled();
  });

  it('ignores applicant refresh requests before scoping the cached dashboard', async () => {
    const full = { marker: 'full' };
    const scoped = { marker: 'scoped' };
    inventoryService.getDashboard.mockResolvedValue(full);
    policy.scopeDashboard.mockReturnValue(scoped);

    await expect(
      controller.getDashboard(requestFor(applicantA), 'true'),
    ).resolves.toBe(scoped);
    expect(inventoryService.getDashboard).toHaveBeenCalledWith(false);
    expect(policy.scopeDashboard).toHaveBeenCalledWith(applicantA, full, false);
  });

  it('allows applicants to refresh active purchase records without granting a full refresh', async () => {
    inventoryService.getDashboard.mockResolvedValue({});

    await controller.getDashboard(requestFor(applicantA), 'active');

    expect(inventoryService.getDashboard).toHaveBeenCalledWith('active');
  });

  it('keeps explicit dashboard refresh available to full purchase roles', async () => {
    inventoryService.getDashboard.mockResolvedValue({});

    await controller.getDashboard(
      requestFor(principal('purchase_admin')),
      'true',
    );

    expect(inventoryService.getDashboard).toHaveBeenCalledWith(true);
  });

  it('limits applicant options to the session building without changing other options', () => {
    const result = controller.getApplicationOptions(requestFor(applicantA));

    expect(result).toEqual({ ...options(), buildings: ['A楼'] });
    expect(policy.requireApplicantBuilding).toHaveBeenCalledWith(applicantA);
  });

  it.each(['admin', 'editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'keeps the full application options for %s',
    (role) => {
      expect(
        controller.getApplicationOptions(requestFor(principal(role))),
      ).toEqual(options());
    },
  );

  it('does not retain AdminOnly on the policy-authorized batch delete route', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/purchase-inventory/purchase-inventory.controller.ts',
      ),
      'utf8',
    );

    expect(source).not.toMatch(
      /@AdminOnly\(\)\s*@Post\('records\/batch-delete'\)/,
    );
    expect(
      Reflect.getMetadata(
        AdminOnlyMetadataKey,
        PurchaseInventoryController.prototype.deleteRecords,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        AdminOnlyMetadataKey,
        PurchaseInventoryController.prototype.selfTestWorkflows,
      ),
    ).toBe(true);
  });

  it('authorizes a batch delete before invoking the deletion gateway', async () => {
    const events: string[] = [];
    const body = { records: [{ submissionRecordId: 'rec-a' }] };
    policy.authorizeDelete.mockImplementation(async () => {
      events.push('authorize');
      return body;
    });
    deletionService.deleteRecords.mockImplementation(async () => {
      events.push('delete');
      return { success: true };
    });

    await controller.deleteRecords(requestFor(applicantA), body);

    expect(events).toEqual(['authorize', 'delete']);
    expect(deletionService.deleteRecords).toHaveBeenCalledWith(body);
  });

  it('never invokes deletion when a mixed-building batch is rejected', async () => {
    policy.authorizeDelete.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.deleteRecords(requestFor(applicantA), {
        records: [
          { submissionRecordId: 'rec-a' },
          { submissionRecordId: 'rec-b' },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deletionService.deleteRecords).not.toHaveBeenCalled();
  });

  it('prepares an update before invoking the edit gateway', async () => {
    const events: string[] = [];
    const body = { submissionRecordId: 'rec-a', fields: { notes: 'ok' } };
    const prepared = { ...body, fields: { notes: 'prepared' } };
    policy.prepareUpdate.mockImplementation(async () => {
      events.push('prepare');
      return prepared;
    });
    editService.updateRecord.mockImplementation(async () => {
      events.push('edit');
      return { success: true };
    });

    await controller.updateRecord(requestFor(applicantA), 'rec-a', body);

    expect(events).toEqual(['prepare', 'edit']);
    expect(editService.updateRecord).toHaveBeenCalledWith('rec-a', prepared);
  });

  it('never invokes edit when the policy rejects an unknown or cross-building record', async () => {
    policy.prepareUpdate.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.updateRecord(requestFor(applicantA), 'rec-b', {
        submissionRecordId: 'rec-b',
        fields: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(editService.updateRecord).not.toHaveBeenCalled();
  });

  it('lets an administrator decide an online purchase approval', async () => {
    const input = { decision: 'approved' };

    await expect(
      controller.approveRecord(
        requestFor(principal('admin')),
        'rec-approval-1',
        input,
      ),
    ).resolves.toEqual({
      pending: true,
      taskId: 'purchase-approval-task-1',
      message: '审批操作已受理，正在后台同步飞书多维表',
    });
    expect(onlineApprovalService.acceptDecision).toHaveBeenCalledWith(
      'rec-approval-1',
      input,
    );
  });

  it.each([
    'editor',
    'purchase_admin',
    'supply_chain_admin',
    'purchase_applicant',
    'guest',
  ] as AccessRole[])(
    'rejects online purchase approval for %s before invoking the service',
    async (role) => {
      const accessPrincipal =
        role === 'purchase_applicant' ? applicantA : principal(role);
      const error = await controller
        .approveRecord(requestFor(accessPrincipal), 'rec-approval-1', {
          decision: 'rejected',
        })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getStatus()).toBe(403);
      expect(onlineApprovalService.acceptDecision).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', 'short', `valid-but-controlled\nvalue`])(
    'rejects a missing or malformed guard principal fingerprint before applicant lookup: %p',
    async (accessPrincipalFingerprint) => {
      await expect(
        controller.submitApplications(
          {
            accessPrincipal: applicantA,
            accessRole: applicantA.role,
            accessPrincipalFingerprint,
          },
          JSON.stringify(applicationRequest()),
          [],
          APPLICATION_IDEMPOTENCY_KEY,
          APPLICATION_SUBMISSION_FINGERPRINT,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(policy.assertRequestedBuilding).not.toHaveBeenCalled();
      expect(applicationService.findAcceptedApplication).not.toHaveBeenCalled();
      expect(
        applicationService.resolveApplicantForBuilding,
      ).not.toHaveBeenCalled();
      expect(applicationService.acceptApplications).not.toHaveBeenCalled();
    },
  );

  it('reuses a durable application before refreshing the external applicant directory', async () => {
    const request = applicationRequest();
    const recovered = {
      pending: true,
      taskId: 'purchase-application-original',
      message: '原采购申请仍在确认中',
    };
    applicationService.findAcceptedApplication.mockReturnValue(recovered);
    applicationService.resolveApplicantForBuilding.mockRejectedValue(
      new Error('在职人员数据源不可用'),
    );

    await expect(
      controller.submitApplications(
        requestFor(applicantA),
        JSON.stringify(request),
        [],
        APPLICATION_IDEMPOTENCY_KEY,
        APPLICATION_SUBMISSION_FINGERPRINT,
      ),
    ).resolves.toBe(recovered);

    expect(applicationService.findAcceptedApplication).toHaveBeenCalledWith(
      request,
      [],
      'A楼',
      APPLICATION_IDEMPOTENCY_KEY,
      APPLICATION_SUBMISSION_FINGERPRINT,
      ACCESS_PRINCIPAL_FINGERPRINT,
    );
    expect(
      applicationService.resolveApplicantForBuilding,
    ).not.toHaveBeenCalled();
    expect(applicationService.acceptApplications).not.toHaveBeenCalled();
  });

  it('accepts a new application before the external applicant directory settles', async () => {
    const request = applicationRequest();
    applicationService.resolveApplicantForBuilding.mockImplementation(
      () => new Promise(() => undefined),
    );

    const outcome = await Promise.race([
      controller.submitApplications(
        requestFor(applicantA),
        JSON.stringify(request),
        [],
        APPLICATION_IDEMPOTENCY_KEY,
        APPLICATION_SUBMISSION_FINGERPRINT,
      ),
      new Promise((resolve) =>
        setImmediate(() => resolve({ blockedOnApplicantDirectory: true })),
      ),
    ]);

    expect(outcome).toEqual(
      expect.objectContaining({
        pending: true,
        taskId: 'purchase-application-task-1',
      }),
    );
    expect(
      applicationService.resolveApplicantForBuilding,
    ).not.toHaveBeenCalled();
    expect(applicationService.acceptApplications).toHaveBeenCalledWith(
      expect.objectContaining({
        shared: expect.objectContaining({ building: 'A楼' }),
      }),
      [],
      undefined,
      APPLICATION_IDEMPOTENCY_KEY,
      APPLICATION_SUBMISSION_FINGERPRINT,
      request,
      ACCESS_PRINCIPAL_FINGERPRINT,
      true,
    );
  });

  it('scopes an applicant catalog query to the session building without bypassing cache', async () => {
    await controller.searchCatalog(
      requestFor(applicantA),
      '',
      '一级',
      '二级',
      '关键字',
      '12',
    );

    expect(applicationService.searchCatalog).toHaveBeenCalledWith(
      {
        building: 'A楼',
        primaryCategory: '一级',
        secondaryCategory: '二级',
        query: '关键字',
        limit: 12,
      },
      false,
    );
  });

  it('rejects a cross-building applicant catalog query before reading the catalog', async () => {
    await expect(
      controller.searchCatalog(requestFor(applicantA), 'B楼', '', '', '', '50'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(applicationService.searchCatalog).not.toHaveBeenCalled();
  });

  it.each(['admin', 'editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'keeps an empty catalog query unscoped and cached for %s',
    async (role) => {
      await controller.searchCatalog(
        requestFor(principal(role)),
        '',
        '',
        '',
        '',
        '50',
      );

      expect(applicationService.searchCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ building: '' }),
        false,
      );
    },
  );

  it.each(['admin', 'editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'passes the policy-normalized catalog building to the cached service for %s',
    async (role) => {
      policy.assertRequestedBuilding.mockReturnValue('A楼');

      await controller.searchCatalog(
        requestFor(principal(role)),
        ' a楼 ',
        '',
        '',
        '',
        '50',
      );

      expect(policy.assertRequestedBuilding).toHaveBeenCalledWith(
        principal(role),
        'a楼',
      );
      expect(applicationService.searchCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ building: 'A楼' }),
        false,
      );
    },
  );

  it('scopes applicant search to the session building without bypassing cache', async () => {
    await controller.searchApplicants(requestFor(applicantA), '', '马', '20');

    expect(applicationService.searchApplicants).toHaveBeenCalledWith(
      { building: 'A楼', query: '马', limit: 20 },
      false,
    );
  });

  it.each(['admin', 'editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'keeps an empty applicant search unscoped and cached for %s',
    async (role) => {
      await controller.searchApplicants(
        requestFor(principal(role)),
        '',
        '',
        '30',
      );

      expect(applicationService.searchApplicants).toHaveBeenCalledWith(
        { building: '', query: '', limit: 30 },
        false,
      );
    },
  );

  it('lets an inventory administrator search only the session-building applicant directory', async () => {
    const inventoryAdministrator: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };

    await controller.searchApplicants(
      requestFor(inventoryAdministrator),
      '',
      '马',
      '20',
    );

    expect(applicationService.searchApplicants).toHaveBeenCalledWith(
      { building: 'A楼', query: '马', limit: 20 },
      false,
    );
  });

  it('rejects an inventory administrator applicant search for another building', async () => {
    const inventoryAdministrator: AccessPrincipal = {
      role: 'inventory_admin',
      purchaseBuilding: 'A楼',
    };

    await expect(
      controller.searchApplicants(
        requestFor(inventoryAdministrator),
        'B楼',
        '',
        '30',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(applicationService.searchApplicants).not.toHaveBeenCalled();
  });

  it('rejects an explicit cross-building applicant search before reading applicants', async () => {
    await expect(
      controller.searchApplicants(requestFor(applicantA), 'B楼', '', '30'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(applicationService.searchApplicants).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, APPLICATION_SUBMISSION_FINGERPRINT],
    ['short', APPLICATION_SUBMISSION_FINGERPRINT],
    [APPLICATION_IDEMPOTENCY_KEY, undefined],
    [APPLICATION_IDEMPOTENCY_KEY, 'not-a-sha256'],
  ])(
    'rejects a missing or malformed application idempotency proof before authorization',
    async (idempotencyKey, submissionFingerprint) => {
      await expect(
        controller.submitApplications(
          requestFor(applicantA),
          JSON.stringify(applicationRequest()),
          [],
          idempotencyKey,
          submissionFingerprint,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(policy.assertRequestedBuilding).not.toHaveBeenCalled();
      expect(
        applicationService.resolveApplicantForBuilding,
      ).not.toHaveBeenCalled();
      expect(applicationService.acceptApplications).not.toHaveBeenCalled();
    },
  );

  it('rejects an applicant submit for another building before submission', async () => {
    const request = applicationRequest({ building: 'B楼' });

    await expect(
      controller.submitApplications(
        requestFor(applicantA),
        JSON.stringify(request),
        [],
        APPLICATION_IDEMPOTENCY_KEY,
        APPLICATION_SUBMISSION_FINGERPRINT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      applicationService.resolveApplicantForBuilding,
    ).not.toHaveBeenCalled();
    expect(applicationService.acceptApplications).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '"text"', '42'])(
    'rejects a non-object application payload %s before authorization or submission',
    async (payload) => {
      await expect(
        controller.submitApplications(
          requestFor(applicantA),
          payload,
          [],
          APPLICATION_IDEMPOTENCY_KEY,
          APPLICATION_SUBMISSION_FINGERPRINT,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(policy.assertRequestedBuilding).not.toHaveBeenCalled();
      expect(
        applicationService.resolveApplicantForBuilding,
      ).not.toHaveBeenCalled();
      expect(applicationService.acceptApplications).not.toHaveBeenCalled();
    },
  );

  it.each(['{"shared":[],"items":[]}', '{"shared":{},"items":{}}'])(
    'rejects malformed application sections before authorization: %s',
    async (payload) => {
      await expect(
        controller.submitApplications(
          requestFor(applicantA),
          payload,
          [],
          APPLICATION_IDEMPOTENCY_KEY,
          APPLICATION_SUBMISSION_FINGERPRINT,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(policy.assertRequestedBuilding).not.toHaveBeenCalled();
      expect(applicationService.acceptApplications).not.toHaveBeenCalled();
    },
  );

  it('defers forged applicant rejection to the accepted task before business writes', async () => {
    applicationService.resolveApplicantForBuilding.mockResolvedValue(null);
    const request = applicationRequest({
      applicantRecordId: 'rec-b',
      applicantOpenId: 'ou-forged',
    });

    await expect(
      controller.submitApplications(
        requestFor(applicantA),
        JSON.stringify(request),
        [],
        APPLICATION_IDEMPOTENCY_KEY,
        APPLICATION_SUBMISSION_FINGERPRINT,
      ),
    ).resolves.toEqual(expect.objectContaining({ pending: true }));
    expect(
      applicationService.resolveApplicantForBuilding,
    ).not.toHaveBeenCalled();
    expect(applicationService.acceptApplications).toHaveBeenCalledWith(
      expect.objectContaining({
        shared: expect.objectContaining({
          building: 'A楼',
          applicantRecordId: 'rec-b',
          applicantOpenId: 'ou-forged',
        }),
      }),
      [],
      undefined,
      APPLICATION_IDEMPOTENCY_KEY,
      APPLICATION_SUBMISSION_FINGERPRINT,
      request,
      ACCESS_PRINCIPAL_FINGERPRINT,
      true,
    );
  });

  it('passes applicant-controlled fields only to the background revalidation task', async () => {
    applicationService.resolveApplicantForBuilding.mockResolvedValue({
      recordId: 'rec-a',
      openId: 'ou-authoritative',
      name: '权威姓名',
      employeeNo: 'NT-001',
      position: '权威岗位',
      building: 'A楼',
      specialty: '电气',
    });
    const request = applicationRequest({
      applicantRecordId: 'rec-a',
      applicantOpenId: 'ou-authoritative',
      applicantName: '伪造姓名',
      applicantEmployeeNo: 'FAKE',
      applicantPosition: '伪造岗位',
      applicantBuilding: 'B楼',
    });

    await controller.submitApplications(
      requestFor(applicantA),
      JSON.stringify(request),
      [],
      APPLICATION_IDEMPOTENCY_KEY,
      APPLICATION_SUBMISSION_FINGERPRINT,
    );

    expect(applicationService.acceptApplications).toHaveBeenCalledWith(
      expect.objectContaining({
        shared: expect.objectContaining({
          building: 'A楼',
          applicantBuilding: 'B楼',
          applicantRecordId: 'rec-a',
          applicantOpenId: 'ou-authoritative',
          applicantName: '伪造姓名',
          applicantEmployeeNo: 'FAKE',
          applicantPosition: '伪造岗位',
        }),
      }),
      [],
      undefined,
      APPLICATION_IDEMPOTENCY_KEY,
      APPLICATION_SUBMISSION_FINGERPRINT,
      request,
      ACCESS_PRINCIPAL_FINGERPRINT,
      true,
    );
    expect(
      applicationService.resolveApplicantForBuilding,
    ).not.toHaveBeenCalled();
  });

  it.each(['admin', 'editor', 'purchase_admin'] as const)(
    'defers authoritative applicant revalidation for %s until after acceptance',
    async (role) => {
      const request = applicationRequest({ building: ' b楼 ' });
      policy.assertRequestedBuilding.mockReturnValue('B楼');
      applicationService.resolveApplicantForBuilding.mockResolvedValue({
        recordId: 'rec-authoritative',
        openId: 'ou-authoritative',
        name: '权威申请人',
        employeeNo: 'NT-002',
        position: '运维工程师',
        building: 'B楼',
        specialty: '电气',
      });

      await controller.submitApplications(
        requestFor(principal(role)),
        JSON.stringify(request),
        [],
        APPLICATION_IDEMPOTENCY_KEY,
        APPLICATION_SUBMISSION_FINGERPRINT,
      );

      expect(
        applicationService.resolveApplicantForBuilding,
      ).not.toHaveBeenCalled();
      expect(applicationService.acceptApplications).toHaveBeenCalledWith(
        expect.objectContaining({
          shared: expect.objectContaining({
            building: 'B楼',
            applicantRecordId: request.shared.applicantRecordId,
            applicantOpenId: request.shared.applicantOpenId,
          }),
        }),
        [],
        undefined,
        APPLICATION_IDEMPOTENCY_KEY,
        APPLICATION_SUBMISSION_FINGERPRINT,
        request,
        ACCESS_PRINCIPAL_FINGERPRINT,
        true,
      );
    },
  );

  it('returns the tracked purchase application task status', () => {
    const result = controller.getApplicationSubmissionTask(
      requestFor(applicantA),
      'purchase-application-task-1',
    );

    expect(applicationService.getSubmissionTaskStatus).toHaveBeenCalledWith(
      'purchase-application-task-1',
      'A楼',
      ACCESS_PRINCIPAL_FINGERPRINT,
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'running' }),
      }),
    );
  });

  it('does not disclose a same-building task to another authenticated principal', () => {
    applicationService.getSubmissionTaskStatus.mockReturnValue({
      success: false,
      message: '采购申请后台任务不存在或已过期',
    });

    const result = controller.getApplicationSubmissionTask(
      requestFor(applicantA, OTHER_ACCESS_PRINCIPAL_FINGERPRINT),
      'purchase-application-task-1',
    );

    expect(applicationService.getSubmissionTaskStatus).toHaveBeenCalledWith(
      'purchase-application-task-1',
      'A楼',
      OTHER_ACCESS_PRINCIPAL_FINGERPRINT,
    );
    expect(result).toEqual(expect.objectContaining({ success: false }));
  });
});

function requestFor(
  accessPrincipal: AccessPrincipal,
  accessPrincipalFingerprint = ACCESS_PRINCIPAL_FINGERPRINT,
) {
  return {
    accessPrincipal,
    accessPrincipalFingerprint,
    accessRole: accessPrincipal.role,
  };
}

function principal(role: AccessRole): AccessPrincipal {
  return { role, purchaseBuilding: null };
}

function options() {
  return {
    buildings: ['A楼', 'B楼'],
    specialties: ['电气'],
    purchaseMethods: ['综合采购'],
    purchaseChannels: ['线下'],
    comparisonOptions: ['是'],
    primaryCategories: ['一级'],
    secondaryCategories: ['二级'],
  };
}

function applicationRequest(overrides: Record<string, unknown> = {}) {
  return {
    shared: {
      applicantRecordId: 'rec-a',
      applicantOpenId: 'ou-a',
      applicantName: '客户端姓名',
      applicantEmployeeNo: 'CLIENT-NO',
      applicantPosition: '客户端岗位',
      applicantBuilding: 'B楼',
      building: 'A楼',
      specialty: '电气',
      purchaseMethod: '综合采购',
      purchaseChannel: '线下',
      supplier: '',
      onlineUrl: '',
      comparisonSatisfied: '是',
      requirementSummary: '测试',
      expectedDeliveryDate: '2026-07-20',
      immediateOutbound: false,
      notes: '',
      ...overrides,
    },
    items: [],
  };
}
