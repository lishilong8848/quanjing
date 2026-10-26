jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  return {
    ...actual,
    Body: decorator,
    Controller: decorator,
    Get: decorator,
    Optional: decorator,
    Param: decorator,
    Post: decorator,
    Query: decorator,
    Req: decorator,
    Res: decorator,
    SetMetadata: decorator,
    UploadedFile: decorator,
    UploadedFiles: decorator,
    UseInterceptors: decorator,
  };
});

jest.mock('@nestjs/platform-express', () => ({
  AnyFilesInterceptor: jest.fn(() => class TestAnyFilesInterceptor {}),
  FileInterceptor: jest.fn(() => class TestFileInterceptor {}),
  FilesInterceptor: jest.fn(() => class TestFilesInterceptor {}),
}));

jest.mock('./change-attachment-storage.service', () => ({
  CHANGE_ATTACHMENT_MAX_BYTES: 200 * 1024 * 1024,
  ChangeAttachmentStorageService: class TestChangeAttachmentStorageService {},
}));

jest.mock('../../common/config/external-services.config', () => ({
  readEnv: jest.fn(() => ''),
}));

jest.mock('./duty-schedule.service', () => ({
  DutyScheduleService: class TestDutyScheduleService {},
}));

jest.mock('./duty-schedule.automation', () => ({
  DutyScheduleAutomationService: class TestDutyScheduleAutomationService {},
}));

jest.mock('./duty-screenshot.service', () => ({
  DutyScreenshotService: class TestDutyScreenshotService {},
}));

jest.mock('./typhoon-warning-monitor.service', () => ({
  TyphoonWarningMonitorService: class TestTyphoonWarningMonitorService {},
}));

jest.mock(
  '@server/modules/overtime-workflow/overtime-workflow.service',
  () => ({
    OvertimeWorkflowService: class TestOvertimeWorkflowService {},
  }),
  { virtual: true },
);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DutyScheduleController } from './duty-schedule.controller';

const overtimeRequest = {
  clientMutationId: 'overtime-request-11111111-1111-4111-8111-111111111111',
  staffName: '示例人员008',
  startAt: '2026-08-13T18:00:00+08:00',
  endAt: '2026-08-14T02:00:00+08:00',
  reason: '配合设备维护',
  expectedImpact: {
    rawHours: 8,
    payableHours: 8,
    conflictingSchedules: [],
    isWholeHour: true,
    invalidRangeReason: null,
    canSubmit: true,
  },
};

const overtimeResult = {
  success: true as const,
  created: 1,
  recordId: 'rec_overtime_integration_01',
  clientMutationId: overtimeRequest.clientMutationId,
  requestFingerprint: 'fingerprint-overtime-integration-01',
  impact: overtimeRequest.expectedImpact,
  message: '加班申请已提交',
};

describe('DutyScheduleController overtime workflow integration', () => {
  it('imports the overtime workflow module for production injection', () => {
    const source = readFileSync(
      join(__dirname, 'duty-schedule.module.ts'),
      'utf8',
    );
    expect(source).toContain(
      "import { OvertimeWorkflowModule } from '@server/modules/overtime-workflow/overtime-workflow.module';",
    );
    expect(source).toMatch(
      /imports:\s*\[[\s\S]*OvertimeWorkflowModule[\s\S]*\]/,
    );
  });

  it('durably accepts the workflow after Base creation and returns the original result', async () => {
    const createOvertimeRequest = jest.fn().mockResolvedValue(overtimeResult);
    const acceptApplication = jest
      .fn()
      .mockResolvedValue({ created: true });
    const controller = createController(createOvertimeRequest, acceptApplication);

    await expect(
      controller.createOvertimeRequest(JSON.stringify(overtimeRequest), []),
    ).resolves.toBe(overtimeResult);
    expect(createOvertimeRequest).toHaveBeenCalledWith(overtimeRequest, undefined);
    expect(acceptApplication).toHaveBeenCalledWith({
      request: overtimeRequest,
      result: overtimeResult,
    });
    expect(createOvertimeRequest.mock.invocationCallOrder[0]).toBeLessThan(
      acceptApplication.mock.invocationCallOrder[0],
    );
  });

  it('does not report success when the durable workflow accept fails', async () => {
    const createOvertimeRequest = jest.fn().mockResolvedValue(overtimeResult);
    const acceptApplication = jest
      .fn()
      .mockRejectedValue(new Error('workflow ledger unavailable'));
    const controller = createController(createOvertimeRequest, acceptApplication);

    await expect(
      controller.createOvertimeRequest(JSON.stringify(overtimeRequest), []),
    ).rejects.toThrow('workflow ledger unavailable');
  });

  it('keeps the successful Base-only result when the workflow is explicitly disabled', async () => {
    const createOvertimeRequest = jest.fn().mockResolvedValue(overtimeResult);
    const acceptApplication = jest.fn();
    const controller = createController(
      createOvertimeRequest,
      acceptApplication,
      false,
    );

    await expect(
      controller.createOvertimeRequest(JSON.stringify(overtimeRequest), []),
    ).resolves.toBe(overtimeResult);
    expect(acceptApplication).not.toHaveBeenCalled();
  });

  it('fails safely after Base creation when the workflow service is unavailable', async () => {
    const createOvertimeRequest = jest.fn().mockResolvedValue(overtimeResult);
    const controller = createController(createOvertimeRequest);

    await expect(
      controller.createOvertimeRequest(JSON.stringify(overtimeRequest), []),
    ).rejects.toThrow('加班审批工作流暂不可用');
  });
});

function createController(
  createOvertimeRequest: jest.Mock,
  acceptApplication?: jest.Mock,
  enabled = true,
): DutyScheduleController {
  const Controller = DutyScheduleController as unknown as new (
    ...dependencies: unknown[]
  ) => DutyScheduleController;
  return new Controller(
    { createOvertimeRequest },
    {},
    {},
    { start: jest.fn() },
    undefined,
    acceptApplication
      ? { acceptApplication, isEnabled: () => enabled }
      : undefined,
  );
}
