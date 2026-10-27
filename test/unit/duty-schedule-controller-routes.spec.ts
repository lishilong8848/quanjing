jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  return {
    ...actual,
    Body: decorator,
    Controller: decorator,
    Get: decorator,
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

jest.mock(
  '@server/modules/duty-schedule/change-attachment-storage.service',
  () => ({
    CHANGE_ATTACHMENT_MAX_BYTES: 200 * 1024 * 1024,
    ChangeAttachmentStorageService: class TestChangeAttachmentStorageService {},
  }),
);

jest.mock('@server/common/config/external-services.config', () => ({
  readEnv: jest.fn(() => ''),
}));

jest.mock('@server/modules/duty-schedule/duty-schedule.service', () => ({
  DutyScheduleService: class TestDutyScheduleService {},
}));

jest.mock('@server/modules/duty-schedule/duty-schedule.automation', () => ({
  DutyScheduleAutomationService: class TestDutyScheduleAutomationService {},
}));

jest.mock('@server/modules/duty-schedule/duty-screenshot.service', () => ({
  DutyScreenshotService: class TestDutyScreenshotService {},
}));

jest.mock(
  '@server/modules/duty-schedule/typhoon-warning-monitor.service',
  () => ({
    TyphoonWarningMonitorService: class TestTyphoonWarningMonitorService {},
  }),
);

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { FilesInterceptor } from '@nestjs/platform-express';
import { lastValueFrom, Observable, of } from 'rxjs';
import {
  ChangeAttachmentUploadAdmissionInterceptor,
  DutyScheduleController,
} from '../../server/modules/duty-schedule/duty-schedule.controller';

describe('DutyScheduleController routes', () => {
  function createController() {
    const updateChangeScheduleAdjustment = jest.fn(async () => ({
      success: true,
    }));
    const createOvertimeRequest = jest.fn(async () => ({
      success: true,
      created: 1,
      recordId: 'recOvertime1',
    }));
    const monitorTyphoonWarningAndSendPathScreenshot = jest.fn(async () => ({
      success: true,
      sent: false,
      source: 'manual',
      reason: 'no-active-typhoon-warning',
    }));
    const previewTyphoonWarningPathScreenshot = jest.fn(async () => ({
      success: true,
      checkedAt: '2026-07-28T10:00:00.000Z',
      hasActiveWarning: false,
      canSend: false,
      reason: 'no-active-typhoon-warning',
    }));
    const forceSendTyphoonPathScreenshot = jest.fn(async () => ({
      success: true,
      sent: true,
      source: 'manual-group',
      forced: true,
    }));
    const captureAndSendTyphoonPath = jest.fn(async () => ({
      success: true,
    }));
    const controller = new DutyScheduleController(
      { updateChangeScheduleAdjustment, createOvertimeRequest } as never,
      {
        monitorTyphoonWarningAndSendPathScreenshot,
        previewTyphoonWarningPathScreenshot,
        forceSendTyphoonPathScreenshot,
      } as never,
      { captureAndSendTyphoonPath } as never,
      { start: jest.fn() } as never,
      undefined,
      {
        isEnabled: () => true,
        acceptApplication: jest.fn(async () => ({ created: true })),
      } as never,
    );

    return {
      controller,
      updateChangeScheduleAdjustment,
      createOvertimeRequest,
      monitorTyphoonWarningAndSendPathScreenshot,
      previewTyphoonWarningPathScreenshot,
      forceSendTyphoonPathScreenshot,
      captureAndSendTyphoonPath,
    };
  }

  it('registers POST /api/change-info/adjustment', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('change-info/adjustment')");
    expect(source).toContain('updateChangeScheduleAdjustment');
  });

  it('removes private change submitter and attachment details from guest yearly data', async () => {
    const getYearlyChangeInfo = jest.fn(async () => ({
      changes: [
        {
          id: 'rec-change-private',
          bitableRecordId: 'rec-change-private',
          title: 'UPS 维护',
          submitterName: '张三',
          workflowStatus: '内部审批已通过',
          planDocuments: [
            {
              fileToken: 'private-plan-token',
              name: '内部变更方案.pdf',
              url: '/api/private-plan',
            },
          ],
          delayReason: '内部延期原因',
          delayEvidence: [
            {
              fileToken: 'private-proof-token',
              name: '内部举证.png',
              url: '/api/private-proof',
            },
          ],
        },
      ],
      total: 1,
      keyTotal: 0,
    }));
    const controller = new DutyScheduleController(
      { getYearlyChangeInfo } as never,
      {} as never,
      {} as never,
      { start: jest.fn() } as never,
    );
    const handler = controller.getYearlyChangeInfo as unknown as (
      year: string,
      refresh: string | undefined,
      request: { accessRole?: string },
    ) => Promise<{ changes: Array<Record<string, unknown>> }>;

    const guest = await handler.call(controller, '2026', undefined, {
      accessRole: 'guest',
    });
    expect(guest.changes[0]).toMatchObject({
      id: 'rec-change-private',
      title: 'UPS 维护',
      submitterName: null,
      planDocuments: [],
      delayReason: null,
      delayEvidence: [],
      workflowStatus: null,
    });
    expect(JSON.stringify(guest)).not.toContain('内部变更方案');
    expect(JSON.stringify(guest)).not.toContain('private-plan-token');

    const editor = await handler.call(controller, '2026', undefined, {
      accessRole: 'duty_editor',
    });
    expect(editor.changes[0]).toMatchObject({
      submitterName: '张三',
      planDocuments: [{ fileToken: 'private-plan-token' }],
      delayReason: '内部延期原因',
      delayEvidence: [{ fileToken: 'private-proof-token' }],
    });
  });

  it('registers POST /api/duty-schedules/exception-follow-up', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('duty-schedules/exception-follow-up')");
    expect(source).toContain('createExceptionFollowUp');
    expect(source).toContain("@Get('duty-schedules/exception-follow-ups')");
    expect(source).toContain('getExceptionFollowUps');
    expect(source).toContain(
      "@Post('duty-schedules/exception-follow-up/update')",
    );
    expect(source).toContain('updateExceptionFollowUp');
    expect(source).toContain(
      "@Post('duty-schedules/exception-follow-up/delete')",
    );
    expect(source).toContain('deleteExceptionFollowUp');
  });

  it('registers POST /api/duty-schedules/leave-request', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('duty-schedules/leave-request')");
    expect(source).toContain('createLeaveRequest');
    expect(source).toMatch(
      /@Post\('duty-schedules\/leave-request'\)[\s\S]{0,900}FilesInterceptor\('screenshot',\s*1/,
    );
    expect(source).toMatch(
      /async createLeaveRequest\([\s\S]{0,600}@Body\('payload'\) payload: string/,
    );
    expect(source).toMatch(
      /async createLeaveRequest\([\s\S]{0,800}@UploadedFiles\(\) files:/,
    );
    expect(source).toContain('leaveRequestScreenshotFileFilter');
    expect(source).toContain('parseLeaveRequestPayload');
    const leaveRequestRoute = source.slice(
      source.indexOf("@Post('duty-schedules/leave-request')"),
      source.indexOf("@Post('duty-schedules/change-request')"),
    );
    expect(leaveRequestRoute).toContain('fields: 1');
    expect(leaveRequestRoute).toContain('files: 1');
    expect(leaveRequestRoute).toContain('parts: 3');
  });

  it('registers the guest-submittable overtime screenshot command with strict multipart limits', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toMatch(
      /@GuestSubmittable\(\)\s*@Post\('duty-schedules\/overtime-request'\)/,
    );
    const routeStart = source.indexOf(
      "@Post('duty-schedules/overtime-request')",
    );
    const routeEnd = source.indexOf(
      "@Post('duty-schedules/change-request')",
      routeStart,
    );
    const route = source.slice(routeStart, routeEnd);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(route).toContain("FilesInterceptor('screenshot', 1, {");
    expect(route).toContain('files: 1');
    expect(route).toContain('fileSize: 10 * 1024 * 1024');
    expect(route).toContain('fields: 1');
    expect(route).toContain('parts: 3');
    expect(route).toContain('fieldSize: 16 * 1024');
    expect(route).toContain('fileFilter: overtimeRequestScreenshotFileFilter');
    expect(route).toContain("@Body('payload') payload: string");
    expect(route).toContain('@UploadedFiles() files:');
    expect(route).toContain('parseOvertimeRequestPayload');
    expect(route).toMatch(
      /this\.dutyScheduleService\.createOvertimeRequest\(\s*request,\s*files\[0\],[\s\S]*?accessRequest\?\.accessPrincipal/,
    );
  });

  it('runs the overtime-specific screenshot filter callback with overtime wording', () => {
    const interceptorCalls = (FilesInterceptor as unknown as jest.Mock).mock
      .calls;
    const overtimeCall = interceptorCalls.filter(
      ([fieldName]) => fieldName === 'screenshot',
    )[1];
    const fileFilter = overtimeCall?.[2]?.fileFilter as (
      request: unknown,
      file: { originalname: string; mimetype: string },
      callback: (error: Error | null, accepted: boolean) => void,
    ) => void;
    const invalidCallback = jest.fn();

    fileFilter(
      {},
      { originalname: 'overtime-proof.txt', mimetype: 'text/plain' },
      invalidCallback,
    );

    expect(invalidCallback).toHaveBeenCalledWith(expect.any(Error), false);
    expect(invalidCallback.mock.calls[0][0].message).toBe(
      '加班举证截图仅支持 PNG、JPG、JPEG、WebP 图片',
    );
    const validCallback = jest.fn();
    fileFilter(
      {},
      { originalname: 'overtime-proof.png', mimetype: 'image/png' },
      validCallback,
    );
    expect(validCallback).toHaveBeenCalledWith(null, true);
  });

  it('uses overtime-specific payload errors and forwards the parsed screenshot command', async () => {
    const { controller, createOvertimeRequest } = createController();
    const handler = (
      controller as unknown as {
        createOvertimeRequest: (
          payload: string,
          files?: Array<Record<string, unknown>>,
          accessRequest?: { accessPrincipal: { role: 'admin'; purchaseBuilding: null; accountId: string }; accessPrincipalFingerprint: string },
        ) => Promise<unknown>;
      }
    ).createOvertimeRequest;

    await expect(handler.call(controller, '', [])).rejects.toThrow(
      '加班 payload 不能为空',
    );
    const screenshot = { fieldname: 'screenshot' };
    const payload = {
      clientMutationId: 'overtime-request-controller-test',
      staffName: '张三',
      reason: '测'.repeat(2000),
    };
    await handler.call(controller, JSON.stringify(payload), [screenshot], {
      accessPrincipal: { role: 'admin', purchaseBuilding: null, accountId: 'local-admin' },
      accessPrincipalFingerprint: 'trusted-legacy-fixture',
    });
    expect(createOvertimeRequest).toHaveBeenCalledWith(payload, screenshot);
    await expect(
      handler.call(controller, JSON.stringify({ reason: '测'.repeat(6000) }), [
        screenshot,
      ]),
    ).rejects.toThrow('加班 payload 不能超过 16 KiB');
  });

  it('registers the guest-submittable multipart change request command', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toMatch(
      /@GuestSubmittable\(\)\s*@Post\('duty-schedules\/leave-request'\)/,
    );
    expect(source).toMatch(
      /@GuestSubmittable\(\)\s*@Post\('duty-schedules\/change-request'\)/,
    );
    expect(source).toContain("FilesInterceptor('documents', 5, {");
    expect(source).toContain('files: 5');
    expect(source).toContain('fileSize: CHANGE_ATTACHMENT_MAX_BYTES');
    expect(source).toContain('fields: 1');
    expect(source).toContain('parts: 6');
    expect(source).toContain('fieldSize: 64 * 1024');
    expect(source).toContain('fileFilter: changeRequestDocumentFileFilter');
    const changeRequestRoute = source.slice(
      source.indexOf("@Post('duty-schedules/change-request')"),
      source.indexOf(
        '@GuestReadable()',
        source.indexOf('async createChangeRequest'),
      ),
    );
    expect(changeRequestRoute).not.toContain('AnyFilesInterceptor({');
    expect(changeRequestRoute).toContain('storage: diskStorage({');
    expect(changeRequestRoute).toContain(
      'destination: changeAttachmentTempDestination',
    );
    expect(changeRequestRoute).toMatch(
      /UseInterceptors\(\s*changeAttachmentUploadAdmissionInterceptor,\s*FilesInterceptor/,
    );
    expect(changeRequestRoute).toContain('stageFromDisk');
    expect(changeRequestRoute).toContain('removeExactChangeAttachmentTempFile');
    expect(changeRequestRoute).not.toContain('20 * 1024 * 1024');
    expect(source).toContain('createChangeRequest(');
  });

  it('registers the guarded change drill report command and attachment owner prefix', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('duty-schedules/change-drill-report')");
    expect(source).toContain('createChangeDrillReport(request)');
    expect(source).toContain('change-drill-report');
    expect(source).toContain('当前身份无权提交演练报告');
  });

  it('registers asynchronous change summary report submit/status/abandon routes and trusted owner binding', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('duty-schedules/change-summary-report')");
    expect(source).toContain(
      "@Get('duty-schedules/change-summary-report-sync/:taskId')",
    );
    expect(source).toContain(
      "@Post('duty-schedules/change-summary-report/abandon')",
    );
    expect(source).toContain(
      'requireAccessPrincipalFingerprint(accessRequest)',
    );
    expect(source).toContain('abandonChangeSummaryReport(');
    expect(source).toContain('change-summary-report');
    expect(source).toContain('当前身份无权提交变更总结');
  });

  it('passes only the guard-issued principal fingerprint to summary create/status/abandon', async () => {
    const createChangeSummaryReport = jest.fn(async () => ({ success: true }));
    const getChangeSummaryReportSyncStatus = jest.fn(async () => ({
      success: true,
    }));
    const abandonChangeSummaryReport = jest.fn(async () => ({
      success: true,
    }));
    const controller = new DutyScheduleController(
      {
        createChangeSummaryReport,
        getChangeSummaryReportSyncStatus,
        abandonChangeSummaryReport,
      } as never,
      {} as never,
      {} as never,
      { start: jest.fn() } as never,
    );
    const accessRequest = {
      accessRole: 'admin',
      accessPrincipalFingerprint: 'A'.repeat(43),
    };

    await controller.createChangeSummaryReport(
      {} as never,
      accessRequest as never,
    );
    await controller.getChangeSummaryReportSyncStatus(
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
      accessRequest as never,
    );
    await controller.abandonChangeSummaryReport(
      {} as never,
      accessRequest as never,
    );

    expect(createChangeSummaryReport).toHaveBeenCalledWith({}, 'A'.repeat(43));
    expect(getChangeSummaryReportSyncStatus).toHaveBeenCalledWith(
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
      'A'.repeat(43),
    );
    expect(abandonChangeSummaryReport).toHaveBeenCalledWith({}, 'A'.repeat(43));
    await expect(
      controller.createChangeSummaryReport(
        {} as never,
        { accessRole: 'admin' } as never,
      ),
    ).rejects.toThrow('提交会话无法验证');
    await expect(
      controller.abandonChangeSummaryReport(
        {} as never,
        {
          accessRole: 'guest',
          accessPrincipalFingerprint: 'A'.repeat(43),
        } as never,
      ),
    ).rejects.toThrow('无权放弃变更总结');
    expect(abandonChangeSummaryReport).toHaveBeenCalledTimes(1);
  });

  it('keeps change summary self-test cleanup admin-only, loopback-only and proof-bound', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );
    const route = source.slice(
      source.indexOf(
        "'duty-schedules/change-summary-report/self-test/cleanup-bound-attachment'",
      ) - 40,
      source.indexOf(
        "@Get('duty-schedules/change-records/:recordId/attachments/:fileToken')",
      ),
    );

    expect(route).toContain('@AdminOnly()');
    expect(route).toContain("accessRequest.accessRole !== 'admin'");
    expect(route).toContain('!isDirectLoopbackRequest(accessRequest)');
    expect(route).toContain('x-change-summary-self-test-cleanup-proof');
    expect(route).toContain('cleanupChangeSummarySelfTestBoundAttachment');
  });

  it('keeps failed change-summary self-test finalization admin-only, loopback-only and proof-bound', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );
    const routeStart = source.indexOf(
      "'duty-schedules/change-summary-report/self-test/finalize-failed-cleanup'",
    );
    const route = source.slice(routeStart - 40, routeStart + 1_800);

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(route).toContain('@AdminOnly()');
    expect(route).toContain("accessRequest.accessRole !== 'admin'");
    expect(route).toContain('!isDirectLoopbackRequest(accessRequest)');
    expect(route).toContain('x-change-summary-failed-self-test-cleanup-proof');
    expect(route).toContain('finalizeFailedChangeSummarySelfTestCleanup');
  });

  it('keeps trusted attachment deletion state admin-only and loopback-only', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );
    const routeStart = source.indexOf(
      "@Get('duty-schedules/change-attachments/:id/self-test-deletion-state')",
    );
    const route = source.slice(routeStart - 40, routeStart + 1_600);

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(route).toContain('@AdminOnly()');
    expect(route).toContain("accessRequest.accessRole !== 'admin'");
    expect(route).toContain('!isDirectLoopbackRequest(accessRequest)');
    expect(route).toContain('getDeletionStateForTrustedServer');
  });

  it('stages one change attachment on disk with a 200 MiB limit', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );
    const routeStart = source.indexOf(
      "@Post('duty-schedules/change-attachments/stage')",
    );
    const routeEnd = source.indexOf(
      "@Post('duty-schedules/change-attachments/:id/delete')",
      routeStart,
    );
    const route = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(route).toContain("FileInterceptor('file', {");
    expect(route).toContain('storage: diskStorage({');
    expect(route).toContain('destination: changeAttachmentTempDestination');
    expect(route).toContain('fileSize: CHANGE_ATTACHMENT_MAX_BYTES');
    expect(route).toContain('files: 1');
    expect(route).toContain('parts: 3');
    expect(route).toMatch(
      /UseInterceptors\(\s*changeAttachmentUploadAdmissionInterceptor,\s*FileInterceptor/,
    );
    expect(route).toContain('stageFromDisk');
    expect(route).toContain('finally');
    expect(route).toContain('removeExactChangeAttachmentTempFile');
    expect(route).not.toContain('memoryStorage');
  });

  it('rejects before Multer when the route upload admission queue is full and releases permits', async () => {
    const interceptor = new ChangeAttachmentUploadAdmissionInterceptor({
      concurrency: 1,
      queueLimit: 1,
    });
    const firstDone: Array<() => void> = [];
    const first = lastValueFrom(
      interceptor.intercept(
        {} as never,
        {
          handle: () =>
            new Observable<void>((subscriber) => {
              firstDone.push(() => subscriber.complete());
            }),
        } as never,
      ),
      { defaultValue: undefined },
    );
    const queuedHandle = jest.fn(() => of('queued'));
    const queued = lastValueFrom(
      interceptor.intercept({} as never, { handle: queuedHandle } as never),
    );
    const rejectedHandle = jest.fn(() => of('must-not-run'));

    await expect(
      lastValueFrom(
        interceptor.intercept({} as never, { handle: rejectedHandle } as never),
      ),
    ).rejects.toThrow('繁忙');
    expect(rejectedHandle).not.toHaveBeenCalled();

    firstDone[0]();
    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBe('queued');
    expect(queuedHandle).toHaveBeenCalledTimes(1);

    await expect(
      lastValueFrom(
        interceptor.intercept(
          {} as never,
          { handle: () => of('released') } as never,
        ),
      ),
    ).resolves.toBe('released');
  });

  it('removes the staged temp file when owner validation fails', async () => {
    const stagingDir = join(tmpdir(), 'nantong-change-attachment-staging');
    mkdirSync(stagingDir, { recursive: true });
    const filePath = join(stagingDir, randomUUID());
    writeFileSync(filePath, '%PDF-test');
    const controller = new DutyScheduleController(
      {} as never,
      {} as never,
      {} as never,
      { start: jest.fn() } as never,
      { stageFromDisk: jest.fn() } as never,
    );

    await expect(
      controller.stageChangeAttachment('invalid-owner', {
        path: filePath,
        fieldname: 'file',
        originalname: 'scheme.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 9,
        destination: stagingDir,
        filename: filePath.split(/[\\/]/).pop() || '',
        stream: undefined,
        buffer: undefined,
      } as never),
    ).rejects.toThrow('请求标识无效');
    expect(existsSync(filePath)).toBe(false);
    rmSync(filePath, { force: true });
  });

  it('rejects guest staging for a summary owner before COS while preserving other guest owners', async () => {
    const stagingDir = join(tmpdir(), 'nantong-change-attachment-staging');
    mkdirSync(stagingDir, { recursive: true });
    const stageFromDisk = jest.fn(async () => ({
      id: 'storage-summary-test',
      filePath: 'change-summary-reports/test.pdf',
      bucketId: 'default-bucket',
      url: 'https://storage.example.test/change-summary-reports/test.pdf',
      name: 'summary.pdf',
      size: 9,
      mimeType: 'application/pdf',
    }));
    const controller = new DutyScheduleController(
      {} as never,
      {} as never,
      {} as never,
      { start: jest.fn() } as never,
      { stageFromDisk } as never,
    );
    const invoke = controller.stageChangeAttachment.bind(
      controller,
    ) as unknown as (
      ownerMutationId: string,
      file: Record<string, unknown>,
      request: { accessRole: string },
    ) => Promise<unknown>;
    const createFile = () => {
      const path = join(stagingDir, randomUUID());
      writeFileSync(path, '%PDF-test');
      return {
        path,
        fieldname: 'file',
        originalname: 'summary.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 9,
        destination: stagingDir,
        filename: path.split(/[\\/]/).pop() || '',
        stream: undefined,
        buffer: undefined,
      };
    };

    const deniedFile = createFile();
    await expect(
      invoke(
        'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
        deniedFile,
        { accessRole: 'guest' },
      ),
    ).rejects.toThrow('无权暂存变更总结附件');
    expect(stageFromDisk).not.toHaveBeenCalled();
    expect(existsSync(deniedFile.path)).toBe(false);

    const allowedFile = createFile();
    await expect(
      invoke(
        'change-request-123e4567-e89b-42d3-a456-426614174000',
        allowedFile,
        { accessRole: 'guest' },
      ),
    ).resolves.toMatchObject({ success: true });
    expect(stageFromDisk).toHaveBeenCalledTimes(1);
    expect(existsSync(allowedFile.path)).toBe(false);
  });

  it('keeps owner-bound delete and signed download routes', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      "@Post('duty-schedules/change-attachments/:id/delete')",
    );
    expect(source).toContain(
      "@Get('duty-schedules/change-attachments/:id/download')",
    );
    expect(source).toContain("@Body('ownerMutationId') ownerMutationId");
    expect(source).toContain("@Query('ownerMutationId') ownerMutationId");
    expect(source).toContain('{ ownerMutationId: normalizedOwnerMutationId }');
  });

  it('accepts direct JSON change requests while preserving legacy multipart payloads', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );
    const start = source.indexOf('async createChangeRequest(');
    const end = source.indexOf('@GuestReadable()', start);
    const handler = source.slice(start, end);

    expect(handler).toContain('@Body() body: unknown');
    expect(handler).toContain('parseChangeRequestBody(payload, body)');
    expect(handler).toContain('createChangeRequest(request, [], {');
    expect(handler).toContain('backgroundAttachments: true');
    expect(handler).toContain('{ ...request, stagedDocuments }');
    expect(handler).toContain('stagedObjectIds');
    expect(source).toContain(
      "@Get('duty-schedules/change-request-sync/:taskId')",
    );
  });

  it('registers POST /api/duty-schedules/personnel-movement', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('duty-schedules/personnel-movement')");
    expect(source).toContain('createPersonnelMovement');
  });

  it('registers schedule-only fast sync and removes the AI refresh route', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('duty-schedules/sync-local-fast')");
    expect(source).toContain('syncDutyScheduleToLocalFast');
    expect(source).not.toContain("@Post('duty-staff-actual-ai/refresh')");
    expect(source).not.toContain('refreshDutyStaffActualFromRules');
  });

  it('keeps only the public monthly schedule screenshot access route', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain(
      "@Post('monthly-schedules/access/screenshot-check')",
    );
    expect(source).toContain('verifyMonthlyScheduleScreenshotAccess');
    expect(source).toContain("@Get('monthly-schedules/:year/:month')");
    expect(source).not.toContain('monthly-schedules/access/login-url');
    expect(source).not.toContain('monthly-schedules/access/password-login');
    expect(source).not.toContain('monthly-schedules/access/code-login');
    expect(source).not.toContain('monthly-schedules/access/oauth/callback');
    expect(source).not.toContain('monthly-schedules/access/check');
    expect(source).not.toContain('monthly-schedules/access/apply');
  });

  it('passes the monthly schedule refresh query through to the service', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    const start = source.indexOf('async getMonthlySchedules(');
    const end = source.indexOf("@Get('duty-program-modified/scan')", start);
    const handler = source.slice(start, end);
    expect(handler).toContain("@Query('refresh') refresh?: string");
    expect(handler).toContain("refresh === '1' || refresh === 'true'");
  });

  it('passes refresh query to yearly sealing info loading', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Get('sealing-info/:year')");
    expect(source).toContain("@Query('refresh') refresh?: string");
    expect(source).toContain("refresh === '1' || refresh === 'true'");
  });

  it('adds a signed token to monthly schedule screenshot URLs', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-screenshot.service.ts',
      ),
      'utf8',
    );

    expect(source).toContain('createMonthlyScheduleScreenshotAccessToken');
    expect(source).toContain("'screenshotToken'");
  });

  it('registers a manual typhoon path screenshot test route', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Post('typhoon-path-screenshot/send-test')");
    expect(source).toContain('sendTyphoonPathTestScreenshot');
    expect(source).toContain('captureAndSendTyphoonPath');
    expect(source).toContain('receiveIdType');
    expect(source).toContain('FEISHU_TYPHOON_PATH_TEST_OPEN_ID');
    expect(source).toContain('测试台风路径截图需要指定个人接收 ID');
  });

  it('registers guarded typhoon path preview and group routes', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Get('typhoon-path-screenshot/preview')");
    expect(source).toContain('previewTyphoonWarningPathScreenshot');
    expect(source).toContain("@Post('typhoon-path-screenshot/send-group')");
    expect(source).toContain('sendTyphoonPathGroupScreenshot');
    expect(source).toContain("source: 'manual'");
    expect(source).toContain("'manual-group'");
    expect(source).toContain('FORCE_SEND_TYPHOON_PATH');
    expect(source).not.toContain(
      'sendTyphoonPathGroupScreenshot(): Promise<TyphoonPathScreenshotResponse>',
    );
  });

  it('routes a normal group request through the warning monitor instead of direct screenshot send', async () => {
    const {
      controller,
      monitorTyphoonWarningAndSendPathScreenshot,
      captureAndSendTyphoonPath,
    } = createController();
    const send = controller.sendTyphoonPathGroupScreenshot as unknown as (
      body: Record<string, unknown>,
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(
      send.call(
        controller,
        { clientMutationId: 'manual-check-20260728' },
        { accessRole: 'duty_editor', ip: '127.0.0.1' },
      ),
    ).resolves.toMatchObject({
      sent: false,
      reason: 'no-active-typhoon-warning',
    });
    expect(monitorTyphoonWarningAndSendPathScreenshot).toHaveBeenCalledWith({
      source: 'manual',
      expectedWarningKey: undefined,
    });
    expect(captureAndSendTyphoonPath).not.toHaveBeenCalled();
  });

  it('requires an administrator, confirmation text and idempotency key for force send', async () => {
    const { controller, forceSendTyphoonPathScreenshot } = createController();
    const send = controller.sendTyphoonPathGroupScreenshot as unknown as (
      body: Record<string, unknown>,
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(
      send.call(
        controller,
        {
          force: true,
          confirmation: 'FORCE_SEND_TYPHOON_PATH',
          clientMutationId: 'force-20260728',
        },
        { accessRole: 'duty_editor', ip: '127.0.0.1' },
      ),
    ).rejects.toThrow('仅管理员可以在无有效台风预警时强制发送');
    await expect(
      send.call(
        controller,
        {
          force: true,
          confirmation: 'WRONG',
          clientMutationId: 'force-20260728',
        },
        { accessRole: 'admin', ip: '127.0.0.1' },
      ),
    ).rejects.toThrow('请明确确认强制发送台风路径图');
    await expect(
      send.call(
        controller,
        {
          force: true,
          confirmation: 'FORCE_SEND_TYPHOON_PATH',
        },
        { accessRole: 'admin', ip: '127.0.0.1' },
      ),
    ).rejects.toThrow('缺少有效的操作幂等标识');
    expect(forceSendTyphoonPathScreenshot).not.toHaveBeenCalled();
  });

  it('uses a stable client mutation id for an explicitly confirmed admin force send', async () => {
    const { controller, forceSendTyphoonPathScreenshot } = createController();
    const send = controller.sendTyphoonPathGroupScreenshot as unknown as (
      body: Record<string, unknown>,
      request: Record<string, unknown>,
    ) => Promise<unknown>;

    await send.call(
      controller,
      {
        force: true,
        confirmation: 'FORCE_SEND_TYPHOON_PATH',
        clientMutationId: 'force-20260728',
      },
      { accessRole: 'admin', ip: '127.0.0.1' },
    );

    expect(forceSendTyphoonPathScreenshot).toHaveBeenCalledWith({
      clientMutationId: 'force-20260728',
    });
  });

  it('selects the future 24h rain layer before capturing typhoon path screenshots', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-screenshot.service.ts',
      ),
      'utf8',
    );

    expect(source).toContain("page.locator('.icons .icon').nth(1)");
    expect(source).toContain(
      "page.locator('.ctrls-box.rain .choose-item').first()",
    );
    expect(source).toContain('dismissTyphoonPointPopup');
    expect(source).toContain("page.locator('.leaflet-container').click");
    expect(source).toContain('未来24小时降雨');
  });

  it('crops typhoon path screenshots to the main map area', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-screenshot.service.ts',
      ),
      'utf8',
    );

    expect(source).toContain('TYPHOON_PATH_SCREENSHOT_CLIP_HEIGHT');
    expect(source).toContain('TYPHOON_PATH_SCREENSHOT_CLIP_WIDTH');
    expect(source).toContain('const viewportWidth =');
    expect(source).toContain('const viewportHeight =');
    expect(source).toContain('const clipWidth =');
    expect(source).toContain('const clipHeight =');
    expect(source).toContain('const clipX =');
    expect(source).toContain('Math.floor(viewportWidth / 2)');
    expect(source).toContain('Math.floor((viewportHeight * 2) / 3)');
    expect(source).toContain('TYPHOON_PATH_SCREENSHOT_CLIP_X');
    expect(source).toContain('Math.floor(clipWidth / 3)');
    expect(source).toContain('clip: {');
    expect(source).toContain('x: clipX');
    expect(source).toContain('width: clipWidth');
    expect(source).toContain('height: clipHeight');
  });

  it('keeps typhoon path message cards focused on title and time', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-screenshot.service.ts',
      ),
      'utf8',
    );

    expect(source).toContain("content: '台风路径图'");
    expect(source).toContain(
      'options.warningTitle ? `预警：${options.warningTitle}` :',
    );
    expect(source).toContain('`时间：${this.formatDateTime(options.sentAt)}`');
    expect(source).toContain("content: '打开台风网'");
    expect(source).toContain('url: TYPHOON_PATH_URL');
    expect(source).not.toContain('用途：台风路径截图测试');
    expect(source).not.toContain('`来源：${options.source}`');
    expect(source).not.toContain("content: '南通台风路径截图'");
  });

  it.each([
    ['string', 'false'],
    ['number', 0],
    ['null', null],
    ['array', []],
    ['object', {}],
  ])(
    'rejects a %s clearAdjustment before calling the service',
    async (_label, clearAdjustment) => {
      const { controller, updateChangeScheduleAdjustment } = createController();

      await expect(
        controller.updateChangeScheduleAdjustment(
          {
            recordId: 'record-1',
            clearAdjustment,
          } as never,
          { accessRole: 'admin' } as never,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(updateChangeScheduleAdjustment).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['false', { recordId: 'record-1', clearAdjustment: false }, 'duty_editor'],
    ['omitted', { recordId: 'record-1' }, 'duty_editor'],
    [
      'true for admin',
      { recordId: 'record-1', clearAdjustment: true },
      'admin',
    ],
  ])(
    'accepts clearAdjustment when it is %s',
    async (_label, body, accessRole) => {
      const { controller, updateChangeScheduleAdjustment } = createController();

      await expect(
        controller.updateChangeScheduleAdjustment(
          body as never,
          { accessRole } as never,
        ),
      ).resolves.toEqual({ success: true });
      expect(updateChangeScheduleAdjustment).toHaveBeenCalledWith(
        body,
        accessRole,
      );
    },
  );

  it('rejects clearAdjustment true for duty editors', async () => {
    const { controller, updateChangeScheduleAdjustment } = createController();

    await expect(
      controller.updateChangeScheduleAdjustment(
        { recordId: 'record-1', clearAdjustment: true },
        { accessRole: 'duty_editor' } as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(updateChangeScheduleAdjustment).not.toHaveBeenCalled();
  });
});
