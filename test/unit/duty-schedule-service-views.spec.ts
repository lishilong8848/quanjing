jest.mock(
  '@server/database/schema',
  () => ({
    appRoomScheduleEnhanced: {},
    appSyncConfig: {},
    appSealingInfo: {},
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({})),
    maskSecret: jest.fn((value?: string | null) => (value ? '***' : '')),
    parseFeishuBitableLink: jest.fn(() => ({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
    readEnv: jest.fn(() => ''),
  }),
  { virtual: true },
);

jest.mock(
  '@server/common/database/unavailable-database',
  () => ({
    isDatabaseDisabled: jest.fn(() => true),
  }),
  { virtual: true },
);

jest.mock('../../server/modules/bitable-sync/employee-onboarding.config', () => ({
  readEmployeeOnboardingConfig: jest.fn(() => ({ appToken: 'canonicalPersonApp', wikiToken: '', tableId: 'tbl122d1a08645adab', tableName: '员工信息池（全量）' })),
}));

jest.mock(
  '@server/common/feishu/bitable-direct-read',
  () => ({
    extractDateTimeIso: jest.fn(() => null),
    extractDateValue: jest.fn(() => null),
    extractDisplayText: jest.fn((value?: unknown, separator = ''): string => {
      if (typeof value === 'string') {
        return value;
      }
      if (Array.isArray(value)) {
        return value
          .map((item) => {
            if (typeof item === 'string') {
              return item;
            }
            if (
              typeof item === 'object' &&
              item !== null &&
              typeof (item as { text?: unknown }).text === 'string'
            ) {
              return (item as { text: string }).text;
            }
            return '';
          })
          .filter(Boolean)
          .join(separator);
      }
      return '';
    }),
    extractDisplayValues: jest.fn(() => []),
    extractNumberValue: jest.fn(() => null),
    fetchBitableRecords: jest.fn(),
    getRecordId: jest.fn(
      (record: { record_id?: string; id?: string }) =>
        record.record_id || record.id || '',
    ),
    invalidateBitableRecordCache: jest.fn(),
    readLatestPersistedBitableRecordSnapshot: jest.fn(),
    normalizeBuildingForFrontend: jest.fn((value: string) =>
      String(value || '').includes('110') ? 'station_110' : value,
    ),
    normalizeBuildingLabel: jest.fn((value: string) => value),
    normalizeShiftForFrontend: jest.fn((value: string) => value),
    normalizeTeamForFrontend: jest.fn((value: string) => value),
    pickField: jest.fn((fields: Record<string, unknown>, names: string[]) =>
      names.map((name) => fields[name]).find((value) => value !== undefined),
    ),
    resolveBitableAppToken: jest.fn(async (_httpService, config) =>
      Promise.resolve(config.appToken),
    ),
  }),
  { virtual: true },
);

jest.mock(
  '@shared/exception-follow-up-match',
  () => ({
    normalizeExceptionFollowUpComparable: jest.fn((value: string) => value),
  }),
  { virtual: true },
);

import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import { readEnv } from '../../server/common/config/external-services.config';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import {
  CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS,
  CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
  CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS,
  CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
  CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS,
  CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD,
  buildConstructionPermitManualReviewFingerprint,
} from '../../server/modules/duty-schedule/construction-management';
import {
  CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
  type LeaveRequestCreateRequest,
  type OvertimeRequestCreateRequest,
} from '../../shared/api.interface';
import {
  calculateLeaveRequestImpact,
  type LeaveRequestImpactSchedule,
} from '../../shared/leave-request-impact';
import {
  calculateOvertimeRequestImpact,
  type OvertimeRequestImpactSchedule,
} from '../../shared/overtime-request-impact';
import type { ChangeRequestCreateRequest } from '../../shared/change-request';
import type { ChangeDrillReportCreateRequest } from '../../shared/change-drill-report';
import type { ChangeDrillReportExecutionPorts } from '../../server/modules/duty-schedule/change-drill-report.service';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

describe('DutyScheduleService construction crew ledger views', () => {
  const previousConstructionAiAuditEnabled =
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED;

  function buildCrewRosterWorkbookBuffer(
    rows: unknown[][] = [
      [
        '姓名*\nName*',
        '证件号码*\nCertificateNo*',
        '手机号码*\nCellphone*',
        '公司*\nCompany*',
        '授权范围(选填)\nAuthorizationScope',
        '授权有效期',
      ],
      [
        '张鹏',
        '411024199110154959',
        '13800004492',
        '浙江省邮电工程建设有限公司',
        'HA楼',
        '2026-06-08 至 2026-06-14',
      ],
    ],
  ): Buffer {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      '工作表1',
    );
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }

  function buildTrainingSignInWorkbookBuffer(names: string[]): Buffer {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['序号', '姓名', '签字'],
        ...names.map((name, index) => [index + 1, name, name]),
      ]),
      '签到表',
    );
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }

  function createServiceWithAxios(axiosRef: Record<string, jest.Mock>) {
    const service = new DutyScheduleService(
      {} as never,
      {
        axiosRef,
      } as never,
    );
    (service as any).constructionOverviewConfig = {
      appToken: 'overviewApp',
      wikiToken: '',
      tableId: 'tblOverview',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    (service as any).constructionFollowupConfig = {
      appToken: 'followupApp',
      wikiToken: '',
      tableId: 'tblFollowup',
      viewId: '',
      tableName: '施工跟进',
      sourceUrl: '',
    };
    (service as any).constructionCrewLedgerConfig = {
      appToken: 'crewApp',
      wikiToken: '',
      tableId: 'tblCrew',
      viewId: '',
      tableName: '施工人员台账',
      sourceUrl: '',
    };
    service.getFeishuTenantAccessToken = jest.fn(async () => 'tenant-token');
    return service as any;
  }

  it('bounds strict monthly schedule reads to the requested Shanghai dates without dropping approval verification', async () => {
    const service = createServiceWithAxios({});
    service.fetchFeishuScheduleRecords = jest.fn().mockResolvedValue([]);
    await service.getMonthlySchedulesFromFeishu('2026-10-24', '2026-10-27', true, true);
    expect(service.fetchFeishuScheduleRecords).toHaveBeenCalledWith(true, true, undefined, {
      startDate: '2026-10-24', endDate: '2026-10-27',
    });
  });

  it('sends conservative Shanghai date filters to Base and still forces fresh approval validation', async () => {
    const approvalSource = require('../../server/common/feishu/leave-approval-source');
    const approvalRead = jest.spyOn(approvalSource, 'fetchLeaveApprovalSnapshot').mockResolvedValue({ verified: true, requests: [] });
    const service = createServiceWithAxios({});
    getBitableRecordsMock().mockResolvedValue([]);
    try {
      await service.fetchFeishuScheduleRecords(true, true, undefined, { startDate: '2026-10-24', endDate: '2026-10-27' });
      expect(getBitableRecordsMock()).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        forceRefresh: true, strict: true, allowStale: false,
        filter: { conjunction: 'and', conditions: [
          { field_name: '排班日期', operator: 'isGreater', value: ['ExactDate', String(Date.parse('2026-10-23T00:00:00+08:00'))] },
          { field_name: '排班日期', operator: 'isLess', value: ['ExactDate', String(Date.parse('2026-10-28T00:00:00+08:00'))] },
        ] },
      }));
      expect(approvalRead).toHaveBeenCalledWith(expect.anything(), { forceRefresh: true, strict: true });
    } finally { approvalRead.mockRestore(); }
  });

  it.each([
    { startDate: '2026-02-31', endDate: '2026-03-04' },
    { startDate: '2026-10-28', endDate: '2026-10-24' },
  ])('rejects invalid bounded schedule dates before any remote read: %j', async (range) => {
    const service = createServiceWithAxios({});
    const calls = getBitableRecordsMock().mock.calls.length;
    await expect(service.fetchFeishuScheduleRecords(true, true, undefined, range)).rejects.toThrow('排班查询日期范围无效');
    expect(getBitableRecordsMock().mock.calls).toHaveLength(calls);
  });

  function createChangeDrillReportRequest(): ChangeDrillReportCreateRequest {
    return {
      clientMutationId:
        'change-drill-report-123e4567-e89b-42d3-a456-426614174000',
      changeRecordId: 'recChange123',
      buildings: ['H楼'],
      reportDocuments: [
        {
          name: '演练报告.pdf',
          type: 'application/pdf',
          size: 1024,
          objectStorage: {
            id: 'storageDrill123',
            filePath: 'change-drill-reports/report.pdf',
            bucketId: 'change-bucket',
            url: 'https://storage.example.test/change-drill-reports/report.pdf',
          },
        },
      ],
    };
  }

  async function captureChangeDrillReportPorts(service: any): Promise<{
    ports: ChangeDrillReportExecutionPorts;
    request: ChangeDrillReportCreateRequest;
    reportService: { assertPersistedReportMatches: jest.Mock };
  }> {
    const request = createChangeDrillReportRequest();
    let capturedPorts: ChangeDrillReportExecutionPorts | undefined;
    const reportService = {
      assertPersistedReportMatches: jest.fn(),
      execute: jest.fn(
        async (
          submittedRequest: ChangeDrillReportCreateRequest,
          ports: ChangeDrillReportExecutionPorts,
        ) => {
          capturedPorts = ports;
          return {
            success: true as const,
            clientMutationId: submittedRequest.clientMutationId,
            changeRecordId: submittedRequest.changeRecordId,
            reportRecordId: 'recDrillReport123',
            buildings: [...submittedRequest.buildings],
            message: '演练报告已同步飞书多维表',
          };
        },
      ),
    };
    service.changeDrillReportService = reportService;
    service.changeAttachmentStorage = {};
    service.calendarChangeConfig = {
      appToken: 'changeApp',
      wikiToken: '',
      tableId: 'tblChange',
      viewId: '',
      tableName: '变更底表',
      sourceUrl: '',
    };
    service.changeDrillReportTableId = 'tblDrillReport';
    service.changeDrillReportTableName = '演练&总结报告';

    await service.createChangeDrillReport(request);
    if (!capturedPorts) {
      throw new Error('未捕获演练报告执行 ports');
    }
    return { ports: capturedPorts, request, reportService };
  }

  async function invokeChangeDrillReportCreatePort(service: any) {
    const captured = await captureChangeDrillReportPorts(service);
    service.createBitableRecord = jest.fn(async () => 'recDrillReport123');
    service.fetchBitableRecordById = jest.fn(async () => ({
      record_id: 'recDrillReport123',
      fields: {
        变更关联: [{ link_record_ids: ['recChange123'] }],
        '演练报告（风险中及以上）': [{ file_token: 'fileDrill123' }],
        '变更演练报告（风险中及以上）': [{ file_token: 'fileDrill123' }],
        演练楼栋: ['H楼'],
        演练提交请求唯一ID: captured.request.clientMutationId,
        演练提交请求指纹: 'a'.repeat(64),
      },
    }));

    await captured.ports.createReport({
      clientMutationId: captured.request.clientMutationId,
      fingerprint: 'a'.repeat(64),
      clientToken: '123e4567-e89b-42d3-a456-426614174000',
      changeRecordId: captured.request.changeRecordId,
      buildings: [...captured.request.buildings],
      reportFileTokens: ['fileDrill123'],
    });

    return service.createBitableRecord.mock.calls[0][3] as Record<
      string,
      unknown
    >;
  }

  it('logs only safe Feishu codes when a change summary record write is rejected', () => {
    const service = createServiceWithAxios({});
    const loggerError = jest.fn();
    service.logger.error = loggerError;
    const sensitiveMessage =
      'write rejected for private-summary.pdf, 示例人员008, tenant-token-secret';
    const error = Object.assign(new Error(sensitiveMessage), {
      response: {
        status: 400,
        data: { code: 1254015, msg: sensitiveMessage },
      },
    });

    service.logChangeSummaryReportWriteFailure(
      error,
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
    );

    expect(loggerError).toHaveBeenCalledTimes(1);
    const message = String(loggerError.mock.calls[0][0]);
    expect(message).toMatch(
      /^变更总结记录创建被飞书拒绝：requestRef=[0-9a-f]{12}, upstreamStatus=400, bitableCode=1254015$/,
    );
    expect(message).not.toMatch(
      /private-summary|示例人员008|tenant-token-secret|write rejected/i,
    );
  });

  it('does not infer a change summary Feishu code from message digits', () => {
    const service = createServiceWithAxios({});
    const loggerError = jest.fn();
    service.logger.error = loggerError;

    service.logChangeSummaryReportWriteFailure(
      new Error('业务日期 20260812 / 工号 123456'),
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
    );

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(
        /^变更总结记录创建被飞书拒绝：requestRef=[0-9a-f]{12}, upstreamStatus=unknown, bitableCode=unknown$/,
      ),
    );
    expect(String(loggerError.mock.calls[0][0])).not.toMatch(/20260812|123456/);
  });

  it('writes the change summary relation as a record id string array', async () => {
    const service = createServiceWithAxios({});
    service.changeAttachmentStorage = {};
    service.calendarChangeConfig = {
      appToken: 'changeApp',
      wikiToken: '',
      tableId: 'tblChange',
      viewId: '',
      tableName: '变更底表',
      sourceUrl: '',
    };
    service.createBitableRecord = jest.fn(async () => 'recSummary');
    const ports = service.createChangeSummaryReportPorts({});

    await ports.createReport({
      clientMutationId:
        'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
      fingerprint: 'a'.repeat(64),
      clientToken: '123e4567-e89b-42d3-a456-426614174000',
      changeRecordId: 'recChange123',
      reportFileTokens: ['fileSummary123'],
    });

    const fields = service.createBitableRecord.mock.calls[0][3];
    expect(fields['变更关联']).toEqual(['recChange123']);
    expect(fields['变更关联']).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it('queries persisted drill reports with the canonical attachment field name', async () => {
    const service = createServiceWithAxios({});
    const captured = await captureChangeDrillReportPorts(service);
    getBitableRecordsMock().mockResolvedValueOnce([]);

    await captured.ports.findReportByMutationId(
      captured.request.clientMutationId,
    );

    expect(getBitableRecordsMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'changeApp',
        tableId: 'tblDrillReport',
        fieldNames: [
          '变更关联',
          '变更演练报告（风险中及以上）',
          '演练楼栋',
          '演练提交请求唯一ID',
          '演练提交请求指纹',
        ],
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: '演练提交请求唯一ID',
              operator: 'is',
              value: [captured.request.clientMutationId],
            },
          ],
        },
        forceRefresh: true,
        strict: true,
      }),
    );
  });

  it('writes drill attachments to the canonical report field', async () => {
    const service = createServiceWithAxios({});

    const fields = await invokeChangeDrillReportCreatePort(service);

    expect(fields['变更演练报告（风险中及以上）']).toEqual([
      { file_token: 'fileDrill123' },
    ]);
    expect(fields).not.toHaveProperty('演练报告（风险中及以上）');
  });

  it('writes the drill report relation as a record id string array', async () => {
    const service = createServiceWithAxios({});

    const fields = await invokeChangeDrillReportCreatePort(service);

    expect(fields.变更关联).toEqual(['recChange123']);
  });

  it('reads Feishu search link_record_ids for a persisted change summary', async () => {
    const clientMutationId =
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000';
    getBitableRecordsMock().mockResolvedValueOnce([
      {
        record_id: 'recSummary123',
        fields: {
          变更关联: [{ link_record_ids: ['recChange123'] }],
          '变更总结报告（风险低及以上）': [{ file_token: 'fileSummary123' }],
          变更总结请求唯一ID: clientMutationId,
          变更总结请求指纹: 'a'.repeat(64),
        },
      },
    ]);
    const service = createServiceWithAxios({});
    service.changeAttachmentStorage = {};
    service.calendarChangeConfig = {
      appToken: 'changeApp',
      wikiToken: '',
      tableId: 'tblChange',
      viewId: '',
      tableName: '变更底表',
      sourceUrl: '',
    };

    const ports = service.createChangeSummaryReportPorts({});

    await expect(
      ports.findReportByMutationId(clientMutationId),
    ).resolves.toEqual({
      recordId: 'recSummary123',
      clientMutationId,
      fingerprint: 'a'.repeat(64),
      changeRecordId: 'recChange123',
      reportFileTokens: ['fileSummary123'],
    });
  });

  it('ignores a drill report when locating a change summary by the shared change relation', async () => {
    getBitableRecordsMock().mockResolvedValueOnce([
      {
        record_id: 'recDrill123',
        fields: {
          变更关联: [{ link_record_ids: ['recChange123'] }],
          '演练报告（风险中及以上）': [{ file_token: 'fileDrill123' }],
          演练提交请求唯一ID:
            'change-drill-report-123e4567-e89b-42d3-a456-426614174000',
          演练提交请求指纹: 'b'.repeat(64),
        },
      },
    ]);
    const service = createServiceWithAxios({});
    service.changeAttachmentStorage = {};
    service.calendarChangeConfig = {
      appToken: 'changeApp',
      wikiToken: '',
      tableId: 'tblChange',
      viewId: '',
      tableName: '变更底表',
      sourceUrl: '',
    };

    const ports = service.createChangeSummaryReportPorts({});

    await expect(
      ports.findReportByChangeRecordId('recChange123'),
    ).resolves.toBeNull();
  });

  it('uses Feishu batch_get for strict record reads so formula values are display labels', async () => {
    const axiosRef = {
      post: jest.fn(async () => ({
        data: {
          code: 0,
          data: {
            records: [
              {
                record_id: 'recStrictDisplay123',
                fields: {
                  变更进度: { type: 3, value: ['已结束'] },
                },
              },
            ],
          },
        },
      })),
    };
    const service = createServiceWithAxios(axiosRef);

    const record = await service.fetchBitableRecordByIdWithDisplayValues(
      'appToken',
      'tblChange',
      '变更底表',
      'recStrictDisplay123',
      'tenant-token',
    );

    expect(record).toEqual(
      expect.objectContaining({
        record_id: 'recStrictDisplay123',
        fields: {
          变更进度: { type: 3, value: ['已结束'] },
        },
      }),
    );
    expect(axiosRef.post).toHaveBeenCalledWith(
      expect.stringContaining('/records/batch_get'),
      {
        record_ids: ['recStrictDisplay123'],
        automatic_fields: true,
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  function createConstructionFollowupAuditGateScenario() {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    service.buildDailyPersonnelChecklistUploadFile = jest.fn(async () => null);
    service.auditConstructionFollowupFiles = jest.fn(async () => [null, {}]);
    service.scheduleConstructionFollowupAuditBackfill = jest.fn();
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
        { file_token: 'tokIsolation' },
      ],
    }));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.syncConstructionFollowupPostSaveSideEffects = jest.fn(
      async () => undefined,
    );
    return service;
  }

  function createLeaveRequestInput(
    overrides: Partial<LeaveRequestCreateRequest> = {},
    schedules: LeaveRequestImpactSchedule[] = [createLeaveSchedule()],
  ): LeaveRequestCreateRequest {
    const leaveStaffName = overrides.leaveStaffName ?? '示例人员008';
    const startAt = overrides.startAt ?? '2026-08-05T18:00';
    const endAt = overrides.endAt ?? '2026-08-06T09:00';
    return {
      clientMutationId: 'leave-request-test-1',
      leaveStaffName,
      startAt,
      endAt,
      leaveType: '年假',
      leaveReason: '年度休假',
      needSubstitute: true,
      substituteStaffName: '示例人员013',
      ...overrides,
      expectedImpact:
        overrides.expectedImpact ??
        calculateLeaveRequestImpact(schedules, {
          leaveStaffName,
          startAt,
          endAt,
        }),
    };
  }

  function createLeaveScreenshot(
    overrides: Partial<{
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }> = {},
  ) {
    const buffer =
      overrides.buffer ??
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      ]);
    return {
      fieldname: 'screenshot',
      originalname: 'leave-process.png',
      encoding: '7bit',
      mimetype: 'image/png',
      size: buffer.length,
      buffer,
      ...overrides,
    };
  }

  function createExpectedLeaveImpact() {
    return {
      affectedSchedules: [
        {
          recordId: 'recNight',
          date: '2026-08-05',
          building: 'A楼',
          team: '一班',
          shift: '夜间值守',
          scheduledHours: 15,
          leaveHours: 15,
          countedHours: 15,
        },
      ],
      excludedSchedules: [],
      rawHours: 15,
      minimumHours: 15,
      unrecognizedShifts: [],
      missingCalendarYears: [],
      invalidRange: false,
      invalidRangeReason: null,
    };
  }

  function createLeaveSchedule(
    overrides: Partial<LeaveRequestImpactSchedule> = {},
  ): LeaveRequestImpactSchedule {
    return {
      recordId: 'recNight',
      scheduleDate: '2026-08-05',
      building: 'building_a',
      buildingText: 'A楼',
      team: 'team_1',
      teamText: '一班',
      shift: 'night',
      shiftText: '夜间值守',
      dutyStaffActual: ['示例人员008'],
      ...overrides,
    };
  }

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function getBitableRecordsMock(): jest.Mock {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    return bitableDirectRead.fetchBitableRecords;
  }

  function getPersistedBitableRecordSnapshotMock(): jest.Mock {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { readLatestPersistedBitableRecordSnapshot: jest.Mock };
    return bitableDirectRead.readLatestPersistedBitableRecordSnapshot;
  }

  function getInvalidateBitableRecordCacheMock(): jest.Mock {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { invalidateBitableRecordCache: jest.Mock };
    return bitableDirectRead.invalidateBitableRecordCache;
  }

  function expectStrictLeaveRequestLookup(clientMutationId: string): void {
    expect(getBitableRecordsMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblLeave',
        fieldNames: ['请求唯一ID', '请求指纹'],
        filter: expect.objectContaining({
          conditions: [
            expect.objectContaining({
              field_name: '请求唯一ID',
              operator: 'is',
              value: [clientMutationId],
            }),
          ],
        }),
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(getBitableRecordsMock()).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: 'tblLeavePerson' }),
    );
  }

  function createLeaveRequestFieldMetas() {
    return [
      { field_id: 'fldjXCAzJk', field_name: '休假开始时间', type: 5 },
      { field_id: 'fld9LND1ZA', field_name: '休假结束时间', type: 5 },
      { field_id: 'fldRJkgamA', field_name: '休假类型', type: 3 },
      { field_id: 'fldAtshsb9', field_name: '请假原因', type: 1 },
      { field_id: 'fldxEKxxQR', field_name: '休假人员', type: 11 },
      {
        field_id: 'fldLeaveStaffProgramName',
        field_name: '休假人员姓名（程序）',
        type: 1,
      },
      { field_id: 'fldlUOzqnH', field_name: '需替班人员', type: 11 },
      {
        field_id: 'fld7noByKE',
        field_name: '是否需要替班（替班打√）',
        type: 7,
      },
      { field_id: 'fldpUkeEzS', field_name: '替班人员（填姓名）', type: 1 },
      { field_id: 'fldHWdPR5B', field_name: '休假工时数', type: 2 },
      {
        field_id: 'fldNDGYPnW',
        field_name: '休假工时数（最低4h）',
        type: 2,
      },
      { field_id: 'fldRequestId', field_name: '请求唯一ID', type: 1 },
      { field_id: 'fldRequestFingerprint', field_name: '请求指纹', type: 1 },
      {
        field_id: 'fldImpactScheduleRecordIds',
        field_name: '系统影响排班记录ID',
        type: 1,
      },
      { field_id: 'fldCP3Q5uM', field_name: '流程截图', type: 17 },
      { field_id: 'fldLeaveApprovalSource', field_name: '审批来源', type: 3 },
      {
        field_id: 'fldLeaveWorkflowStatus',
        field_name: '请假工作流状态',
        type: 3,
      },
      { field_id: 'fldoiQwQuq', field_name: '休假人员（文本）', type: 20 },
      { field_id: 'fldInfluwF', field_name: '所属楼栋', type: 21 },
      { field_id: 'fldQJiJPd0', field_name: '班组', type: 21 },
      { field_id: 'fldcbi40pZ', field_name: '班次（有关联）', type: 20 },
    ];
  }

  function createDefaultLeavePersonnelRecords(): Array<
    Record<string, unknown>
  > {
    return [
      {
        record_id: 'recPersonZhangSan',
        fields: {
          姓名: '示例人员008',
          员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
          班组: 'A班',
        },
      },
      {
        record_id: 'recPersonLiSi',
        fields: {
          姓名: '示例人员013',
          员工姓名: [{ id: 'ou_lisi', name: '示例人员013' }],
          班组: 'A班',
        },
      },
    ];
  }

  function createLeaveRequestService(
    schedules: Array<Record<string, unknown>>,
    options: {
      fieldMetas?: ReturnType<typeof createLeaveRequestFieldMetas>;
      leaveLookupError?: unknown;
      leaveRecords?: Array<Record<string, unknown>>;
      personnelLookupError?: unknown;
      personnelRecords?: Array<Record<string, unknown>>;
      canonicalPersonnelRecords?: Array<Record<string, unknown>>;
    } = {},
  ) {
    const personnelRecords =
      options.personnelRecords ?? createDefaultLeavePersonnelRecords();
    getBitableRecordsMock().mockImplementation(
      async (_httpService: unknown, read: { tableId?: string }) => {
        if (read.tableId === 'tblLeave') {
          if (options.leaveLookupError !== undefined) {
            throw options.leaveLookupError;
          }
          return options.leaveRecords ?? [];
        }
        if (read.tableId === 'tblLeavePerson') {
          if (options.personnelLookupError !== undefined) {
            throw options.personnelLookupError;
          }
          return personnelRecords;
        }
        if (read.tableId === 'tbl122d1a08645adab') return options.canonicalPersonnelRecords ?? personnelRecords;
        return [];
      },
    );
    const service = createServiceWithAxios({});
    (service as any).leavePersonProfileConfig = {
      appToken: 'leavePersonApp',
      wikiToken: '',
      tableId: 'tblLeavePerson',
      viewId: '',
      tableName: '请休假人员资料',
      sourceUrl: '',
    };
    (service as any).leaveSubstituteConfig = {
      appToken: 'leaveApp',
      wikiToken: '',
      tableId: 'tblLeave',
      viewId: 'vewHyBE14E',
      tableName: '请休假替班修正',
      sourceUrl:
        'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    };
    service.fetchBitableFieldMetas = jest.fn(
      async () => options.fieldMetas ?? createLeaveRequestFieldMetas(),
    );
    service.getMonthlySchedulesFromFeishu = jest.fn(async () => schedules);
    service.uploadBitableAttachment = jest.fn(
      async () => 'tok-leave-process-screenshot',
    );
    service.createBitableRecord = jest.fn().mockResolvedValueOnce('recLeave1');
    const createLeaveRequest = service.createLeaveRequest.bind(service);
    service.createLeaveRequest = jest.fn(
      (request, screenshot = createLeaveScreenshot(), principal?: AccessPrincipal) =>
        createLeaveRequest(request, screenshot, principal),
    );
    const buildLeaveRequestMutationFingerprint =
      service.buildLeaveRequestMutationFingerprint.bind(service);
    service.buildLeaveRequestMutationFingerprint = jest.fn(
      (request, screenshot = createLeaveScreenshot()) =>
        buildLeaveRequestMutationFingerprint(request, screenshot),
    );
    return service;
  }

  function createOvertimeRequestInput(
    overrides: Partial<OvertimeRequestCreateRequest> = {},
    schedules: OvertimeRequestImpactSchedule[] = [],
    staffShift: string | null = 'A班',
  ): OvertimeRequestCreateRequest {
    const staffName = overrides.staffName ?? '示例人员008';
    const startAt = overrides.startAt ?? '2026-08-05T19:00+08:00';
    const endAt = overrides.endAt ?? '2026-08-05T22:00+08:00';
    return {
      clientMutationId: 'overtime-request-test-1',
      staffName,
      startAt,
      endAt,
      reason: '夜间应急保障',
      ...overrides,
      expectedImpact:
        overrides.expectedImpact ??
        calculateOvertimeRequestImpact(schedules, {
          staffName,
          startAt,
          endAt,
          staffShift,
        }),
    };
  }

  function createOvertimeScreenshot(
    overrides: Parameters<typeof createLeaveScreenshot>[0] = {},
  ) {
    return createLeaveScreenshot({
      originalname: 'overtime-proof.png',
      ...overrides,
    });
  }

  function createOvertimeRequestFieldMetas() {
    return [
      { field_id: 'fldAkMDN4j', field_name: '加班人员', type: 11 },
      { field_id: 'fld6i1nnqj', field_name: '加班人员姓名', type: 1 },
      { field_id: 'fldLDUzzkk', field_name: '加班开始时间', type: 5 },
      { field_id: 'fld1WAlola', field_name: '加班结束时间', type: 5 },
      { field_id: 'fldiT8jZJM', field_name: '加班时长', type: 2 },
      { field_id: 'fldNBsiD6p', field_name: '加班举证', type: 17 },
      { field_id: 'fldryGT7Gy', field_name: '加班原因', type: 1 },
      { field_id: 'flddA6fBNh', field_name: '请求唯一ID', type: 1 },
      { field_id: 'fldsR7gdBZ', field_name: '请求指纹', type: 1 },
    ];
  }

  function createOvertimeRequestService(
    schedules: Array<Record<string, unknown>> = [],
    options: {
      fieldMetas?: ReturnType<typeof createOvertimeRequestFieldMetas>;
      localScheduleRangeComplete?: boolean;
      overtimeLookupError?: unknown;
      overtimeRecords?: Array<Record<string, unknown>>;
      personnelLookupError?: unknown;
      personnelRecords?: Array<Record<string, unknown>>;
      personnelSnapshotMissing?: boolean;
      todayDateKey?: string;
    } = {},
  ) {
    const personnelRecords =
      options.personnelRecords ?? createDefaultLeavePersonnelRecords();
    getBitableRecordsMock().mockImplementation(
      async (_httpService: unknown, read: { tableId?: string }) => {
        if (read.tableId === 'tblf1bbd02a2b049') {
          if (options.overtimeLookupError !== undefined) {
            throw options.overtimeLookupError;
          }
          return options.overtimeRecords ?? [];
        }
        if (read.tableId === 'tblLeavePerson') {
          if (options.personnelLookupError !== undefined) {
            throw options.personnelLookupError;
          }
          return personnelRecords;
        }
        return [];
      },
    );
    getPersistedBitableRecordSnapshotMock().mockImplementation(
      async (read: { tableId?: string }) => {
        if (read.tableId !== 'tblLeavePerson') {
          return null;
        }
        if (options.personnelLookupError !== undefined) {
          throw options.personnelLookupError;
        }
        if (options.personnelSnapshotMissing) {
          return null;
        }
        return {
          records: personnelRecords,
          fetchedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
      },
    );
    const service = createServiceWithAxios({});
    service.leavePersonProfileConfig = {
      appToken: 'leavePersonApp',
      wikiToken: '',
      tableId: 'tblLeavePerson',
      viewId: '',
      tableName: '请休假人员资料',
      sourceUrl: '',
    };
    service.leaveSubstituteConfig = {
      appToken: 'leaveApp',
      wikiToken: '',
      tableId: 'tblf1bbd02a2b049',
      viewId: 'vewHyBE14E',
      tableName: '请休假替班修正',
      sourceUrl:
        'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    };
    service.fetchBitableFieldMetas = jest.fn(
      async () => options.fieldMetas ?? createOvertimeRequestFieldMetas(),
    );
    service.getMonthlySchedulesFromLocalCache = jest.fn(
      async (startDate: string, endDate: string) => {
        if (options.localScheduleRangeComplete === false) {
          return schedules;
        }
        const schedulesWithCoverage = [...schedules];
        const coveredDates = new Set(
          schedulesWithCoverage.map((schedule) => schedule.scheduleDate),
        );
        for (
          let cursor = new Date(`${startDate}T00:00:00.000Z`);
          cursor <= new Date(`${endDate}T00:00:00.000Z`);
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        ) {
          const scheduleDate = cursor.toISOString().slice(0, 10);
          if (coveredDates.has(scheduleDate)) continue;
          schedulesWithCoverage.push({
            recordId: `recLocalCoverage-${scheduleDate}`,
            scheduleDate,
            building: 'building_a',
            buildingText: 'A楼',
            team: 'team_coverage',
            teamText: '缓存覆盖校验',
            shift: 'white',
            shiftText: '白班',
            dutyStaffActual: ['缓存覆盖校验'],
          });
        }
        return schedulesWithCoverage;
      },
    );
    service.getMonthlySchedulesFromFeishu = jest.fn(async () => schedules);
    service.uploadBitableAttachment = jest.fn(async () => 'tok-overtime-proof');
    service.createBitableRecord = jest.fn(async () => 'recOvertime1');
    service.getShanghaiTodayDateKey = jest.fn(
      () => options.todayDateKey ?? '2026-08-08',
    );
    const createOvertimeRequest = service.createOvertimeRequest.bind(service);
    service.createOvertimeRequest = jest.fn(
      (request, screenshot = createOvertimeScreenshot()) =>
        createOvertimeRequest(request, screenshot),
    );
    const buildOvertimeRequestMutationFingerprint =
      service.buildOvertimeRequestMutationFingerprint.bind(service);
    service.buildOvertimeRequestMutationFingerprint = jest.fn(
      (request, screenshot = createOvertimeScreenshot()) =>
        buildOvertimeRequestMutationFingerprint(request, screenshot),
    );
    return service;
  }

  it('rejects overtime when the verified person differs from a stale local personnel cache before uploading', async () => {
    const service = createOvertimeRequestService();
    service.resolveLeaveRequestStaff = jest.fn(async () => ({ userId: 'ou_verified_self', personRecordId: 'recVerifiedSelf' }));
    await expect(DutyScheduleService.prototype.createOvertimeRequest.call(service, createOvertimeRequestInput(), createLeaveScreenshot(), {
      role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: '示例人员008',
    })).rejects.toThrow('加班人员缓存不一致');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('writes overtime for the verified person when both personnel sources agree', async () => {
    const service = createOvertimeRequestService();
    service.resolveLeaveRequestStaff = jest.fn(async () => ({ userId: 'ou_zhangsan', personRecordId: 'recVerifiedSelf' }));
    await expect(DutyScheduleService.prototype.createOvertimeRequest.call(service, createOvertimeRequestInput(), createLeaveScreenshot(), {
      role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: '示例人员008',
    })).resolves.toMatchObject({ success: true });
    expect(service.createBitableRecord).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ 加班人员: [{ id: 'ou_zhangsan' }] }), expect.anything(), expect.anything());
  });

  it('rejects replay of prepared overtime that belongs to a different verified person', async () => {
    const service = createOvertimeRequestService();
    const request = createOvertimeRequestInput();
    await expect(service.createOvertimeRequestNow(request, request.clientMutationId, createLeaveScreenshot(), {
      preparedWrite: { fields: { 加班人员: [{ id: 'ou_other' }] }, requestFingerprint: service.buildOvertimeRequestMutationFingerprint(request, createLeaveScreenshot()) },
    }, { userId: 'ou_zhangsan', personRecordId: 'recVerifiedSelf' })).rejects.toThrow('原加班申请不一致');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('writes fixed overtime fields from local personnel and schedule caches without Feishu reads', async () => {
    const service = createOvertimeRequestService();
    const request = createOvertimeRequestInput();
    const fingerprint =
      service.buildOvertimeRequestMutationFingerprint(request);

    await expect(service.createOvertimeRequest(request)).resolves.toEqual({
      success: true,
      created: 1,
      recordId: 'recOvertime1',
      clientMutationId: request.clientMutationId,
      requestFingerprint: fingerprint,
      impact: request.expectedImpact,
      message: '加班申请已提交：示例人员008，3 小时',
    });
    expect(service.getMonthlySchedulesFromLocalCache).toHaveBeenCalledWith(
      '2026-08-04',
      '2026-08-06',
    );
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(getPersistedBitableRecordSnapshotMock()).toHaveBeenCalledWith({
      appToken: 'leavePersonApp',
      tableId: 'tblLeavePerson',
      viewId: undefined,
      tableName: '请休假人员资料',
      fieldNames: ['姓名', '员工姓名', '机楼/专业', '班组', '岗位', '班次'],
    });
    expect(
      getBitableRecordsMock().mock.calls.filter(
        ([, read]: [unknown, { tableId?: string }]) =>
          read.tableId === 'tblLeavePerson',
      ),
    ).toHaveLength(0);
    expect(service.uploadBitableAttachment).toHaveBeenCalledWith(
      'tenant-token',
      'leaveApp',
      expect.objectContaining({ fieldname: 'screenshot' }),
      '加班举证',
    );
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'leaveApp',
      'tblf1bbd02a2b049',
      '请休假替班修正',
      {
        加班人员: [{ id: 'ou_zhangsan' }],
        加班人员姓名: '示例人员008',
        加班开始时间: new Date('2026-08-05T19:00:00+08:00').getTime(),
        加班结束时间: new Date('2026-08-05T22:00:00+08:00').getTime(),
        加班时长: 3,
        加班举证: [{ file_token: 'tok-overtime-proof' }],
        加班原因: '夜间应急保障',
        请求唯一ID: request.clientMutationId,
        请求指纹: fingerprint,
      },
      'tenant-token',
      {
        optionalMissingFieldNames: [],
        retryNetworkErrors: true,
        clientToken: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      },
    );
    expect(
      Object.keys(service.createBitableRecord.mock.calls[0][3]).sort(),
    ).toEqual(
      [
        '加班人员',
        '加班人员姓名',
        '加班开始时间',
        '加班结束时间',
        '加班时长',
        '加班举证',
        '加班原因',
        '请求唯一ID',
        '请求指纹',
      ].sort(),
    );
  });

  it('accepts overtime from 30 days ago and rejects day 31 before external work', async () => {
    const acceptedService = createOvertimeRequestService([], {
      todayDateKey: '2026-08-08',
    });
    await expect(
      acceptedService.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-history-day-30',
          startAt: '2026-07-09T19:00+08:00',
          endAt: '2026-07-09T22:00+08:00',
        }),
      ),
    ).resolves.toEqual(expect.objectContaining({ success: true }));

    const expiredService = createOvertimeRequestService([], {
      todayDateKey: '2026-08-08',
    });
    await expect(
      expiredService.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-history-day-31',
          startAt: '2026-07-08T19:00+08:00',
          endAt: '2026-07-08T22:00+08:00',
        }),
      ),
    ).rejects.toThrow('加班历史日期仅支持过去 30 天内');
    expect(expiredService.fetchBitableFieldMetas).not.toHaveBeenCalled();
    expect(expiredService.createBitableRecord).not.toHaveBeenCalled();
  });

  it('requires one real overtime screenshot and rejects spoofed image content', async () => {
    const service = createOvertimeRequestService();
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-required-screenshot',
    });
    const prototypeCreate = (
      DutyScheduleService.prototype as unknown as {
        createOvertimeRequest: (
          input: OvertimeRequestCreateRequest,
          screenshot?: ReturnType<typeof createOvertimeScreenshot>,
        ) => Promise<unknown>;
      }
    ).createOvertimeRequest;

    await expect(
      prototypeCreate.call(service, request, undefined),
    ).rejects.toThrow('请上传加班举证截图');
    await expect(
      service.createOvertimeRequest(
        request,
        createOvertimeScreenshot({
          buffer: Buffer.from('not-an-image'),
          size: Buffer.byteLength('not-an-image'),
        }),
      ),
    ).rejects.toThrow('截图文件内容与格式不匹配');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('returns only safe attachment-upload diagnostics when the overtime screenshot upload finally fails', async () => {
    const service = createOvertimeRequestService();
    const loggerError = jest.fn();
    service.logger.error = loggerError;
    const sensitiveMessage =
      'upload failed for overtime-proof.png, 示例人员008, tenant-token-secret';
    service.uploadBitableAttachment.mockRejectedValueOnce(
      Object.assign(new Error(sensitiveMessage), {
        response: {
          status: 502,
          data: { code: 1061002, msg: sensitiveMessage },
        },
      }),
    );

    const error = await service
      .createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-attachment-upload-failed',
        }),
      )
      .catch(
        (reason: unknown) =>
          reason as {
            response?: Record<string, unknown>;
            status?: number;
          },
      );

    expect(error).toMatchObject({
      status: 502,
      response: {
        message: '加班举证上传失败，尚未建立加班记录，请稍后重试',
        writeDisposition: 'definitely-not-written',
        operationPhase: 'attachment-upload',
        upstreamStatus: 502,
        bitableCode: '1061002',
      },
    });
    const publicDiagnostics = JSON.stringify({
      response: error.response,
      logs: loggerError.mock.calls,
    });
    expect(publicDiagnostics).not.toContain(sensitiveMessage);
    expect(publicDiagnostics).not.toContain('overtime-proof.png');
    expect(publicDiagnostics).not.toContain('示例人员008');
    expect(publicDiagnostics).not.toContain('tenant-token-secret');
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects overtime staff names longer than 2000 characters before external reads or writes', async () => {
    const service = createOvertimeRequestService();

    await expect(
      service.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-staff-name-too-long',
          staffName: '张'.repeat(2001),
        }),
      ),
    ).rejects.toThrow('加班人员姓名不能超过 2000 个字符');
    expect(service.fetchBitableFieldMetas).not.toHaveBeenCalled();
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'empty staff',
      overrides: { staffName: '   ' },
      message: '请选择加班人员',
    },
    {
      label: 'empty reason',
      overrides: { reason: '   ' },
      message: '请填写加班原因',
    },
    {
      label: 'non-whole-hour start',
      overrides: { startAt: '2026-08-05T19:30+08:00' },
      message: '加班开始和结束时间必须为整点',
    },
    {
      label: 'end not after start',
      overrides: {
        startAt: '2026-08-05T19:00+08:00',
        endAt: '2026-08-05T19:00+08:00',
      },
      message: '加班结束时间必须晚于开始时间',
    },
    {
      label: 'range below one hour',
      overrides: {
        startAt: '2026-08-05T19:00+08:00',
        endAt: '2026-08-05T19:30+08:00',
      },
      message: '加班开始和结束时间必须为整点',
    },
  ])(
    'rejects $label before overtime external work',
    async ({ overrides, message }) => {
      const service = createOvertimeRequestService();

      await expect(
        service.createOvertimeRequest(
          createOvertimeRequestInput({
            clientMutationId: `overtime-request-validation-${overrides.staffName ?? overrides.reason ?? overrides.startAt ?? overrides.endAt}`,
            ...overrides,
          }),
        ),
      ).rejects.toThrow(message);
      expect(service.fetchBitableFieldMetas).not.toHaveBeenCalled();
      expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
      expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['加班人员', 1],
    ['加班人员姓名', 11],
    ['加班开始时间', 1],
    ['加班结束时间', 1],
    ['加班时长', 1],
    ['加班举证', 1],
    ['加班原因', 11],
    ['请求唯一ID', 11],
    ['请求指纹', 11],
  ])(
    'rejects the real %s field when its type is not fixed',
    async (fieldName, type) => {
      const service = createOvertimeRequestService([], {
        fieldMetas: createOvertimeRequestFieldMetas().map((field) =>
          field.field_name === fieldName ? { ...field, type } : field,
        ),
      });

      await expect(
        service.createOvertimeRequest(
          createOvertimeRequestInput({
            clientMutationId: `overtime-request-wrong-type-${fieldName}`,
          }),
        ),
      ).rejects.toThrow(`加班多维表“${fieldName}”字段`);
      expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    },
  );

  it('fails closed when an overtime field id or type is missing', async () => {
    const wrongId = createOvertimeRequestService([], {
      fieldMetas: createOvertimeRequestFieldMetas().map((field) =>
        field.field_name === '加班人员姓名'
          ? { ...field, field_id: 'fldWrongNameId' }
          : field,
      ),
    });
    await expect(
      wrongId.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-wrong-field-id',
        }),
      ),
    ).rejects.toThrow('加班多维表未找到固定字段“加班人员姓名”');

    const missingType = createOvertimeRequestService([], {
      fieldMetas: createOvertimeRequestFieldMetas().map((field) =>
        field.field_name === '加班人员' ? { ...field, type: undefined } : field,
      ),
    });
    await expect(
      missingType.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-missing-field-type',
        }),
      ),
    ).rejects.toThrow('加班多维表“加班人员”字段必须是人员类型');
  });

  it('returns 409 definitely-not-written when authoritative overtime impact drifts', async () => {
    const authoritativeSchedules = [createLeaveSchedule()];
    const service = createOvertimeRequestService(authoritativeSchedules);
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-impact-drift',
    });

    await expect(service.createOvertimeRequest(request)).rejects.toMatchObject({
      status: 409,
      response: {
        writeDisposition: 'definitely-not-written',
        latestImpact: expect.objectContaining({
          canSubmit: false,
          conflictingSchedules: [
            expect.objectContaining({ recordId: 'recNight' }),
          ],
        }),
      },
    });
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it.each(['班组', '班次', '班别', '值班班次'])(
    'resolves the authoritative overtime shift from personnel field %s',
    async (shiftFieldName) => {
      const service = createOvertimeRequestService([], {
        personnelRecords: [
          {
            record_id: `recPersonShift-${shiftFieldName}`,
            fields: {
              姓名: '示例人员008',
              员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
              [shiftFieldName]: 'A班',
            },
          },
        ],
      });

      await expect(
        service.resolveOvertimeRequestStaff('示例人员008'),
      ).resolves.toEqual({
        userId: 'ou_zhangsan',
        shift: 'A班',
      });
      expect(getPersistedBitableRecordSnapshotMock()).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tableId: 'tblLeavePerson',
          fieldNames: ['姓名', '员工姓名', '机楼/专业', '班组', '岗位', '班次'],
        }),
      );
      expect(getBitableRecordsMock()).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tableId: 'tblLeavePerson' }),
      );
    },
  );

  it('fails definitely-not-written when the local overtime personnel snapshot is missing', async () => {
    const service = createOvertimeRequestService([], {
      personnelSnapshotMissing: true,
    });

    await expect(
      service.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-local-personnel-cache-missing',
        }),
      ),
    ).rejects.toMatchObject({
      status: 502,
      response: {
        message: expect.stringContaining('本地人员资料缓存'),
        writeDisposition: 'definitely-not-written',
      },
    });
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('fails definitely-not-written when the local overtime schedule range is incomplete', async () => {
    const service = createOvertimeRequestService([], {
      localScheduleRangeComplete: false,
    });

    await expect(
      service.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-local-schedule-cache-incomplete',
        }),
      ),
    ).rejects.toMatchObject({
      status: 502,
      response: {
        message: expect.stringContaining('本地排班缓存'),
        writeDisposition: 'definitely-not-written',
      },
    });
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects long-white overtime inside legal workday hours with the authoritative message', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recLongWhiteWorkday',
        scheduleDate: '2026-08-10',
        team: 'long_white',
        teamText: '长白',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createOvertimeRequestService(schedules, {
      personnelRecords: [
        {
          record_id: 'recPersonLongWhite',
          fields: {
            姓名: '示例人员008',
            员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
            班次: '长白',
          },
        },
      ],
    });
    const request = createOvertimeRequestInput(
      {
        clientMutationId: 'overtime-request-long-white-workday',
        startAt: '2026-08-10T10:00+08:00',
        endAt: '2026-08-10T11:00+08:00',
      },
      schedules,
      '长白',
    );

    await expect(service.createOvertimeRequest(request)).rejects.toThrow(
      '长白班工作日加班仅可选择 09:00 前或 18:00 后',
    );
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('fails closed when the legal workday calendar is unavailable for long-white overtime', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recLongWhiteUnknownCalendar',
        scheduleDate: '2027-01-04',
        team: 'long_white',
        teamText: '长白',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createOvertimeRequestService(schedules, {
      personnelRecords: [
        {
          record_id: 'recPersonLongWhiteUnknownCalendar',
          fields: {
            姓名: '示例人员008',
            员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
            班次: '长白',
          },
        },
      ],
    });
    const request = createOvertimeRequestInput(
      {
        clientMutationId: 'overtime-request-long-white-calendar-missing',
        startAt: '2027-01-04T10:00+08:00',
        endAt: '2027-01-04T11:00+08:00',
      },
      schedules,
      '长白',
    );

    await expect(service.createOvertimeRequest(request)).rejects.toThrow(
      '法定工作日历数据不完整，暂不能提交该时段',
    );
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects a full adjacent night overtime shift that creates 24 hours of continuous duty', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recWhiteBeforeOvertime',
        scheduleDate: '2026-08-10',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createOvertimeRequestService(schedules);
    const request = createOvertimeRequestInput(
      {
        clientMutationId: 'overtime-request-continuous-duty-24-hours',
        startAt: '2026-08-10T18:00+08:00',
        endAt: '2026-08-11T09:00+08:00',
      },
      schedules,
      'A班',
    );

    await expect(service.createOvertimeRequest(request)).rejects.toThrow(
      '7×24 排班人员加班不得与本人排班连续值守达到 24 小时',
    );
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('allows four hours of overtime immediately after a day shift without reaching 24 hours', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recWhiteBeforePartialOvertime',
        scheduleDate: '2026-08-10',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createOvertimeRequestService(schedules);
    const request = createOvertimeRequestInput(
      {
        clientMutationId: 'overtime-request-continuous-duty-partial',
        startAt: '2026-08-10T18:00+08:00',
        endAt: '2026-08-10T22:00+08:00',
      },
      schedules,
      'A班',
    );

    await expect(service.createOvertimeRequest(request)).resolves.toMatchObject(
      {
        success: true,
        created: 1,
        impact: expect.objectContaining({
          payableHours: 4,
          invalidRangeReason: null,
          canSubmit: true,
        }),
      },
    );
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('projects approved substitute assignment context into the authoritative overtime impact', async () => {
    const baseSchedule = createLeaveSchedule({
      recordId: 'recApprovedSubstituteNight',
      scheduleDate: '2026-08-05',
      shift: 'night',
      shiftText: 'night',
    });
    const substituteStaffName = baseSchedule.dutyStaffActual[0];
    const schedules = [
      {
        ...baseSchedule,
        personText: 'original-duty-staff',
        dutyStaffReference: ['original-duty-staff'],
        leaveStaff: ['original-duty-staff'],
        substituteStaff: [substituteStaffName],
      },
    ];
    const service = createOvertimeRequestService(schedules);
    const request = createOvertimeRequestInput(
      {
        clientMutationId: 'overtime-request-approved-substitute-backfill',
        expectedImpact: {
          rawHours: 3,
          payableHours: 3,
          conflictingSchedules: [],
          isWholeHour: true,
          invalidRangeReason: null,
          canSubmit: true,
        },
      },
      schedules,
    );

    await expect(service.createOvertimeRequest(request)).resolves.toMatchObject(
      {
        success: true,
        created: 1,
        impact: {
          rawHours: 3,
          payableHours: 3,
          conflictingSchedules: [],
          isWholeHour: true,
          invalidRangeReason: null,
          canSubmit: true,
        },
      },
    );
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects personnel without an authoritative shift before upload or record creation', async () => {
    const service = createOvertimeRequestService([], {
      personnelRecords: [
        {
          record_id: 'recPersonMissingShift',
          fields: {
            姓名: '示例人员008',
            员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
          },
        },
      ],
    });

    await expect(
      service.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-personnel-shift-missing',
        }),
      ),
    ).rejects.toThrow('加班人员“示例人员008”缺少班次信息，请先在人员表维护');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('strictly replays one persisted overtime record only when fingerprint and start time match', async () => {
    const persistedRecords: Array<Record<string, unknown>> = [];
    const service = createOvertimeRequestService([], {
      overtimeRecords: persistedRecords,
    });
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-cloud-replay',
    });
    const fingerprint =
      service.buildOvertimeRequestMutationFingerprint(request);
    persistedRecords.push({
      record_id: 'recPersistedOvertime',
      fields: {
        请求唯一ID: request.clientMutationId,
        请求指纹: fingerprint,
        加班开始时间: new Date(request.startAt).getTime(),
      },
    });

    await expect(service.createOvertimeRequest(request)).resolves.toMatchObject(
      {
        created: 0,
        recordId: 'recPersistedOvertime',
        requestFingerprint: fingerprint,
      },
    );
    expect(getBitableRecordsMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblf1bbd02a2b049',
        fieldNames: ['请求唯一ID', '请求指纹', '加班开始时间'],
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
    expect(
      getBitableRecordsMock().mock.calls.filter(
        ([, read]: [unknown, { tableId?: string }]) =>
          read.tableId === 'tblLeavePerson',
      ),
    ).toHaveLength(0);
  });

  it('returns a strict overtime impact DTO when replaying a persisted record', async () => {
    const schedules = [createLeaveSchedule()];
    const persistedRecords: Array<Record<string, unknown>> = [];
    const service = createOvertimeRequestService([], {
      overtimeRecords: persistedRecords,
    });
    const request = createOvertimeRequestInput(
      { clientMutationId: 'overtime-request-strict-replay-dto' },
      schedules,
    );
    const unsafeImpact =
      request.expectedImpact as OvertimeRequestCreateRequest['expectedImpact'] & {
        injected?: string;
      };
    unsafeImpact.injected = 'must-not-leak';
    (
      unsafeImpact
        .conflictingSchedules[0] as (typeof unsafeImpact.conflictingSchedules)[number] & {
        injected?: string;
      }
    ).injected = 'must-not-leak';
    const fingerprint =
      service.buildOvertimeRequestMutationFingerprint(request);
    persistedRecords.push({
      record_id: 'recStrictReplayDto',
      fields: {
        请求唯一ID: request.clientMutationId,
        请求指纹: fingerprint,
        加班开始时间: new Date(request.startAt).getTime(),
      },
    });

    const response = await service.createOvertimeRequest(request);

    expect(response.impact).toEqual({
      rawHours: request.expectedImpact.rawHours,
      payableHours: request.expectedImpact.payableHours,
      conflictingSchedules: request.expectedImpact.conflictingSchedules.map(
        ({ recordId, date, building, team, shift, overlapHours }) => ({
          recordId,
          date,
          building,
          team,
          shift,
          overlapHours,
        }),
      ),
      isWholeHour: request.expectedImpact.isWholeHour,
      invalidRangeReason: request.expectedImpact.invalidRangeReason,
      canSubmit: request.expectedImpact.canSubmit,
    });
    expect(response.impact).not.toHaveProperty('injected');
    expect(response.impact.conflictingSchedules[0]).not.toHaveProperty(
      'injected',
    );
  });

  it('deduplicates concurrent and completed overtime replays while reporting created zero to followers', async () => {
    const service = createOvertimeRequestService();
    const deferredRecordId = createDeferred<string>();
    service.createBitableRecord.mockImplementation(
      () => deferredRecordId.promise,
    );
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-idempotent',
    });

    const firstPromise = service.createOvertimeRequest(request);
    await waitForCondition(
      () => service.createBitableRecord.mock.calls.length === 1,
      'the first overtime-request write to start',
    );
    const concurrentPromise = service.createOvertimeRequest(request);
    deferredRecordId.resolve('recConcurrentOvertime');
    const [first, concurrent] = await Promise.all([
      firstPromise,
      concurrentPromise,
    ]);
    const replay = await service.createOvertimeRequest(request);

    expect(first).toMatchObject({
      created: 1,
      recordId: 'recConcurrentOvertime',
    });
    expect(concurrent).toMatchObject({
      created: 0,
      recordId: 'recConcurrentOvertime',
    });
    expect(replay).toMatchObject({
      created: 0,
      recordId: 'recConcurrentOvertime',
    });
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects the same overtime id with changed payload or screenshot', async () => {
    const service = createOvertimeRequestService();
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-conflict',
    });
    await service.createOvertimeRequest(request);

    await expect(
      service.createOvertimeRequest({ ...request, reason: '不同原因' }),
    ).rejects.toThrow('clientMutationId 重复但加班内容不同');
    await expect(
      service.createOvertimeRequest(
        request,
        createOvertimeScreenshot({
          originalname: 'overtime-proof.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
          size: 4,
        }),
      ),
    ).rejects.toThrow('clientMutationId 重复但加班内容不同');
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('never reports success for a definitely rejected overtime record creation', async () => {
    const service = createOvertimeRequestService();
    service.createBitableRecord.mockRejectedValueOnce(
      Object.assign(new Error('field rejected'), {
        response: { status: 400, data: { code: 1254061 } },
      }),
    );

    await expect(
      service.createOvertimeRequest(
        createOvertimeRequestInput({
          clientMutationId: 'overtime-request-definite-write-failure',
        }),
      ),
    ).rejects.toMatchObject({
      status: 502,
      response: { writeDisposition: 'definitely-not-written' },
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('treats an initial overtime uniqueness lookup failure as unknown, persists it, and safely retries the original id', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'overtime-request-ledger-'));
    const service = createOvertimeRequestService([], {
      overtimeLookupError: Object.assign(new Error('lookup timeout'), {
        code: 'ETIMEDOUT',
      }),
    });
    service.overtimeRequestMutationLedgerDir = ledgerDir;
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-initial-lookup-unknown',
    });

    try {
      await expect(
        service.createOvertimeRequest(request),
      ).rejects.toMatchObject({
        name: 'OvertimeRequestAmbiguousWriteError',
        status: 503,
        response: { writeDisposition: 'unknown-result' },
      });
      expect(service.createBitableRecord).not.toHaveBeenCalled();
      const ledgerPath = service.getOvertimeRequestMutationLedgerPath(
        request.clientMutationId,
      );
      await expect(
        readFile(ledgerPath, 'utf8').then((contents) => JSON.parse(contents)),
      ).resolves.toMatchObject({
        version: 1,
        namespace: 'overtime-request',
        state: 'unknown',
        fingerprint: service.buildOvertimeRequestMutationFingerprint(request),
      });

      getBitableRecordsMock().mockImplementation(
        async (_httpService: unknown, read: { tableId?: string }) => {
          if (read.tableId === 'tblf1bbd02a2b049') return [];
          if (read.tableId === 'tblLeavePerson') {
            return createDefaultLeavePersonnelRecords();
          }
          return [];
        },
      );
      await expect(
        service.createOvertimeRequest(request),
      ).resolves.toMatchObject({
        success: true,
        created: 1,
        recordId: 'recOvertime1',
      });
      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
      await expect(readFile(ledgerPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('retries a durable unknown overtime write after an empty strict reconcile with the same client token', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'overtime-request-ledger-'));
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-durable-unknown-retry',
    });

    try {
      const firstService = createOvertimeRequestService();
      firstService.overtimeRequestMutationLedgerDir = ledgerDir;
      firstService.createBitableRecord.mockRejectedValue(
        Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }),
      );
      await expect(
        firstService.createOvertimeRequest(request),
      ).rejects.toMatchObject({
        name: 'OvertimeRequestAmbiguousWriteError',
        response: { writeDisposition: 'unknown-result' },
      });
      const originalClientToken =
        firstService.createBitableRecord.mock.calls[0][5].clientToken;

      const restartedService = createOvertimeRequestService();
      restartedService.overtimeRequestMutationLedgerDir = ledgerDir;
      await expect(
        restartedService.createOvertimeRequest(request),
      ).resolves.toMatchObject({
        success: true,
        created: 1,
        recordId: 'recOvertime1',
      });
      expect(restartedService.createBitableRecord).toHaveBeenCalledTimes(1);
      expect(
        restartedService.createBitableRecord.mock.calls[0][5].clientToken,
      ).toBe(originalClientToken);
      const ledgerPath = restartedService.getOvertimeRequestMutationLedgerPath(
        request.clientMutationId,
      );
      await expect(readFile(ledgerPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('removes a durable overtime ledger after successful strict reconciliation', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'overtime-request-ledger-'));
    const persistedRecords: Array<Record<string, unknown>> = [];
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-durable-reconcile-success',
    });

    try {
      const firstService = createOvertimeRequestService([], {
        overtimeRecords: persistedRecords,
      });
      firstService.overtimeRequestMutationLedgerDir = ledgerDir;
      firstService.createBitableRecord.mockRejectedValue(
        Object.assign(new Error('write timeout'), { code: 'ETIMEDOUT' }),
      );
      await expect(
        firstService.createOvertimeRequest(request),
      ).rejects.toMatchObject({ name: 'OvertimeRequestAmbiguousWriteError' });
      const ledgerPath = firstService.getOvertimeRequestMutationLedgerPath(
        request.clientMutationId,
      );
      const fingerprint =
        firstService.buildOvertimeRequestMutationFingerprint(request);
      persistedRecords.push({
        record_id: 'recDurableReconciledOvertime',
        fields: {
          请求唯一ID: request.clientMutationId,
          请求指纹: fingerprint,
          加班开始时间: new Date(request.startAt).getTime(),
        },
      });

      const restartedService = createOvertimeRequestService([], {
        overtimeRecords: persistedRecords,
      });
      restartedService.overtimeRequestMutationLedgerDir = ledgerDir;
      await expect(
        restartedService.createOvertimeRequest(request),
      ).resolves.toMatchObject({
        created: 0,
        recordId: 'recDurableReconciledOvertime',
      });
      expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
      await expect(readFile(ledgerPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('does not fail a successful overtime request when exact ledger cleanup fails and logs no sensitive values', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'overtime-request-ledger-'));
    const service = createOvertimeRequestService();
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-sensitive-cleanup-id',
    });
    const deferredRecordId = createDeferred<string>();
    service.createBitableRecord.mockImplementation(
      () => deferredRecordId.promise,
    );
    const loggerWarn = jest.fn();
    service.logger.warn = loggerWarn;

    try {
      const pending = service.createOvertimeRequest(request);
      await waitForCondition(
        () => service.createBitableRecord.mock.calls.length === 1,
        'the overtime record write to start before cleanup failure setup',
      );
      service.overtimeRequestMutationLedgerDir = ledgerDir;
      const ledgerPath = service.getOvertimeRequestMutationLedgerPath(
        request.clientMutationId,
      );
      await mkdir(ledgerPath, { recursive: true });
      deferredRecordId.resolve('recCleanupWarningOvertime');

      await expect(pending).resolves.toMatchObject({
        success: true,
        recordId: 'recCleanupWarningOvertime',
      });
      expect(loggerWarn).toHaveBeenCalledWith(
        '加班幂等未知状态清理失败，将在后续成功请求中重试',
      );
      const logs = JSON.stringify(loggerWarn.mock.calls);
      expect(logs).not.toContain(request.clientMutationId);
      expect(logs).not.toContain(ledgerDir);
    } finally {
      deferredRecordId.resolve('recCleanupWarningOvertime');
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('keeps a durable overtime reconcile timeout as unknown-result and preserves its ledger', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'overtime-request-ledger-'));
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-durable-reconcile-timeout',
    });

    try {
      const firstService = createOvertimeRequestService();
      firstService.overtimeRequestMutationLedgerDir = ledgerDir;
      firstService.createBitableRecord.mockRejectedValue(
        Object.assign(new Error('write timeout'), { code: 'ETIMEDOUT' }),
      );
      await expect(
        firstService.createOvertimeRequest(request),
      ).rejects.toMatchObject({ name: 'OvertimeRequestAmbiguousWriteError' });
      const ledgerPath = firstService.getOvertimeRequestMutationLedgerPath(
        request.clientMutationId,
      );
      const ledgerBeforeRetry = await readFile(ledgerPath, 'utf8');

      const restartedService = createOvertimeRequestService([], {
        overtimeLookupError: Object.assign(new Error('reconcile timeout'), {
          code: 'ETIMEDOUT',
        }),
      });
      restartedService.overtimeRequestMutationLedgerDir = ledgerDir;

      await expect(
        restartedService.createOvertimeRequest(request),
      ).rejects.toMatchObject({
        name: 'OvertimeRequestAmbiguousWriteError',
        status: 503,
        response: { writeDisposition: 'unknown-result' },
      });
      expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
      await expect(readFile(ledgerPath, 'utf8')).resolves.toBe(
        ledgerBeforeRetry,
      );
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('fails closed on an unknown overtime write and safely reconciles the original retry', async () => {
    const persistedRecords: Array<Record<string, unknown>> = [];
    const service = createOvertimeRequestService([], {
      overtimeRecords: persistedRecords,
    });
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-unknown-retry',
    });
    const fingerprint =
      service.buildOvertimeRequestMutationFingerprint(request);
    service.createBitableRecord.mockRejectedValue(
      Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }),
    );

    await expect(service.createOvertimeRequest(request)).rejects.toMatchObject({
      name: 'OvertimeRequestAmbiguousWriteError',
    });
    persistedRecords.push({
      record_id: 'recRecoveredOvertime',
      fields: {
        请求唯一ID: request.clientMutationId,
        请求指纹: fingerprint,
        加班开始时间: new Date(request.startAt).getTime(),
      },
    });
    await expect(service.createOvertimeRequest(request)).resolves.toMatchObject(
      {
        created: 0,
        recordId: 'recRecoveredOvertime',
      },
    );
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('safely retries an unknown overtime write with the same deterministic client token when strict lookup stays empty', async () => {
    const service = createOvertimeRequestService();
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-unknown-safe-repost',
    });
    service.createBitableRecord
      .mockRejectedValueOnce(
        Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }),
      )
      .mockResolvedValueOnce('recSafelyRetriedOvertime');

    await expect(service.createOvertimeRequest(request)).rejects.toMatchObject({
      name: 'OvertimeRequestAmbiguousWriteError',
    });
    await expect(service.createOvertimeRequest(request)).resolves.toMatchObject(
      {
        created: 1,
        recordId: 'recSafelyRetriedOvertime',
      },
    );
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
    const firstClientToken =
      service.createBitableRecord.mock.calls[0][5].clientToken;
    const retryClientToken =
      service.createBitableRecord.mock.calls[1][5].clientToken;
    expect(retryClientToken).toBe(firstClientToken);
  });

  it('keeps overtime client tokens stable and isolated from leave requests with the same UUID suffix', () => {
    const service = createOvertimeRequestService();
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const overtimeMutationId = `overtime-request-${uuid}`;
    const overtimeToken =
      service.toOvertimeRequestBitableClientToken(overtimeMutationId);

    expect(
      service.toOvertimeRequestBitableClientToken(overtimeMutationId),
    ).toBe(overtimeToken);
    expect(overtimeToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(overtimeToken).not.toBe(
      service.toLeaveRequestBitableClientToken(`leave-request-${uuid}`),
    );
  });

  it('preserves a strict 409 when native token reconciliation finds changed overtime content', async () => {
    const persistedRecords: Array<Record<string, unknown>> = [];
    const service = createOvertimeRequestService([], {
      overtimeRecords: persistedRecords,
    });
    const request = createOvertimeRequestInput({
      clientMutationId: 'overtime-request-native-token-content-conflict',
    });
    service.createBitableRecord.mockImplementationOnce(async () => {
      persistedRecords.push({
        record_id: 'recChangedOvertimeContent',
        fields: {
          请求唯一ID: request.clientMutationId,
          请求指纹: 'different-request-fingerprint',
          加班开始时间: new Date(request.startAt).getTime(),
        },
      });
      throw Object.assign(new Error('client token conflict'), {
        response: {
          status: 400,
          data: { code: 1255006, msg: 'client token conflict' },
        },
      });
    });

    await expect(service.createOvertimeRequest(request)).rejects.toMatchObject({
      status: 409,
      response: { writeDisposition: 'definitely-not-written' },
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  function useRealCreateBitableRecord(service: any): jest.Mock {
    service.createBitableRecord = jest.fn((...args: unknown[]) =>
      (
        DutyScheduleService.prototype as unknown as {
          createBitableRecord: (...methodArgs: unknown[]) => Promise<string>;
        }
      ).createBitableRecord.apply(service, args),
    );
    return service.createBitableRecord;
  }

  function createChangeRequestInput(
    overrides: Partial<ChangeRequestCreateRequest> = {},
  ): ChangeRequestCreateRequest {
    return {
      clientMutationId: 'change-request-123e4567-e89b-42d3-a456-426614174000',
      submitterName: '示例人员008',
      nature: '标准变更',
      summary: 'UPS 年度维护',
      changeType: '计划性变更',
      workType: '维护',
      buildings: ['A楼', '110站'],
      plannedStartAt: '2026-08-03T09:00',
      plannedEndAt: '2026-08-03T12:00',
      discipline: '电气',
      level: '低',
      riskSummary: '切换前确认旁路供电正常',
      ...overrides,
    };
  }

  function createChangeRequestFieldMetas() {
    return [
      { field_id: 'fldX1uU37v', field_name: '变更性质判断', type: 3 },
      { field_id: 'fldhApsYlj', field_name: '会议开始时间', type: 5 },
      { field_id: 'fldSecHYBr', field_name: '会议结束时间', type: 5 },
      { field_id: 'fld4Mb34MM', field_name: '变更简述', type: 1 },
      { field_id: 'fldMCGLrqs', field_name: '变更类型', type: 3 },
      { field_id: 'fld5C1kiE6', field_name: '作业类型', type: 3 },
      { field_id: 'fldpvaNYeb', field_name: '变更楼栋', type: 4 },
      {
        field_id: 'fldVD5BNEQ',
        field_name: '计划开始日期（阿里）',
        type: 5,
      },
      {
        field_id: 'fldrl38KPS',
        field_name: '计划结束日期（阿里）',
        type: 5,
      },
      { field_id: 'fldQNjGs78', field_name: '专业', type: 3 },
      { field_id: 'fldyx0s7Ra', field_name: '变更等级（阿里）', type: 3 },
      {
        field_id: 'fldx4xtjHB',
        field_name: '变更重要风险点（简述）',
        type: 1,
      },
      { field_id: 'fld0qzcXDh', field_name: '变更文档', type: 17 },
      { field_id: 'fldChangeSubmitter', field_name: '申请提交人', type: 11 },
      { field_id: 'fldgSjbxxF', field_name: '变更编码&描述', type: 20 },
      { field_id: 'fldMSZy9Qm', field_name: '变更进度', type: 20 },
      { field_id: 'fld9oFnegn', field_name: '变更提交人', type: 1003 },
    ];
  }

  function createMigratedChangeRequestFieldMetas() {
    return [
      ...createChangeRequestFieldMetas().map((field) =>
        field.field_name === '变更提交人' && field.type === 1003
          ? { ...field, field_name: '系统创建人' }
          : field,
      ),
      {
        field_id: 'fldWritableChangeSubmitter',
        field_name: '变更提交人',
        type: 11,
      },
    ];
  }

  function createChangeDocument(name = 'change-plan.pdf') {
    return {
      fieldname: 'documents',
      originalname: name,
      encoding: '7bit',
      mimetype: 'application/pdf',
      size: 9,
      buffer: Buffer.from('%PDF-test'),
    };
  }

  function createChangeRequestService(
    options: {
      fieldMetas?: ReturnType<typeof createChangeRequestFieldMetas>;
      createRecord?: () => Promise<string>;
      attachmentStorage?: Record<string, jest.Mock>;
      personnelRecords?: Array<Record<string, unknown>>;
      personnelSnapshotMissing?: boolean;
    } = {},
  ) {
    const service = createServiceWithAxios({});
    service.changeRequestMutationLedgerDir = '';
    (service as any).changeAttachmentStorage = options.attachmentStorage;
    (service as any).leavePersonProfileConfig = {
      appToken: 'leavePersonApp',
      wikiToken: '',
      tableId: 'tblLeavePerson',
      viewId: '',
      tableName: '请休假人员资料',
      sourceUrl: '',
    };
    getPersistedBitableRecordSnapshotMock().mockResolvedValue(
      options.personnelSnapshotMissing
        ? null
        : {
            records: options.personnelRecords ?? [
              {
                record_id: 'recPersonZhangSan',
                fields: {
                  姓名: '示例人员008',
                  员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
                },
              },
            ],
            fetchedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
    );
    (service as any).calendarChangeConfig = {
      appToken: 'changeApp',
      wikiToken: '',
      tableId: 'tbl8f743982e48e1',
      viewId: 'vewew3vfZT',
      tableName: '计划变更日历',
      sourceUrl:
        'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    };
    service.fetchBitableFieldMetas = jest.fn(
      async () => options.fieldMetas ?? createMigratedChangeRequestFieldMetas(),
    );
    service.uploadBitableAttachment = jest.fn(
      async (
        _tenantToken: string,
        _appToken: string,
        file: { originalname: string },
      ) => `tok-${file.originalname}`,
    );
    service.createBitableRecord = jest.fn(
      options.createRecord ?? (async () => 'recChange1'),
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    const record = {
      record_id: 'recChange1',
      fields: { 变更简述: 'UPS 年度维护' },
      created_time: '1785728400000',
      last_modified_time: '1785728400000',
    };
    service.fetchBitableRecordById = jest.fn(async () => record);
    service.mapFeishuCalendarChangeRecord = jest.fn(() => ({
      id: 'recChange1',
      bitableRecordId: 'recChange1',
      title: 'UPS 年度维护',
      startDate: '2026-08-03T01:00:00.000Z',
      endDate: '2026-08-03T04:00:00.000Z',
      actualStartDate: null,
      actualEndDate: null,
      plannedDelayStartDate: null,
      plannedDelayEndDate: null,
      level: '低',
      type: '计划性变更',
      progress: null,
      executor: null,
      buildings: ['A楼', '110站'],
      riskSummary: '切换前确认旁路供电正常',
      isKey: false,
      recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      createdAt: '2026-08-03T01:00:00.000Z',
      updatedAt: '2026-08-03T01:00:00.000Z',
    }));
    return service;
  }

  async function getChangeRequestPartialFailureDetails(
    promise: Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      await promise;
      throw new Error('expected a partial attachment failure');
    } catch (error) {
      const details = (error as { details?: unknown }).details;
      if (typeof details !== 'string') throw error;
      return JSON.parse(details) as Record<string, unknown>;
    }
  }

  it('migrates the sole CreatedUser 变更提交人 field and writes the selected open_id into the new user field', async () => {
    const initialFieldMetas = createChangeRequestFieldMetas();
    const migratedFieldMetas = [
      ...initialFieldMetas.map((field) =>
        field.field_name === '变更提交人'
          ? { ...field, field_name: '系统创建人' }
          : field,
      ),
      {
        field_id: 'fldWritableChangeSubmitter',
        field_name: '变更提交人',
        type: 11,
      },
    ];
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const post = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          field: {
            field_id: 'fldWritableChangeSubmitter',
            field_name: '变更提交人',
            type: 11,
          },
        },
      },
    });
    const service = createChangeRequestService({
      fieldMetas: initialFieldMetas,
    });
    (service as any).httpService.axiosRef.put = put;
    (service as any).httpService.axiosRef.post = post;
    service.fetchBitableFieldMetas = jest
      .fn()
      .mockResolvedValueOnce(initialFieldMetas)
      .mockResolvedValueOnce(migratedFieldMetas);

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).resolves.toMatchObject({
      success: true,
      record: { id: 'recChange1' },
    });

    const fieldsUrl =
      'https://open.feishu.cn/open-apis/bitable/v1/apps/changeApp/tables/tbl8f743982e48e1/fields';
    expect(put).toHaveBeenCalledWith(
      `${fieldsUrl}/fld9oFnegn`,
      { field_name: '系统创建人', type: 1003 },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        timeout: expect.any(Number),
      }),
    );
    expect(post).toHaveBeenCalledWith(
      fieldsUrl,
      {
        field_name: '变更提交人',
        type: 11,
        property: { multiple: false },
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        timeout: expect.any(Number),
      }),
    );
    expect(service.fetchBitableFieldMetas).toHaveBeenCalledTimes(2);
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[0],
    );
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(
      service.createBitableRecord.mock.invocationCallOrder[0],
    );
    const writtenFields = service.createBitableRecord.mock.calls[0][3];
    expect(writtenFields).toHaveProperty('变更提交人', [{ id: 'ou_zhangsan' }]);
    expect(writtenFields).not.toHaveProperty('系统创建人');
    expect(writtenFields).not.toHaveProperty('申请提交人');
  });

  it('prefers the new writable 变更提交人 field even when the legacy user field appears first', async () => {
    const fieldMetas = [
      ...createChangeRequestFieldMetas().filter(
        (field) => field.field_name !== '变更提交人',
      ),
      {
        field_id: 'fldWritableChangeSubmitter',
        field_name: '变更提交人',
        type: 11,
      },
    ];
    const service = createChangeRequestService({ fieldMetas });

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).resolves.toMatchObject({
      success: true,
      record: { id: 'recChange1' },
    });

    const writtenFields = service.createBitableRecord.mock.calls[0][3];
    expect(writtenFields).toHaveProperty('变更提交人', [{ id: 'ou_zhangsan' }]);
    expect(writtenFields).not.toHaveProperty('申请提交人');
  });

  it('resumes creating the writable 变更提交人 after a completed system-field rename', async () => {
    const interruptedFieldMetas = createChangeRequestFieldMetas().map(
      (field) =>
        field.field_name === '变更提交人' && field.type === 1003
          ? { ...field, field_name: '系统创建人' }
          : field,
    );
    const migratedFieldMetas = [
      ...interruptedFieldMetas,
      {
        field_id: 'fldWritableChangeSubmitter',
        field_name: '变更提交人',
        type: 11,
      },
    ];
    const put = jest.fn();
    const post = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          field: migratedFieldMetas.at(-1),
        },
      },
    });
    const service = createChangeRequestService({
      fieldMetas: interruptedFieldMetas,
    });
    (service as any).httpService.axiosRef.put = put;
    (service as any).httpService.axiosRef.post = post;
    service.fetchBitableFieldMetas = jest
      .fn()
      .mockResolvedValueOnce(interruptedFieldMetas)
      .mockResolvedValueOnce(migratedFieldMetas);

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).resolves.toMatchObject({ success: true });

    expect(put).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/fields'),
      {
        field_name: '变更提交人',
        type: 11,
        property: { multiple: false },
      },
      expect.any(Object),
    );
    expect(service.createBitableRecord.mock.calls[0][3]).toHaveProperty(
      '变更提交人',
      [{ id: 'ou_zhangsan' }],
    );
  });

  it('creates a change request with only writable form fields and reads back one record', async () => {
    const fieldMetas = createChangeRequestFieldMetas().filter(
      (field) => !(field.field_name === '变更提交人' && field.type === 1003),
    );
    const service = createChangeRequestService({ fieldMetas });
    const request = createChangeRequestInput();

    await expect(
      service.createChangeRequest(request, [createChangeDocument()]),
    ).resolves.toMatchObject({
      success: true,
      clientMutationId: request.clientMutationId,
      record: { id: 'recChange1', title: 'UPS 年度维护' },
    });

    expect(service.uploadBitableAttachment).toHaveBeenCalledWith(
      'tenant-token',
      'changeApp',
      expect.objectContaining({ originalname: 'change-plan.pdf' }),
      '变更文档“change-plan.pdf”',
      expect.any(Number),
      { maxAttempts: 5, requestTimeoutMs: 60_000 },
    );
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'changeApp',
      'tbl8f743982e48e1',
      '计划变更日历',
      {
        变更性质判断: '标准变更',
        变更简述: 'UPS 年度维护',
        变更类型: '计划性变更',
        作业类型: '维护',
        变更楼栋: ['A楼', '110站'],
        '计划开始日期（阿里）': new Date('2026-08-03T09:00:00+08:00').getTime(),
        '计划结束日期（阿里）': new Date('2026-08-03T12:00:00+08:00').getTime(),
        专业: '电气',
        '变更等级（阿里）': '低',
        '变更重要风险点（简述）': '切换前确认旁路供电正常',
        变更文档: [{ file_token: 'tok-change-plan.pdf' }],
        申请提交人: [{ id: 'ou_zhangsan' }],
      },
      'tenant-token',
      {
        clientToken: '123e4567-e89b-42d3-a456-426614174000',
        retryNetworkErrors: true,
        deadlineAt: expect.any(Number),
      },
    );
    const writtenFields = service.createBitableRecord.mock.calls[0][3];
    expect(writtenFields).not.toHaveProperty('变更编码&描述');
    expect(writtenFields).not.toHaveProperty('变更进度');
    expect(writtenFields).not.toHaveProperty('变更提交人');
    expect(writtenFields).toHaveProperty('申请提交人', [{ id: 'ou_zhangsan' }]);
    expect(writtenFields).toHaveProperty('变更文档', [
      { file_token: 'tok-change-plan.pdf' },
    ]);
    expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    expect(
      service.uploadBitableAttachment.mock.invocationCallOrder[0],
    ).toBeLessThan(service.createBitableRecord.mock.invocationCallOrder[0]);
    expect(service.fetchBitableRecordById).toHaveBeenCalledWith(
      'changeApp',
      'tbl8f743982e48e1',
      '计划变更日历',
      'recChange1',
      'tenant-token',
      expect.any(Number),
    );
    expect(getInvalidateBitableRecordCacheMock()).toHaveBeenCalledWith({
      appToken: 'changeApp',
      tableId: 'tbl8f743982e48e1',
    });
    expect(getPersistedBitableRecordSnapshotMock()).toHaveBeenCalledWith({
      appToken: 'leavePersonApp',
      tableId: 'tblLeavePerson',
      viewId: undefined,
      tableName: '请休假人员资料',
      fieldNames: ['姓名', '员工姓名', '机楼/专业', '班组', '岗位', '班次'],
    });
    expect(
      getBitableRecordsMock().mock.calls.some(
        ([, options]: [unknown, { tableId?: string }]) =>
          options.tableId === 'tblLeavePerson',
      ),
    ).toBe(false);
  });

  it('creates the formal change record before accepting background attachment sync', async () => {
    const upload = createDeferred<string>();
    const fieldMetas = createChangeRequestFieldMetas()
      .filter((field) => field.field_name !== '申请提交人')
      .map((field) =>
        field.field_name === '变更提交人' ? { ...field, type: 11 } : field,
      );
    const service = createChangeRequestService({ fieldMetas });
    service.uploadBitableAttachment = jest.fn(() => upload.promise);
    const request = createChangeRequestInput();

    const pending = (service as any).createChangeRequest(
      request,
      [createChangeDocument()],
      { backgroundAttachments: true },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
      变更提交人: [{ id: 'ou_zhangsan' }],
    });
    expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
      '变更文档',
    );

    await expect(pending).resolves.toMatchObject({
      success: true,
      pendingSync: true,
      taskId: request.clientMutationId,
      record: { id: 'recChange1' },
    });
    expect(service.getSyncTask(request.clientMutationId)).toMatchObject({
      status: 'running',
    });

    upload.resolve('tok-change-plan.pdf');
    await waitForCondition(
      () =>
        service.getSyncTask(request.clientMutationId)?.status === 'completed',
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'changeApp',
      'tbl8f743982e48e1',
      '计划变更日历',
      'recChange1',
      { 变更文档: [{ file_token: 'tok-change-plan.pdf' }] },
      'tenant-token',
    );
  });

  it('keeps the formal change record when background attachment sync fails', async () => {
    const fieldMetas = createChangeRequestFieldMetas()
      .filter((field) => field.field_name !== '申请提交人')
      .map((field) =>
        field.field_name === '变更提交人' ? { ...field, type: 11 } : field,
      );
    const service = createChangeRequestService({ fieldMetas });
    service.uploadBitableAttachment = jest
      .fn()
      .mockRejectedValue(new Error('connect ETIMEDOUT'));
    const request = createChangeRequestInput();

    await expect(
      (service as any).createChangeRequest(request, [createChangeDocument()], {
        backgroundAttachments: true,
      }),
    ).resolves.toMatchObject({
      pendingSync: true,
      record: { id: 'recChange1' },
    });
    await waitForCondition(
      () => service.getSyncTask(request.clientMutationId)?.status === 'failed',
    );

    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(service.getSyncTask(request.clientMutationId)).toMatchObject({
      status: 'failed',
      inserted: 0,
      failed: 1,
      message: expect.stringContaining('change-plan.pdf'),
      result: {
        code: 'CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE',
        clientMutationId: request.clientMutationId,
        recordState: 'created',
        recordId: 'recChange1',
        documents: [
          expect.objectContaining({
            name: 'change-plan.pdf',
            status: 'upload_failed',
            stage: 'upload',
            retryable: true,
            message: expect.stringContaining('ETIMEDOUT'),
          }),
        ],
      },
    });
  });

  it('keeps uploaded background attachments pending until every file can be linked to the original record', async () => {
    const service = createChangeRequestService();
    let shouldFail = true;
    service.uploadBitableAttachment = jest.fn(
      async (
        _tenantToken: string,
        _appToken: string,
        file: { originalname: string },
      ) => {
        if (file.originalname === 'retry.pdf' && shouldFail) {
          throw new Error('connect ETIMEDOUT: retry later');
        }
        return `tok-${file.originalname}`;
      },
    );
    const request = createChangeRequestInput({
      clientMutationId: 'change-request-523e4567-e89b-42d3-a456-426614174000',
    });
    const files = [
      createChangeDocument('stable.pdf'),
      createChangeDocument('retry.pdf'),
    ];

    await expect(
      (service as any).createChangeRequest(request, files, {
        backgroundAttachments: true,
      }),
    ).resolves.toMatchObject({
      pendingSync: true,
      record: { id: 'recChange1' },
    });
    await waitForCondition(
      () => service.getSyncTask(request.clientMutationId)?.status === 'failed',
    );

    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    expect(service.getSyncTask(request.clientMutationId)).toMatchObject({
      status: 'failed',
      total: 2,
      inserted: 0,
      failed: 2,
      result: {
        code: 'CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE',
        recordState: 'created',
        recordId: 'recChange1',
        documents: [
          expect.objectContaining({
            name: 'stable.pdf',
            status: 'uploaded_pending_attach',
            stage: 'record-link',
            retryable: true,
          }),
          expect.objectContaining({
            name: 'retry.pdf',
            status: 'upload_failed',
            stage: 'upload',
            retryable: true,
          }),
        ],
      },
    });

    shouldFail = false;
    await expect(
      (service as any).createChangeRequest(request, files, {
        backgroundAttachments: true,
      }),
    ).resolves.toMatchObject({
      pendingSync: true,
      record: { id: 'recChange1' },
    });
    await waitForCondition(
      () =>
        service.getSyncTask(request.clientMutationId)?.status === 'completed',
    );
    expect(service.getSyncTask(request.clientMutationId)).toMatchObject({
      status: 'completed',
      total: 2,
      inserted: 2,
      failed: 0,
    });

    const uploadedNames = service.uploadBitableAttachment.mock.calls.map(
      (call: unknown[]) => (call[2] as { originalname: string }).originalname,
    );
    expect(uploadedNames.filter((name) => name === 'stable.pdf')).toHaveLength(
      1,
    );
    expect(uploadedNames.filter((name) => name === 'retry.pdf')).toHaveLength(
      2,
    );
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(service.updateBitableRecordFields).toHaveBeenCalledTimes(1);
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'changeApp',
      'tbl8f743982e48e1',
      '计划变更日历',
      'recChange1',
      {
        变更文档: [
          { file_token: 'tok-stable.pdf' },
          { file_token: 'tok-retry.pdf' },
        ],
      },
      'tenant-token',
    );
  });

  it('fails closed when the local change submitter snapshot is unavailable', async () => {
    const service = createChangeRequestService({
      personnelSnapshotMissing: true,
    });

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).rejects.toThrow('本地人员资料缓存尚未准备完成');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects a non-person legacy submitter field when no CreatedUser field can be migrated', async () => {
    const fieldMetas = createChangeRequestFieldMetas()
      .filter((field) => field.field_name !== '变更提交人')
      .map((field) =>
        field.field_name === '申请提交人' ? { ...field, type: 1 } : field,
      );
    const service = createChangeRequestService({ fieldMetas });

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).rejects.toThrow('可写的人员字段');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects a missing change submitter Base field before upload or record creation', async () => {
    const fieldMetas = createChangeRequestFieldMetas().filter(
      (field) =>
        field.field_name !== '申请提交人' && field.field_name !== '变更提交人',
    );
    const service = createChangeRequestService({ fieldMetas });

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).rejects.toThrow('变更提交人');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('resolves staged attachments by owned storage id and ignores forged metadata', async () => {
    const attachmentStorage = {
      resolveOwned: jest.fn(async () => ({
        id: 'obj-trusted',
        filePath: 'trusted/path/change-plan.pdf',
        bucketId: 'trusted-bucket',
        url: 'https://trusted.example/change-plan.pdf',
        name: 'trusted-change-plan.pdf',
        size: 9,
        mimeType: 'application/pdf',
        sha256: 'a'.repeat(64),
      })),
      readAll: jest.fn(async () => Buffer.from('%PDF-test')),
      readRange: jest.fn(),
      bindToRecord: jest.fn(async () => undefined),
    };
    const service = createChangeRequestService({ attachmentStorage });
    const request = createChangeRequestInput({
      stagedDocuments: [
        {
          name: 'forged.exe',
          originalname: 'forged.exe',
          type: 'application/x-msdownload',
          mimetype: 'application/x-msdownload',
          size: 1,
          objectStorage: {
            id: 'obj-trusted',
            filePath: '../../forged.exe',
            bucketId: 'forged-bucket',
            url: 'https://forged.example/forged.exe',
          },
        },
      ],
    });

    await expect(service.createChangeRequest(request)).resolves.toMatchObject({
      success: true,
      record: { id: 'recChange1' },
    });
    expect(attachmentStorage.resolveOwned).toHaveBeenCalledWith(
      'obj-trusted',
      request.clientMutationId,
    );
    expect(service.uploadBitableAttachment).toHaveBeenCalledWith(
      'tenant-token',
      'changeApp',
      expect.objectContaining({
        originalname: 'trusted-change-plan.pdf',
        mimetype: 'application/pdf',
        size: 9,
      }),
      '变更文档“trusted-change-plan.pdf”',
      expect.any(Number),
      { maxAttempts: 5, requestTimeoutMs: 60_000 },
    );
    expect(attachmentStorage.bindToRecord).toHaveBeenCalledWith(
      'obj-trusted',
      'recChange1',
      'tok-trusted-change-plan.pdf',
      { ownerMutationId: request.clientMutationId },
    );
  });

  it('rejects mixed legacy and staged attachments before resolving or writing', async () => {
    const attachmentStorage = {
      resolveOwned: jest.fn(),
      readAll: jest.fn(),
      readRange: jest.fn(),
      bindToRecord: jest.fn(),
    };
    const service = createChangeRequestService({ attachmentStorage });
    const request = createChangeRequestInput({
      stagedDocuments: [
        {
          name: 'change-plan.pdf',
          type: 'application/pdf',
          size: 9,
          objectStorage: {
            id: 'obj-mixed',
            filePath: 'ignored',
            bucketId: 'ignored',
            url: 'https://ignored.example/file',
          },
        },
      ],
    });

    await expect(
      service.createChangeRequest(request, [createChangeDocument()]),
    ).rejects.toThrow('不能同时');
    expect(attachmentStorage.resolveOwned).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('requires object staging for legacy multipart documents above 20 MiB', async () => {
    const service = createChangeRequestService();
    const document = {
      ...createChangeDocument(),
      size: 20 * 1024 * 1024 + 1,
    };

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [document]),
    ).rejects.toThrow('请先上传到对象存储');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('retries only staged binding after a record was created', async () => {
    const attachmentStorage = {
      resolveOwned: jest.fn(async () => ({
        id: 'obj-retry-bind',
        filePath: 'trusted/change-plan.pdf',
        bucketId: 'trusted-bucket',
        url: 'https://trusted.example/change-plan.pdf',
        name: 'change-plan.pdf',
        size: 9,
        mimeType: 'application/pdf',
        sha256: 'b'.repeat(64),
      })),
      readAll: jest.fn(async () => Buffer.from('%PDF-test')),
      readRange: jest.fn(),
      bindToRecord: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary bind failure'))
        .mockResolvedValueOnce(undefined),
    };
    const service = createChangeRequestService({ attachmentStorage });
    const request = createChangeRequestInput({
      clientMutationId: 'change-request-223e4567-e89b-42d3-a456-426614174000',
      stagedDocuments: [
        {
          name: 'change-plan.pdf',
          type: 'application/pdf',
          size: 9,
          objectStorage: {
            id: 'obj-retry-bind',
            filePath: 'ignored',
            bucketId: 'ignored',
            url: 'https://ignored.example/file',
          },
        },
      ],
    });

    const details = await getChangeRequestPartialFailureDetails(
      service.createChangeRequest(request),
    );
    expect(details).toMatchObject({
      recordState: 'created',
      retryAction: 'retry-same-mutation',
      message: expect.stringContaining('绑定'),
    });
    await expect(service.createChangeRequest(request)).resolves.toMatchObject({
      success: true,
      record: { id: 'recChange1' },
    });
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(attachmentStorage.bindToRecord).toHaveBeenCalledTimes(2);
  });

  it('reports a staged background binding failure as pending without double-counting it', async () => {
    const attachmentStorage = {
      resolveOwned: jest.fn(async () => ({
        id: 'obj-background-bind',
        filePath: 'trusted/background-change-plan.pdf',
        bucketId: 'trusted-bucket',
        url: 'https://trusted.example/background-change-plan.pdf',
        name: 'background-change-plan.pdf',
        size: 9,
        mimeType: 'application/pdf',
        sha256: 'd'.repeat(64),
      })),
      readAll: jest.fn(async () => Buffer.from('%PDF-test')),
      readRange: jest.fn(),
      bindToRecord: jest.fn(async () => {
        throw new Error('temporary bind failure');
      }),
    };
    const service = createChangeRequestService({ attachmentStorage });
    const request = createChangeRequestInput({
      clientMutationId: 'change-request-423e4567-e89b-42d3-a456-426614174000',
      stagedDocuments: [
        {
          name: 'background-change-plan.pdf',
          type: 'application/pdf',
          size: 9,
          objectStorage: {
            id: 'obj-background-bind',
            filePath: 'ignored',
            bucketId: 'ignored',
            url: 'https://ignored.example/file',
          },
        },
      ],
    });

    await expect(
      (service as any).createChangeRequest(request, [], {
        backgroundAttachments: true,
      }),
    ).resolves.toMatchObject({
      pendingSync: true,
      record: { id: 'recChange1' },
    });
    await waitForCondition(
      () => service.getSyncTask(request.clientMutationId)?.status === 'failed',
    );

    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(service.getSyncTask(request.clientMutationId)).toMatchObject({
      status: 'failed',
      total: 1,
      inserted: 0,
      failed: 1,
      message: expect.stringContaining('background-change-plan.pdf'),
      result: {
        code: 'CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE',
        recordState: 'created',
        recordId: 'recChange1',
        documents: [
          expect.objectContaining({
            name: 'background-change-plan.pdf',
            status: 'uploaded_pending_attach',
            stage: 'record-link',
            retryable: true,
            message: '附件关联暂时失败',
          }),
        ],
      },
    });
  });

  it('adapts staged files above 20 MiB to Feishu prepare, part and finish APIs', async () => {
    const post = jest.fn();
    post.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          upload_id: 'upload-large',
          block_size: 4 * 1024 * 1024,
          block_num: 6,
        },
      },
    });
    for (let index = 0; index < 6; index += 1) {
      post.mockResolvedValueOnce({ data: { code: 0 } });
    }
    post.mockResolvedValueOnce({
      data: { code: 0, data: { file_token: 'tok-large' } },
    });
    const service = createServiceWithAxios({ post });
    service.runConstructionAttachmentUploadWithRetry = jest.fn(
      async (operation: () => Promise<unknown>) => operation(),
    );
    service.runBitableAttachmentUploadSerially = jest.fn(
      async (_key: string, operation: () => Promise<unknown>) => operation(),
    );
    const size = 20 * 1024 * 1024 + 1;
    service.changeAttachmentStorage = {
      readAll: jest.fn(),
      readRange: jest.fn(async (_id: string, start: number, end: number) => {
        const buffer = Buffer.alloc(end - start + 1);
        if (start === 0) Buffer.from('%PDF-').copy(buffer);
        return buffer;
      }),
    };

    await expect(
      service.uploadStagedChangeRequestAttachment(
        'tenant-token',
        'changeApp',
        {
          fieldname: 'documents',
          originalname: 'large-plan.pdf',
          mimetype: 'application/pdf',
          size,
          storageId: 'obj-large',
          sha256: 'c'.repeat(64),
        },
        'change-request-323e4567-e89b-42d3-a456-426614174000',
        Date.now() + 60_000,
      ),
    ).resolves.toBe('tok-large');
    expect(post.mock.calls.map(([url]) => url)).toEqual([
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_prepare',
      ...Array(6).fill(
        'https://open.feishu.cn/open-apis/drive/v1/medias/upload_part',
      ),
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_finish',
    ]);
    expect(post.mock.calls[0][1]).toEqual({
      file_name: 'large-plan.pdf',
      parent_type: 'bitable_file',
      parent_node: 'changeApp',
      size,
      extra: JSON.stringify({ drive_route_token: 'changeApp' }),
    });
    expect(post.mock.calls[7][1]).toEqual({
      upload_id: 'upload-large',
      block_num: 6,
    });
    const firstPartBody = post.mock.calls[1][1].getBuffer().toString('utf8');
    const lastPartBody = post.mock.calls[6][1].getBuffer().toString('utf8');
    expect(firstPartBody).toContain('name="upload_id"');
    expect(firstPartBody).toContain('upload-large');
    expect(firstPartBody).toContain('name="seq"');
    expect(firstPartBody).toContain('\r\n\r\n0\r\n');
    expect(lastPartBody).toContain('\r\n\r\n5\r\n');
    expect(lastPartBody).toContain('name="size"');
    expect(lastPartBody).toContain('\r\n\r\n1\r\n');
    expect(service.changeAttachmentStorage.readAll).not.toHaveBeenCalled();
    expect(service.changeAttachmentStorage.readRange).toHaveBeenCalledTimes(7);
  });

  it('rejects a spoofed staged file above 20 MiB from its ranged header without readAll or Feishu upload', async () => {
    const post = jest.fn();
    const service = createServiceWithAxios({ post });
    service.changeAttachmentStorage = {
      readAll: jest.fn(),
      readRange: jest.fn(async () => Buffer.alloc(1024)),
    };

    await expect(
      service.uploadStagedChangeRequestAttachment(
        'tenant-token',
        'changeApp',
        {
          fieldname: 'documents',
          originalname: 'spoofed-large.pdf',
          mimetype: 'application/pdf',
          size: 20 * 1024 * 1024 + 1,
          storageId: 'obj-spoofed-large',
          sha256: 'd'.repeat(64),
        },
        'change-request-423e4567-e89b-42d3-a456-426614174000',
        Date.now() + 60_000,
      ),
    ).rejects.toThrow('内容与文件类型不匹配');
    expect(service.changeAttachmentStorage.readRange).toHaveBeenCalledWith(
      'obj-spoofed-large',
      0,
      1023,
      {
        ownerMutationId: 'change-request-423e4567-e89b-42d3-a456-426614174000',
      },
    );
    expect(service.changeAttachmentStorage.readAll).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('confirms a created change request when the targeted readback is temporarily unavailable', async () => {
    const service = createChangeRequestService();
    service.fetchBitableRecordById = jest.fn(async () => {
      throw new Error('temporary readback failure');
    });
    const request = createChangeRequestInput();

    await expect(
      service.createChangeRequest(request, [createChangeDocument()]),
    ).resolves.toMatchObject({
      success: true,
      clientMutationId: request.clientMutationId,
      record: {
        id: 'recChange1',
        bitableRecordId: 'recChange1',
        title: request.summary,
        progress: null,
      },
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('reuses uploaded attachments when the final record create must be retried', async () => {
    const service = createChangeRequestService();
    service.createBitableRecord = jest
      .fn()
      .mockRejectedValueOnce(
        new Error('connect ETIMEDOUT: temporary record create failure'),
      )
      .mockResolvedValueOnce('recChange1');
    const request = createChangeRequestInput();
    const document = createChangeDocument();

    const details = await getChangeRequestPartialFailureDetails(
      service.createChangeRequest(request, [document]),
    );
    expect(details).toMatchObject({
      recordId: `change-request-pending-${request.clientMutationId}`,
      documents: [
        expect.objectContaining({
          status: 'uploaded_pending_attach',
          stage: 'record-link',
          retryable: true,
        }),
      ],
    });
    await expect(
      service.createChangeRequest(request, [document]),
    ).resolves.toMatchObject({
      success: true,
      clientMutationId: request.clientMutationId,
      record: { id: 'recChange1' },
    });

    expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
    expect(service.createBitableRecord.mock.calls[1].slice(0, 5)).toEqual(
      service.createBitableRecord.mock.calls[0].slice(0, 5),
    );
    expect(service.createBitableRecord.mock.calls[1][5]).toMatchObject({
      clientToken: service.createBitableRecord.mock.calls[0][5].clientToken,
      retryNetworkErrors: true,
      deadlineAt: expect.any(Number),
    });
    expect(service.createBitableRecord.mock.calls[0][3]).toHaveProperty(
      '变更文档',
      [{ file_token: 'tok-change-plan.pdf' }],
    );
    expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.fetchBitableRecordById).toHaveBeenCalledTimes(1);
  });

  it('treats Feishu 1254608 Duplicate as unknown and retries with the same client token', async () => {
    const service = createChangeRequestService();
    service.createBitableRecord = jest
      .fn()
      .mockRejectedValueOnce(new Error('1254608 Duplicate'))
      .mockResolvedValueOnce('recChange1');
    const request = createChangeRequestInput();
    const document = createChangeDocument();

    const partial = await getChangeRequestPartialFailureDetails(
      service.createChangeRequest(request, [document]),
    );
    expect(partial).toMatchObject({
      recordState: 'unknown',
      recordCreated: null,
      retryAction: 'retry-same-mutation',
    });
    const firstClientToken =
      service.createBitableRecord.mock.calls[0][5].clientToken;

    await expect(
      service.createChangeRequest(request, [document]),
    ).resolves.toMatchObject({ success: true, record: { id: 'recChange1' } });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
    expect(service.createBitableRecord.mock.calls[1][5]).toMatchObject({
      clientToken: firstClientToken,
    });
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
  });

  it('persists Feishu 1255006 as manual reconciliation and never posts it automatically again', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'change-request-ledger-'));
    const request = createChangeRequestInput();
    const document = createChangeDocument();

    try {
      const firstService = createChangeRequestService();
      firstService.changeRequestMutationLedgerDir = ledgerDir;
      firstService.createBitableRecord = jest
        .fn()
        .mockRejectedValue(new Error('1255006 Client token conflict'));

      const firstPartial = await getChangeRequestPartialFailureDetails(
        firstService.createChangeRequest(request, [document]),
      );
      expect(firstPartial).toMatchObject({
        recordState: 'unknown',
        recordCreated: null,
        retryAction: 'manual-reconcile',
        message: expect.stringContaining('人工核查'),
      });
      await expect(
        readFile(
          join(ledgerDir, `${request.clientMutationId}.manual-reconcile.json`),
          'utf8',
        ).then((contents) => JSON.parse(contents)),
      ).resolves.toMatchObject({
        state: 'manual-reconcile',
        clientMutationId: request.clientMutationId,
        clientToken: '123e4567-e89b-42d3-a456-426614174000',
      });

      const restartedService = createChangeRequestService();
      restartedService.changeRequestMutationLedgerDir = ledgerDir;
      const restartedPartial = await getChangeRequestPartialFailureDetails(
        restartedService.createChangeRequest(request, [document]),
      );
      expect(restartedPartial).toMatchObject({
        recordState: 'unknown',
        retryAction: 'manual-reconcile',
      });
      expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('does not lock a draft when Feishu permanently rejects record creation', async () => {
    const service = createChangeRequestService();
    service.createBitableRecord = jest
      .fn()
      .mockRejectedValue(
        new Error('The attachment does not belong to this bitable: 1254303'),
      );

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).rejects.toThrow('正式记录创建被飞书拒绝');
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('bounds attachment concurrency, waits for every file, and reports partial results', async () => {
    const service = createChangeRequestService();
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    service.uploadBitableAttachment = jest.fn(
      async (
        _tenantToken: string,
        _appToken: string,
        file: { originalname: string },
      ) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        completed += 1;
        if (file.originalname === 'change-1.pdf') {
          throw new Error('connect ETIMEDOUT: first upload failed');
        }
        return `tok-${file.originalname}`;
      },
    );
    const files = Array.from({ length: 5 }, (_, index) =>
      createChangeDocument(`change-${index + 1}.pdf`),
    );

    const request = createChangeRequestInput();
    const details = await getChangeRequestPartialFailureDetails(
      service.createChangeRequest(request, files),
    );

    expect(maxActive).toBeLessThanOrEqual(1);
    expect(completed).toBe(5);
    expect(details).toMatchObject({
      code: 'CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE',
      clientMutationId: request.clientMutationId,
      recordCreated: false,
      recordId: `change-request-pending-${request.clientMutationId}`,
      record: {
        id: `change-request-pending-${request.clientMutationId}`,
        progress: '附件待补传',
      },
      documents: [
        expect.objectContaining({
          name: 'change-1.pdf',
          status: 'upload_failed',
          stage: 'upload',
          retryable: true,
        }),
        ...Array.from({ length: 4 }, (_, index) =>
          expect.objectContaining({
            name: `change-${index + 2}.pdf`,
            status: 'uploaded_pending_attach',
            stage: 'record-link',
            retryable: true,
          }),
        ),
      ],
    });
    expect(service.createBitableRecord).not.toHaveBeenCalled();
    expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
  });

  it('reuses uploaded attachment tokens and retries only failed files', async () => {
    const service = createChangeRequestService();
    let shouldFail = true;
    service.uploadBitableAttachment = jest.fn(
      async (
        _tenantToken: string,
        _appToken: string,
        file: { originalname: string },
      ) => {
        if (file.originalname === 'retry.pdf' && shouldFail) {
          throw new Error('connect ETIMEDOUT: retry later');
        }
        return `tok-${file.originalname}`;
      },
    );
    const files = [
      createChangeDocument('stable.pdf'),
      createChangeDocument('retry.pdf'),
    ];
    const request = createChangeRequestInput();

    await getChangeRequestPartialFailureDetails(
      service.createChangeRequest(request, files),
    );
    shouldFail = false;
    await expect(
      service.createChangeRequest(request, files),
    ).resolves.toMatchObject({ success: true, record: { id: 'recChange1' } });

    const uploadedNames = service.uploadBitableAttachment.mock.calls.map(
      (call: unknown[]) => (call[2] as { originalname: string }).originalname,
    );
    expect(
      uploadedNames.filter((name: string) => name === 'stable.pdf'),
    ).toHaveLength(1);
    expect(
      uploadedNames.filter((name: string) => name === 'retry.pdf'),
    ).toHaveLength(2);
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'changeApp',
      'tbl8f743982e48e1',
      '计划变更日历',
      expect.objectContaining({
        变更文档: [
          { file_token: 'tok-stable.pdf' },
          { file_token: 'tok-retry.pdf' },
        ],
      }),
      'tenant-token',
      expect.objectContaining({ retryNetworkErrors: true }),
    );
    expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
  });

  it('restores uploaded attachment tokens after a service restart and retries only missing files', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'change-request-ledger-'));
    const request = createChangeRequestInput();
    const files = [
      createChangeDocument('stable.pdf'),
      createChangeDocument('retry.pdf'),
    ];

    try {
      const firstService = createChangeRequestService();
      firstService.changeRequestMutationLedgerDir = ledgerDir;
      firstService.uploadBitableAttachment = jest.fn(
        async (
          _tenantToken: string,
          _appToken: string,
          file: { originalname: string },
        ) => {
          if (file.originalname === 'retry.pdf') {
            throw new Error('connect ETIMEDOUT: retry after restart');
          }
          return `durable-${file.originalname}`;
        },
      );

      await getChangeRequestPartialFailureDetails(
        firstService.createChangeRequest(request, files),
      );

      const restartedService = createChangeRequestService();
      restartedService.changeRequestMutationLedgerDir = ledgerDir;
      restartedService.uploadBitableAttachment = jest.fn(
        async (
          _tenantToken: string,
          _appToken: string,
          file: { originalname: string },
        ) => `restarted-${file.originalname}`,
      );

      await expect(
        restartedService.createChangeRequest(request, files),
      ).resolves.toMatchObject({ success: true, record: { id: 'recChange1' } });

      expect(restartedService.uploadBitableAttachment).toHaveBeenCalledTimes(1);
      expect(
        restartedService.uploadBitableAttachment.mock.calls[0][2],
      ).toMatchObject({ originalname: 'retry.pdf' });
      expect(
        restartedService.createBitableRecord.mock.calls[0][3],
      ).toHaveProperty('变更文档', [
        { file_token: 'durable-stable.pdf' },
        { file_token: 'restarted-retry.pdf' },
      ]);
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('reuses the exact create payload after an ambiguous response and service restart', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'change-request-ledger-'));
    const request = createChangeRequestInput();
    const document = createChangeDocument();

    try {
      const firstService = createChangeRequestService();
      firstService.changeRequestMutationLedgerDir = ledgerDir;
      firstService.uploadBitableAttachment = jest.fn(
        async () => 'durable-token-before-ambiguous-create',
      );
      firstService.createBitableRecord = jest.fn(async () => {
        throw new Error('connect ETIMEDOUT after Feishu accepted the request');
      });

      const partial = await getChangeRequestPartialFailureDetails(
        firstService.createChangeRequest(request, [document]),
      );
      expect(partial).toMatchObject({
        recordState: 'unknown',
        recordCreated: null,
      });
      await expect(
        readFile(
          join(ledgerDir, `${request.clientMutationId}.record-unknown.json`),
          'utf8',
        ).then((contents) => JSON.parse(contents)),
      ).resolves.toMatchObject({
        state: 'record-unknown',
        clientMutationId: request.clientMutationId,
        clientToken: '123e4567-e89b-42d3-a456-426614174000',
      });
      const firstCreateArguments =
        firstService.createBitableRecord.mock.calls[0];

      const restartedService = createChangeRequestService();
      restartedService.changeRequestMutationLedgerDir = ledgerDir;
      restartedService.uploadBitableAttachment = jest.fn(
        async () => 'different-token-that-must-not-be-used',
      );

      await expect(
        restartedService.createChangeRequest(request, [document]),
      ).resolves.toMatchObject({ success: true, record: { id: 'recChange1' } });

      expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(
        restartedService.createBitableRecord.mock.calls[0].slice(0, 5),
      ).toEqual(firstCreateArguments.slice(0, 5));
      expect(
        restartedService.createBitableRecord.mock.calls[0][5],
      ).toMatchObject({
        clientToken: firstCreateArguments[5].clientToken,
        retryNetworkErrors: true,
        deadlineAt: expect.any(Number),
      });
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('restores a formal record id after interruption and does not create the record again', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'change-request-ledger-'));
    const request = createChangeRequestInput();
    const document = createChangeDocument();

    try {
      const firstService = createChangeRequestService();
      firstService.changeRequestMutationLedgerDir = ledgerDir;
      firstService.mapFeishuCalendarChangeRecord = jest.fn(() => {
        throw new Error('simulated process interruption after record creation');
      });

      await expect(
        firstService.createChangeRequest(request, [document]),
      ).rejects.toThrow('simulated process interruption');
      expect(firstService.createBitableRecord).toHaveBeenCalledTimes(1);

      const restartedService = createChangeRequestService();
      restartedService.changeRequestMutationLedgerDir = ledgerDir;

      await expect(
        restartedService.createChangeRequest(request, [document]),
      ).resolves.toMatchObject({ success: true, record: { id: 'recChange1' } });

      expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
      expect(restartedService.fetchBitableRecordById).toHaveBeenCalledWith(
        'changeApp',
        'tbl8f743982e48e1',
        '计划变更日历',
        'recChange1',
        'tenant-token',
        expect.any(Number),
      );
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('stops before record creation when the total change-request deadline is exhausted', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const ledgerDir = await mkdtemp(join(tmpdir(), 'change-request-ledger-'));
    const request = createChangeRequestInput();
    const files = Array.from({ length: 5 }, (_, index) =>
      createChangeDocument(`deadline-${index + 1}.pdf`),
    );

    try {
      const firstService = createChangeRequestService();
      firstService.changeRequestMutationLedgerDir = ledgerDir;
      firstService.uploadBitableAttachment = jest.fn(
        async (
          _tenantToken: string,
          _appToken: string,
          file: { originalname: string },
        ) => {
          jest.setSystemTime(Date.now() + 90_000);
          return `durable-${file.originalname}`;
        },
      );

      const details = await getChangeRequestPartialFailureDetails(
        firstService.createChangeRequest(request, files),
      );

      expect(firstService.uploadBitableAttachment).toHaveBeenCalledTimes(4);
      expect(firstService.createBitableRecord).not.toHaveBeenCalled();
      expect(details).toMatchObject({
        recordState: 'not-created',
        recordCreated: false,
        documents: [
          ...Array.from({ length: 3 }, (_, index) =>
            expect.objectContaining({
              name: `deadline-${index + 1}.pdf`,
              status: 'uploaded_pending_attach',
              retryable: true,
            }),
          ),
          expect.objectContaining({
            name: 'deadline-4.pdf',
            status: 'upload_failed',
            retryable: true,
          }),
          expect.objectContaining({
            name: 'deadline-5.pdf',
            status: 'upload_failed',
            retryable: true,
          }),
        ],
      });

      const restartedService = createChangeRequestService();
      restartedService.changeRequestMutationLedgerDir = ledgerDir;
      restartedService.uploadBitableAttachment = jest.fn(
        async (
          _tenantToken: string,
          _appToken: string,
          file: { originalname: string },
        ) => `durable-${file.originalname}`,
      );
      await expect(
        restartedService.createChangeRequest(request, files),
      ).resolves.toMatchObject({ success: true, record: { id: 'recChange1' } });
      expect(restartedService.uploadBitableAttachment).toHaveBeenCalledTimes(2);
      expect(
        restartedService.uploadBitableAttachment.mock.calls.map(
          (call: unknown[]) =>
            (call[2] as { originalname: string }).originalname,
        ),
      ).toEqual(['deadline-4.pdf', 'deadline-5.pdf']);
    } finally {
      jest.useRealTimers();
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('returns a retryable structured partial when durable-ledger bootstrap hangs', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const service = createChangeRequestService();
    service.loadDurableChangeRequestMutationState = jest.fn(
      () => new Promise(() => undefined),
    );
    const request = createChangeRequestInput();
    const pending = service.createChangeRequest(request, [
      createChangeDocument(),
    ]);
    const settled = pending.then(
      () => ({ kind: 'success' as const }),
      (error: { details?: unknown }) => ({
        kind: 'error' as const,
        details:
          typeof error.details === 'string'
            ? (JSON.parse(error.details) as Record<string, unknown>)
            : null,
      }),
    );

    try {
      await jest.advanceTimersByTimeAsync(360_000);
      const outcome = await Promise.race([
        settled,
        Promise.resolve({ kind: 'pending' as const }),
      ]);
      expect(outcome).toMatchObject({
        kind: 'error',
        details: {
          code: 'CHANGE_REQUEST_ATTACHMENT_PARTIAL_FAILURE',
          recordState: 'not-created',
          recordCreated: false,
          documents: [
            expect.objectContaining({
              status: 'upload_failed',
              retryable: true,
            }),
          ],
        },
      });
      expect(service.fetchBitableFieldMetas).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['app token', 'tenant token'] as const)(
    'returns a retryable structured partial when %s resolution hangs',
    async (tokenKind) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
      const service = createChangeRequestService();
      if (tokenKind === 'app token') {
        const bitableDirectRead = jest.requireMock(
          '@server/common/feishu/bitable-direct-read',
        ) as { resolveBitableAppToken: jest.Mock };
        bitableDirectRead.resolveBitableAppToken.mockImplementationOnce(
          () => new Promise(() => undefined),
        );
      } else {
        service.getFeishuTenantAccessToken = jest.fn(
          () => new Promise(() => undefined),
        );
      }
      const request = createChangeRequestInput();
      const pending = service.createChangeRequest(request, [
        createChangeDocument(),
      ]);
      const settled = pending.then(
        () => ({ kind: 'success' as const }),
        (error: { details?: unknown }) => ({
          kind: 'error' as const,
          details:
            typeof error.details === 'string'
              ? (JSON.parse(error.details) as Record<string, unknown>)
              : null,
        }),
      );

      try {
        await jest.advanceTimersByTimeAsync(360_000);
        const outcome = await Promise.race([
          settled,
          Promise.resolve({ kind: 'pending' as const }),
        ]);
        expect(outcome).toMatchObject({
          kind: 'error',
          details: {
            recordState: 'not-created',
            recordCreated: false,
          },
        });
        expect(service.fetchBitableFieldMetas).not.toHaveBeenCalled();
        expect(service.createBitableRecord).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('checks the total deadline on every field-metadata page', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const get = jest.fn(async () => {
      jest.setSystemTime(Date.now() + 120_000);
      return {
        data: {
          code: 0,
          data: {
            items: [],
            has_more: get.mock.calls.length < 4,
            page_token: `page-${get.mock.calls.length}`,
          },
        },
      };
    });
    const service = createServiceWithAxios({ get });

    try {
      await expect(
        service.fetchBitableFieldMetas(
          'changeApp',
          'tblChange',
          '计划变更日历',
          'tenant-token',
          Date.now() + 360_000,
        ),
      ).rejects.toThrow('变更申请同步时间已用尽');
      expect(get).toHaveBeenCalledTimes(3);
      expect(get.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.any(String),
            expect.objectContaining({ timeout: 30_000 }),
          ]),
        ]),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not start an attachment after its queue wait reaches the deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const service = createServiceWithAxios({});
    const queue = createDeferred<void>();
    service.bitableAttachmentUploadTails.set('changeApp', queue.promise);
    const operation = jest.fn(async () => 'uploaded');

    try {
      const pending = service.runBitableAttachmentUploadSerially(
        'changeApp',
        operation,
        Date.now() + 1_000,
      );
      const assertion =
        expect(pending).rejects.toThrow('变更申请同步时间已用尽');
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(operation).not.toHaveBeenCalled();
      queue.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(operation).not.toHaveBeenCalled();
    } finally {
      queue.resolve();
      jest.useRealTimers();
    }
  });

  it('reports an unknown create outcome by 360 seconds and converges with the same client token', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const deferred = createDeferred<string>();
    const service = createChangeRequestService({
      createRecord: () => deferred.promise,
    });
    const request = createChangeRequestInput();
    const document = createChangeDocument();
    const pending = service.createChangeRequest(request, [document]);
    const settled = pending.then(
      () => ({ kind: 'success' as const }),
      (error: { details?: unknown }) => ({
        kind: 'error' as const,
        details:
          typeof error.details === 'string'
            ? (JSON.parse(error.details) as Record<string, unknown>)
            : null,
      }),
    );

    try {
      for (
        let index = 0;
        index < 20 && service.createBitableRecord.mock.calls.length === 0;
        index += 1
      ) {
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
      const firstClientToken =
        service.createBitableRecord.mock.calls[0][5].clientToken;

      await jest.advanceTimersByTimeAsync(360_000);
      const outcome = await Promise.race([
        settled,
        Promise.resolve({ kind: 'pending' as const }),
      ]);
      expect(outcome).toMatchObject({
        kind: 'error',
        details: {
          recordState: 'unknown',
          recordCreated: null,
          documents: [
            expect.objectContaining({
              status: 'uploaded_pending_attach',
              retryable: true,
            }),
          ],
        },
      });

      deferred.resolve('recLate');
      service.createBitableRecord.mockResolvedValueOnce('recLate');
      await expect(
        service.createChangeRequest(request, [document]),
      ).resolves.toMatchObject({ success: true, record: { id: 'recChange1' } });
      expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
      expect(service.createBitableRecord.mock.calls[1][5]).toMatchObject({
        clientToken: firstClientToken,
      });
      expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    } finally {
      deferred.resolve('recLate');
      jest.useRealTimers();
    }
  });

  it('caps change-request upload and create Axios timeouts to the remaining deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, data: { file_token: 'tok-deadline' } },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { record: { record_id: 'recDeadline' } } },
      });
    const service = createServiceWithAxios({ post });

    try {
      await service.uploadBitableAttachment(
        'tenant-token',
        'changeApp',
        createChangeDocument(),
        '变更文档“change-plan.pdf”',
        Date.now() + 4_321,
      );
      await service.createBitableRecord(
        'changeApp',
        'tblChange',
        '计划变更日历',
        { 变更简述: 'deadline test' },
        'tenant-token',
        {
          clientToken: '123e4567-e89b-42d3-a456-426614174000',
          deadlineAt: Date.now() + 7_654,
        },
      );

      expect(post.mock.calls[0][2]).toMatchObject({ timeout: 4_321 });
      expect(post.mock.calls[1][2]).toMatchObject({ timeout: 7_654 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not start an attachment retry when its backoff exceeds the remaining deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const service = createServiceWithAxios({});
    service.sleep = jest.fn(async () => undefined);
    const operation = jest.fn(async () => {
      throw new Error('connect ETIMEDOUT: retryable upload failure');
    });

    try {
      await expect(
        service.runConstructionAttachmentUploadWithRetry(
          operation,
          'deadline.pdf',
          '变更文档“deadline.pdf”',
          Date.now() + 500,
        ),
      ).rejects.toThrow('变更申请同步时间已用尽');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(service.sleep).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('writes conditional meeting fields for a non-standard change', async () => {
    const service = createChangeRequestService();
    await service.createChangeRequest(
      createChangeRequestInput({
        nature: '非标准变更',
        meetingStartAt: '2026-08-02T14:00',
        meetingEndAt: '2026-08-02T15:00',
      }),
      [createChangeDocument()],
    );

    expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
      会议开始时间: new Date('2026-08-02T14:00:00+08:00').getTime(),
      会议结束时间: new Date('2026-08-02T15:00:00+08:00').getTime(),
    });
  });

  it('rejects an incompatible Base field type before uploading or writing', async () => {
    const fieldMetas = createMigratedChangeRequestFieldMetas().map((field) =>
      field.field_id === 'fld0qzcXDh' ? { ...field, type: 1 } : field,
    );
    const service = createChangeRequestService({ fieldMetas });

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [
        createChangeDocument(),
      ]),
    ).rejects.toThrow('“变更文档”字段必须是附件类型');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects a spoofed document before authentication, upload or write', async () => {
    const service = createChangeRequestService();
    const spoofed = {
      ...createChangeDocument(),
      size: 12,
      buffer: Buffer.from('not-a-pdf'),
    };

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [spoofed]),
    ).rejects.toThrow('变更文档内容与文件类型不匹配');
    expect(service.fetchBitableFieldMetas).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects forged OOXML entry strings without a valid ZIP directory', async () => {
    const service = createChangeRequestService();
    const spoofed = {
      ...createChangeDocument('change-plan.docx'),
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 64,
      buffer: Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from('[Content_Types].xml_rels/.relsword/document.xml'),
      ]),
    };

    await expect(
      service.createChangeRequest(createChangeRequestInput(), [spoofed]),
    ).rejects.toThrow('变更文档内容与文件类型不匹配');
    expect(service.fetchBitableFieldMetas).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent change requests with the same mutation id', async () => {
    const deferred = createDeferred<string>();
    const service = createChangeRequestService({
      createRecord: () => deferred.promise,
    });
    const request = createChangeRequestInput();
    const file = createChangeDocument();

    const first = service.createChangeRequest(request, [file]);
    const second = service.createChangeRequest(request, [file]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    deferred.resolve('recChange1');

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('persists the change-request fingerprint across service restarts', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'change-request-ledger-'));
    const request = createChangeRequestInput();
    const document = createChangeDocument();

    try {
      const firstService = createChangeRequestService();
      firstService.changeRequestMutationLedgerDir = ledgerDir;
      const firstResponse = await firstService.createChangeRequest(request, [
        document,
      ]);

      const restartedService = createChangeRequestService();
      restartedService.changeRequestMutationLedgerDir = ledgerDir;
      await expect(
        restartedService.createChangeRequest(request, [document]),
      ).resolves.toEqual(firstResponse);
      expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
      expect(restartedService.fetchBitableRecordById).not.toHaveBeenCalled();

      const conflictingService = createChangeRequestService();
      conflictingService.changeRequestMutationLedgerDir = ledgerDir;
      await expect(
        conflictingService.createChangeRequest(
          { ...request, summary: '同一标识下的不同申请' },
          [document],
        ),
      ).rejects.toThrow('相同 clientMutationId 已用于不同内容');
      expect(conflictingService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(conflictingService.createBitableRecord).not.toHaveBeenCalled();
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('binds a Feishu leave applicant to the actual personnel Open ID before uploading or writing', async () => {
    const readEnvMock = readEnv as jest.MockedFunction<typeof readEnv>;
    readEnvMock.mockImplementation(name => name === 'FEISHU_APP_ID' ? 'cli_fixture' : '');
    try {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      const principal: AccessPrincipal = {
        role: 'site_member', purchaseBuilding: null, displayName: '示例人员008',
        accountId: `feishu-${feishuIdentityFingerprint('cli_fixture', 'ou_other')}`,
      };
      await expect(service.createLeaveRequest(createLeaveRequestInput(), createLeaveScreenshot(), principal))
        .rejects.toThrow('登录账号与申请人员资料不一致');
      expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    } finally {
      readEnvMock.mockImplementation(() => '');
    }
  });

  it('accepts a site member leave whose stable Feishu identity matches the personnel record', async () => {
    const readEnvMock = readEnv as jest.MockedFunction<typeof readEnv>;
    readEnvMock.mockImplementation(name => name === 'FEISHU_APP_ID' ? 'cli_fixture' : '');
    try {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      await expect(service.createLeaveRequest(createLeaveRequestInput(), createLeaveScreenshot(), {
        role: 'site_member', purchaseBuilding: null, displayName: '示例人员008',
        accountId: `feishu-${feishuIdentityFingerprint('cli_fixture', 'ou_zhangsan')}`,
      })).resolves.toMatchObject({ success: true, leaveStaffName: '示例人员008' });
      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
      await expect(service.createLeaveRequest(createLeaveRequestInput(), createLeaveScreenshot(), {
        role: 'site_member', purchaseBuilding: null, displayName: '示例人员008',
        accountId: `feishu-${feishuIdentityFingerprint('cli_fixture', 'ou_other')}`,
      })).rejects.toThrow('登录账号与申请人员资料不一致');
      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    } finally {
      readEnvMock.mockImplementation(() => '');
    }
  });

  it.each(['guest', 'site_member'] as const)('binds an external %s leave to the authenticated personnel record', async (role) => {
    const readEnvMock = readEnv as jest.MockedFunction<typeof readEnv>;
    readEnvMock.mockImplementation(name => name === 'FEISHU_APP_ID' ? 'cli_fixture' : '');
    try {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      const externalPrincipal = (recordId: string): AccessPrincipal => ({
        role, purchaseBuilding: null, displayName: '示例人员008',
        accountId: 'local-external-' + require('node:crypto').createHash('sha256')
          .update(JSON.stringify(['cli_fixture', 'canonicalPersonApp', 'tbl122d1a08645adab', recordId])).digest('hex'),
      });
      await expect(service.createLeaveRequest(createLeaveRequestInput(), createLeaveScreenshot(), externalPrincipal('recPersonLiSi')))
        .rejects.toThrow('登录账号与申请人员资料不一致');
      expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
      await expect(service.createLeaveRequest(createLeaveRequestInput(), createLeaveScreenshot(), externalPrincipal('recPersonZhangSan')))
        .resolves.toMatchObject({ success: true, leaveStaffName: '示例人员008' });
      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    } finally {
      readEnvMock.mockImplementation(() => '');
    }
  });

  it('external name login validates the canonical personnel record instead of the legacy leave profile copy', async () => {
    const readEnvMock = readEnv as jest.MockedFunction<typeof readEnv>;
    readEnvMock.mockImplementation(name => name === 'FEISHU_APP_ID' ? 'cli_fixture' : '');
    try {
      const service = createLeaveRequestService([createLeaveSchedule()], {
        canonicalPersonnelRecords: [{ record_id: 'recCanonicalZhangSan', fields: {
          姓名: '示例人员008', 员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }], '机楼/专业': ['A楼'],
        } }],
      });
      const accountId = 'local-external-' + require('node:crypto').createHash('sha256')
        .update(JSON.stringify(['cli_fixture', 'canonicalPersonApp', 'tbl122d1a08645adab', 'recCanonicalZhangSan'])).digest('hex');
      await expect(service.createLeaveRequest(createLeaveRequestInput(), createLeaveScreenshot(), {
        role: 'guest', purchaseBuilding: null, displayName: '示例人员008', accountId,
      })).resolves.toMatchObject({ success: true, leaveStaffName: '示例人员008' });
      expect(getBitableRecordsMock()).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        appToken: 'canonicalPersonApp', tableId: 'tbl122d1a08645adab', strict: true, allowStale: false,
      }));
      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    } finally { readEnvMock.mockImplementation(() => ''); }
  });

  it('external login cannot fall back to a same-name legacy profile when the canonical person is absent', async () => {
    const readEnvMock = readEnv as jest.MockedFunction<typeof readEnv>;
    readEnvMock.mockImplementation(name => name === 'FEISHU_APP_ID' ? 'cli_fixture' : '');
    try {
      const service = createLeaveRequestService([createLeaveSchedule()], { canonicalPersonnelRecords: [] });
      const accountId = 'local-external-' + require('node:crypto').createHash('sha256')
        .update(JSON.stringify(['cli_fixture', 'canonicalPersonApp', 'tbl122d1a08645adab', 'recCanonicalZhangSan'])).digest('hex');
      await expect(service.createLeaveRequest(createLeaveRequestInput(), createLeaveScreenshot(), {
        role: 'guest', purchaseBuilding: null, displayName: '示例人员008', accountId,
      })).rejects.toThrow('未找到');
      expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    } finally { readEnvMock.mockImplementation(() => ''); }
  });

  it('writes a complete night leave with exact timestamps and authoritative hours', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const leaveRequest = createLeaveRequestInput();
    const expectedFingerprint =
      service.buildLeaveRequestMutationFingerprint(leaveRequest);
    const result = await service.createLeaveRequest(leaveRequest);

    expect(result).toMatchObject({
      success: true,
      total: 1,
      created: 1,
      recordIds: ['recLeave1'],
      startAt: '2026-08-05T18:00',
      endAt: '2026-08-06T09:00',
      leaveStaffName: '示例人员008',
      clientMutationId: 'leave-request-test-1',
      rawHours: 15,
      minimumHours: 15,
      affectedSchedules: [
        expect.objectContaining({
          recordId: 'recNight',
          scheduledHours: 15,
          leaveHours: 15,
          countedHours: 15,
        }),
      ],
      shiftGroups: [
        {
          shiftKey: '2026-08-05T18:00__2026-08-06T09:00',
          scheduleDate: '2026-08-05',
          startAt: '2026-08-05T18:00',
          endAt: '2026-08-06T09:00',
          kind: 'night',
          shift: '夜间值守',
          buildings: ['A楼'],
          teams: ['一班'],
          scheduleRecordIds: ['recNight'],
          leaveHours: 15,
        },
      ],
      excludedSchedules: [],
      missingCalendarYears: [],
      unrecognizedShifts: [],
    });
    expect(service.getMonthlySchedulesFromFeishu).toHaveBeenCalledWith(
      '2026-08-04',
      '2026-08-07',
      true,
      true,
    );
    expect(service.fetchBitableFieldMetas).toHaveBeenCalledWith(
      'leaveApp',
      'tblLeave',
      '请休假替班修正',
      'tenant-token',
    );
    expect(getBitableRecordsMock()).toHaveBeenCalledWith(expect.anything(), {
      appToken: 'leaveApp',
      tableId: 'tblLeave',
      tableName: '请休假替班修正',
      fieldNames: ['请求唯一ID', '请求指纹'],
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: '请求唯一ID',
            operator: 'is',
            value: ['leave-request-test-1'],
          },
        ],
      },
      cacheTtlMs: 0,
      forceRefresh: true,
      strict: true,
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'leaveApp',
      'tblLeave',
      '请休假替班修正',
      {
        休假开始时间: new Date('2026-08-05T18:00:00+08:00').getTime(),
        休假结束时间: new Date('2026-08-06T09:00:00+08:00').getTime(),
        休假类型: '年假',
        请假原因: '年度休假',
        休假人员: [{ id: 'ou_zhangsan' }],
        '休假人员姓名（程序）': '示例人员008',
        需替班人员: [{ id: 'ou_zhangsan' }],
        '是否需要替班（替班打√）': false,
        休假工时数: 15,
        '休假工时数（最低4h）': 15,
        请求唯一ID: 'leave-request-test-1',
        请求指纹: expectedFingerprint,
        系统影响排班记录ID: 'recNight',
        流程截图: [{ file_token: 'tok-leave-process-screenshot' }],
        审批来源: '程序卡片',
        请假工作流状态: '待路由',
      },
      'tenant-token',
      {
        optionalMissingFieldNames: [],
        retryNetworkErrors: true,
        clientToken: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      },
    );
    const fields = service.createBitableRecord.mock.calls[0][3];
    expect(fields).not.toHaveProperty('休假人员（文本）');
    expect(fields).not.toHaveProperty('所属楼栋');
    expect(fields).not.toHaveProperty('班组');
    expect(fields).not.toHaveProperty('班次（有关联）');
    expect(fields).not.toHaveProperty('休假工时（取整）');
    expect(fields).toMatchObject({
      '是否需要替班（替班打√）': false,
    });
    expect(fields).not.toHaveProperty('替班人员（填姓名）');
    expect(fields['休假工时数']).toBe(fields['休假工时数（最低4h）']);
  });

  it('writes the applicant into the current 休假人员 user field', async () => {
    const fieldMetas = createLeaveRequestFieldMetas().filter(
      (field) => field.field_name !== '需替班人员',
    );
    const service = createLeaveRequestService([createLeaveSchedule()], {
      fieldMetas,
    });

    await service.createLeaveRequest(createLeaveRequestInput());

    const fields = service.createBitableRecord.mock.calls[0][3];
    expect(fields).toMatchObject({
      休假人员: [{ id: 'ou_zhangsan' }],
    });
    expect(fields).not.toHaveProperty('需替班人员');
  });

  it('allows a 110 applicant without a Feishu account and keeps the personnel record identity', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recStationWhite',
        scheduleDate: '2026-08-20',
        building: 'station_110',
        buildingText: '110站',
        shift: 'white',
        shiftText: '白班',
        dutyStaffActual: ['示例人员005'],
      }),
    ];
    const service = createLeaveRequestService(schedules, {
      personnelRecords: [
        {
          record_id: 'recPersonBianTianYang',
          fields: {
            姓名: '示例人员005',
            岗位: '110值班人员',
            '机楼/专业': '110站',
            班组: 'B班',
          },
        },
      ],
    });

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-110-no-account',
            leaveStaffName: '示例人员005',
            startAt: '2026-08-20T08:00',
            endAt: '2026-08-20T20:00',
            needSubstitute: false,
            substituteStaffName: '',
          },
          schedules,
        ),
      ),
    ).resolves.toMatchObject({ success: true, leaveStaffName: '示例人员005' });

    const fields = service.createBitableRecord.mock.calls[0][3];
    expect(fields).toMatchObject({
      '休假人员姓名（程序）': '示例人员005',
      '是否需要替班（替班打√）': false,
    });
    expect(fields).not.toHaveProperty('休假人员');
    expect(fields).not.toHaveProperty('需替班人员');
  });

  it.each([false, true])('treats the 110 station shared duty account as no personal Feishu account (Feishu login: %s)', async (feishuLogin) => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recStationNightZhangHua',
        scheduleDate: '2026-09-26',
        building: 'station_110',
        buildingText: '110站',
        team: 'shift_b',
        teamText: 'B班',
        shift: 'night',
        shiftText: '夜班',
        dutyStaffActual: ['张华'],
      }),
    ];
    const service = createLeaveRequestService(schedules, {
      personnelRecords: [
        {
          record_id: 'recPersonZhangHua',
          fields: {
            姓名: '张华',
            员工姓名: [
              {
                id: 'ou_station_110_shared',
                name: '南通基地-110kV变电站值班',
              },
            ],
            岗位: '110站站长',
            '机楼/专业': ['110站'],
            班组: 'B班',
          },
        },
      ],
    });

    const readEnvMock = readEnv as jest.MockedFunction<typeof readEnv>;
    readEnvMock.mockImplementation(name => name === 'FEISHU_APP_ID' ? 'cli_fixture' : '');
    try {
    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-110-shared-account',
            leaveStaffName: '张华',
            startAt: '2026-09-26T20:00',
            endAt: '2026-09-27T08:00',
            needSubstitute: false,
            substituteStaffName: '',
          },
          schedules,
        ),
        undefined,
        feishuLogin ? { role: 'guest', purchaseBuilding: null,
          accountId: `feishu-${feishuIdentityFingerprint('cli_fixture', 'ou_station_110_shared')}`,
          displayName: '南通基地-110kV变电站值班' } : undefined,
      ),
    ).resolves.toMatchObject({ success: true, leaveStaffName: '张华' });

    const fields = service.createBitableRecord.mock.calls[0][3];
    expect(fields).toMatchObject({
      '休假人员姓名（程序）': '张华',
      '是否需要替班（替班打√）': false,
    });
    expect(fields).not.toHaveProperty('休假人员');
    expect(fields).not.toHaveProperty('需替班人员');
    } finally {
      readEnvMock.mockImplementation(() => '');
    }
  });

  it('still rejects a mismatched personal Feishu account outside 110 station', async () => {
    const schedules = [createLeaveSchedule()];
    const service = createLeaveRequestService(schedules, {
      personnelRecords: [
        {
          record_id: 'recPersonZhangSan',
          fields: {
            姓名: '示例人员008',
            员工姓名: [{ id: 'ou_wrong_person', name: '示例人员013' }],
            '机楼/专业': ['A楼'],
          },
        },
      ],
    });

    await expect(
      service.createLeaveRequest(createLeaveRequestInput({}, schedules)),
    ).rejects.toThrow('请休假人员“示例人员008”的飞书账号与姓名不一致');
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: '普通白班',
      schedule: createLeaveSchedule({ shift: 'white', shiftText: '白班' }),
      startAt: '2026-08-05T09:00',
      endAt: '2026-08-05T18:00',
    },
    {
      label: '普通夜班',
      schedule: createLeaveSchedule(),
      startAt: '2026-08-05T18:00',
      endAt: '2026-08-06T09:00',
    },
    {
      label: '110 白班',
      schedule: createLeaveSchedule({
        building: 'station_110',
        buildingText: '110机房',
        shift: 'white',
        shiftText: '白班',
      }),
      startAt: '2026-08-05T08:00',
      endAt: '2026-08-05T20:00',
    },
    {
      label: '110 夜班',
      schedule: createLeaveSchedule({
        building: 'station_110',
        buildingText: '110机房',
        shift: 'night',
        shiftText: '夜班',
      }),
      startAt: '2026-08-05T20:00',
      endAt: '2026-08-06T08:00',
    },
  ])(
    'accepts $label without an applicant-selected substitute',
    async ({ label, schedule, startAt, endAt }) => {
      const schedules = [schedule];
      const service = createLeaveRequestService(schedules);

      await expect(
        service.createLeaveRequest(
          createLeaveRequestInput(
            {
              clientMutationId: `leave-request-required-substitute-${label}`,
              startAt,
              endAt,
              needSubstitute: false,
              substituteStaffName: '',
            },
            schedules,
          ),
        ),
      ).resolves.toMatchObject({ success: true });
      expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
        '是否需要替班（替班打√）': false,
      });
      expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
        '替班人员（填姓名）',
      );
    },
  );

  it.each([
    {
      label: '前一夜班',
      candidateSchedule: createLeaveSchedule({
        recordId: 'recPreviousNight',
        scheduleDate: '2026-08-04',
        dutyStaffActual: ['示例人员013'],
      }),
    },
    {
      label: '后一夜班',
      candidateSchedule: createLeaveSchedule({
        recordId: 'recNextNight',
        dutyStaffActual: ['示例人员013'],
      }),
    },
  ])(
    'ignores an applicant-supplied substitute assigned to the $label',
    async ({ label, candidateSchedule }) => {
      const schedules = [
        createLeaveSchedule({ shift: 'white', shiftText: '白班' }),
        candidateSchedule,
      ];
      const service = createLeaveRequestService(schedules);

      await expect(
        service.createLeaveRequest(
          createLeaveRequestInput(
            {
              clientMutationId: `leave-request-adjacent-night-${label}`,
              startAt: '2026-08-05T09:00',
              endAt: '2026-08-05T18:00',
              needSubstitute: false,
              substituteStaffName: '示例人员013',
            },
            schedules,
          ),
        ),
      ).resolves.toMatchObject({ success: true });
      expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
        '是否需要替班（替班打√）': false,
      });
      expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
        '替班人员（填姓名）',
      );
    },
  );

  it('allows a long-white-only leave without a substitute', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recLongWhite',
        scheduleDate: '2026-08-03',
        team: 'long_white',
        teamText: '长白',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-long-white-without-substitute',
            startAt: '2026-08-03T09:00',
            endAt: '2026-08-03T18:00',
            needSubstitute: false,
            substituteStaffName: '',
          },
          schedules,
        ),
      ),
    ).resolves.toMatchObject({ success: true, rawHours: 8 });
    expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
      '是否需要替班（替班打√）': false,
    });
  });

  it('normalizes a forged true substitute flag with an empty name for long-white leave', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recLongWhiteForgedEmpty',
        scheduleDate: '2026-08-03',
        team: 'long_white',
        teamText: '长白',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-long-white-forged-empty',
            startAt: '2026-08-03T09:00',
            endAt: '2026-08-03T18:00',
            needSubstitute: true,
            substituteStaffName: '',
          },
          schedules,
        ),
      ),
    ).resolves.toMatchObject({ success: true });
    const fields = service.createBitableRecord.mock.calls[0][3];
    expect(fields).toMatchObject({
      '是否需要替班（替班打√）': false,
    });
    expect(fields).not.toHaveProperty('替班人员（填姓名）');
  });

  it('ignores a forged self substitute for long-white leave', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recLongWhiteForgedSelf',
        scheduleDate: '2026-08-03',
        team: 'long_white',
        teamText: '长白',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-long-white-forged-self',
            startAt: '2026-08-03T09:00',
            endAt: '2026-08-03T18:00',
            needSubstitute: true,
            substituteStaffName: '示例人员008',
          },
          schedules,
        ),
      ),
    ).resolves.toMatchObject({ success: true });
    const fields = service.createBitableRecord.mock.calls[0][3];
    expect(fields).toMatchObject({
      '是否需要替班（替班打√）': false,
    });
    expect(fields).not.toHaveProperty('替班人员（填姓名）');
  });

  it('ignores an applicant-supplied substitute for a duty leave', async () => {
    const schedules = [createLeaveSchedule()];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-authoritative-substitute-flag',
            needSubstitute: false,
            substituteStaffName: '  示例人员013  ',
          },
          schedules,
        ),
      ),
    ).resolves.toMatchObject({ success: true });

    expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
      '是否需要替班（替班打√）': false,
    });
    expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
      '替班人员（填姓名）',
    );
    const personnelReads = getBitableRecordsMock().mock.calls.filter(
      ([, read]) => read.tableId === 'tblLeavePerson',
    );
    expect(personnelReads).toHaveLength(1);
  });

  it('ignores the applicant when supplied as their own substitute', async () => {
    const schedules = [createLeaveSchedule()];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-self-substitute',
            needSubstitute: false,
            substituteStaffName: '示例人员008',
          },
          schedules,
        ),
      ),
    ).resolves.toMatchObject({ success: true });
    expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
      '替班人员（填姓名）',
    );
  });

  it('ignores an applicant-supplied substitute with an overlapping shift', async () => {
    const schedules = [
      createLeaveSchedule({ shift: 'white', shiftText: '白班' }),
      createLeaveSchedule({
        recordId: 'recOtherBuildingWhite',
        building: 'building_b',
        buildingText: 'B楼',
        shift: 'white',
        shiftText: '白班',
        dutyStaffActual: ['示例人员013'],
      }),
    ];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-cross-building-substitute',
            startAt: '2026-08-05T09:00',
            endAt: '2026-08-05T18:00',
            needSubstitute: false,
            substituteStaffName: '示例人员013',
          },
          schedules,
        ),
      ),
    ).resolves.toMatchObject({ success: true });
    expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
      '替班人员（填姓名）',
    );
  });

  it.each([
    {
      label: '人员表不存在',
      substituteStaffName: '示例人员017',
      personnelRecords: [
        {
          record_id: 'recPersonZhangSan',
          fields: {
            姓名: '示例人员008',
            员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
          },
        },
      ],
      error: '请休假人员资料中未找到替班人员“示例人员017”',
    },
    {
      label: '人员表重复',
      substituteStaffName: '示例人员013',
      personnelRecords: [
        {
          record_id: 'recPersonZhangSan',
          fields: {
            姓名: '示例人员008',
            员工姓名: [{ id: 'ou_zhangsan', name: '示例人员008' }],
          },
        },
        {
          record_id: 'recPersonLiSi1',
          fields: {
            姓名: '示例人员013',
            员工姓名: [{ id: 'ou_lisi_1', name: '示例人员013' }],
          },
        },
        {
          record_id: 'recPersonLiSi2',
          fields: {
            姓名: '示例人员013',
            员工姓名: [{ id: 'ou_lisi_2', name: '示例人员013' }],
          },
        },
      ],
      error: '请休假人员资料中存在多个替班人员“示例人员013”，请先在人员表中完成去重',
    },
  ])(
    'does not resolve an applicant-supplied substitute when $label',
    async ({ label, substituteStaffName, personnelRecords }) => {
      const schedules = [createLeaveSchedule()];
      const service = createLeaveRequestService(schedules, {
        personnelRecords,
      });

      await expect(
        service.createLeaveRequest(
          createLeaveRequestInput(
            {
              clientMutationId: `leave-request-substitute-personnel-${label}`,
              needSubstitute: false,
              substituteStaffName,
            },
            schedules,
          ),
        ),
      ).resolves.toMatchObject({ success: true });
      expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
        '替班人员（填姓名）',
      );
    },
  );

  it('lets the dedicated leave personnel table environment override the default source URL table', () => {
    const previousTableId = process.env.FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID;
    process.env.FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID = 'tbldef80a4eea3ec35e37';
    const readEnvMock = readEnv as jest.MockedFunction<typeof readEnv>;
    readEnvMock.mockImplementation((name) => process.env[name]?.trim() || '');
    try {
      const service = createServiceWithAxios({});
      expect((service as any).leavePersonProfileConfig.tableId).toBe(
        'tbldef80a4eea3ec35e37',
      );
    } finally {
      if (previousTableId === undefined) {
        delete process.env.FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID;
      } else {
        process.env.FEISHU_LEAVE_PERSON_PROFILE_TABLE_ID = previousTableId;
      }
      readEnvMock.mockImplementation(() => '');
    }
  });

  it('requires one real screenshot before creating a leave request', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-missing-screenshot',
    });

    await expect(
      (
        DutyScheduleService.prototype as unknown as {
          createLeaveRequest: (
            input: LeaveRequestCreateRequest,
            screenshot?: ReturnType<typeof createLeaveScreenshot>,
          ) => Promise<unknown>;
        }
      ).createLeaveRequest.call(service, request, undefined),
    ).rejects.toThrow('请上传流程截图');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects an oversized leave reason before external reads or writes', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-oversized-reason',
      leaveReason: '假'.repeat(2001),
    });

    await expect(service.createLeaveRequest(request)).rejects.toThrow(
      '请假原因不能超过 2000 个字符',
    );
    expect(getBitableRecordsMock()).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects a screenshot whose declared image type does not match its file signature', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-spoofed-screenshot',
    });
    const spoofedScreenshot = createLeaveScreenshot({
      originalname: 'spoofed.png',
      mimetype: 'image/png',
      buffer: Buffer.from('not-a-real-image'),
      size: Buffer.byteLength('not-a-real-image'),
    });

    await expect(
      service.createLeaveRequest(request, spoofedScreenshot),
    ).rejects.toThrow('截图文件内容与格式不匹配');
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('uploads the required screenshot and writes its file token to the real Base attachment field', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const screenshot = createLeaveScreenshot();
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-with-screenshot',
    });

    await expect(
      service.createLeaveRequest(request, screenshot),
    ).resolves.toMatchObject({ success: true, created: 1 });
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.uploadBitableAttachment).toHaveBeenCalledWith(
      'tenant-token',
      'leaveApp',
      screenshot,
      '请休假流程截图',
    );
    expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
      流程截图: [{ file_token: 'tok-leave-process-screenshot' }],
    });
    expect(getBitableRecordsMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'leavePersonApp',
        tableId: 'tblLeavePerson',
        viewId: undefined,
        fieldNames: ['姓名', '员工姓名', '机楼/专业', '班组', '岗位', '班次'],
        forceRefresh: true,
        strict: true,
        allowStale: false,
      }),
    );
  });

  it('reports a machine-readable definitely-not-written result when leave personnel lookup fails', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()], {
      personnelLookupError: new Error('strict leave personnel lookup failed'),
    });

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-personnel-lookup-failed',
        }),
      ),
    ).rejects.toMatchObject({
      status: 502,
      response: {
        writeDisposition: 'definitely-not-written',
      },
    });
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('does not create a leave record when the required screenshot upload fails', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    service.uploadBitableAttachment.mockRejectedValueOnce(
      Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }),
    );

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-screenshot-upload-failed',
        }),
      ),
    ).rejects.toMatchObject({
      status: 502,
      response: {
        message:
          expect.stringContaining('流程截图上传失败，尚未建立请休假记录'),
        writeDisposition: 'definitely-not-written',
      },
    });
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('includes screenshot content in the leave request idempotency fingerprint', () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-screenshot-fingerprint',
    });
    const first = createLeaveScreenshot();
    const second = createLeaveScreenshot({
      buffer: Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
      ]),
      originalname: 'leave-process.jpg',
      mimetype: 'image/jpeg',
      size: 10,
    });

    expect(
      service.buildLeaveRequestMutationFingerprint(request, first),
    ).not.toBe(service.buildLeaveRequestMutationFingerprint(request, second));
  });

  it('requires the real 流程截图 attachment field in the leave Base schema', async () => {
    const missingFieldService = createLeaveRequestService(
      [createLeaveSchedule()],
      {
        fieldMetas: createLeaveRequestFieldMetas().filter(
          (field) => field.field_name !== '流程截图',
        ),
      },
    );
    await expect(
      missingFieldService.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-missing-screenshot-field',
        }),
      ),
    ).rejects.toThrow('请休假多维表未找到“流程截图”字段');

    const wrongTypeService = createLeaveRequestService(
      [createLeaveSchedule()],
      {
        fieldMetas: createLeaveRequestFieldMetas().map((field) =>
          field.field_name === '流程截图' ? { ...field, type: 1 } : field,
        ),
      },
    );
    await expect(
      wrongTypeService.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-wrong-screenshot-field',
        }),
      ),
    ).rejects.toThrow('请休假多维表“流程截图”字段必须是附件类型');
  });

  it('maps distinct mutation ids to distinct UUIDv4 Bitable client tokens', () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const standardToken = service.toLeaveRequestBitableClientToken(
      `leave-request-${uuid}`,
    );
    const prefixedToken = service.toLeaveRequestBitableClientToken(
      `prefix-leave-request-${uuid}`,
    );
    const bareToken = service.toLeaveRequestBitableClientToken(uuid);

    expect(standardToken).toBe(uuid);
    expect(prefixedToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(bareToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(prefixedToken).not.toBe(standardToken);
    expect(bareToken).not.toBe(standardToken);
    expect(prefixedToken).not.toBe(bareToken);
  });

  it('returns the persisted Base record for the same mutation after a service restart', async () => {
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-persisted-replay',
    });
    const fingerprintService = createLeaveRequestService([
      createLeaveSchedule(),
    ]);
    const fingerprint =
      fingerprintService.buildLeaveRequestMutationFingerprint(request);
    const restartedService = createLeaveRequestService(
      [createLeaveSchedule({ shiftText: '排班后来已变化' })],
      {
        leaveRecords: [
          {
            record_id: 'recPersistedLeave',
            fields: {
              请求唯一ID: request.clientMutationId,
              请求指纹: fingerprint,
            },
          },
        ],
        personnelRecords: [],
      },
    );

    await expect(
      restartedService.createLeaveRequest(request),
    ).resolves.toMatchObject({
      success: true,
      total: 1,
      created: 0,
      recordIds: ['recPersistedLeave'],
      clientMutationId: request.clientMutationId,
      rawHours: 15,
      minimumHours: 15,
    });
    expect(
      restartedService.getMonthlySchedulesFromFeishu,
    ).not.toHaveBeenCalled();
    expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
    expect(getBitableRecordsMock()).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: 'tblLeavePerson' }),
    );
  });

  it('rejects a persisted mutation id reused with different leave content', async () => {
    const originalRequest = createLeaveRequestInput({
      clientMutationId: 'leave-request-persisted-conflict',
    });
    const fingerprintService = createLeaveRequestService([
      createLeaveSchedule(),
    ]);
    const originalFingerprint =
      fingerprintService.buildLeaveRequestMutationFingerprint(originalRequest);
    const restartedService = createLeaveRequestService(
      [createLeaveSchedule()],
      {
        leaveRecords: [
          {
            record_id: 'recPersistedConflict',
            fields: {
              请求唯一ID: originalRequest.clientMutationId,
              请求指纹: originalFingerprint,
            },
          },
        ],
      },
    );

    await expect(
      restartedService.createLeaveRequest({
        ...originalRequest,
        leaveReason: '更改后的请假原因',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      restartedService.createLeaveRequest({
        ...originalRequest,
        leaveReason: '更改后的请假原因',
      }),
    ).rejects.toThrow('clientMutationId 重复但请休假内容不同');
    expect(
      restartedService.getMonthlySchedulesFromFeishu,
    ).not.toHaveBeenCalled();
    expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
    expect(getBitableRecordsMock()).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: 'tblLeavePerson' }),
    );
  });

  it('fails closed when the persisted leave-request lookup fails', async () => {
    const lookupError = new Error('strict persisted lookup failed');
    const service = createLeaveRequestService([createLeaveSchedule()], {
      leaveLookupError: lookupError,
    });

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-persisted-lookup-failed',
        }),
      ),
    ).rejects.toBe(lookupError);
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
    expect(getBitableRecordsMock()).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tableId: 'tblLeavePerson' }),
    );
  });

  it('fails closed when Base contains duplicate persisted mutation ids', async () => {
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-persisted-duplicate',
    });
    const fingerprintService = createLeaveRequestService([
      createLeaveSchedule(),
    ]);
    const fingerprint =
      fingerprintService.buildLeaveRequestMutationFingerprint(request);
    const service = createLeaveRequestService([createLeaveSchedule()], {
      leaveRecords: ['recDuplicateLeave1', 'recDuplicateLeave2'].map(
        (recordId) => ({
          record_id: recordId,
          fields: {
            请求唯一ID: request.clientMutationId,
            请求指纹: fingerprint,
          },
        }),
      ),
    });

    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.createLeaveRequest(request)).rejects.toThrow(
      '存在多个相同请求唯一ID',
    );
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'missing request id field',
      fieldName: '请求唯一ID',
      fieldMetas: createLeaveRequestFieldMetas().filter(
        (field) => field.field_name !== '请求唯一ID',
      ),
      error: '请休假多维表未找到“请求唯一ID”字段',
    },
    {
      label: 'non-text request id field',
      fieldName: '请求唯一ID',
      fieldMetas: createLeaveRequestFieldMetas().map((field) =>
        field.field_name === '请求唯一ID' ? { ...field, type: 2 } : field,
      ),
      error: '请休假多维表“请求唯一ID”字段必须是文本类型',
    },
    {
      label: 'missing fingerprint field',
      fieldName: '请求指纹',
      fieldMetas: createLeaveRequestFieldMetas().filter(
        (field) => field.field_name !== '请求指纹',
      ),
      error: '请休假多维表未找到“请求指纹”字段',
    },
    {
      label: 'non-text fingerprint field',
      fieldName: '请求指纹',
      fieldMetas: createLeaveRequestFieldMetas().map((field) =>
        field.field_name === '请求指纹' ? { ...field, type: 2 } : field,
      ),
      error: '请休假多维表“请求指纹”字段必须是文本类型',
    },
  ])('fails closed for $label', async ({ fieldMetas, error }) => {
    const service = createLeaveRequestService([createLeaveSchedule()], {
      fieldMetas,
    });

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: `leave-request-schema-${error}`,
        }),
      ),
    ).rejects.toThrow(error);
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'hours',
      expectedImpact: {
        ...createExpectedLeaveImpact(),
        rawHours: 8,
        minimumHours: 8,
      },
    },
    {
      label: 'affected schedules',
      expectedImpact: {
        ...createExpectedLeaveImpact(),
        affectedSchedules: [
          {
            ...createExpectedLeaveImpact().affectedSchedules[0],
            recordId: 'recOther',
          },
        ],
      },
    },
    {
      label: 'shift details',
      expectedImpact: {
        ...createExpectedLeaveImpact(),
        affectedSchedules: [
          {
            ...createExpectedLeaveImpact().affectedSchedules[0],
            shift: '白班',
          },
        ],
      },
    },
  ])(
    'rejects a stale client preview when authoritative $label changed',
    async ({ label, expectedImpact }) => {
      const service = createLeaveRequestService([createLeaveSchedule()]);

      const submission = service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: `leave-request-stale-${label}`,
          expectedImpact,
        }),
      );
      await expect(submission).rejects.toMatchObject({ status: 409 });
      await expect(submission).rejects.toThrow('排班已发生变化');
      await expect(submission).rejects.toMatchObject({
        response: {
          latestImpact: createExpectedLeaveImpact(),
          writeDisposition: 'definitely-not-written',
        },
      });

      expectStrictLeaveRequestLookup(`leave-request-stale-${label}`);
      expect(service.fetchBitableFieldMetas).toHaveBeenCalledTimes(1);
      expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    },
  );

  it('rejects a malformed preview before reading schedules or writing', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-malformed-preview',
          expectedImpact: {} as never,
        }),
      ),
    ).rejects.toThrow('请休假请求缺少有效的排班工时预览');

    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(getBitableRecordsMock()).not.toHaveBeenCalled();
    expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('includes the prior-day night shift for an early-month leave', async () => {
    const schedules = [
      createLeaveSchedule({
        recordId: 'recPreviousMonthNight',
        scheduleDate: '2026-07-31',
        shiftText: '夜班',
      }),
    ];
    const service = createLeaveRequestService(schedules);

    const result = await service.createLeaveRequest(
      createLeaveRequestInput(
        {
          clientMutationId: 'leave-request-month-start',
          startAt: '2026-08-01T00:00',
          endAt: '2026-08-01T04:00',
        },
        schedules,
      ),
    );

    expect(result).toMatchObject({
      rawHours: 4,
      minimumHours: 4,
      affectedSchedules: [
        expect.objectContaining({
          recordId: 'recPreviousMonthNight',
          leaveHours: 4,
          countedHours: 4,
        }),
      ],
    });
    expect(service.getMonthlySchedulesFromFeishu).toHaveBeenCalledWith(
      '2026-07-31',
      '2026-08-02',
      true,
      true,
    );
  });

  it('fails closed when the authoritative schedule refresh fails', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    service.getMonthlySchedulesFromFeishu.mockRejectedValueOnce(
      new Error('authoritative schedule refresh failed'),
    );

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-authoritative-refresh-failed',
        }),
      ),
    ).rejects.toThrow('authoritative schedule refresh failed');

    expectStrictLeaveRequestLookup(
      'leave-request-authoritative-refresh-failed',
    );
    expect(service.fetchBitableFieldMetas).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('uses a strict Bitable read for an authoritative schedule refresh', async () => {
    const service = createServiceWithAxios({});
    (service as any).scheduleAppToken = 'scheduleApp';
    (service as any).scheduleTableId = 'tblSchedule';
    getBitableRecordsMock().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await (service as any).getMonthlySchedulesFromFeishu(
      '2026-08-01',
      '2026-08-31',
      true,
      true,
    );

    expect(getBitableRecordsMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        forceRefresh: true,
        strict: true,
      }),
    );
  });

  it('serves normal monthly schedule reads from the local snapshot and reserves Feishu for explicit refresh', async () => {
    const service = createServiceWithAxios({});
    const cachedSchedules = [
      createLeaveSchedule({
        recordId: 'recCachedMonth',
        scheduleDate: '2026-08-05',
      }),
    ];
    service.getMonthlySchedulesFromLocalCache = jest
      .fn()
      .mockResolvedValue(cachedSchedules);
    service.getMonthlySchedulesFromFeishu = jest
      .fn()
      .mockResolvedValue(cachedSchedules);

    await expect(service.getMonthlySchedules(2026, 8)).resolves.toEqual(
      cachedSchedules,
    );
    expect(service.getMonthlySchedulesFromLocalCache).toHaveBeenCalledWith(
      '2026-08-01',
      '2026-08-31',
    );
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();

    await service.getMonthlySchedules(2026, 8, true);
    expect(service.getMonthlySchedulesFromFeishu).toHaveBeenCalledWith(
      '2026-08-01',
      '2026-08-31',
      true,
      true,
    );
  });

  it.each([
    {
      label: 'minute-level start',
      startAt: '2026-08-05T18:30',
      endAt: '2026-08-06T09:00',
      error: '休假开始时间格式无效，仅支持 YYYY-MM-DDTHH:00 整点',
    },
    {
      label: 'minute-level end',
      startAt: '2026-08-05T18:00',
      endAt: '2026-08-06T09:30',
      error: '休假结束时间格式无效，仅支持 YYYY-MM-DDTHH:00 整点',
    },
    {
      label: 'non-increasing range',
      startAt: '2026-08-05T18:00',
      endAt: '2026-08-05T18:00',
      error: '休假结束时间必须晚于开始时间',
    },
  ])('rejects $label before writing', async ({ startAt, endAt, error }) => {
    const service = createLeaveRequestService([createLeaveSchedule()]);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: `leave-request-invalid-${startAt}-${endAt}`,
          startAt,
          endAt,
        }),
      ),
    ).rejects.toThrow(error);
    expect(service.getMonthlySchedulesFromFeishu).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects a real three-hour impact instead of raising it to four', async () => {
    const schedules = [
      createLeaveSchedule({ shift: 'white', shiftText: '白班' }),
    ];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-three-hours',
            startAt: '2026-08-05T09:00',
            endAt: '2026-08-05T12:00',
          },
          schedules,
        ),
      ),
    ).rejects.toThrow('休假工时不足 4 小时');
    expectStrictLeaveRequestLookup('leave-request-three-hours');
    expect(service.getFeishuTenantAccessToken).toHaveBeenCalledTimes(1);
    expect(service.fetchBitableFieldMetas).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'long-white rest-day start',
      schedules: [
        createLeaveSchedule({
          recordId: 'recLongWhiteSunday',
          scheduleDate: '2026-08-02',
          team: 'long_white',
          teamText: '长白',
          shift: 'white',
          shiftText: '白班',
        }),
        createLeaveSchedule({
          recordId: 'recLongWhiteMonday',
          scheduleDate: '2026-08-03',
          team: 'long_white',
          teamText: '长白',
          shift: 'white',
          shiftText: '白班',
        }),
      ],
      startAt: '2026-08-02T09:00',
      endAt: '2026-08-03T18:00',
      error: '休假开始时间不在该人员的实际排班时段内',
    },
    {
      label: 'night-shift after-hours end',
      schedules: [createLeaveSchedule()],
      startAt: '2026-08-05T18:00',
      endAt: '2026-08-06T10:00',
      error: '休假结束时间不在该人员的实际排班时段内',
    },
  ])(
    'rejects a $label even when the range overlaps enough scheduled hours',
    async ({ label, schedules, startAt, endAt, error }) => {
      const service = createLeaveRequestService(schedules);

      await expect(
        service.createLeaveRequest(
          createLeaveRequestInput(
            {
              clientMutationId: `leave-request-boundary-${label}`,
              startAt,
              endAt,
            },
            schedules,
          ),
        ),
      ).rejects.toThrow(error);
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    },
  );

  it('rejects an unrecognized shift before writing', async () => {
    const schedules = [
      createLeaveSchedule({ shift: 'middle', shiftText: '中班' }),
    ];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-unknown-shift',
            startAt: '2026-08-05T09:00',
            endAt: '2026-08-05T18:00',
          },
          schedules,
        ),
      ),
    ).rejects.toThrow('存在无法识别的班次：中班 / middle');
    expectStrictLeaveRequestLookup('leave-request-unknown-shift');
    expect(service.getFeishuTenantAccessToken).toHaveBeenCalledTimes(1);
    expect(service.fetchBitableFieldMetas).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('rejects long-white leave when annual calendar data is missing', async () => {
    const schedules = [
      createLeaveSchedule({
        scheduleDate: '2027-08-02',
        team: 'long_white',
        teamText: '长白班',
        shift: 'white',
        shiftText: '白班',
      }),
    ];
    const service = createLeaveRequestService(schedules);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput(
          {
            clientMutationId: 'leave-request-calendar-missing',
            startAt: '2027-08-02T09:00',
            endAt: '2027-08-02T18:00',
          },
          schedules,
        ),
      ),
    ).rejects.toThrow('缺少 2027 年工作日历，不能提交请休假');
    expectStrictLeaveRequestLookup('leave-request-calendar-missing');
    expect(service.getFeishuTenantAccessToken).toHaveBeenCalledTimes(1);
    expect(service.fetchBitableFieldMetas).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('deduplicates truly concurrent writes with the same payload', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const deferredRecordId = createDeferred<string>();
    service.createBitableRecord
      .mockReset()
      .mockImplementation(() => deferredRecordId.promise);
    const leaveRequest = createLeaveRequestInput({
      clientMutationId: 'leave-request-idempotent',
    });

    const firstPromise = service.createLeaveRequest(leaveRequest);
    await waitForCondition(
      () => service.createBitableRecord.mock.calls.length === 1,
      'the first leave-request write to start',
    );
    const concurrentPromise = service.createLeaveRequest(leaveRequest);

    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    deferredRecordId.resolve('recConcurrentLeave');
    const [first, concurrent] = await Promise.all([
      firstPromise,
      concurrentPromise,
    ]);

    expect(concurrent).toEqual(first);
    expect(first.recordIds).toEqual(['recConcurrentLeave']);
    const completedReplay = await service.createLeaveRequest(leaveRequest);
    expect(completedReplay).toEqual(first);
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a retry that only changes the ignored client substitute flag', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-idempotent-ignored-substitute-flag',
      needSubstitute: false,
    });

    const first = await service.createLeaveRequest(request);
    const replay = await service.createLeaveRequest({
      ...request,
      needSubstitute: true,
      substituteStaffName: '申请端无效替班值',
    });

    expect(replay).toEqual(first);
    expect(first.recordIds).toEqual(['recLeave1']);
    expect(service.createBitableRecord.mock.calls[0][3]).toMatchObject({
      '是否需要替班（替班打√）': false,
    });
    expect(service.createBitableRecord.mock.calls[0][3]).not.toHaveProperty(
      '替班人员（填姓名）',
    );
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects a different screenshot while the original mutation is still in flight', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const deferredRecordId = createDeferred<string>();
    service.createBitableRecord
      .mockReset()
      .mockImplementation(() => deferredRecordId.promise);
    const leaveRequest = createLeaveRequestInput({
      clientMutationId: 'leave-request-screenshot-in-flight-conflict',
    });
    const originalScreenshot = createLeaveScreenshot();
    const changedScreenshot = createLeaveScreenshot({
      originalname: 'leave-process.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      size: 4,
    });

    const firstPromise = service.createLeaveRequest(
      leaveRequest,
      originalScreenshot,
    );
    await waitForCondition(
      () => service.createBitableRecord.mock.calls.length === 1,
      'the original leave-request screenshot write to start',
    );
    await expect(
      service.createLeaveRequest(leaveRequest, changedScreenshot),
    ).rejects.toThrow('clientMutationId 重复但请休假内容不同');
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);

    deferredRecordId.resolve('recOriginalScreenshotLeave');
    await expect(firstPromise).resolves.toMatchObject({
      recordIds: ['recOriginalScreenshotLeave'],
    });
  });

  it('rejects a changed hour while the original mutation is still in flight', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const deferredRecordId = createDeferred<string>();
    service.createBitableRecord
      .mockReset()
      .mockImplementation(() => deferredRecordId.promise);
    const leaveRequest = createLeaveRequestInput({
      clientMutationId: 'leave-request-in-flight-conflict',
    });

    const firstPromise = service.createLeaveRequest(leaveRequest);
    await waitForCondition(
      () => service.createBitableRecord.mock.calls.length === 1,
      'the original leave-request write to start',
    );
    await expect(
      service.createLeaveRequest({
        ...leaveRequest,
        startAt: '2026-08-05T19:00',
      }),
    ).rejects.toThrow('clientMutationId 重复但请休假内容不同');
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    deferredRecordId.resolve('recOriginalLeave');
    await expect(firstPromise).resolves.toMatchObject({
      recordIds: ['recOriginalLeave'],
    });
  });

  it('reconciles an ambiguous write from Base without posting a second record', async () => {
    getInvalidateBitableRecordCacheMock().mockClear();
    const persistedRecords: Array<Record<string, unknown>> = [];
    const service = createLeaveRequestService([createLeaveSchedule()], {
      leaveRecords: persistedRecords,
    });
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-ambiguous-reconcile',
    });
    const fingerprint = service.buildLeaveRequestMutationFingerprint(request);
    service.createBitableRecord.mockReset().mockRejectedValue(
      Object.assign(new Error('请休假替班修正写入失败: socket timeout'), {
        code: 'ETIMEDOUT',
      }),
    );

    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
    });
    persistedRecords.push({
      record_id: 'recRecoveredLeave',
      fields: {
        请求唯一ID: request.clientMutationId,
        请求指纹: fingerprint,
      },
    });

    await expect(service.createLeaveRequest(request)).resolves.toMatchObject({
      success: true,
      created: 0,
      recordIds: ['recRecoveredLeave'],
      clientMutationId: request.clientMutationId,
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(getInvalidateBitableRecordCacheMock()).toHaveBeenCalledWith({
      appToken: 'leaveApp',
      tableId: 'tblLeave',
    });
  });

  it('recovers an ambiguous first response by immediately reading the persisted Base record', async () => {
    getInvalidateBitableRecordCacheMock().mockClear();
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-immediate-reconcile',
    });
    const fingerprint = service.buildLeaveRequestMutationFingerprint(request);
    let leaveLookupCount = 0;
    getBitableRecordsMock().mockImplementation(
      async (_httpService: unknown, read: { tableId?: string }) => {
        if (read.tableId === 'tblLeave') {
          leaveLookupCount += 1;
          return leaveLookupCount === 1
            ? []
            : [
                {
                  record_id: 'recImmediateRecoveredLeave',
                  fields: {
                    请求唯一ID: request.clientMutationId,
                    请求指纹: fingerprint,
                  },
                },
              ];
        }
        if (read.tableId === 'tblLeavePerson') {
          return createDefaultLeavePersonnelRecords();
        }
        return [];
      },
    );
    service.createBitableRecord.mockReset().mockRejectedValue(
      Object.assign(new Error('请休假替班修正写入失败: socket timeout'), {
        code: 'ETIMEDOUT',
      }),
    );

    await expect(service.createLeaveRequest(request)).resolves.toMatchObject({
      success: true,
      created: 0,
      recordIds: ['recImmediateRecoveredLeave'],
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    expect(leaveLookupCount).toBe(2);
    expect(getInvalidateBitableRecordCacheMock()).toHaveBeenCalledWith({
      appToken: 'leaveApp',
      tableId: 'tblLeave',
    });
  });

  it.each([
    {
      label: 'network timeout',
      createError: () =>
        Object.assign(new Error('请休假替班修正写入失败: socket timeout'), {
          code: 'ETIMEDOUT',
        }),
    },
    {
      label: 'success without a record id',
      createError: () => new Error('请休假替班修正写入成功但未返回记录 ID'),
    },
  ])(
    'safely replays an ambiguous $label result with the same client token',
    async ({ createError }) => {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      const request = createLeaveRequestInput({
        clientMutationId: `leave-request-ambiguous-${createError().message}`,
      });
      service.createBitableRecord
        .mockReset()
        .mockRejectedValueOnce(createError())
        .mockResolvedValueOnce('recSafelyReplayedLeave');

      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      await expect(service.createLeaveRequest(request)).resolves.toMatchObject({
        success: true,
        created: 1,
        recordIds: ['recSafelyReplayedLeave'],
      });
      expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
      expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
      const clientTokens = service.createBitableRecord.mock.calls.map(
        (call: unknown[]) => (call[5] as { clientToken?: string }).clientToken,
      );
      expect(clientTokens).toEqual([clientTokens[0], clientTokens[0]]);
      expect(service.createBitableRecord.mock.calls[1][3]).toEqual(
        service.createBitableRecord.mock.calls[0][3],
      );
      expect(
        service.leaveRequestPreparedWriteExpiryTimers.has(
          request.clientMutationId,
        ),
      ).toBe(false);
    },
  );

  it('coalesces concurrent retries of an unknown leave write', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-unknown-concurrent-retry',
    });
    const deferredLookup = createDeferred<Array<Record<string, unknown>>>();
    let leaveLookupCount = 0;
    getBitableRecordsMock().mockImplementation(
      async (_httpService: unknown, read: { tableId?: string }) => {
        if (read.tableId === 'tblLeave') {
          leaveLookupCount += 1;
          return leaveLookupCount === 3 ? deferredLookup.promise : [];
        }
        if (read.tableId === 'tblLeavePerson') {
          return createDefaultLeavePersonnelRecords();
        }
        return [];
      },
    );
    service.createBitableRecord
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
      )
      .mockResolvedValueOnce('recConcurrentUnknownRetry');

    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
    });
    const firstRetry = service.createLeaveRequest(request);
    for (let index = 0; index < 20 && leaveLookupCount < 3; index += 1) {
      await Promise.resolve();
    }
    expect(leaveLookupCount).toBe(3);
    const concurrentRetry = service.createLeaveRequest(request);
    deferredLookup.resolve([]);

    const [firstResponse, concurrentResponse] = await Promise.all([
      firstRetry,
      concurrentRetry,
    ]);
    expect(concurrentResponse).toEqual(firstResponse);
    expect(firstResponse.recordIds).toEqual(['recConcurrentUnknownRetry']);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
  });

  it('never washes out a historical unknown write with a later explicit rejection', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-unknown-then-rejected',
    });
    service.createBitableRecord
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
      )
      .mockRejectedValueOnce(new Error('field schema rejected'));

    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
    });
    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
      message: expect.stringContaining('请休假写入结果未知'),
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
  });

  it('drops an unknown leave prepared payload after 24 hours and becomes reconcile-only', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-expired-prepared-write',
    });
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    service.createBitableRecord
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
      );

    try {
      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      const unknownEntry = service.leaveRequestMutationUnknown.get(
        request.clientMutationId,
      );
      expect(unknownEntry.replayState.preparedWrite).toBeDefined();

      dateNow.mockReturnValue(24 * 60 * 60 * 1000 + 1_001);
      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });

      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
      expect(unknownEntry.replayState.preparedWrite).toBeUndefined();
      expect(unknownEntry.replayState.reconcileOnly).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('expires a cold unknown prepared payload after 24 hours without another request', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-04T00:00:00.000Z'));
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-cold-prepared-write-expiry',
    });
    service.createBitableRecord
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
      );

    try {
      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      const unknownEntry = service.leaveRequestMutationUnknown.get(
        request.clientMutationId,
      );
      expect(unknownEntry?.replayState.preparedWrite).toBeDefined();

      await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(unknownEntry?.replayState.preparedWrite).toBeUndefined();
      expect(unknownEntry?.replayState.reconcileOnly).toBe(true);
      expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists a privacy-safe unknown tombstone and only reconciles after restart', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'leave-request-ledger-'));
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-persisted-unknown',
    });

    try {
      const firstService = createLeaveRequestService([createLeaveSchedule()]);
      firstService.leaveRequestMutationLedgerDir = ledgerDir;
      firstService.createBitableRecord
        .mockReset()
        .mockRejectedValue(
          Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
        );

      await expect(
        firstService.createLeaveRequest(request),
      ).rejects.toMatchObject({ name: 'LeaveRequestAmbiguousWriteError' });
      const ledgerPath = firstService.getLeaveRequestMutationLedgerPath(
        request.clientMutationId,
      );
      const ledgerContents = await readFile(ledgerPath, 'utf8');
      expect(JSON.parse(ledgerContents)).toMatchObject({
        version: 1,
        state: 'unknown',
        clientMutationHash: firstService.getLeaveRequestMutationLedgerKey(
          request.clientMutationId,
        ),
        fingerprint: firstService.buildLeaveRequestMutationFingerprint(request),
        reconcileOnly: true,
        firstSeenAt: expect.any(Number),
      });
      for (const sensitiveValue of [
        request.clientMutationId,
        request.leaveStaffName,
        request.leaveReason,
        request.startAt,
        request.endAt,
        'tok-leave-process-screenshot',
        'leave-process.png',
      ]) {
        expect(ledgerContents).not.toContain(sensitiveValue);
      }

      getBitableRecordsMock().mockClear();
      const restartedService = createLeaveRequestService([
        createLeaveSchedule(),
      ]);
      restartedService.leaveRequestMutationLedgerDir = ledgerDir;

      await expect(
        restartedService.createLeaveRequest(request),
      ).rejects.toMatchObject({ name: 'LeaveRequestAmbiguousWriteError' });
      expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
      expectStrictLeaveRequestLookup(request.clientMutationId);
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('persists the unknown tombstone before waiting for strict reconciliation', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'leave-request-ledger-'));
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-ledger-before-reconcile',
    });
    const deferredLookup = createDeferred<Array<Record<string, unknown>>>();
    const reconcileStarted = createDeferred<void>();
    let pending: Promise<unknown> | undefined;
    let tombstoneExistedBeforeReconcile = false;

    try {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      service.leaveRequestMutationLedgerDir = ledgerDir;
      let leaveLookupCount = 0;
      getBitableRecordsMock().mockImplementation(
        async (_httpService: unknown, read: { tableId?: string }) => {
          if (read.tableId === 'tblLeave') {
            leaveLookupCount += 1;
            if (leaveLookupCount === 1) return [];
            try {
              await readFile(
                service.getLeaveRequestMutationLedgerPath(
                  request.clientMutationId,
                ),
                'utf8',
              );
              tombstoneExistedBeforeReconcile = true;
            } catch {
              tombstoneExistedBeforeReconcile = false;
            }
            reconcileStarted.resolve();
            return deferredLookup.promise;
          }
          if (read.tableId === 'tblLeavePerson') {
            return createDefaultLeavePersonnelRecords();
          }
          return [];
        },
      );
      service.createBitableRecord
        .mockReset()
        .mockRejectedValue(
          Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
        );

      pending = service.createLeaveRequest(request);
      await reconcileStarted.promise;
      expect(leaveLookupCount).toBe(2);
      deferredLookup.resolve([]);
      await expect(pending).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      expect(tombstoneExistedBeforeReconcile).toBe(true);
    } finally {
      deferredLookup.resolve([]);
      await pending?.catch(() => undefined);
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('rejects different leave content against a persisted unknown tombstone before external work', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'leave-request-ledger-'));
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-persisted-unknown-conflict',
    });

    try {
      const firstService = createLeaveRequestService([createLeaveSchedule()]);
      firstService.leaveRequestMutationLedgerDir = ledgerDir;
      firstService.createBitableRecord
        .mockReset()
        .mockRejectedValue(
          Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
        );
      await expect(
        firstService.createLeaveRequest(request),
      ).rejects.toMatchObject({ name: 'LeaveRequestAmbiguousWriteError' });

      getBitableRecordsMock().mockClear();
      const restartedService = createLeaveRequestService([
        createLeaveSchedule(),
      ]);
      restartedService.leaveRequestMutationLedgerDir = ledgerDir;
      await expect(
        restartedService.createLeaveRequest({
          ...request,
          leaveReason: '另一个请假原因',
        }),
      ).rejects.toThrow('clientMutationId 重复但请休假内容不同');
      expect(getBitableRecordsMock()).not.toHaveBeenCalled();
      expect(restartedService.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(restartedService.createBitableRecord).not.toHaveBeenCalled();
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('fails closed on a corrupt leave tombstone across repeated retries', async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), 'leave-request-ledger-'));
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-corrupt-ledger',
    });

    try {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      service.leaveRequestMutationLedgerDir = ledgerDir;
      await writeFile(
        service.getLeaveRequestMutationLedgerPath(request.clientMutationId),
        '{"version":1,"state":"unknown","broken":',
        'utf8',
      );

      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      expect(service.uploadBitableAttachment).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
      expect(
        service.leaveRequestMutationUnknown.get(request.clientMutationId)
          ?.replayState.reconcileOnly,
      ).toBe(true);
    } finally {
      await rm(ledgerDir, { recursive: true, force: true });
    }
  });

  it('safely replays an Axios HTTP 504 through the real Bitable write path', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-real-http-504',
    });
    const http504 = Object.assign(new Error('Request failed'), {
      code: 'ERR_BAD_RESPONSE',
      response: {
        status: 504,
        data: { code: 999999, msg: 'upstream service unavailable' },
      },
    });
    const post = jest
      .fn()
      .mockRejectedValueOnce(http504)
      .mockRejectedValueOnce(http504)
      .mockRejectedValueOnce(http504)
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: { record: { record_id: 'recRecoveredAfter504' } },
        },
      });
    (service as any).httpService.axiosRef.post = post;
    service.sleep = jest.fn(async () => undefined);
    useRealCreateBitableRecord(service);

    const firstError = await service
      .createLeaveRequest(request)
      .catch(
        (error: unknown) =>
          error as { getStatus?: () => number; name?: string },
      );
    expect(firstError).toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
    });
    expect(firstError.getStatus?.()).toBe(503);
    await expect(service.createLeaveRequest(request)).resolves.toMatchObject({
      success: true,
      recordIds: ['recRecoveredAfter504'],
    });
    expect(post).toHaveBeenCalledTimes(4);
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[3][1]).toEqual(post.mock.calls[0][1]);
    const clientTokens = post.mock.calls.map(
      (call) => call[2]?.params?.client_token,
    );
    expect(clientTokens).toEqual([
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      clientTokens[0],
      clientTokens[0],
      clientTokens[0],
    ]);
  });

  it.each([408, 409, 425, 429])(
    'keeps HTTP %s leave writes ambiguous and retries only with the same client token',
    async (status) => {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      const request = createLeaveRequestInput({
        clientMutationId: `leave-request-transient-http-${status}`,
      });
      service.createBitableRecord.mockReset().mockRejectedValue(
        Object.assign(new Error(`HTTP ${status}`), {
          response: { status },
        }),
      );

      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      await expect(service.createLeaveRequest(request)).rejects.toThrow(
        '请休假写入结果未知',
      );
      expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
      const clientTokens = service.createBitableRecord.mock.calls.map(
        (call: unknown[]) => (call[5] as { clientToken?: string }).clientToken,
      );
      expect(clientTokens).toEqual([clientTokens[0], clientTokens[0]]);
    },
  );

  it.each(['ETIMEDOUT', 'ERR_NETWORK', 'ENETDOWN', 'ENOTFOUND'])(
    'keeps %s leave writes ambiguous without relying on message text',
    async (code) => {
      const service = createLeaveRequestService([createLeaveSchedule()]);
      const request = createLeaveRequestInput({
        clientMutationId: `leave-request-transient-code-${code.toLowerCase()}`,
      });
      service.createBitableRecord
        .mockReset()
        .mockRejectedValue(
          Object.assign(new Error('request failed'), { code }),
        );

      await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
        name: 'LeaveRequestAmbiguousWriteError',
      });
      await expect(service.createLeaveRequest(request)).rejects.toThrow(
        '请休假写入结果未知',
      );
      expect(service.createBitableRecord).toHaveBeenCalledTimes(2);
      const clientTokens = service.createBitableRecord.mock.calls.map(
        (call: unknown[]) => (call[5] as { clientToken?: string }).clientToken,
      );
      expect(clientTokens).toEqual([clientTokens[0], clientTokens[0]]);
    },
  );

  it('bounds the in-memory unknown leave mutation ledger', () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);

    for (let index = 0; index < 501; index += 1) {
      service.rememberLeaveRequestUnknownMutation(
        `leave-request-unknown-${index}`,
        `fingerprint-${index}`,
      );
    }

    expect(service.leaveRequestMutationUnknown.size).toBe(500);
    expect(
      service.leaveRequestMutationUnknown.has('leave-request-unknown-0'),
    ).toBe(false);
    expect(
      service.leaveRequestMutationUnknown.has('leave-request-unknown-500'),
    ).toBe(true);
  });

  it.each([
    {
      label: 'HTTP 400 response',
      createPost: () =>
        jest.fn().mockRejectedValue(
          Object.assign(new Error('client token conflict'), {
            code: 'ERR_BAD_REQUEST',
            response: {
              status: 400,
              data: { code: 1255006, msg: 'client token conflict' },
            },
          }),
        ),
    },
    {
      label: 'HTTP 200 business response',
      createPost: () =>
        jest.fn().mockResolvedValue({
          data: { code: 1255006, msg: 'client token conflict' },
        }),
    },
  ])(
    'reconciles a native client-token conflict from $label',
    async ({ label, createPost }) => {
      getInvalidateBitableRecordCacheMock().mockClear();
      const service = createLeaveRequestService([createLeaveSchedule()]);
      const request = createLeaveRequestInput({
        clientMutationId: `leave-request-native-token-conflict-${label}`,
      });
      const fingerprint = service.buildLeaveRequestMutationFingerprint(request);
      let leaveLookupCount = 0;
      getBitableRecordsMock().mockImplementation(
        async (_httpService: unknown, read: { tableId?: string }) => {
          if (read.tableId === 'tblLeave') {
            leaveLookupCount += 1;
            return leaveLookupCount === 1
              ? []
              : [
                  {
                    record_id: 'recNativeTokenConflict',
                    fields: {
                      请求唯一ID: request.clientMutationId,
                      请求指纹: fingerprint,
                    },
                  },
                ];
          }
          if (read.tableId === 'tblLeavePerson') {
            return createDefaultLeavePersonnelRecords();
          }
          return [];
        },
      );
      const post = createPost();
      (service as any).httpService.axiosRef.post = post;
      useRealCreateBitableRecord(service);

      await expect(service.createLeaveRequest(request)).resolves.toMatchObject({
        success: true,
        created: 0,
        recordIds: ['recNativeTokenConflict'],
      });
      expect(post).toHaveBeenCalledTimes(1);
      expect(leaveLookupCount).toBe(2);
      expect(getInvalidateBitableRecordCacheMock()).toHaveBeenCalledWith({
        appToken: 'leaveApp',
        tableId: 'tblLeave',
      });
    },
  );

  it('keeps a native client-token conflict reconcile-only until the record is visible', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-native-token-conflict-pending',
    });
    const tokenConflict = Object.assign(new Error('client token conflict'), {
      code: 'ERR_BAD_REQUEST',
      response: {
        status: 400,
        data: { code: 1255006, msg: 'client token conflict' },
      },
    });
    const post = jest.fn().mockRejectedValue(tokenConflict);
    (service as any).httpService.axiosRef.post = post;
    useRealCreateBitableRecord(service);

    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
    });
    await expect(service.createLeaveRequest(request)).rejects.toThrow(
      '请休假写入结果未知',
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(service.uploadBitableAttachment).toHaveBeenCalledTimes(1);
    expect(
      service.leaveRequestMutationUnknown.get(request.clientMutationId)
        ?.replayState.preparedWrite,
    ).toBeUndefined();
  });

  it('keeps a native client-token conflict unknown when strict reconciliation finds duplicate ids', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-native-token-conflict-duplicate-read',
    });
    const fingerprint = service.buildLeaveRequestMutationFingerprint(request);
    let leaveLookupCount = 0;
    getBitableRecordsMock().mockImplementation(
      async (_httpService: unknown, read: { tableId?: string }) => {
        if (read.tableId === 'tblLeave') {
          leaveLookupCount += 1;
          if (leaveLookupCount === 1) {
            return [];
          }
          return ['recDuplicateA', 'recDuplicateB'].map((recordId) => ({
            record_id: recordId,
            fields: {
              请求唯一ID: request.clientMutationId,
              请求指纹: fingerprint,
            },
          }));
        }
        if (read.tableId === 'tblLeavePerson') {
          return createDefaultLeavePersonnelRecords();
        }
        return [];
      },
    );
    service.createBitableRecord.mockReset().mockRejectedValue(
      Object.assign(new Error('client token conflict'), {
        response: {
          status: 400,
          data: { code: 1255006, msg: 'client token conflict' },
        },
      }),
    );

    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
    });
    await expect(service.createLeaveRequest(request)).rejects.toMatchObject({
      name: 'LeaveRequestAmbiguousWriteError',
    });
    expect(service.createBitableRecord).toHaveBeenCalledTimes(1);
    const unknownEntry = service.leaveRequestMutationUnknown.get(
      request.clientMutationId,
    );
    expect(unknownEntry?.replayState.reconcileOnly).toBe(true);
    expect(unknownEntry?.replayState.preparedWrite).toBeUndefined();
  });

  it('retries a real HTTP 400 even when its message mentions network timeout', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);
    const request = createLeaveRequestInput({
      clientMutationId: 'leave-request-http-400-retry',
    });
    const http400 = Object.assign(
      new Error('network timeout while validating leave request'),
      {
        code: 'ERR_BAD_REQUEST',
        response: {
          status: 400,
          data: { code: 1254001, msg: 'network timeout in request payload' },
        },
      },
    );
    const post = jest
      .fn()
      .mockRejectedValueOnce(http400)
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: { record: { record_id: 'recAfterExplicit400' } },
        },
      });
    (service as any).httpService.axiosRef.post = post;
    useRealCreateBitableRecord(service);

    const firstError = await service.createLeaveRequest(request).catch(
      (error: unknown) =>
        error as {
          bitableCode?: string;
          getStatus?: () => number;
          message?: string;
          upstreamStatus?: number;
        },
    );
    expect(firstError).toMatchObject({
      bitableCode: '1254001',
      upstreamStatus: 400,
    });
    expect(firstError.getStatus?.()).toBe(502);
    expect(firstError.message).toContain('1254001');
    await expect(service.createLeaveRequest(request)).resolves.toMatchObject({
      recordIds: ['recAfterExplicit400'],
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keeps runtime boolean validation for needSubstitute', async () => {
    const service = createLeaveRequestService([createLeaveSchedule()]);

    await expect(
      service.createLeaveRequest(
        createLeaveRequestInput({
          clientMutationId: 'leave-request-invalid-boolean',
          needSubstitute: 'false' as never,
        }),
      ),
    ).rejects.toThrow('是否需要替班必须为布尔值');
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('creates a sealing registration record with minute-level date time fields', async () => {
    const service = createServiceWithAxios({});
    (service as any).sealingConfig = {
      appToken: 'sealApp',
      wikiToken: '',
      tableId: 'tblSeal',
      viewId: 'vewSeal',
      tableName: '封网信息',
      sourceUrl:
        'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    };
    service.fetchBitableFieldMetas = jest.fn(async () => [
      { field_id: 'fldyloi3Wd', field_name: '封网信息', type: 1 },
      { field_id: 'fldY3ITpTr', field_name: '开始日期', type: 5 },
      { field_id: 'fldHGRu3v7', field_name: '结束日期', type: 5 },
    ]);
    service.createBitableRecord = jest.fn().mockResolvedValueOnce('recSeal');

    const result = await service.createSealingRegistration({
      sealingInfo: '2026年618封网 - 强管控',
      startTime: '2026-06-18T00:30',
      endTime: '2026-06-19T23:59',
    });

    expect(result).toMatchObject({
      success: true,
      recordId: 'recSeal',
      sealingInfo: '2026年618封网 - 强管控',
      startTime: new Date('2026-06-18T00:30:00+08:00').toISOString(),
      endTime: new Date('2026-06-19T23:59:00+08:00').toISOString(),
    });
    expect(result.recordUrl || '').toContain('record=recSeal');
    expect(service.fetchBitableFieldMetas).toHaveBeenCalledWith(
      'sealApp',
      'tblSeal',
      '封网信息',
      'tenant-token',
    );
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'sealApp',
      'tblSeal',
      '封网信息',
      {
        封网信息: '2026年618封网 - 强管控',
        开始日期: new Date('2026-06-18T00:30:00+08:00').getTime(),
        结束日期: new Date('2026-06-19T23:59:00+08:00').getTime(),
      },
      'tenant-token',
    );
  });

  async function flushBackgroundTasks(turns = 20) {
    for (let index = 0; index < turns; index += 1) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function waitForCondition(
    condition: () => boolean,
    description: string,
    maxTurns = 50,
  ) {
    for (let index = 0; index < maxTurns; index += 1) {
      if (condition()) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  function buildQueuedConstructionFollowupSubmitTask(id: string) {
    const now = new Date().toISOString();
    return {
      id,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
      nextRunAt: now,
      attempts: 0,
      request: {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'close',
      },
      files: [],
      accessRole: 'guest' as const,
    };
  }

  beforeEach(() => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as {
      fetchBitableRecords: jest.Mock;
      readLatestPersistedBitableRecordSnapshot: jest.Mock;
    };
    bitableDirectRead.fetchBitableRecords.mockReset();
    bitableDirectRead.readLatestPersistedBitableRecordSnapshot.mockReset();
  });

  afterAll(() => {
    if (previousConstructionAiAuditEnabled === undefined) {
      delete process.env.CONSTRUCTION_AI_AUDIT_ENABLED;
      return;
    }
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED =
      previousConstructionAiAuditEnabled;
  });

  it('loads construction crew ledger rows outside the configured view', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockImplementation(
      async (
        _httpService: unknown,
        options: { tableName?: string; viewId?: string },
      ) => {
        if (options.tableName === '施工项目总览') {
          return [
            {
              record_id: 'recOverview',
              fields: {
                施工编号: 'SG260625-0001',
                作业内容: '测试项目',
                计划开始时间: '2026-06-25',
                计划结束时间: '2026-06-30',
              },
            },
          ];
        }
        if (options.tableName === '施工跟进') {
          return [];
        }
        if (
          options.tableName === '施工人员台账' &&
          options.viewId === 'vewFilteredCrew'
        ) {
          return [];
        }
        if (options.tableName === '施工人员台账' && !options.viewId) {
          return [
            {
              record_id: 'recCrewFromFullTable',
              fields: {
                施工编码: 'SG260625-0001',
                姓名: '张鹏',
                手机号: '13800004492',
                授权状态: '授权有效',
                持证统计: '低压电工证',
              },
            },
          ];
        }
        return [];
      },
    );
    const service = createServiceWithAxios({});
    (service as any).constructionCrewLedgerConfig.viewId = 'vewFilteredCrew';

    const result = await service.getConstructionManagement(false);

    expect(result.items[0]?.crewMembers).toHaveLength(1);
    expect(result.items[0]?.crewMembers[0]).toMatchObject({
      recordId: 'recCrewFromFullTable',
      name: '张鹏',
      constructionCode: 'SG260625-0001',
      authorizationStatus: '授权有效',
    });
    const crewReadOptions = bitableDirectRead.fetchBitableRecords.mock.calls
      .map((call) => call[1])
      .filter((options) => options.tableName === '施工人员台账');
    expect(crewReadOptions[0]).toMatchObject({ viewId: 'vewFilteredCrew' });
    expect(crewReadOptions[1]).toMatchObject({ tableId: 'tblCrew' });
    expect(crewReadOptions[1].viewId).toBeUndefined();
  });

  it('loads construction followups outside the configured view', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockImplementation(
      async (
        _httpService: unknown,
        options: { tableId?: string; viewId?: string },
      ) => {
        if (options.tableId !== 'tblFollowup') {
          return [];
        }
        return options.viewId
          ? [
              {
                record_id: 'recFollowupFromFullTable',
                fields: { source: 'view-stale' },
              },
            ]
          : [
              {
                record_id: 'recFollowupFromFullTable',
                fields: { source: 'full-table-current' },
              },
            ];
      },
    );
    const service = createServiceWithAxios({});
    (service as any).constructionFollowupConfig.viewId = 'vewFilteredFollowup';

    const records = await service.fetchConstructionFollowupRecordsForManagement(
      'followupApp',
      (service as any).constructionFollowupConfig,
      { cacheTtlMs: 0, forceRefresh: true },
    );

    expect(records).toEqual([
      expect.objectContaining({
        record_id: 'recFollowupFromFullTable',
        fields: { source: 'full-table-current' },
      }),
    ]);
    const followupReadOptions = bitableDirectRead.fetchBitableRecords.mock.calls
      .map((call) => call[1])
      .filter((options) => options.tableId === 'tblFollowup');
    expect(followupReadOptions[0]).toMatchObject({
      viewId: 'vewFilteredFollowup',
    });
    expect(followupReadOptions[1]).toMatchObject({ tableId: 'tblFollowup' });
    expect(followupReadOptions[1].viewId).toBeUndefined();
  });

  it('keeps a freshly created construction overview visible while the configured view is delayed', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValue([]);
    const service = createServiceWithAxios({});

    service.rememberRecentConstructionOverviewRecord({
      record_id: 'recFreshOverview',
      fields: {
        作业内容: '新建施工视图延迟测试',
        楼栋: 'A楼',
        计划开始时间: Date.parse('2026-07-26T09:00:00+08:00'),
        计划结束时间: Date.parse('2026-07-27T18:00:00+08:00'),
      },
    });

    const result = await service.getConstructionManagement(false);

    expect(result.summary.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      recordId: 'recFreshOverview',
      workContent: '新建施工视图延迟测试',
      building: 'A楼',
    });
  });

  it('reports manual-only construction review status when AI audit is disabled', () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    try {
      const service = createServiceWithAxios({});
      service.getConstructionImageAuditConfig = jest.fn(() => ({
        apiKey: 'configured-key',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-vl-max-latest',
      }));

      expect(service.getConstructionImageAuditStatus()).toEqual({
        enabled: false,
        configured: false,
        provider: '人工审核',
        model: null,
        baseUrl: null,
        supportsImageInput: false,
        message: '施工 AI/OCR 审核已关闭，当前仅使用人工审核',
      });
      expect(service.getConstructionImageAuditConfig).not.toHaveBeenCalled();
    } finally {
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('reports the configured construction image audit status when AI audit is enabled', () => {
    const service = createServiceWithAxios({});
    service.getConstructionImageAuditConfig = jest.fn(() => ({
      apiKey: 'configured-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-vl-max-latest',
    }));

    expect(service.getConstructionImageAuditStatus()).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: true,
        provider: 'Qwen',
        model: 'qwen-vl-max-latest',
        supportsImageInput: true,
      }),
    );
  });

  it('returns a non-mutating manual-review construction view when AI audit is disabled', async () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    const constructionManagementModule = jest.requireActual(
      '../../server/modules/duty-schedule/construction-management',
    ) as typeof import('../../server/modules/duty-schedule/construction-management');
    const retainedFile = {
      fileToken: 'tokHotWork',
      name: '动火作业票.jpg',
      size: 128,
    };
    const retainedManualReview = {
      field: '人工审核-动火作业票',
      fingerprintField: '人工审核数据标识-动火作业票',
      reviewed: true,
      value: '通过',
      fingerprint: 'manual-fingerprint',
      expectedFingerprint: 'manual-fingerprint',
      validUntil: '2026-07-31',
    };
    const issueAttachment = {
      field: '动火作业票',
      label: '动火作业票',
      count: 1,
      files: [retainedFile],
      status: 'issue' as const,
      feedback: 'AI审核不通过',
      manualReview: retainedManualReview,
    };
    const emptyIssueAttachment = {
      field: '高处作业票',
      label: '高处作业票',
      count: 0,
      files: [],
      status: 'issue' as const,
      feedback: 'AI反馈残留',
      manualReview: null,
    };
    const sourceFollowup = {
      recordId: 'recFollowup',
      isolationCompliant: '人工驳回',
      isolationFeedback: 'AI挂牌隔离审核不通过',
      processFeedback: '现场施工正常（人工填写）',
      closingFeedback: 'AI收尾照片审核不通过',
      aiIssues: ['AI挂牌隔离审核不通过', 'AI审核不通过'],
      closingApproval: '人工驳回',
      attachments: [issueAttachment, emptyIssueAttachment],
    };
    const sourceResponse = {
      generatedAt: '2026-07-25T00:00:00.000Z',
      summary: {
        total: 1,
        active: 1,
        pendingApproval: 0,
        endingSoon: 0,
        attachmentIssues: 3,
        completedFollowups: 0,
        latestUpdatedAt: null,
      },
      items: [
        {
          recordId: 'recOverview',
          applicationAttachments: [
            {
              ...issueAttachment,
              field: '施工申请单',
              label: '施工申请单',
            },
            {
              ...emptyIssueAttachment,
              field: '施工安全告知书',
              label: '施工安全告知书',
            },
          ],
          followups: [sourceFollowup],
          latestFollowup: sourceFollowup,
        },
      ],
      followups: [sourceFollowup],
      imageAuditStatus: {
        configured: true,
        provider: 'Qwen',
        model: 'qwen-vl-max-latest',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        supportsImageInput: true,
        message: 'Qwen 已配置',
      },
      sectionStatus: {
        overview: { configured: true },
        followups: { configured: true },
      },
    } as unknown as ReturnType<
      typeof constructionManagementModule.buildConstructionManagementView
    >;
    const sourceSnapshot = JSON.parse(JSON.stringify(sourceResponse));
    const buildViewSpy = jest
      .spyOn(constructionManagementModule, 'buildConstructionManagementView')
      .mockReturnValue(sourceResponse);

    try {
      const bitableDirectRead = jest.requireMock(
        '@server/common/feishu/bitable-direct-read',
      ) as { fetchBitableRecords: jest.Mock };
      bitableDirectRead.fetchBitableRecords.mockResolvedValue([]);
      const service = createServiceWithAxios({});
      service.updateBitableRecordFields = jest.fn(async () => undefined);

      const result = await service.getConstructionManagement(false);

      expect(result.summary.attachmentIssues).toBe(0);
      expect(result).not.toBe(sourceResponse);
      const cleanedFollowups = [
        result.followups[0],
        result.items[0].followups[0],
        result.items[0].latestFollowup!,
      ];
      for (const followup of cleanedFollowups) {
        expect(followup).not.toBe(sourceFollowup);
        expect(followup.isolationFeedback).toBeNull();
        expect(followup.isolationCompliant).toBe(
          sourceFollowup.isolationCompliant,
        );
        expect(followup.processFeedback).toBe(sourceFollowup.processFeedback);
        expect(followup.closingFeedback).toBeNull();
        expect(followup.closingApproval).toBe(sourceFollowup.closingApproval);
        expect(followup.aiIssues).toEqual([]);
        expect(followup.attachments).toEqual([
          expect.objectContaining({
            feedback: null,
            status: 'complete',
            files: [retainedFile],
            manualReview: retainedManualReview,
          }),
          expect.objectContaining({
            feedback: null,
            status: 'empty',
            files: [],
            manualReview: null,
          }),
        ]);
      }
      expect(result.items[0].applicationAttachments).toEqual([
        expect.objectContaining({
          feedback: null,
          status: 'complete',
          files: [retainedFile],
          manualReview: retainedManualReview,
        }),
        expect.objectContaining({
          feedback: null,
          status: 'empty',
          files: [],
          manualReview: null,
        }),
      ]);
      expect(sourceResponse).toEqual(sourceSnapshot);
      expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    } finally {
      buildViewSpy.mockRestore();
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('uses one construction AI audit switch snapshot for a management request', async () => {
    const constructionManagementModule = jest.requireActual(
      '../../server/modules/duty-schedule/construction-management',
    ) as typeof import('../../server/modules/duty-schedule/construction-management');
    const sourceFollowup = {
      recordId: 'recSnapshotFollowup',
      isolationFeedback: 'AI挂牌隔离审核不通过',
      processFeedback: '现场施工正常（人工填写）',
      closingFeedback: 'AI收尾照片审核不通过',
      aiIssues: ['AI过程照片审核不通过'],
      attachments: [],
    };
    const sourceResponse = {
      generatedAt: '2026-07-25T00:00:00.000Z',
      summary: {
        total: 1,
        active: 1,
        pendingApproval: 0,
        endingSoon: 0,
        attachmentIssues: 1,
        completedFollowups: 0,
        latestUpdatedAt: null,
      },
      items: [],
      followups: [sourceFollowup],
      imageAuditStatus: {
        configured: true,
        provider: 'Qwen',
        model: 'qwen-vl-max-latest',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        supportsImageInput: true,
        message: 'Qwen 已配置',
      },
      sectionStatus: {
        overview: { configured: true },
        followups: { configured: true },
      },
    } as unknown as ReturnType<
      typeof constructionManagementModule.buildConstructionManagementView
    >;
    const buildViewSpy = jest
      .spyOn(constructionManagementModule, 'buildConstructionManagementView')
      .mockReturnValue(sourceResponse);

    try {
      const bitableDirectRead = jest.requireMock(
        '@server/common/feishu/bitable-direct-read',
      ) as { fetchBitableRecords: jest.Mock };
      bitableDirectRead.fetchBitableRecords.mockResolvedValue([]);
      const service = createServiceWithAxios({});
      const aiAuditEnabled = jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      service.isConstructionAiAuditEnabled = aiAuditEnabled;
      service.syncConstructionCrewLedgerAuthorizationFields = jest.fn(
        async () => false,
      );
      service.refreshDailyPermitAuditFeedbacksIfNeeded = jest.fn(
        async () => false,
      );

      const result = await service.getConstructionManagement(true);

      expect(aiAuditEnabled).toHaveBeenCalledTimes(1);
      expect(
        service.refreshDailyPermitAuditFeedbacksIfNeeded,
      ).not.toHaveBeenCalled();
      expect(result.imageAuditStatus.enabled).toBe(false);
      expect(result.summary.attachmentIssues).toBe(0);
      expect(result.followups[0]).toMatchObject({
        isolationFeedback: null,
        processFeedback: sourceFollowup.processFeedback,
        closingFeedback: null,
        aiIssues: [],
      });
    } finally {
      buildViewSpy.mockRestore();
    }
  });

  it('does not refresh daily permit audit feedbacks during force refresh when construction AI audit is disabled', async () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    try {
      const bitableDirectRead = jest.requireMock(
        '@server/common/feishu/bitable-direct-read',
      ) as { fetchBitableRecords: jest.Mock };
      bitableDirectRead.fetchBitableRecords.mockResolvedValue([]);
      const service = createServiceWithAxios({});
      service.syncConstructionCrewLedgerAuthorizationFields = jest.fn(
        async () => false,
      );
      service.refreshDailyPermitAuditFeedbacksIfNeeded = jest.fn(
        async () => false,
      );

      await service.getConstructionManagement(true);

      expect(
        service.refreshDailyPermitAuditFeedbacksIfNeeded,
      ).not.toHaveBeenCalled();
    } finally {
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('refreshes daily permit audit feedbacks during force refresh when construction AI audit is enabled', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValue([]);
    const service = createServiceWithAxios({});
    service.syncConstructionCrewLedgerAuthorizationFields = jest.fn(
      async () => false,
    );
    service.refreshDailyPermitAuditFeedbacksIfNeeded = jest.fn(
      async () => false,
    );

    await service.getConstructionManagement(true);

    expect(
      service.refreshDailyPermitAuditFeedbacksIfNeeded,
    ).toHaveBeenCalledTimes(1);
  });

  it('fails closed before refreshing daily permit audit feedbacks when construction AI audit is disabled', async () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    try {
      const service = createServiceWithAxios({});
      service.hasBitableSourceConfig = jest.fn(() => true);

      await expect(
        service.refreshDailyPermitAuditFeedbacksIfNeeded({
          overviewRecords: [],
          followupRecords: [],
          crewRecords: [],
          referenceDate: new Date('2026-06-25T00:00:00+08:00'),
        }),
      ).resolves.toBe(false);
      expect(service.hasBitableSourceConfig).not.toHaveBeenCalled();
    } finally {
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('fails closed before auditing construction follow-up files when construction AI audit is disabled', async () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    try {
      const service = createServiceWithAxios({});
      service.auditConstructionIsolationPhotos = jest.fn(async () => null);
      service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
      service.auditConstructionTrainingAssessmentFiles = jest.fn(
        async () => ({}),
      );

      await expect(
        service.auditConstructionFollowupFiles({
          normalized: {
            followupMode: 'daily',
            dailyFollowupStage: 'prepare',
            checklistContext: {},
            workTypes: [],
          },
          effectiveFiles: [],
          permitAuditFiles: [],
          referenceDate: new Date('2026-06-25T00:00:00+08:00'),
        }),
      ).resolves.toEqual([null, {}]);
      expect(service.auditConstructionIsolationPhotos).not.toHaveBeenCalled();
      expect(service.auditConstructionPermitAttachments).not.toHaveBeenCalled();
      expect(
        service.auditConstructionTrainingAssessmentFiles,
      ).not.toHaveBeenCalled();
    } finally {
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('keeps attachment upload and post-save side effects while construction AI audit is disabled', async () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    try {
      const service = createConstructionFollowupAuditGateScenario();

      const result = await service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          followupStaffIds: ['ou_1'],
          dailyPersonnelCheck: 'checked',
        },
        [
          {
            fieldname: 'isolationPhotoFiles',
            originalname: 'isolation.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('photo'),
            size: 5,
          },
        ],
      );
      await waitForCondition(
        () =>
          service.syncConstructionFollowupPostSaveSideEffects.mock.calls
            .length === 1,
        'construction follow-up post-save side effects',
      );

      expect(result).toMatchObject({
        success: true,
        recordId: 'recTodayFollowup',
        attachmentSyncPending: true,
      });
      expect(
        service.uploadConstructionAttachmentFieldValues,
      ).toHaveBeenCalledTimes(1);
      expect(service.auditConstructionFollowupFiles).not.toHaveBeenCalled();
      expect(
        service.scheduleConstructionFollowupAuditBackfill,
      ).not.toHaveBeenCalled();
      expect(
        service.syncConstructionFollowupPostSaveSideEffects,
      ).toHaveBeenCalledTimes(1);
    } finally {
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('keeps construction follow-up audit and backfill when construction AI audit is enabled', async () => {
    const service = createConstructionFollowupAuditGateScenario();

    await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck: 'checked',
      },
      [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: 'isolation.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
    );
    await waitForCondition(
      () =>
        service.syncConstructionFollowupPostSaveSideEffects.mock.calls
          .length === 1,
      'construction follow-up post-save side effects',
    );

    expect(
      service.uploadConstructionAttachmentFieldValues,
    ).toHaveBeenCalledTimes(1);
    expect(service.auditConstructionFollowupFiles).toHaveBeenCalledTimes(1);
    expect(
      service.scheduleConstructionFollowupAuditBackfill,
    ).toHaveBeenCalledTimes(1);
    expect(
      service.syncConstructionFollowupPostSaveSideEffects,
    ).toHaveBeenCalledTimes(1);
  });

  it('checks room manager sync when deposit confirmation is filled during force refresh', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords
      .mockResolvedValueOnce([
        {
          record_id: 'recOverview',
          fields: {
            施工编号: 'SG260605-1039',
            作业内容: '测试项目',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          record_id: 'recFollowupDepositDone',
          fields: {
            施工编号: 'SG260605-1039',
            跟进记录: '质保金确认',
            质保金是否确认: true,
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          record_id: 'recFollowupDepositDone',
          fields: {
            施工编号: 'SG260605-1039',
            跟进记录: '质保金确认',
            质保金是否确认: true,
            同步机房经理: true,
          },
        },
      ]);
    const service = createServiceWithAxios({});
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.refreshDailyPermitAuditFeedbacksIfNeeded = jest.fn(
      async () => false,
    );

    await service.getConstructionManagement(true);

    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recFollowupDepositDone',
      { 同步机房经理: true },
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          '质保金是否确认',
          '同步机房经理',
        ]),
      }),
    );
  });

  it('reuses an existing construction-code view and refreshes its filter', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ field_id: 'fldCode', field_name: '施工编码' }],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ view_id: 'vewExisting', view_name: 'SG260605-1031' }],
            has_more: false,
          },
        },
      });
    const post = jest.fn();
    const patch = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, post, patch });

    await service.ensureConstructionCrewLedgerProjectView(
      'SG260605-1031',
      'tenant-token',
    );

    expect(post).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith(
      expect.stringContaining('/views/vewExisting'),
      {
        property: {
          filter_info: {
            conjunction: 'and',
            conditions: [
              {
                field_id: 'fldCode',
                operator: 'is',
                value: ['SG260605-1031'],
              },
            ],
          },
        },
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('creates a construction-code view when it does not exist', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ field_id: 'fldCode', field_name: '施工编码' }],
          },
        },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      });
    const post = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: { view: { view_id: 'vewNew' } },
      },
    });
    const patch = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, post, patch });

    await service.ensureConstructionCrewLedgerProjectView(
      'SG260605-1031',
      'tenant-token',
    );

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/views'),
      { view_name: 'SG260605-1031', view_type: 'grid' },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
    expect(patch).toHaveBeenCalledWith(
      expect.stringContaining('/views/vewNew'),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('fills crew ledger authorization dates and status from ledger date fields', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { extractDateTimeIso: jest.Mock };
    bitableDirectRead.extractDateTimeIso.mockImplementation(
      (value: unknown) => {
        if (typeof value === 'number') {
          return new Date(value).toISOString();
        }
        if (typeof value === 'string' && value.trim()) {
          const text = value.trim();
          return new Date(
            text.includes('T') ? text : `${text}T00:00:00+08:00`,
          ).toISOString();
        }
        return null;
      },
    );
    const service = createServiceWithAxios({});
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const changed = await service.syncConstructionCrewLedgerAuthorizationFields(
      [
        {
          record_id: 'recExpired',
          fields: {
            授权开始日期: '2026-05-01',
            授权结束日期: '2026-06-07',
            授权状态: '授权有效',
          },
        },
        {
          record_id: 'recFuture',
          fields: {
            授权起始日期: '2026-06-10',
            授权截止日期: '2026-06-30',
          },
        },
        {
          record_id: 'recCompanyOnly',
          fields: {
            公司: '浙江邮电',
            施工单位: '',
          },
        },
      ],
      new Date('2026-06-08T00:00:00+08:00'),
    );

    expect(changed).toBe(true);
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'crewApp',
      'tblCrew',
      '施工人员台账',
      'recExpired',
      { 授权状态: '已过期' },
      'tenant-token',
      expect.any(Object),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'crewApp',
      'tblCrew',
      '施工人员台账',
      'recFuture',
      {
        授权开始日期: new Date('2026-06-10T00:00:00+08:00').getTime(),
        授权结束日期: new Date('2026-06-30T00:00:00+08:00').getTime(),
        授权状态: '未开始',
      },
      'tenant-token',
      expect.any(Object),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'crewApp',
      'tblCrew',
      '施工人员台账',
      'recCompanyOnly',
      { 施工单位: '浙江邮电' },
      'tenant-token',
      expect.any(Object),
    );
  });

  it('upserts uploaded crew roster rows into the construction crew ledger', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      {
        record_id: 'recExistingCrew',
        fields: {
          施工编码: 'SG260605-1036',
          姓名: '张鹏',
          手机号: '13800004492',
        },
      },
    ]);
    const service = createServiceWithAxios({});
    service.fetchBitableFieldMetas = jest.fn(async () => [
      { field_id: 'fldName', field_name: '姓名', type: 1 },
      { field_id: 'fldPhone', field_name: '手机号', type: 13 },
      { field_id: 'fldCertNo', field_name: '证件号码', type: 1 },
      { field_id: 'fldCompany', field_name: '公司', type: 1 },
      { field_id: 'fldConstructionUnit', field_name: '施工单位', type: 1 },
      { field_id: 'fldScope', field_name: '授权范围', type: 1 },
      { field_id: 'fldStart', field_name: '授权开始日期', type: 5 },
      { field_id: 'fldEnd', field_name: '授权结束日期', type: 5 },
      { field_id: 'fldStatus', field_name: '授权状态', type: 3 },
      { field_id: 'fldLink', field_name: '关联施工单', type: 18 },
      { field_id: 'fldCode', field_name: '施工编码', type: 1 },
    ]);
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.createBitableRecord = jest.fn(async () => 'recNewCrew');
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const buffer = buildCrewRosterWorkbookBuffer([
      [
        '姓名*\nName*',
        '证件号码*\nCertificateNo*',
        '手机号码*\nCellphone*',
        '公司*\nCompany*',
        '授权范围(选填)\nAuthorizationScope',
        '授权有效期',
      ],
      [
        '张鹏',
        '411024199110154959',
        '13800004492',
        '浙江省邮电工程建设有限公司',
        'HA楼',
        '2026-06-08 至 2026-06-14',
      ],
      [
        '周淑娟',
        '320611197206091525',
        '13800007382',
        '浙江邮电',
        'HA楼',
        '2026-06-08 至 2026-06-14',
      ],
    ]);

    const result = await service.syncConstructionCrewRosterFilesToLedger({
      files: [
        {
          fieldname: 'crewRosterFiles',
          originalname: '施工人员名单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer,
          size: buffer.length,
        },
      ],
      overviewRecordId: 'recOverview',
      constructionCode: 'SG260605-1036',
      tenantAccessToken: 'tenant-token',
      referenceDate: new Date('2026-06-08T00:00:00+08:00'),
    });

    expect(result).toMatchObject({ parsed: 2, created: 1, updated: 1 });
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'crewApp',
      'tblCrew',
      '施工人员台账',
      'recExistingCrew',
      expect.objectContaining({
        姓名: '张鹏',
        手机号: '13800004492',
        施工单位: '浙江省邮电工程建设有限公司',
        授权开始日期: new Date('2026-06-08T00:00:00+08:00').getTime(),
        授权结束日期: new Date('2026-06-14T00:00:00+08:00').getTime(),
        授权状态: '授权有效',
        关联施工单: ['recOverview'],
        施工编码: 'SG260605-1036',
      }),
      'tenant-token',
      expect.any(Object),
    );
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'crewApp',
      'tblCrew',
      '施工人员台账',
      expect.objectContaining({
        姓名: '周淑娟',
        手机号: '13800007382',
        公司: '浙江邮电',
        施工单位: '浙江邮电',
        授权范围: 'HA楼',
        授权状态: '授权有效',
        关联施工单: ['recOverview'],
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('rejects construction project deletion when the record id is missing', async () => {
    const del = jest.fn();
    const service = createServiceWithAxios({ delete: del });

    await expect(
      service.deleteConstructionProject({
        recordId: '',
        constructionCode: 'SG260605-1031',
      }),
    ).rejects.toThrow('缺少施工总览记录 ID');
    expect(del).not.toHaveBeenCalled();
  });

  it('returns a real pending sync task before construction project delete preparation settles', async () => {
    const service = createServiceWithAxios({});
    let resolvePreparation:
      | ((value: {
          recordId: string;
          constructionCode: string;
          tenantAccessToken: string;
          overviewAppToken: string;
          followupAppToken: string;
          crewLedgerAppToken: string;
          crewLedgerConfig: Record<string, unknown>;
        }) => void)
      | null = null;
    service.prepareConstructionProjectDelete = jest.fn(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    service.deleteConstructionProjectNow = jest.fn(async () => ({
      success: true,
      recordId: 'recOverview',
      constructionCode: 'SG260605-1031',
      deleted: {
        overview: 1,
        followups: 2,
        crewLedger: 3,
        crewLedgerViews: 1,
      },
      message: 'deleted',
    }));

    const pending = service.deleteConstructionProject({
      recordId: 'recOverview',
      constructionCode: 'SG260605-1031',
    });
    const earlyResult = await Promise.race([
      pending,
      Promise.resolve('still-waiting' as const),
    ]);

    expect(earlyResult).not.toBe('still-waiting');
    if (earlyResult === 'still-waiting') {
      return;
    }
    expect(earlyResult).toMatchObject({
      pending: true,
      taskId: expect.stringMatching(/^construction-/),
    });
    expect(service.getSyncTask(earlyResult.taskId || '')).toMatchObject({
      status: 'pending',
    });
    expect(service.prepareConstructionProjectDelete).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));
    expect(service.prepareConstructionProjectDelete).toHaveBeenCalledTimes(1);
    resolvePreparation?.({
      recordId: 'recOverview',
      constructionCode: 'SG260605-1031',
      tenantAccessToken: 'tenant-token',
      overviewAppToken: 'overviewApp',
      followupAppToken: 'followupApp',
      crewLedgerAppToken: 'crewApp',
      crewLedgerConfig: (service as any).constructionCrewLedgerConfig,
    });
    await waitForCondition(
      () =>
        service.getSyncTask(earlyResult.taskId || '')?.status === 'completed',
      'construction delete task completion',
    );

    expect(service.getSyncTask(earlyResult.taskId || '')).toMatchObject({
      status: 'completed',
      total: 7,
      failed: 0,
      result: expect.objectContaining({
        recordId: 'recOverview',
      }),
    });
  });

  it.each(['prepare', 'delete'] as const)(
    'marks the construction project delete task failed when %s fails',
    async (failureStage) => {
      const service = createServiceWithAxios({});
      const prepared = {
        recordId: 'recOverview',
        constructionCode: 'SG260605-1031',
        tenantAccessToken: 'tenant-token',
        overviewAppToken: 'overviewApp',
        followupAppToken: 'followupApp',
        crewLedgerAppToken: 'crewApp',
        crewLedgerConfig: (service as any).constructionCrewLedgerConfig,
      };
      service.prepareConstructionProjectDelete =
        failureStage === 'prepare'
          ? jest.fn(async () => {
              throw new Error('prepare failed');
            })
          : jest.fn(async () => prepared);
      service.deleteConstructionProjectNow =
        failureStage === 'delete'
          ? jest.fn(async () => {
              throw new Error('delete failed');
            })
          : jest.fn();

      const result = await service.deleteConstructionProject({
        recordId: 'recOverview',
        constructionCode: 'SG260605-1031',
      });
      await waitForCondition(
        () => service.getSyncTask(result.taskId || '')?.status === 'failed',
        `construction delete ${failureStage} failure`,
      );

      expect(service.getSyncTask(result.taskId || '')).toMatchObject({
        status: 'failed',
        failed: 1,
        message: expect.stringContaining(`${failureStage} failed`),
      });
      expect(service.getSyncTask(result.taskId || '')?.endTime).toBeInstanceOf(
        Date,
      );
    },
  );

  it('deletes only overview, followups, and crew ledger records for the selected project', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords
      .mockResolvedValueOnce([
        { record_id: 'recOverview', fields: { 施工编码: 'SG260605-1031' } },
        { record_id: 'recOther', fields: { 施工编码: 'SG260605-9999' } },
      ])
      .mockResolvedValueOnce([
        { record_id: 'recFollowByCode', fields: { 施工编码: 'SG260605-1031' } },
        { record_id: 'recFollowByLink', fields: { 施工总览: ['recOverview'] } },
        { record_id: 'recFollowOther', fields: { 施工编码: 'SG260605-9999' } },
      ])
      .mockResolvedValueOnce([
        { record_id: 'recCrewByCode', fields: { 施工编码: 'SG260605-1031' } },
        { record_id: 'recCrewByLink', fields: { 关联施工单: ['recOverview'] } },
        { record_id: 'recCrewOther', fields: { 施工编码: 'SG260605-9999' } },
      ]);
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recOverview',
            fields: { 施工编码: 'SG260605-1031' },
          },
        },
      },
    });
    const del = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, delete: del });
    service.rememberRecentConstructionOverviewRecord({
      record_id: 'recOverview',
      fields: { 作业内容: '待删除测试项目' },
    });

    const result = await service.deleteConstructionProject({
      recordId: 'recOverview',
      constructionCode: 'SG260605-1031',
    });

    expect(result).toEqual(
      expect.objectContaining({
        pending: true,
        deleted: {
          overview: 0,
          followups: 0,
          crewLedger: 0,
          crewLedgerViews: 0,
        },
      }),
    );
    await flushBackgroundTasks();
    expect(del).toHaveBeenCalledTimes(5);
    expect(result.deleted).toEqual({
      overview: 0,
      followups: 0,
      crewLedger: 0,
      crewLedgerViews: 0,
    });
    const deletedUrls = del.mock.calls.map(([url]) => String(url));
    expect(deletedUrls.join('\n')).toContain('recFollowByCode');
    expect(deletedUrls.join('\n')).toContain('recFollowByLink');
    expect(deletedUrls.join('\n')).toContain('recCrewByCode');
    expect(deletedUrls.join('\n')).toContain('recCrewByLink');
    expect(deletedUrls.join('\n')).toContain('recOverview');
    expect(deletedUrls.join('\n')).not.toContain('recFollowOther');
    expect(deletedUrls.join('\n')).not.toContain('recCrewOther');
    expect(
      (service as any).recentConstructionOverviewRecords.has('recOverview'),
    ).toBe(false);
  });

  it('refuses deletion when the construction code is duplicated in overview records', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      { record_id: 'recOverview', fields: { 施工编码: 'SG260605-1031' } },
      { record_id: 'recOther', fields: { 施工编码: 'SG260605-1031' } },
    ]);
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recOverview',
            fields: { 施工编码: 'SG260605-1031' },
          },
        },
      },
    });
    const del = jest.fn();
    const service = createServiceWithAxios({ get, delete: del });

    const result = await service.deleteConstructionProject({
      recordId: 'recOverview',
      constructionCode: 'SG260605-1031',
    });
    expect(result).toMatchObject({
      pending: true,
      taskId: expect.stringMatching(/^construction-/),
    });
    await waitForCondition(
      () => service.getSyncTask(result.taskId || '')?.status === 'failed',
      'duplicate construction code rejection',
    );

    expect(service.getSyncTask(result.taskId || '')).toMatchObject({
      status: 'failed',
      failed: 1,
      message: expect.stringContaining('施工编码重复'),
    });
    expect(del).not.toHaveBeenCalled();
  });

  it('creates an initial follow-up record with application attachments for a new construction application', async () => {
    const service = createServiceWithAxios({});
    (service as any).constructionFollowupConfig = {
      appToken: 'overviewApp',
      wikiToken: '',
      tableId: 'tblFollowup',
      viewId: '',
      tableName: '施工进展跟进',
      sourceUrl: '',
    };
    service.resolveConstructionChangeLinkRecordId = jest.fn(async () => null);
    service.createBitableRecord = jest.fn(
      async (
        _appToken: string,
        tableId: string,
        _tableName: string,
        _fields: Record<string, unknown>,
      ) =>
        tableId === 'tblOverview' ? 'recNewOverview' : 'recInitialFollowup',
    );
    service.uploadConstructionAttachment = jest.fn(
      async (
        _tenantAccessToken: string,
        _appToken: string,
        file: { originalname: string },
      ) => `tok-${file.originalname}`,
    );
    service.ensureConstructionCrewLedgerProjectViewFromOverviewRecord = jest.fn(
      async () => 'SG260605-1036',
    );
    service.syncConstructionCrewRosterFilesToLedger = jest.fn(async () => ({
      parsed: 1,
      created: 1,
      updated: 0,
      records: [{ recordId: 'recCrewLedger' }],
      members: [{ recordId: 'recCrewLedger', name: '张鹏' }],
    }));
    service.runConstructionCrewRosterCertificateBatchCheck = jest.fn(
      async () => ({ summary: '完成', checked: 1, updated: 1, skipped: 0 }),
    );
    const crewRosterBuffer = buildCrewRosterWorkbookBuffer();

    const result = await service.createConstructionApplication(
      {
        workContent: '测试-A',
        building: 'A楼',
        specialty: '其他',
        workTypes: ['一般作业', '动火作业'],
        contractorType: '外部',
        planStartTime: '2026-06-01T09:00',
        planEndTime: '2026-07-31T18:00',
        authorizationStartDate: '2026-06-01',
        authorizationEndDate: '2026-07-31',
        depositPaid: '是',
        depositAmount: 20000,
        constructionApplicantId: 'ou_applicant',
      },
      [
        {
          fieldname: 'applicationFiles',
          originalname: '施工申请单.pdf',
          mimetype: 'application/pdf',
          buffer: Buffer.from('application'),
          size: 11,
        },
        {
          fieldname: 'crewRosterFiles',
          originalname: '施工人员名单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: crewRosterBuffer,
          size: crewRosterBuffer.length,
        },
      ],
    );

    expect(service.uploadConstructionAttachment).toHaveBeenCalledTimes(2);
    expect(service.createBitableRecord).toHaveBeenCalledTimes(2);

    const overviewFields = service.createBitableRecord.mock.calls[0][3];
    const overviewCreateOptions = service.createBitableRecord.mock.calls[0][5];
    expect(overviewFields).toEqual(
      expect.objectContaining({
        新建施工单提交: true,
        [CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS.applicationFiles]: [
          { file_token: 'tok-施工申请单.pdf' },
        ],
        [CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS.crewRosterFiles]: [
          { file_token: 'tok-施工人员名单.xlsx' },
        ],
      }),
    );
    expect(overviewCreateOptions).toEqual({
      optionalMissingFieldNames: expect.arrayContaining(['新建施工单提交']),
    });

    const followupFields = service.createBitableRecord.mock.calls[1][3];
    expect(followupFields).toEqual(
      expect.objectContaining({
        施工总览: ['recNewOverview'],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles]: [
          { file_token: 'tok-施工申请单.pdf' },
        ],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.crewRosterFiles]: [
          { file_token: 'tok-施工人员名单.xlsx' },
        ],
      }),
    );
    expect(followupFields).not.toHaveProperty(
      CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS.crewRosterFiles,
    );
    expect(result).toEqual(
      expect.objectContaining({
        recordId: 'recNewOverview',
        initialFollowupRecordId: 'recInitialFollowup',
      }),
    );
    expect(service.syncConstructionCrewRosterFilesToLedger).toHaveBeenCalled();
    expect(
      service.syncConstructionCrewRosterFilesToLedger,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationStartDate: '2026-06-01',
        authorizationEndDate: '2026-07-31',
      }),
    );
    expect(
      service.runConstructionCrewRosterCertificateBatchCheck,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        overviewRecordId: 'recNewOverview',
      }),
    );
  });

  it('deduplicates concurrent and completed construction application writes by client mutation id', async () => {
    const service = createServiceWithAxios({});
    let resolveCreate:
      | ((value: {
          success: true;
          recordId: string;
          recordUrl: null;
          initialFollowupRecordId: string;
          initialFollowupRecordUrl: null;
          message: string;
        }) => void)
      | null = null;
    service.createConstructionApplicationNow = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const request = {
      clientMutationId: 'application-mutation-1',
      workContent: 'test',
      building: 'A',
      specialty: 'other',
      workTypes: ['general'],
      contractorType: 'external',
      planStartTime: '2026-07-24T09:00',
      planEndTime: '2026-07-24T18:00',
    } as any;

    const first = service
      .createConstructionApplication(request, [])
      .catch((error) => error);
    const second = service
      .createConstructionApplication(request, [])
      .catch((error) => error);
    await Promise.resolve();

    expect(service.createConstructionApplicationNow).toHaveBeenCalledTimes(1);
    resolveCreate?.({
      success: true,
      recordId: 'recApplication',
      recordUrl: null,
      initialFollowupRecordId: 'recFollowup',
      initialFollowupRecordUrl: null,
      message: 'created',
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const completedResult = await service.createConstructionApplication(
      request,
      [],
    );

    expect(firstResult).toEqual(secondResult);
    expect(completedResult).toEqual(firstResult);
    expect(service.createConstructionApplicationNow).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent and completed construction follow-up writes by client mutation id', async () => {
    const service = createServiceWithAxios({});
    let resolveCreate:
      | ((value: {
          success: true;
          recordId: string;
          recordUrl: null;
          constructionRecordId: string;
          updated: false;
          attachmentSyncPending: false;
          message: string;
        }) => void)
      | null = null;
    service.createConstructionFollowupNow = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const request = {
      clientMutationId: 'followup-mutation-1',
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: ['general'],
    } as any;

    const first = service.createConstructionFollowup(request);
    const second = service.createConstructionFollowup(request);
    await Promise.resolve();

    expect(service.createConstructionFollowupNow).toHaveBeenCalledTimes(1);
    resolveCreate?.({
      success: true,
      recordId: 'recFollowup',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      updated: false,
      attachmentSyncPending: false,
      message: 'created',
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const completedResult = await service.createConstructionFollowup(request);

    expect(firstResult).toEqual(secondResult);
    expect(completedResult).toEqual(firstResult);
    expect(service.createConstructionFollowupNow).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-flight construction mutation id reused with different file content', async () => {
    const service = createServiceWithAxios({});
    let resolveCreate:
      | ((value: {
          success: true;
          recordId: string;
          recordUrl: null;
          constructionRecordId: string;
          updated: false;
          attachmentSyncPending: false;
          message: string;
        }) => void)
      | null = null;
    service.createConstructionFollowupNow = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const request = {
      clientMutationId: 'followup-inflight-conflict-1',
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: ['general'],
    } as any;
    const file = (content: string) => ({
      fieldname: 'applicationFiles',
      originalname: 'same-name.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from(content),
      size: 4,
    });

    const first = service.createConstructionFollowup(request, [file('aaaa')]);
    const conflicting = service
      .createConstructionFollowup(request, [file('bbbb')])
      .then(
        () => 'unexpected-success' as const,
        (error) => error as Error,
      );
    await Promise.resolve();
    resolveCreate?.({
      success: true,
      recordId: 'recFirst',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      updated: false,
      attachmentSyncPending: false,
      message: 'created',
    });

    await expect(first).resolves.toMatchObject({ recordId: 'recFirst' });
    const conflictResult = await conflicting;
    expect(conflictResult).toBeInstanceOf(Error);
    expect((conflictResult as Error).message).toContain('请求内容冲突');
    expect(service.createConstructionFollowupNow).toHaveBeenCalledTimes(1);
  });

  it('rejects a completed construction mutation id reused with a different request', async () => {
    const service = createServiceWithAxios({});
    service.createConstructionFollowupNow = jest.fn(async () => ({
      success: true,
      recordId: 'recFirst',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      updated: false,
      attachmentSyncPending: false,
      message: 'created',
    }));
    const firstRequest = {
      clientMutationId: 'followup-completed-conflict-1',
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: ['general'],
    } as any;

    await expect(
      service.createConstructionFollowup(firstRequest),
    ).resolves.toMatchObject({ recordId: 'recFirst' });
    await expect(
      service.createConstructionFollowup({
        ...firstRequest,
        workTypes: ['hot-work'],
      }),
    ).rejects.toThrow('请求内容冲突');
    expect(service.createConstructionFollowupNow).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed construction mutation and allows a retry', async () => {
    const service = createServiceWithAxios({});
    service.createConstructionFollowupNow = jest
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({
        success: true,
        recordId: 'recFollowup',
        recordUrl: null,
        constructionRecordId: 'recOverview',
        updated: false,
        attachmentSyncPending: false,
        message: 'created',
      });
    const request = {
      clientMutationId: 'followup-retry-1',
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: ['general'],
    } as any;

    await expect(service.createConstructionFollowup(request)).rejects.toThrow(
      'write failed',
    );
    await expect(
      service.createConstructionFollowup(request),
    ).resolves.toMatchObject({ recordId: 'recFollowup' });
    expect(service.createConstructionFollowupNow).toHaveBeenCalledTimes(2);
  });

  it('isolates application and follow-up idempotency namespaces', async () => {
    const service = createServiceWithAxios({});
    service.createConstructionApplicationNow = jest.fn(async () => ({
      success: true,
      recordId: 'recApplication',
      recordUrl: null,
      initialFollowupRecordId: 'recInitialFollowup',
      initialFollowupRecordUrl: null,
      message: 'created',
    }));
    service.createConstructionFollowupNow = jest.fn(async () => ({
      success: true,
      recordId: 'recFollowup',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      updated: false,
      attachmentSyncPending: false,
      message: 'created',
    }));
    const clientMutationId = 'shared-client-mutation-id';

    await Promise.all([
      service.createConstructionApplication({
        clientMutationId,
        workContent: 'test',
        building: 'A',
        specialty: 'other',
        workTypes: ['general'],
        contractorType: 'external',
        planStartTime: '2026-07-24T09:00',
        planEndTime: '2026-07-24T18:00',
      } as any),
      service.createConstructionFollowup({
        clientMutationId,
        constructionRecordId: 'recOverview',
        followupMode: 'supplemental',
        workTypes: ['general'],
      } as any),
    ]);

    expect(service.createConstructionApplicationNow).toHaveBeenCalledTimes(1);
    expect(service.createConstructionFollowupNow).toHaveBeenCalledTimes(1);
  });

  it('runs different construction mutation ids concurrently', async () => {
    const service = createServiceWithAxios({});
    const resolvers: Array<
      (value: {
        success: true;
        recordId: string;
        recordUrl: null;
        constructionRecordId: string;
        updated: false;
        attachmentSyncPending: false;
        message: string;
      }) => void
    > = [];
    service.createConstructionFollowupNow = jest.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = service.createConstructionFollowup({
      clientMutationId: 'followup-parallel-1',
      constructionRecordId: 'recOverview',
    } as any);
    const second = service.createConstructionFollowup({
      clientMutationId: 'followup-parallel-2',
      constructionRecordId: 'recOverview',
    } as any);
    await Promise.resolve();

    expect(service.createConstructionFollowupNow).toHaveBeenCalledTimes(2);
    resolvers.forEach((resolve, index) =>
      resolve({
        success: true,
        recordId: `recFollowup${index}`,
        recordUrl: null,
        constructionRecordId: 'recOverview',
        updated: false,
        attachmentSyncPending: false,
        message: 'created',
      }),
    );
    await Promise.all([first, second]);
  });

  it('starts the local certificate service and retries when the first trigger cannot connect', async () => {
    const connectionError = Object.assign(new Error('connect refused'), {
      code: 'ECONNREFUSED',
    });
    const post = jest
      .fn()
      .mockRejectedValueOnce(connectionError)
      .mockResolvedValueOnce({
        data: { status: 'accepted', task_id: 'taskAutoStart' },
      });
    const service = createServiceWithAxios({ post });
    service.startConstructionCertificateService = jest.fn(async () => true);

    await service.triggerConstructionCertificateQueryFromFollowup({
      followupRecordId: 'recFollowup',
    });

    expect(service.startConstructionCertificateService).toHaveBeenCalledWith(
      'http://127.0.0.1:58000',
    );
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      'http://127.0.0.1:58000/api/ui/certificate/trigger',
      { record_id: 'recFollowup' },
      { timeout: 10000 },
    );
  });

  it('updates the same daily follow-up record for the same project on the same day', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      {
        record_id: 'recTodayFollowup',
        created_time: new Date().toISOString(),
        fields: {
          施工编码: 'SG260605-1031',
          施工总览: ['recOverview'],
        },
      },
    ]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      施工过程照片: [{ file_token: 'tokProcess' }],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.createBitableRecord = jest.fn(async () => 'recNewFollowup');
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recTodayFollowup',
      created_time: new Date().toISOString(),
      fields: {
        施工编码: 'SG260605-1031',
        施工总览: ['recOverview'],
      },
    }));
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.syncConstructionCrewRosterFilesToLedger = jest.fn(async () => ({
      parsed: 1,
      created: 0,
      updated: 1,
    }));
    const crewRosterBuffer = buildCrewRosterWorkbookBuffer();

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: '过程正常',
        checklistConstructionCode: 'SG260605-1031',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('new-photo'),
          size: 9,
        },
      ],
    );
    await flushBackgroundTasks();

    expect(service.createBitableRecord).not.toHaveBeenCalled();
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recTodayFollowup',
      expect.objectContaining({
        施工过程照片: [{ file_token: 'tokProcess' }],
      }),
      'tenant-token',
      expect.any(Object),
    );
    expect(result.updated).toBe(true);
    expect(result.recordId).toBe('recTodayFollowup');
  });

  it('does not rewrite unchanged follow-up staff when updating an existing daily record', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      {
        record_id: 'recTodayFollowup',
        created_time: new Date().toISOString(),
        fields: {
          施工编码: 'SG260605-1031',
          施工总览: ['recOverview'],
          跟进人员: [{ id: 'ou_1', name: '示例人员006' }],
        },
      },
    ]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      施工过程照片: [{ file_token: 'tokProcess' }],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: '过程正常',
        checklistConstructionCode: 'SG260605-1031',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('new-photo'),
          size: 9,
        },
      ],
    );

    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recTodayFollowup',
      expect.not.objectContaining({
        跟进人员: expect.anything(),
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('re-audits permit-only uploads even when the same permit file is already attached', async () => {
    const existingBuffer = Buffer.from('same-hot-work-permit');
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recTodayFollowup',
      created_time: new Date().toISOString(),
      fields: {
        施工总览: ['recOverview'],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles]: [
          {
            file_token: 'tokExistingHotWork',
            name: 'hot-work.jpg',
            size: existingBuffer.length,
          },
        ],
      },
    }));
    service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
      async () => [],
    );
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [],
    );
    service.downloadConstructionAttachment = jest.fn(async () => ({
      buffer: existingBuffer,
    }));
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({}));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    const hotWorkFeedback =
      '核验日期：2026-06-06；结论：通过；有效期至：2026-06-08；问题：无';
    service.auditConstructionPermitAttachments = jest.fn(async () => ({
      [hotWorkFeedbackField]: hotWorkFeedback,
    }));

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupRecordId: 'recTodayFollowup',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        permitOnlyUpload: 'true',
        checklistConstructionCode: 'SG260605-1035',
        workTypes: ['一般作业', '动火作业'],
      },
      [
        {
          fieldname: 'hotWorkPermitFiles',
          originalname: 'hot-work.jpg',
          mimetype: 'image/jpeg',
          buffer: existingBuffer,
          size: existingBuffer.length,
        },
      ],
    );

    expect(result.attachmentSyncPending).toBe(true);
    await waitForCondition(
      () =>
        service.uploadConstructionAttachmentFieldValues.mock.calls.length > 0 &&
        service.auditConstructionPermitAttachments.mock.calls.length > 0,
      'permit-only upload and audit start',
    );
    expect(
      service.uploadConstructionAttachmentFieldValues,
    ).toHaveBeenCalledWith(
      'tenant-token',
      'followupApp',
      [
        expect.objectContaining({
          fieldname: 'hotWorkPermitFiles',
          originalname: 'hot-work.jpg',
        }),
      ],
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
    );
    expect(service.auditConstructionPermitAttachments).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          fieldname: 'hotWorkPermitFiles',
          originalname: 'hot-work.jpg',
        }),
      ],
      ['一般作业', '动火作业'],
      expect.any(Date),
      expect.objectContaining({
        workTypes: ['一般作业', '动火作业'],
      }),
    );
    await waitForCondition(
      () =>
        service.updateBitableRecordFields.mock.calls.some(
          (call: unknown[]) =>
            (call[4] as Record<string, unknown>)?.[hotWorkFeedbackField] ===
            hotWorkFeedback,
        ),
      'permit-only audit feedback backfill',
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recTodayFollowup',
      expect.objectContaining({
        [hotWorkFeedbackField]: hotWorkFeedback,
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('writes follow-up staff when an existing daily record has no staff value', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      {
        record_id: 'recTodayFollowupWithoutStaff',
        created_time: new Date().toISOString(),
        fields: {
          施工编码: 'SG260605-1031',
          施工总览: ['recOverview'],
        },
      },
    ]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      施工过程照片: [{ file_token: 'tokProcess' }],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: '过程正常',
        checklistConstructionCode: 'SG260605-1031',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('new-photo'),
          size: 9,
        },
      ],
    );

    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recTodayFollowupWithoutStaff',
      expect.objectContaining({
        跟进人员: [{ id: 'ou_1' }],
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('does not fail daily prepare submission when crew ledger view sync fails', async () => {
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '\u65bd\u5de5\u9879\u76ee\u603b\u89c8',
      sourceUrl: '',
    };
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recTodayFollowup',
      created_time: new Date().toISOString(),
      fields: {
        施工总览: ['recOverview'],
        挂牌与隔离照片: [{ file_token: 'tokIsolation' }],
      },
    }));
    service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
      async () => [],
    );
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      每日人员核查清单: [{ file_token: 'tokChecklist' }],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.ensureConstructionCrewLedgerProjectView = jest.fn(async () => {
      throw new Error('crew ledger view sync failed');
    });

    await expect(
      service.createConstructionFollowup({
        constructionRecordId: 'recOverview',
        followupRecordId: 'recTodayFollowup',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        checklistConstructionCode: 'SG260605-1035',
        checklistWorkContent: '\u6d4b\u8bd5-A',
        checklistBuilding: 'A\u697c',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck:
          '\u5df2\u6838\u5bf9\u65bd\u5de5\u4eba\u5458\u53f0\u8d26\uff1b\u4eca\u65e51\u4eba\u53c2\u4e0e\u65bd\u5de5',
        dailyCrewMembers: JSON.stringify([
          {
            recordId: 'recCrew1',
            name: '\u6731\u58eb\u5b9d',
            certificateSummary: null,
            complianceStatus: null,
            issueSummary: null,
          },
        ]),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        recordId: 'recTodayFollowup',
        updated: true,
      }),
    );

    expect(service.updateBitableRecordFields).toHaveBeenCalled();
    await flushBackgroundTasks();
    expect(
      service.ensureConstructionCrewLedgerProjectView,
    ).toHaveBeenCalledWith('SG260605-1035', 'tenant-token');
  });

  it('rejects daily prepare submission when selected crew lacks required work certificate', async () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [
        {
          fields: {
            作业类型: ['临时用电作业'],
            所需作业证: ['低压电工证'],
          },
        },
      ],
    );
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({}));
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    await expect(
      service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          followupStaffIds: ['ou_1'],
          workTypes: ['临时用电作业'],
          dailyPersonnelCheck: '已核对施工人员台账',
          dailyCrewMembers: JSON.stringify([
            {
              recordId: 'recCrew1',
              name: '示例人员008',
              certificateSummary: '高处作业证',
              complianceStatus: null,
              issueSummary: null,
            },
          ]),
        },
        [
          {
            fieldname: 'isolationPhotoFiles',
            originalname: '挂牌隔离.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('photo'),
            size: 5,
          },
        ],
      ),
    ).rejects.toThrow('临时用电作业缺低压/高压证，无法提交');

    expect(
      service.uploadConstructionAttachmentFieldValues,
    ).not.toHaveBeenCalled();
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
  });

  it('rejects focused personnel checks until daily work types are explicitly confirmed', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as {
      extractDisplayValues: jest.Mock;
      fetchBitableRecords: jest.Mock;
    };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    bitableDirectRead.extractDisplayValues.mockImplementation(
      (value: unknown) =>
        Array.isArray(value)
          ? value.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
    );

    try {
      const service = createServiceWithAxios({});
      (service as any).constructionOverviewConfig = {
        appToken: '',
        wikiToken: '',
        tableId: '',
        viewId: '',
        tableName: '施工项目总览',
        sourceUrl: '',
      };
      service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
        async () => [
          {
            fields: {
              作业类型: ['临时用电作业'],
              所需作业证: ['低压电工证'],
            },
          },
        ],
      );
      service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
        record_id: 'recTodayFollowup',
        created_time: new Date().toISOString(),
        fields: {
          施工总览: ['recOverview'],
          作业类型: ['临时用电作业'],
        },
      }));
      service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
        async () => [],
      );
      service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
        每日人员核查清单: [{ file_token: 'tokChecklist' }],
      }));
      service.auditConstructionIsolationPhotos = jest.fn(async () => null);
      service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
      service.updateBitableRecordFields = jest.fn(async () => undefined);
      service.ensureConstructionFollowupOverviewLink = jest.fn(
        async () => undefined,
      );
      service.ensureConstructionCrewLedgerProjectView = jest.fn(
        async () => undefined,
      );

      let submissionError: unknown;
      try {
        await service.createConstructionFollowup({
          constructionRecordId: 'recOverview',
          followupRecordId: 'recTodayFollowup',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          partialDailySubmit: 'true',
          dailyChecklistFocus: 'personnel',
          followupStaffIds: ['ou_1'],
          workTypes: ['临时用电作业'],
          dailyPersonnelCheck: '已核对施工人员台账',
          dailyCrewMembers: JSON.stringify([
            {
              recordId: 'recCrew1',
              name: '示例人员008',
              certificateSummary: '低压电工证',
            },
          ]),
        });
      } catch (error) {
        submissionError = error;
      }
      await flushBackgroundTasks();

      expect(submissionError).toBeInstanceOf(Error);
      expect((submissionError as Error).message).toBe(
        '请先完成当天作业类型校核',
      );
      expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    } finally {
      bitableDirectRead.extractDisplayValues.mockImplementation(() => []);
    }
  });

  it('audits focused personnel checks against persisted daily work types without overwriting them', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as {
      extractDisplayValues: jest.Mock;
      fetchBitableRecords: jest.Mock;
    };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    bitableDirectRead.extractDisplayValues.mockImplementation(
      (value: unknown) =>
        Array.isArray(value)
          ? value.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
    );

    try {
      const service = createServiceWithAxios({});
      (service as any).constructionOverviewConfig = {
        appToken: '',
        wikiToken: '',
        tableId: '',
        viewId: '',
        tableName: '施工项目总览',
        sourceUrl: '',
      };
      service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
        async () => [
          {
            fields: {
              作业类型: ['临时用电作业'],
              所需作业证: ['低压电工证'],
            },
          },
          {
            fields: {
              作业类型: ['高处作业'],
              所需作业证: ['高处作业证'],
            },
          },
        ],
      );
      service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
        record_id: 'recTodayFollowup',
        created_time: new Date().toISOString(),
        fields: {
          施工总览: ['recOverview'],
          当日作业类型: ['临时用电作业'],
        },
      }));
      service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
        async () => [],
      );
      service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
        每日人员核查清单: [{ file_token: 'tokChecklist' }],
      }));
      service.auditConstructionIsolationPhotos = jest.fn(async () => null);
      service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
      service.updateBitableRecordFields = jest.fn(async () => undefined);
      service.ensureConstructionFollowupOverviewLink = jest.fn(
        async () => undefined,
      );
      service.ensureConstructionCrewLedgerProjectView = jest.fn(
        async () => undefined,
      );

      await expect(
        service.createConstructionFollowup({
          constructionRecordId: 'recOverview',
          followupRecordId: 'recTodayFollowup',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          partialDailySubmit: 'true',
          dailyChecklistFocus: 'personnel',
          followupStaffIds: ['ou_1'],
          workTypes: ['高处作业'],
          dailyPersonnelCheck: '已核对施工人员台账',
          dailyCrewMembers: JSON.stringify([
            {
              recordId: 'recCrew1',
              name: '示例人员008',
              certificateSummary: '低压电工证',
            },
          ]),
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          success: true,
          recordId: 'recTodayFollowup',
          updated: true,
        }),
      );
      await flushBackgroundTasks();

      const followupUpdates = service.updateBitableRecordFields.mock.calls
        .filter((call: unknown[]) => call[3] === 'recTodayFollowup')
        .map((call: unknown[]) => call[4] as Record<string, unknown>);
      expect(followupUpdates.length).toBeGreaterThan(0);
      expect(followupUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            'AI审核结果-每日人员核查': '通过',
          }),
        ]),
      );
      expect(
        followupUpdates.some((fields: Record<string, unknown>) =>
          Object.prototype.hasOwnProperty.call(fields, '当日作业类型'),
        ),
      ).toBe(false);
    } finally {
      bitableDirectRead.extractDisplayValues.mockImplementation(() => []);
    }
  });

  it('does not run personnel certificate blocking for focused isolation submissions', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [
        {
          fields: {
            作业类型: ['高处作业'],
            所需作业证: ['高处作业证'],
          },
        },
      ],
    );
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
        { file_token: 'tokIsolation' },
      ],
    }));
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    await expect(
      service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          partialDailySubmit: 'true',
          dailyChecklistFocus: 'isolation',
          workTypes: ['高处作业'],
        },
        [
          {
            fieldname: 'isolationPhotoFiles',
            originalname: '挂牌隔离.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('photo'),
            size: 5,
          },
        ],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        recordId: 'recTodayFollowup',
      }),
    );

    expect(
      service.fetchConstructionPermitAuditRequirementRecords,
    ).not.toHaveBeenCalled();
    await waitForCondition(
      () =>
        service.uploadConstructionAttachmentFieldValues.mock.calls.length > 0,
      'focused isolation attachment upload',
    );
    expect(service.uploadConstructionAttachmentFieldValues).toHaveBeenCalled();
  });

  it('starts daily prepare audits before attachment upload finishes', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'overview',
      sourceUrl: '',
    };
    let resolveUpload:
      | ((value: Record<string, Array<{ file_token: string }>>) => void)
      | null = null;
    service.uploadConstructionAttachmentFieldValues = jest.fn(
      () =>
        new Promise<Record<string, Array<{ file_token: string }>>>(
          (resolve) => {
            resolveUpload = resolve;
          },
        ),
    );
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const pending = service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck: 'checked',
      },
      [
        {
          fieldname: 'dailyPersonnelChecklistFiles',
          originalname: 'crew.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: Buffer.from('checklist'),
          size: 9,
        },
        {
          fieldname: 'isolationPhotoFiles',
          originalname: 'isolation.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
    );
    const result = await pending;
    expect(result.recordId).toBe('recTodayFollowup');
    expect(resolveUpload).toBeNull();
    expect(service.auditConstructionIsolationPhotos).not.toHaveBeenCalled();
    expect(service.auditConstructionPermitAttachments).not.toHaveBeenCalled();

    await waitForCondition(
      () => Boolean(resolveUpload),
      'daily prepare attachment upload start',
    );
    try {
      expect(service.auditConstructionIsolationPhotos).toHaveBeenCalled();
      expect(service.auditConstructionPermitAttachments).toHaveBeenCalled();
    } finally {
      resolveUpload?.({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles]:
          [{ file_token: 'tokChecklist' }],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
          { file_token: 'tokIsolation' },
        ],
      });
      await flushBackgroundTasks();
    }
  });

  it('returns after saving daily prepare attachments before AI audit resolves', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    let resolveIsolationAudit: ((value: string | null) => void) | null = null;
    service.auditConstructionIsolationPhotos = jest.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveIsolationAudit = resolve;
        }),
    );
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles]: [
        { file_token: 'tokChecklist' },
      ],
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
        { file_token: 'tokIsolation' },
      ],
    }));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    let settled = false;
    const pending = service
      .createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          followupStaffIds: ['ou_1'],
          dailyPersonnelCheck: '已核对施工人员台账',
        },
        [
          {
            fieldname: 'isolationPhotoFiles',
            originalname: '挂牌.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('photo'),
            size: 5,
          },
        ],
      )
      .then((result) => {
        settled = true;
        return result;
      });

    const result = await pending;
    const settledBeforeAudit = settled;

    expect(settledBeforeAudit).toBe(true);
    expect(result.recordId).toBe('recTodayFollowup');
    expect(resolveIsolationAudit).toBeNull();
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      expect.any(String),
      expect.not.objectContaining({
        '挂牌&隔离合规反馈': '隔离审核通过',
      }),
      'tenant-token',
      expect.any(Object),
    );
    await waitForCondition(
      () => Boolean(resolveIsolationAudit),
      'daily prepare isolation audit start',
    );
    try {
      expect(resolveIsolationAudit).toBeTruthy();
    } finally {
      resolveIsolationAudit?.('隔离审核通过');
      await flushBackgroundTasks();
    }
  });

  it('returns a partial daily follow-up after the core write before personnel workbook generation and audit start', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { extractDisplayValues: jest.Mock };
    bitableDirectRead.extractDisplayValues.mockImplementation(
      (value: unknown) =>
        Array.isArray(value)
          ? value.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
    );
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recTodayFollowup',
      created_time: new Date().toISOString(),
      fields: {
        construction: ['recOverview'],
        当日作业类型: ['一般作业'],
      },
    }));
    service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
      async () => [],
    );
    let resolveChecklist:
      | ((value: {
          fieldname: string;
          originalname: string;
          mimetype: string;
          buffer: Buffer;
          size: number;
        }) => void)
      | null = null;
    service.buildDailyPersonnelChecklistUploadFile = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveChecklist = resolve;
        }),
    );
    let resolveAudit:
      | ((value: [string | null, Record<string, string>]) => void)
      | null = null;
    service.auditConstructionFollowupFiles = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveAudit = resolve;
        }),
    );
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles]: [
        { file_token: 'tokChecklist' },
      ],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const pending = service.createConstructionFollowup({
      constructionRecordId: 'recOverview',
      followupRecordId: 'recTodayFollowup',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      dailyChecklistFocus: 'personnel',
      partialDailySubmit: 'true',
      followupStaffIds: ['ou_1'],
      dailyPersonnelCheck: 'checked',
      dailyCrewMembers: JSON.stringify([
        {
          recordId: 'recCrew1',
          name: '示例人员008',
          certificateSummary: '一般作业',
        },
      ]),
    });
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    const earlyResult = await Promise.race([
      pending,
      Promise.resolve('still-waiting' as const),
    ]);

    expect(earlyResult).not.toBe('still-waiting');
    if (earlyResult === 'still-waiting') {
      resolveChecklist?.({
        fieldname: 'dailyPersonnelChecklistFiles',
        originalname: 'daily-personnel.xlsx',
        mimetype:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from('checklist'),
        size: 9,
      });
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }
      resolveAudit?.([null, {}]);
      await pending;
      await flushBackgroundTasks();
      bitableDirectRead.extractDisplayValues.mockImplementation(() => []);
      return;
    }
    expect(earlyResult).toMatchObject({
      recordId: 'recTodayFollowup',
      updated: true,
      attachmentSyncPending: true,
    });
    expect(service.updateBitableRecordFields).toHaveBeenCalledTimes(1);
    expect(
      service.buildDailyPersonnelChecklistUploadFile,
    ).not.toHaveBeenCalled();
    expect(service.auditConstructionFollowupFiles).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));
    expect(
      service.buildDailyPersonnelChecklistUploadFile,
    ).toHaveBeenCalledTimes(1);
    expect(service.auditConstructionFollowupFiles).not.toHaveBeenCalled();
    resolveChecklist?.({
      fieldname: 'dailyPersonnelChecklistFiles',
      originalname: 'daily-personnel.xlsx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('checklist'),
      size: 9,
    });
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
    expect(service.auditConstructionFollowupFiles).toHaveBeenCalledTimes(1);
    resolveAudit?.([null, {}]);
    await flushBackgroundTasks();
    bitableDirectRead.extractDisplayValues.mockImplementation(() => []);
  });

  it('continues user attachment audit and post-save side effects when personnel workbook generation fails', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    service.buildDailyPersonnelChecklistUploadFile = jest.fn(async () => {
      throw new Error('excel download failed');
    });
    service.auditConstructionFollowupFiles = jest.fn(async () => [null, {}]);
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles]: [
        { file_token: 'tokUserChecklist' },
      ],
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
        { file_token: 'tokIsolation' },
      ],
    }));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck: 'checked',
      },
      [
        {
          fieldname: 'dailyPersonnelChecklistFiles',
          originalname: 'user-checklist.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: Buffer.from('user-checklist'),
          size: 14,
        },
        {
          fieldname: 'isolationPhotoFiles',
          originalname: 'isolation.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
    );

    expect(result).toMatchObject({
      success: true,
      recordId: 'recTodayFollowup',
      attachmentSyncPending: true,
    });
    await flushBackgroundTasks();
    await flushBackgroundTasks();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('每日人员核查清单后台生成失败'),
    );
    expect(
      service.uploadConstructionAttachmentFieldValues,
    ).toHaveBeenCalledWith(
      'tenant-token',
      'followupApp',
      expect.arrayContaining([
        expect.objectContaining({
          fieldname: 'dailyPersonnelChecklistFiles',
          originalname: 'user-checklist.xlsx',
        }),
        expect.objectContaining({
          fieldname: 'isolationPhotoFiles',
          originalname: 'isolation.jpg',
        }),
      ]),
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
    );
    expect(service.auditConstructionFollowupFiles).toHaveBeenCalledTimes(1);
    expect(service.ensureConstructionFollowupOverviewLink).toHaveBeenCalledWith(
      'followupApp',
      'recTodayFollowup',
      'recOverview',
      'tenant-token',
    );
    warn.mockRestore();
  });

  it('fails the post-save task when personnel workbook generation fails without a replacement', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { extractDisplayValues: jest.Mock };
    bitableDirectRead.extractDisplayValues.mockImplementation(
      (value: unknown) =>
        Array.isArray(value)
          ? value.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
    );
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recTodayFollowup',
      created_time: new Date().toISOString(),
      fields: {
        construction: ['recOverview'],
        当日作业类型: ['一般作业'],
      },
    }));
    service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
      async () => [],
    );
    service.buildDailyPersonnelChecklistUploadFile = jest.fn(async () => {
      throw new Error('excel download failed without replacement');
    });
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.uploadConstructionAttachmentFieldValues = jest.fn();
    service.syncConstructionFollowupPostSaveSideEffects = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup({
      constructionRecordId: 'recOverview',
      followupRecordId: 'recTodayFollowup',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      dailyChecklistFocus: 'personnel',
      partialDailySubmit: 'true',
      followupStaffIds: ['ou_1'],
      dailyPersonnelCheck: 'checked',
      dailyCrewMembers: JSON.stringify([
        {
          recordId: 'recCrew1',
          name: '示例人员008',
          certificateSummary: '一般作业',
        },
      ]),
    });

    expect(result.taskId).toMatch(/^construction-/);
    await waitForCondition(
      () => service.getSyncTask(result.taskId || '')?.status === 'failed',
      'personnel workbook post-save task failure',
    );
    expect(service.getSyncTask(result.taskId || '')).toMatchObject({
      status: 'failed',
      message: expect.stringContaining(
        'excel download failed without replacement',
      ),
    });
    expect(
      service.uploadConstructionAttachmentFieldValues,
    ).not.toHaveBeenCalled();
    expect(
      service.syncConstructionFollowupPostSaveSideEffects,
    ).not.toHaveBeenCalled();
    bitableDirectRead.extractDisplayValues.mockImplementation(() => []);
  });

  it('returns after saving the follow-up record before attachment upload resolves', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    let resolveUpload:
      | ((value: Record<string, Array<{ file_token: string }>>) => void)
      | null = null;
    service.uploadConstructionAttachmentFieldValues = jest.fn(
      () =>
        new Promise<Record<string, Array<{ file_token: string }>>>(
          (resolve) => {
            resolveUpload = resolve;
          },
        ),
    );
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const pending = service
      .createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage: 'process',
          followupStaffIds: ['ou_1'],
          processFeedback: '过程正常',
        },
        [
          {
            fieldname: 'processPhotoFiles',
            originalname: 'process.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('photo'),
            size: 5,
          },
        ],
      )
      .then((result) => result);

    const earlyResult = await pending;
    expect(earlyResult.recordId).toBe('recTodayFollowup');
    expect(earlyResult.attachmentSyncPending).toBe(true);
    expect(earlyResult.taskId).toMatch(/^construction-/);
    expect(service.getSyncTask(earlyResult.taskId || '')).toMatchObject({
      status: 'pending',
    });
    expect(earlyResult.message).toContain('后台同步');
    expect(resolveUpload).toBeNull();
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      expect.not.objectContaining({
        施工过程照片: [{ file_token: 'tokProcess' }],
      }),
      'tenant-token',
      expect.any(Object),
    );

    await waitForCondition(
      () => Boolean(resolveUpload),
      'follow-up attachment upload start',
    );
    try {
      expect(resolveUpload).toBeTruthy();
    } finally {
      resolveUpload?.({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.processPhotoFiles]: [
          { file_token: 'tokProcess' },
        ],
      });
    }
    await waitForCondition(
      () =>
        service.updateBitableRecordFields.mock.calls.some(
          (call: unknown[]) =>
            (
              call[4] as {
                施工过程照片?: Array<{ file_token?: string }>;
              }
            )?.施工过程照片?.[0]?.file_token === 'tokProcess',
        ),
      'follow-up attachment field backfill',
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recTodayFollowup',
      expect.objectContaining({
        施工过程照片: [{ file_token: 'tokProcess' }],
      }),
      'tenant-token',
      expect.any(Object),
    );
    await waitForCondition(
      () =>
        service.getSyncTask(earlyResult.taskId || '')?.status === 'completed',
      'follow-up post-save task completion',
    );
    expect(service.getSyncTask(earlyResult.taskId || '')).toMatchObject({
      status: 'completed',
      failed: 0,
      result: {
        recordId: 'recTodayFollowup',
        constructionRecordId: 'recOverview',
      },
    });
  });

  it('reports an explicit failed task when follow-up attachment post-save sync fails', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => {
      throw new Error('attachment upload failed');
    });
    service.createBitableRecord = jest.fn(async () => 'recFailedFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: 'normal',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
    );

    expect(result.taskId).toMatch(/^construction-/);
    await waitForCondition(
      () => service.getSyncTask(result.taskId || '')?.status === 'failed',
      'follow-up post-save task failure',
    );
    expect(service.getSyncTask(result.taskId || '')).toMatchObject({
      status: 'failed',
      failed: 1,
      message: expect.stringContaining('attachment upload failed'),
    });
  });

  it('does not download existing attachments before returning for an administrator follow-up upload', async () => {
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recTodayFollowup',
      created_time: new Date().toISOString(),
      fields: {
        施工总览: ['recOverview'],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.processPhotoFiles]: [
          {
            file_token: 'tokExistingProcess',
            name: 'process.jpg',
          },
        ],
      },
    }));
    service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
      async () => [],
    );
    service.downloadConstructionAttachment = jest.fn(async () => {
      throw new Error('existing attachment should not be downloaded on submit');
    });
    service.createBitableRecord = jest.fn(async () => 'recNewFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.processPhotoFiles]: [
        { file_token: 'tokProcess' },
      ],
    }));
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupRecordId: 'recTodayFollowup',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: '过程正常',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
      'admin',
    );

    expect(result).toMatchObject({
      success: true,
      recordId: 'recTodayFollowup',
      attachmentSyncPending: true,
    });
    expect(service.fetchConstructionFollowupRecordById).not.toHaveBeenCalled();
    expect(service.downloadConstructionAttachment).not.toHaveBeenCalled();
  });

  it('returns after saving the follow-up record when overview link backfill resets the connection', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.createBitableRecord = jest.fn(async () => 'recNewFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      施工过程照片: [{ file_token: 'tokProcess' }],
    }));
    service.ensureConstructionFollowupOverviewLink = jest.fn(async () => {
      throw new Error('read ECONNRESET');
    });
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: '过程正常',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
    );

    expect(result).toMatchObject({
      success: true,
      recordId: 'recNewFollowup',
      attachmentSyncPending: true,
    });
    expect(service.createBitableRecord).toHaveBeenCalled();
    await flushBackgroundTasks();
    expect(service.ensureConstructionFollowupOverviewLink).toHaveBeenCalled();
  });

  it('creates a new daily follow-up when the same-day lookup resets the connection', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockRejectedValueOnce(
      new Error('read ECONNRESET'),
    );
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.createBitableRecord = jest.fn(async () => 'recNewFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      施工过程照片: [{ file_token: 'tokProcess' }],
    }));
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: '过程正常',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
    );

    expect(result).toMatchObject({
      success: true,
      recordId: 'recNewFollowup',
      attachmentSyncPending: true,
    });
    expect(service.createBitableRecord).toHaveBeenCalled();
  });

  it('uploads construction attachments concurrently while preserving field order', async () => {
    const service = createServiceWithAxios({});
    const resolvers: Array<() => void> = [];
    const started: string[] = [];
    service.uploadConstructionAttachment = jest.fn(
      async (
        _tenantAccessToken: string,
        _appToken: string,
        file: { originalname: string },
      ) =>
        new Promise<string>((resolve) => {
          started.push(file.originalname);
          resolvers.push(() => resolve(`tok-${file.originalname}`));
        }),
    );
    const flushUploadQueue = async () => {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    };

    const uploadPromise = service.uploadConstructionAttachmentFieldValues(
      'tenant-token',
      'followupApp',
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process-1.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('one'),
          size: 3,
        },
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process-2.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('two'),
          size: 3,
        },
        {
          fieldname: 'closingPhotoFiles',
          originalname: 'close-1.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('three'),
          size: 5,
        },
        {
          fieldname: 'closingPhotoFiles',
          originalname: 'close-2.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('four'),
          size: 4,
        },
      ],
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
    );
    await flushUploadQueue();

    expect(started).toEqual(['process-1.jpg', 'process-2.jpg']);

    resolvers.shift()?.();
    await flushUploadQueue();
    expect(started).toEqual(['process-1.jpg', 'process-2.jpg', 'close-1.jpg']);
    resolvers.shift()?.();
    await flushUploadQueue();
    expect(started).toEqual([
      'process-1.jpg',
      'process-2.jpg',
      'close-1.jpg',
      'close-2.jpg',
    ]);
    resolvers.shift()?.();
    resolvers.shift()?.();
    const result = await uploadPromise;
    expect(
      result[CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.processPhotoFiles],
    ).toEqual([
      { file_token: 'tok-process-1.jpg' },
      { file_token: 'tok-process-2.jpg' },
    ]);
    expect(
      result[CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.closingPhotoFiles],
    ).toEqual([
      { file_token: 'tok-close-1.jpg' },
      { file_token: 'tok-close-2.jpg' },
    ]);
  });

  it('generates the daily close inspection workbook from checklist answers', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    const uploadedFileNames: string[] = [];
    service.uploadConstructionAttachment = jest.fn(
      async (
        _tenantAccessToken: string,
        _appToken: string,
        file: { originalname: string },
      ) => {
        uploadedFileNames.push(file.originalname);
        return `tok-${file.originalname}`;
      },
    );
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.createBitableRecord = jest.fn(async () => 'recCloseFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'close',
        followupStaffIds: ['ou_1'],
        completed: '否',
        completionChecklist: JSON.stringify(
          CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS.map((item) => ({
            key: item.key,
            result: '√',
            remark: '',
          })),
        ),
        checklistConstructionCode: 'SG260505-1040',
        checklistWorkContent: 'EA118-A挖潜机房施工',
        checklistBuilding: 'A楼',
      },
      [
        {
          fieldname: 'closingPhotoFiles',
          originalname: '每日收尾照片.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('close-photo'),
          size: 11,
        },
      ],
    );
    await flushBackgroundTasks();

    expect(uploadedFileNames).toEqual(
      expect.arrayContaining([
        '每日收尾照片.jpg',
        expect.stringContaining('施工每日完工检查表.xlsx'),
      ]),
    );
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      expect.any(String),
      expect.objectContaining({
        EHS施工收尾审批: true,
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          '每日收尾检查清单',
          'EHS施工收尾审批',
        ]),
      }),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recCloseFollowup',
      expect.objectContaining({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.closingPhotoFiles]: [
          { file_token: 'tok-每日收尾照片.jpg' },
        ],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.inspectionFormFiles]: [
          expect.objectContaining({
            file_token: expect.stringContaining('施工每日完工检查表.xlsx'),
          }),
        ],
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('retries construction attachment uploads when Feishu returns a frequency limit', async () => {
    const service = createServiceWithAxios({});
    service.sleep = jest.fn(async () => undefined);
    const operation = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          '施工附件上传失败：request trigger frequency limit: 99991400',
        ),
      )
      .mockResolvedValueOnce('tok-training');

    const token = await service.runConstructionAttachmentUploadWithRetry(
      operation,
      'training.jpg',
    );

    expect(token).toBe('tok-training');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('retries construction attachment uploads when Feishu times out', async () => {
    const service = createServiceWithAxios({});
    service.sleep = jest.fn(async () => undefined);
    const operation = jest
      .fn()
      .mockRejectedValueOnce(
        new Error('施工附件上传失败：connect ETIMEDOUT 198.18.0.78:443'),
      )
      .mockResolvedValueOnce('tok-close-photo');

    const token = await service.runConstructionAttachmentUploadWithRetry(
      operation,
      '每日收尾照片.jpg',
    );

    expect(token).toBe('tok-close-photo');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('preserves HTTP status and retries attachment uploads after Feishu 429', async () => {
    const rateLimitError = Object.assign(
      new Error('Request failed with status code 429'),
      {
        response: {
          status: 429,
          data: { code: 99991400, msg: 'frequency limit' },
        },
      },
    );
    const service = createServiceWithAxios({});
    service.sleep = jest.fn(async () => undefined);
    const wrapped = service.createBitableAttachmentUploadError(
      '变更文档“change-plan.pdf”',
      rateLimitError,
    );
    const operation = jest
      .fn()
      .mockRejectedValueOnce(wrapped)
      .mockResolvedValueOnce('tok-change');

    await expect(
      service.runConstructionAttachmentUploadWithRetry(
        operation,
        'change-plan.pdf',
        '变更文档“change-plan.pdf”',
      ),
    ).resolves.toBe('tok-change');
    expect(
      (wrapped as { response?: { status?: number } }).response?.status,
    ).toBe(429);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('serializes Bitable media uploads and includes the required drive route', async () => {
    let active = 0;
    let maxActive = 0;
    const requestBodies: string[] = [];
    const post = jest.fn(
      async (_url: string, form: { getBuffer: () => Buffer }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        requestBodies.push(form.getBuffer().toString('utf8'));
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          data: {
            code: 0,
            data: { file_token: `tok-${requestBodies.length}` },
          },
        };
      },
    );
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    await Promise.all([
      service.uploadBitableAttachment(
        'tenant-token',
        'changeApp',
        createChangeDocument('change-a.pdf'),
        '变更文档“change-a.pdf”',
      ),
      service.uploadBitableAttachment(
        'tenant-token',
        'changeApp',
        createChangeDocument('change-b.pdf'),
        '变更文档“change-b.pdf”',
      ),
    ]);

    expect(maxActive).toBe(1);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining('name="extra"'),
        expect.stringContaining('{"drive_route_token":"changeApp"}'),
      ]),
    );
  });

  it('sets multipart Content-Length to the exact serialized form buffer length', async () => {
    const observedLengths: Array<{
      bodyLength: number;
      contentLength: unknown;
      syncLength: number;
    }> = [];
    const post = jest.fn(
      async (
        _url: string,
        form: { getBuffer: () => Buffer; getLengthSync: () => number },
        config: { headers: Record<string, unknown> },
      ) => {
        observedLengths.push({
          bodyLength: form.getBuffer().length,
          contentLength: config.headers['Content-Length'],
          syncLength: form.getLengthSync(),
        });
        return {
          data: { code: 0, data: { file_token: 'tok-content-length' } },
        };
      },
    );
    const service = createServiceWithAxios({ post });

    await expect(
      service.uploadBitableAttachment(
        'tenant-token',
        'changeApp',
        createChangeDocument(),
        '变更文档',
      ),
    ).resolves.toBe('tok-content-length');
    expect(observedLengths).toEqual([
      {
        bodyLength: expect.any(Number),
        contentLength: expect.any(Number),
        syncLength: expect.any(Number),
      },
    ]);
    expect(observedLengths[0].contentLength).toBe(
      observedLengths[0].bodyLength,
    );
    expect(observedLengths[0].syncLength).toBe(observedLengths[0].bodyLength);
  });

  it('retries a wrapped HTTP 502 media upload and returns the successful file token', async () => {
    const upstream502 = Object.assign(
      new Error('Request failed with status code 502'),
      {
        response: {
          status: 502,
          data: { code: 99991663, msg: 'upstream unavailable' },
        },
      },
    );
    const post = jest
      .fn()
      .mockRejectedValueOnce(upstream502)
      .mockResolvedValueOnce({
        data: { code: 0, data: { file_token: 'tok-after-502' } },
      });
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    await expect(
      service.uploadBitableAttachment(
        'tenant-token',
        'changeApp',
        createChangeDocument(),
        '变更文档',
      ),
    ).resolves.toBe('tok-after-502');
    expect(post).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('retries Feishu media business codes that explicitly allow retry', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 1061045, msg: 'cloud doc upload concurrency conflict' },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { file_token: 'tok-change' } },
      });
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    await expect(
      service.uploadBitableAttachment(
        'tenant-token',
        'changeApp',
        createChangeDocument(),
        '变更文档“change-plan.pdf”',
      ),
    ).resolves.toBe('tok-change');
    expect(post).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('does not retry a permanent Feishu media business error', async () => {
    const post = jest.fn().mockResolvedValue({
      data: { code: 1061002, msg: 'invalid upload parameter' },
    });
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    await expect(
      service.uploadBitableAttachment(
        'tenant-token',
        'changeApp',
        createChangeDocument(),
        '变更文档“change-plan.pdf”',
      ),
    ).rejects.toThrow('1061002');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('uses the change-request media budget and succeeds on the fifth retryable upload attempt', async () => {
    const requestBodies: unknown[] = [];
    const observedTimeouts: number[] = [];
    const timeoutError = () =>
      Object.assign(new Error('connect ETIMEDOUT 198.18.0.78:443'), {
        code: 'ETIMEDOUT',
      });
    const post = jest.fn(
      async (_url: string, body: unknown, config: { timeout: number }) => {
        requestBodies.push(body);
        observedTimeouts.push(config.timeout);
        if (requestBodies.length < 5) throw timeoutError();
        return {
          data: { code: 0, data: { file_token: 'tok-after-fifth-attempt' } },
        };
      },
    );
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    await expect(
      service.uploadChangeRequestDocument(
        'tenant-token',
        'changeApp',
        createChangeDocument(),
        'change-request-11111111-1111-4111-8111-111111111111',
        Date.now() + 360_000,
      ),
    ).resolves.toBe('tok-after-fifth-attempt');

    expect(post).toHaveBeenCalledTimes(5);
    expect(new Set(requestBodies).size).toBe(5);
    expect(observedTimeouts).toHaveLength(5);
    for (const timeout of observedTimeouts) {
      expect(timeout).toBeGreaterThan(30_000);
      expect(timeout).toBeLessThanOrEqual(60_000);
    }
  });

  it('retries Bitable record creation when Feishu times out', async () => {
    const post = jest
      .fn()
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT 198.18.0.78:443'))
      .mockResolvedValueOnce({
        data: { code: 0, data: { record: { record_id: 'recFollowup' } } },
      });
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    const recordId = await service.createBitableRecord(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      { 施工编号: 'SG260605-1040' },
      'tenant-token',
    );

    expect(recordId).toBe('recFollowup');
    expect(post).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('backs off and replays a 1254608 Duplicate write with the same client token', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ data: { code: 1254608, msg: 'Duplicate' } })
      .mockResolvedValueOnce({
        data: { code: 0, data: { record: { record_id: 'recDuplicate' } } },
      });
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);
    const clientToken = '123e4567-e89b-42d3-a456-426614174000';

    await expect(
      service.createBitableRecord(
        'changeApp',
        'tblChange',
        '计划变更日历',
        { 变更简述: 'UPS维护' },
        'tenant-token',
        { clientToken },
      ),
    ).resolves.toBe('recDuplicate');
    expect(post).toHaveBeenCalledTimes(2);
    expect(
      post.mock.calls.map((call) => call[2]?.params?.client_token),
    ).toEqual([clientToken, clientToken]);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('retries an Axios Bitable write-conflict response', async () => {
    const conflict = Object.assign(
      new Error('Request failed with status 400'),
      {
        response: {
          status: 400,
          data: { code: 1254291, msg: 'Write conflict, please retry' },
        },
      },
    );
    const post = jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        data: { code: 0, data: { record: { record_id: 'recChange' } } },
      });
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    await expect(
      service.createBitableRecord(
        'changeApp',
        'tblChange',
        '计划变更日历',
        { 变更简述: 'UPS维护' },
        'tenant-token',
      ),
    ).resolves.toBe('recChange');
    expect(post).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('retries Bitable record updates when Feishu times out', async () => {
    const put = jest
      .fn()
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT 198.18.0.78:443'))
      .mockResolvedValueOnce({ data: { code: 0 } });
    const service = createServiceWithAxios({ put });
    service.sleep = jest.fn(async () => undefined);

    await service.updateBitableRecordFields(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recFollowup',
      { 施工编号: 'SG260605-1040' },
      'tenant-token',
    );

    expect(put).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  it('accepts daily close followups into a local queue when Feishu write times out', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    service.createBitableRecord = jest.fn(async () => {
      throw new Error('施工跟进写入失败: connect ETIMEDOUT 198.18.0.78:443');
    });
    service.enqueueConstructionFollowupSubmitRetry = jest.fn(
      async () => 'local-followup-queue-1',
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'close',
        followupStaffIds: ['ou_1'],
        completed: '否',
        completionChecklist: JSON.stringify(
          CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS.map((item) => ({
            key: item.key,
            result: '√',
            remark: '',
          })),
        ),
      },
      [
        {
          fieldname: 'closingPhotoFiles',
          originalname: '每日收尾照片.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('close-photo'),
          size: 11,
        },
      ],
    );

    expect(result).toMatchObject({
      success: true,
      recordId: '',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      pendingSync: true,
      retryTaskId: 'local-followup-queue-1',
      attachmentSyncPending: true,
    });
    expect(result.message).toContain('后台同步');
    expect(service.enqueueConstructionFollowupSubmitRetry).toHaveBeenCalled();
  });

  it('accepts optimistic construction followups into the durable queue before any Feishu write', async () => {
    const service = createServiceWithAxios({});
    service.createConstructionFollowupNow = jest.fn(async () => {
      throw new Error('不应在受理请求内同步写飞书');
    });
    service.enqueueConstructionFollowupSubmit = jest.fn(
      async () => 'local-followup-accepted-1',
    );

    const result = await service.createConstructionFollowup(
      {
        clientMutationId: 'construction-client-mutation-1',
        backgroundSync: 'true',
        constructionRecordId: 'recOverview',
        followupMode: 'supplemental',
        depositPaid: '否',
      },
      [],
      'administrator',
    );

    expect(service.createConstructionFollowupNow).not.toHaveBeenCalled();
    expect(service.enqueueConstructionFollowupSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMutationId: 'construction-client-mutation-1',
        constructionRecordId: 'recOverview',
      }),
      [],
      'administrator',
    );
    expect(result).toMatchObject({
      success: true,
      recordId: '',
      constructionRecordId: 'recOverview',
      pendingSync: true,
      taskId: 'local-followup-accepted-1',
      attachmentSyncPending: true,
    });
    expect(result).not.toHaveProperty('retryTaskId');
    expect(result.message).toContain('后台同步');
  });

  it('keeps non-background construction followups on the validated write path', async () => {
    const service = createServiceWithAxios({});
    service.createConstructionFollowupNow = jest.fn(async () => ({
      success: true,
      recordId: 'recFollowup',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      updated: false,
      attachmentSyncPending: false,
      pendingSync: false,
      retryTaskId: null,
      message: '施工跟进已提交',
    }));
    service.enqueueConstructionFollowupSubmit = jest.fn();

    const result = await service.createConstructionFollowup(
      {
        clientMutationId: 'construction-client-mutation-sync-1',
        constructionRecordId: 'recOverview',
        followupMode: 'supplemental',
        depositPaid: '否',
      },
      [],
      'administrator',
    );

    expect(service.createConstructionFollowupNow).toHaveBeenCalled();
    expect(service.enqueueConstructionFollowupSubmit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      recordId: 'recFollowup',
      pendingSync: false,
    });
  });

  it('keeps a queued retry failed when its post-save child fails and persists the record id before waiting', async () => {
    const service = createServiceWithAxios({});
    const queuedTask = buildQueuedConstructionFollowupSubmitTask(
      `queue-child-failed-${Date.now()}`,
    );
    const childTask: any = {
      id: 'construction-child-failed',
      status: 'running',
      startTime: new Date(),
      message: 'attachment sync running',
    };
    service.syncTasks.set(childTask.id, childTask);
    service.createConstructionFollowupNow = jest.fn(async () => ({
      success: true,
      recordId: 'recPersistedFollowup',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      updated: false,
      attachmentSyncPending: true,
      pendingSync: true,
      taskId: childTask.id,
      message: 'saved',
    }));
    service.sleep = jest.fn(async () => {
      const persistedWhileWaiting =
        await service.readQueuedConstructionFollowupSubmitTask(queuedTask.id);
      expect(persistedWhileWaiting?.request.followupRecordId).toBe(
        'recPersistedFollowup',
      );
      childTask.status = 'failed';
      childTask.message = 'attachment sync failed: read ECONNRESET';
    });
    const queuePath = service.getQueuedConstructionFollowupSubmitTaskPath(
      queuedTask.id,
    );
    await service.persistQueuedConstructionFollowupSubmitTask(queuedTask);

    try {
      await service.processQueuedConstructionFollowupSubmitTask(queuedTask.id);

      const persisted = await service.readQueuedConstructionFollowupSubmitTask(
        queuedTask.id,
      );
      expect(persisted).toMatchObject({
        status: 'failed',
        request: {
          followupRecordId: 'recPersistedFollowup',
        },
      });
      expect(service.sleep).toHaveBeenCalled();
      expect(service.getSyncTask(queuedTask.id)).toMatchObject({
        status: 'failed',
        inserted: 0,
        failed: 1,
      });
    } finally {
      await rm(queuePath, { force: true });
    }
  });

  it('completes and removes a queued retry only after its post-save child succeeds', async () => {
    const service = createServiceWithAxios({});
    const queuedTask = buildQueuedConstructionFollowupSubmitTask(
      `queue-child-completed-${Date.now()}`,
    );
    const childTask: any = {
      id: 'construction-child-completed',
      status: 'running',
      startTime: new Date(),
      message: 'attachment sync running',
    };
    service.syncTasks.set(childTask.id, childTask);
    const result = {
      success: true,
      recordId: 'recPersistedFollowup',
      recordUrl: null,
      constructionRecordId: 'recOverview',
      updated: false,
      attachmentSyncPending: true,
      pendingSync: true,
      taskId: childTask.id,
      message: 'saved',
    };
    service.createConstructionFollowupNow = jest.fn(async () => result);
    service.sleep = jest.fn(async () => {
      const persistedWhileWaiting =
        await service.readQueuedConstructionFollowupSubmitTask(queuedTask.id);
      expect(persistedWhileWaiting?.request.followupRecordId).toBe(
        'recPersistedFollowup',
      );
      childTask.status = 'completed';
      childTask.message = 'attachment sync completed';
    });
    const queuePath = service.getQueuedConstructionFollowupSubmitTaskPath(
      queuedTask.id,
    );
    await service.persistQueuedConstructionFollowupSubmitTask(queuedTask);

    try {
      await service.processQueuedConstructionFollowupSubmitTask(queuedTask.id);

      expect(service.sleep).toHaveBeenCalled();
      await expect(
        service.readQueuedConstructionFollowupSubmitTask(queuedTask.id),
      ).resolves.toBeNull();
      expect(service.getSyncTask(queuedTask.id)).toMatchObject({
        status: 'completed',
        inserted: 1,
        failed: 0,
        result,
      });
    } finally {
      await rm(queuePath, { force: true });
    }
  });

  it('does not queue daily close followups for non-network validation errors', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    service.createBitableRecord = jest.fn(async () => {
      throw new Error('FieldNameNotFound');
    });
    service.enqueueConstructionFollowupSubmitRetry = jest.fn();

    await expect(
      service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage: 'close',
          followupStaffIds: ['ou_1'],
          completed: '否',
          completionChecklist: JSON.stringify(
            CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS.map((item) => ({
              key: item.key,
              result: '√',
              remark: '',
            })),
          ),
        },
        [
          {
            fieldname: 'closingPhotoFiles',
            originalname: '每日收尾照片.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('close-photo'),
            size: 11,
          },
        ],
      ),
    ).rejects.toThrow('FieldNameNotFound');
    expect(
      service.enqueueConstructionFollowupSubmitRetry,
    ).not.toHaveBeenCalled();
  });

  it('does not retry Bitable field name errors', async () => {
    const fieldError = new Error(
      'Request failed with status code 400',
    ) as Error & {
      response?: { data: Record<string, unknown> };
    };
    fieldError.response = {
      data: {
        code: 1254045,
        msg: 'FieldNameNotFound',
        error: {
          message:
            "Invalid request parameter: 'fields.每日人员核查'. Correct format : field_name not found.",
        },
      },
    };
    const post = jest.fn().mockRejectedValueOnce(fieldError);
    const service = createServiceWithAxios({ post });
    service.sleep = jest.fn(async () => undefined);

    await expect(
      service.createBitableRecord(
        'followupApp',
        'tblFollowup',
        '施工跟进',
        { 每日人员核查: '已核查' },
        'tenant-token',
      ),
    ).rejects.toThrow('FieldNameNotFound');

    expect(post).toHaveBeenCalledTimes(1);
    expect(service.sleep).not.toHaveBeenCalled();
  });

  it('creates a new daily follow-up record when the matching project record is from another day', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      {
        record_id: 'recYesterdayFollowup',
        created_time: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
        fields: {
          施工编码: 'SG260605-1031',
          施工总览: ['recOverview'],
        },
      },
    ]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      施工过程照片: [{ file_token: 'tokProcess' }],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.createBitableRecord = jest.fn(async () => 'recNewFollowup');
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.syncConstructionCrewRosterFilesToLedger = jest.fn(async () => ({
      parsed: 1,
      created: 0,
      updated: 1,
    }));
    const crewRosterBuffer = buildCrewRosterWorkbookBuffer();

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupStaffIds: ['ou_1'],
        processFeedback: '过程正常',
        checklistConstructionCode: 'SG260605-1031',
      },
      [
        {
          fieldname: 'processPhotoFiles',
          originalname: 'process.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('new-photo'),
          size: 9,
        },
      ],
    );
    await flushBackgroundTasks();

    expect(service.updateBitableRecordFields).not.toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recYesterdayFollowup',
      expect.any(Object),
      'tenant-token',
      expect.any(Object),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recNewFollowup',
      expect.objectContaining({
        施工过程照片: [{ file_token: 'tokProcess' }],
      }),
      'tenant-token',
      expect.any(Object),
    );
    expect(service.createBitableRecord).toHaveBeenCalled();
    expect(result.updated).toBe(false);
    expect(result.recordId).toBe('recNewFollowup');
  });

  it('backfills construction AI feedback fields after saving daily prepare records', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      每日人员核查清单: [{ file_token: 'tokChecklist' }],
      挂牌与隔离照片: [{ file_token: 'tokIsolation' }],
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles]: [
        { file_token: 'tokHot' },
      ],
    }));
    service.auditConstructionIsolationPhotos = jest.fn(
      async () => '隔离审核通过',
    );
    service.auditConstructionPermitAttachments = jest.fn(async () => ({
      'AI审核结果-动火许可证': '动火票审核通过',
    }));
    service.createBitableRecord = jest.fn(async () => 'recPrepareFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck: '已核对，今日 1 人参与施工',
      },
      [
        {
          fieldname: 'dailyPersonnelChecklistFiles',
          originalname: '每日人员核查清单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: Buffer.from('checklist'),
          size: 9,
        },
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '挂牌.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
        {
          fieldname: 'hotWorkPermitFiles',
          originalname: '动火作业票.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('permit'),
          size: 6,
        },
      ],
    );

    const createdFields = service.createBitableRecord.mock.calls[0][3];
    expect(createdFields).not.toHaveProperty(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles,
    );
    expect(createdFields).not.toHaveProperty('挂牌&隔离合规反馈');
    expect(createdFields).not.toHaveProperty('AI审核结果-动火许可证');

    await flushBackgroundTasks();
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recPrepareFollowup',
      expect.objectContaining({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles]: [
          { file_token: 'tokHot' },
        ],
        '人工审核-动火许可票': null,
        '人工审核票据标识-动火许可票': null,
      }),
      'tenant-token',
      expect.any(Object),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recPrepareFollowup',
      expect.objectContaining({
        'AI审核结果-挂牌&隔离照片': '隔离审核通过',
        'AI审核结果-挂牌与隔离照片': '隔离审核通过',
        'AI审核结果-挂牌&隔离合规反馈': '隔离审核通过',
        '挂牌&隔离合规反馈': '隔离审核通过',
        'AI审核结果-动火许可证': '动火票审核通过',
        '人工审核票据标识-动火许可票': expect.stringMatching(/^v1:/),
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          'AI审核结果-挂牌&隔离照片',
          'AI审核结果-挂牌与隔离照片',
          'AI审核结果-挂牌&隔离合规反馈',
          '挂牌&隔离合规反馈',
          'AI审核结果-动火许可证',
          '人工审核-动火许可票',
          '人工审核票据标识-动火许可票',
        ]),
      }),
    );
  });

  it('does not backfill a completed construction audit after the master switch is disabled', async () => {
    const service = createServiceWithAxios({});
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    let resolveAudit:
      | ((value: [string | null, Record<string, string>]) => void)
      | null = null;
    const auditPromise = new Promise<[string | null, Record<string, string>]>(
      (resolve) => {
        resolveAudit = resolve;
      },
    );

    service.scheduleConstructionFollowupAuditBackfill({
      auditPromise,
      followupAppToken: 'followupApp',
      followupRecordId: 'recPrepareFollowup',
      tenantAccessToken: 'tenant-token',
      savedFields: {},
      existingFields: {},
      changedPermitFileKeys: [],
    });
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    try {
      resolveAudit?.([
        null,
        {
          [hotWorkFeedbackField]: '动火票审核通过',
        },
      ]);
      await flushBackgroundTasks();

      expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    } finally {
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('backfills training assessment AI feedback after saving daily prepare records', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
    const service = createServiceWithAxios({});
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      每日人员核查清单: [{ file_token: 'tokChecklist' }],
      挂牌与隔离照片: [{ file_token: 'tokIsolation' }],
      入场培训签到表: [{ file_token: 'tokTrainingSignIn' }],
      入场培训考核: [
        { file_token: 'tokExam1' },
        { file_token: 'tokExam2' },
        { file_token: 'tokExam3' },
        { file_token: 'tokExam4' },
      ],
    }));
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.createBitableRecord = jest.fn(async () => 'recTrainingFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck: '已核对，今日 5 人参与施工',
      },
      [
        {
          fieldname: 'dailyPersonnelChecklistFiles',
          originalname: '每日人员核查清单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: Buffer.from('checklist'),
          size: 9,
        },
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '挂牌.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
        {
          fieldname: 'entryTrainingSignInFiles',
          originalname: '入场培训签到表.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: buildTrainingSignInWorkbookBuffer([
            '张一',
            '张二',
            '示例人员008',
            '张四',
            '张五',
          ]),
          size: 128,
        },
        ...['1', '2', '3', '4'].map((index) => ({
          fieldname: 'entryTrainingAssessmentFiles',
          originalname: `入场培训考核-${index}.jpg`,
          mimetype: 'image/jpeg',
          buffer: Buffer.from(`exam-${index}`),
          size: 6,
        })),
      ],
    );

    await flushBackgroundTasks();

    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recTrainingFollowup',
      expect.objectContaining({
        [CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD]:
          '结论：不通过；1. 人数：签到疑似5人；2. 文件：考核4份；3. 匹配：缺1份',
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD,
        ]),
      }),
    );
  });

  it('saves supplemental permit files when the permit vision audit fails', async () => {
    const service = createServiceWithAxios({});
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    const hotWorkFile = {
      fieldname: 'hotWorkPermitFiles',
      originalname: '动火作业单.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('permit'),
      size: 6,
    };

    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles]: [
        { file_token: 'tokHot' },
      ],
    }));
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => {
      throw new Error('vision audit timeout');
    });
    service.createBitableRecord = jest.fn(async () => 'recSupplemental');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'supplemental',
      },
      [hotWorkFile],
    );

    expect(result.recordId).toBe('recSupplemental');
    const createdFields = service.createBitableRecord.mock.calls[0][3];
    expect(createdFields).toEqual(
      expect.objectContaining({
        材料是否上传完成: true,
      }),
    );
    expect(createdFields).not.toHaveProperty(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles,
    );
    expect(createdFields).not.toHaveProperty(hotWorkFeedbackField);

    await flushBackgroundTasks();
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      expect.any(String),
      'recSupplemental',
      expect.objectContaining({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles]: [
          { file_token: 'tokHot' },
        ],
      }),
      'tenant-token',
      expect.any(Object),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      expect.any(String),
      'recSupplemental',
      expect.objectContaining({
        [hotWorkFeedbackField]: expect.stringContaining('需人工复核'),
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('updates the selected supplemental follow-up record when a followupRecordId is provided', async () => {
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '鏂藉伐椤圭洰鎬昏',
      sourceUrl: '',
    };
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recInitialFollowup',
      fields: {},
    }));
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.crewRosterFiles]: [
        { file_token: 'tokCrewDelta' },
      ],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.createBitableRecord = jest.fn(async () => 'recSupplementalDelta');
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.syncConstructionCrewRosterFilesToLedger = jest.fn(async () => ({
      parsed: 1,
      created: 0,
      updated: 1,
      records: [{ record_id: 'recCrewMember', fields: {} }],
      members: [{ name: '示例人员008' }],
    }));
    service.runConstructionCrewRosterCertificateBatchCheck = jest.fn(
      async () => ({ summary: '1 人持证检查完成' }),
    );
    service.notifyConstructionCrewRosterUploadSuccess = jest.fn(
      async () => undefined,
    );
    const crewRosterBuffer = buildCrewRosterWorkbookBuffer();

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupRecordId: 'recInitialFollowup',
        followupMode: 'supplemental',
      },
      [
        {
          fieldname: 'crewRosterFiles',
          originalname: '施工人员增删名单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: crewRosterBuffer,
          size: crewRosterBuffer.length,
        },
      ],
      'admin',
    );
    await flushBackgroundTasks();

    expect(service.fetchConstructionFollowupRecordById).toHaveBeenCalledWith(
      'followupApp',
      'recInitialFollowup',
      'tenant-token',
    );
    expect(service.createBitableRecord).not.toHaveBeenCalled();
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recInitialFollowup',
      expect.objectContaining({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.crewRosterFiles]: [
          { file_token: 'tokCrewDelta' },
        ],
      }),
      'tenant-token',
      expect.any(Object),
    );
    expect(result.updated).toBe(true);
    expect(result.recordId).toBe('recInitialFollowup');
    expect(service.syncConstructionCrewRosterFilesToLedger).toHaveBeenCalled();
    expect(
      service.runConstructionCrewRosterCertificateBatchCheck,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        overviewRecordId: 'recOverview',
        records: [{ record_id: 'recCrewMember', fields: {} }],
      }),
    );
  });

  it.each([
    { role: 'guest', expectedTokens: ['tokChecklistOld', 'tokChecklistNew'] },
    { role: 'editor', expectedTokens: ['tokChecklistOld', 'tokChecklistNew'] },
    { role: 'admin', expectedTokens: ['tokChecklistNew'] },
  ])(
    '$role preserves the allowed daily personnel checklist attachment semantics',
    async ({ role, expectedTokens }) => {
      const service = createServiceWithAxios({});
      (service as any).constructionOverviewConfig = {
        appToken: '',
        wikiToken: '',
        tableId: '',
        viewId: '',
        tableName: 'construction overview',
        sourceUrl: '',
      };
      const checklistField =
        CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles;
      service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
        record_id: 'recChecklistFollowup',
        fields: {
          [checklistField]: [{ file_token: 'tokChecklistOld' }],
        },
      }));
      service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
        [checklistField]: [{ file_token: 'tokChecklistNew' }],
      }));
      service.updateBitableRecordFields = jest.fn(async () => undefined);
      service.ensureConstructionFollowupOverviewLink = jest.fn(
        async () => undefined,
      );
      service.ensureConstructionCrewLedgerProjectView = jest.fn(
        async () => undefined,
      );

      await service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupRecordId: 'recChecklistFollowup',
          followupMode: 'supplemental',
        },
        [
          {
            fieldname: 'dailyPersonnelChecklistFiles',
            originalname: 'daily-checklist.xlsx',
            mimetype:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer: Buffer.from('new-checklist'),
            size: 13,
          },
        ],
        role,
      );
      await flushBackgroundTasks();

      const attachmentUpdateCall = service.updateBitableRecordFields.mock.calls
        .filter((call: unknown[]) => call[3] === 'recChecklistFollowup')
        .find(
          (call: unknown[]) =>
            checklistField in (call[4] as Record<string, unknown>),
        );
      expect(attachmentUpdateCall?.[4]).toEqual(
        expect.objectContaining({
          [checklistField]: expectedTokens.map((fileToken) => ({
            file_token: fileToken,
          })),
        }),
      );
    },
  );

  it.each(['admin', 'editor', 'construction_admin'] as const)(
    '%s replaces only the retained permit set during a permit-only upload',
    async (role) => {
      const service = createServiceWithAxios({});
      (service as any).constructionOverviewConfig = {
        appToken: '',
        wikiToken: '',
        tableId: '',
        viewId: '',
        tableName: 'construction overview',
        sourceUrl: '',
      };
      const permitKey = 'hotWorkPermitFiles';
      const permitField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[permitKey];
      const unrelatedField =
        CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles;
      service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
        record_id: 'recPermitOnlyFollowup',
        fields: {
          [permitField]: [{ file_token: 'tokPermitOld' }],
          [unrelatedField]: [{ file_token: 'tokApplicationProtected' }],
        },
      }));
      service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
        [permitField]: [{ file_token: 'tokPermitNew' }],
      }));
      service.auditConstructionFollowupFiles = jest.fn(async () => [null, {}]);
      service.scheduleConstructionFollowupAuditBackfill = jest.fn();
      service.buildConstructionIsolationManualReviewAutoApprovalFields =
        jest.fn(async () => ({}));
      service.updateBitableRecordFields = jest.fn(async () => undefined);
      service.syncConstructionFollowupPostSaveSideEffects = jest.fn(
        async () => undefined,
      );

      await service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupRecordId: 'recPermitOnlyFollowup',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          followupDate: '2026-07-28',
          permitOnlyUpload: true,
          permitValidFromByFileKey: {
            [permitKey]: '2026-07-28',
          },
          permitValidUntilByFileKey: {
            [permitKey]: '2026-07-31',
          },
          retainedAttachmentTokens: {
            [permitKey]: [],
            applicationFiles: [],
          },
        },
        [
          {
            fieldname: permitKey,
            originalname: '动火作业票.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('new-hot-work-permit'),
            size: 19,
          },
        ],
        role,
      );
      await flushBackgroundTasks();

      const attachmentUpdate = service.updateBitableRecordFields.mock.calls
        .map((call: unknown[]) => call[4] as Record<string, unknown>)
        .find((fields: Record<string, unknown>) => permitField in fields);
      expect(attachmentUpdate).toEqual(
        expect.objectContaining({
          [permitField]: [{ file_token: 'tokPermitNew' }],
        }),
      );
      expect(attachmentUpdate).not.toHaveProperty(unrelatedField);
    },
  );

  it('serializes concurrent editor attachment updates against a fresh record snapshot', async () => {
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    const attachmentField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles;
    let storedFields: Record<string, unknown> = {
      [attachmentField]: [{ file_token: 'tokOriginal' }],
    };
    service.fetchConstructionFollowupRecordById = jest.fn(async () => {
      const snapshot = structuredClone(storedFields);
      return {
        record_id: 'recConcurrentFollowup',
        fields: snapshot,
      };
    });
    service.uploadConstructionAttachmentFieldValues = jest.fn(
      async (
        _tenantToken: string,
        _appToken: string,
        files: Array<{ originalname: string }>,
      ) => ({
        [attachmentField]: files.map((file) => ({
          file_token: `tok-${file.originalname}`,
        })),
      }),
    );
    service.updateBitableRecordFields = jest.fn(
      async (
        _appToken: string,
        _tableId: string,
        _tableName: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        storedFields = { ...storedFields, ...structuredClone(fields) };
      },
    );
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    const submit = (fileName: string) =>
      service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupRecordId: 'recConcurrentFollowup',
          followupMode: 'supplemental',
        },
        [
          {
            fieldname: 'applicationFiles',
            originalname: fileName,
            mimetype: 'application/pdf',
            buffer: Buffer.from(fileName),
            size: fileName.length,
          },
        ],
        'editor',
      );

    await Promise.all([submit('first.pdf'), submit('second.pdf')]);
    await flushBackgroundTasks(40);

    const finalTokens = (
      storedFields[attachmentField] as Array<{ file_token: string }>
    ).map((file) => file.file_token);
    expect(finalTokens).toEqual([
      'tokOriginal',
      'tok-first.pdf',
      'tok-second.pdf',
    ]);
    expect(service.fetchConstructionFollowupRecordById).toHaveBeenCalledTimes(
      2,
    );
  });

  it('preserves a concurrent permit upload when an editor submits no new attachment', async () => {
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    const attachmentField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
    const feedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles
        .feedbackField;
    const reviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.temporaryPowerPermitFiles;
    const originalPermit = [{ file_token: 'tokOriginalPermit' }];
    let storedFields: Record<string, unknown> = {
      施工编码: 'SG260715-1001',
      施工总览: ['recOverview'],
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.processPhotoFiles]: [
        { file_token: 'tokProcessPhoto' },
      ],
      [attachmentField]: originalPermit,
    };
    let initialFetchCount = 0;
    let signalFirstInitialFetch: (() => void) | null = null;
    let signalBothInitialSnapshots: (() => void) | null = null;
    let signalUploadWritten: (() => void) | null = null;
    const firstInitialFetchStarted = new Promise<void>((resolve) => {
      signalFirstInitialFetch = resolve;
    });
    const bothInitialSnapshotsCaptured = new Promise<void>((resolve) => {
      signalBothInitialSnapshots = resolve;
    });
    const uploadWritten = new Promise<void>((resolve) => {
      signalUploadWritten = resolve;
    });
    service.fetchConstructionFollowupRecordById = jest.fn(async () => {
      const snapshot = structuredClone(storedFields);
      initialFetchCount += 1;
      if (initialFetchCount === 1) {
        signalFirstInitialFetch?.();
        await bothInitialSnapshotsCaptured;
      } else if (initialFetchCount === 2) {
        signalBothInitialSnapshots?.();
        await uploadWritten;
      }
      return {
        record_id: 'recConcurrentFollowup',
        fields: snapshot,
      };
    });
    service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
      async () => [
        {
          record_id: 'recPermitSource',
          created_time: new Date('2026-07-14T08:00:00+08:00').getTime(),
          fields: {
            施工编码: 'SG260715-1001',
            施工总览: ['recOverview'],
            [attachmentField]: originalPermit,
            [feedbackField]:
              '核验日期：2026-07-14；结论：通过；有效期至：2026-07-31；问题：无',
            [reviewConfig.reviewField]: true,
          },
        },
      ],
    );
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [attachmentField]: [{ file_token: 'tokUploadedPermit' }],
    }));
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.updateBitableRecordFields = jest.fn(
      async (
        _appToken: string,
        _tableId: string,
        _tableName: string,
        _recordId: string,
        fields: Record<string, unknown>,
      ) => {
        storedFields = { ...storedFields, ...structuredClone(fields) };
        const attachmentTokens = (
          fields[attachmentField] as Array<{ file_token: string }> | undefined
        )?.map((file) => file.file_token);
        if (attachmentTokens?.includes('tokUploadedPermit')) {
          signalUploadWritten?.();
        }
      },
    );
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    const uploadSubmission = service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupRecordId: 'recConcurrentFollowup',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupDate: '2026-07-15',
        followupStaffIds: ['ou_1'],
        permitValidUntilByFileKey: {
          temporaryPowerPermitFiles: '2026-07-31',
        },
      },
      [
        {
          fieldname: 'temporaryPowerPermitFiles',
          originalname: '临时用电作业票.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('uploaded-permit'),
          size: 15,
        },
      ],
      'editor',
    );
    await firstInitialFetchStarted;
    const noFileSubmission = service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupRecordId: 'recConcurrentFollowup',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupDate: '2026-07-15',
        followupStaffIds: ['ou_1'],
        processFeedback: '现场施工正常',
        workTypes: ['临时用电作业'],
      },
      [],
      'editor',
    );

    await Promise.all([uploadSubmission, noFileSubmission]);
    await flushBackgroundTasks(40);

    const finalTokens = (
      storedFields[attachmentField] as Array<{ file_token: string }>
    ).map((file) => file.file_token);
    expect(finalTokens).toEqual(['tokOriginalPermit', 'tokUploadedPermit']);
  });

  it('does not resurrect a related permit after an administrator clears it', async () => {
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: 'construction overview',
      sourceUrl: '',
    };
    const attachmentField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
    const feedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles
        .feedbackField;
    const reviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.temporaryPowerPermitFiles;
    service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
      record_id: 'recAdminDailyFollowup',
      fields: {
        施工编码: 'SG260715-1002',
        施工总览: ['recOverview'],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.processPhotoFiles]: [
          { file_token: 'tokProcessPhoto' },
        ],
        [attachmentField]: [{ file_token: 'tokProtectedPermit' }],
      },
    }));
    service.fetchConstructionRelatedProjectFollowupRecords = jest.fn(
      async () => [
        {
          record_id: 'recRelatedPermit',
          created_time: new Date('2026-07-14T08:00:00+08:00').getTime(),
          fields: {
            施工编码: 'SG260715-1002',
            施工总览: ['recOverview'],
            [attachmentField]: [{ file_token: 'tokRelatedPermit' }],
            [feedbackField]:
              '核验日期：2026-07-14；结论：通过；有效期至：2026-07-31；问题：无',
            [reviewConfig.reviewField]: true,
          },
        },
      ],
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupRecordId: 'recAdminDailyFollowup',
        followupMode: 'daily',
        dailyFollowupStage: 'process',
        followupDate: '2026-07-15',
        followupStaffIds: ['ou_1'],
        processFeedback: '现场施工正常',
        workTypes: ['临时用电作业'],
        retainedAttachmentTokens: {
          temporaryPowerPermitFiles: [],
        },
      },
      [],
      'admin',
    );

    const updateCall = service.updateBitableRecordFields.mock.calls.find(
      (call: unknown[]) => call[3] === 'recAdminDailyFollowup',
    );
    expect(updateCall?.[4]).toEqual(
      expect.objectContaining({
        [attachmentField]: [],
      }),
    );
  });

  it('serializes concurrent editor overview attachment updates against a fresh record snapshot', async () => {
    const service = createServiceWithAxios({});
    const attachmentField =
      CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS.constructionIssueFiles;
    let storedOverviewFields: Record<string, unknown> = {
      [attachmentField]: [{ file_token: 'tokOverviewOriginal' }],
    };
    let initialOverviewFetchCount = 0;
    let releaseInitialOverviewFetches: (() => void) | null = null;
    const initialOverviewFetchBarrier = new Promise<void>((resolve) => {
      releaseInitialOverviewFetches = resolve;
    });
    service.fetchConstructionFollowupRecordById = jest.fn(
      async (_appToken: string, recordId: string) => ({
        record_id: recordId,
        fields: {},
      }),
    );
    service.fetchBitableRecordById = jest.fn(async () => {
      const snapshot = structuredClone(storedOverviewFields);
      initialOverviewFetchCount += 1;
      if (initialOverviewFetchCount === 2) {
        releaseInitialOverviewFetches?.();
      }
      if (initialOverviewFetchCount <= 2) {
        await initialOverviewFetchBarrier;
      }
      return {
        record_id: 'recConcurrentOverview',
        fields: snapshot,
      };
    });
    service.downloadConstructionAttachment = jest.fn(async () => ({
      buffer: Buffer.from('original-overview-attachment'),
    }));
    service.uploadConstructionAttachmentFieldValues = jest.fn(
      async (
        _tenantToken: string,
        appToken: string,
        files: Array<{ originalname: string }>,
      ) =>
        appToken === 'overviewApp'
          ? {
              [attachmentField]: files.map((file) => ({
                file_token: `tok-${file.originalname}`,
              })),
            }
          : {},
    );
    service.updateBitableRecordFields = jest.fn(
      async (
        appToken: string,
        _tableId: string,
        _tableName: string,
        recordId: string,
        fields: Record<string, unknown>,
      ) => {
        if (
          appToken === 'overviewApp' &&
          recordId === 'recConcurrentOverview'
        ) {
          storedOverviewFields = {
            ...storedOverviewFields,
            ...structuredClone(fields),
          };
        }
      },
    );
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    const submit = (followupRecordId: string, fileName: string) =>
      service.createConstructionFollowup(
        {
          constructionRecordId: 'recConcurrentOverview',
          followupRecordId,
          followupMode: 'supplemental',
        },
        [
          {
            fieldname: 'constructionIssueFiles',
            originalname: fileName,
            mimetype: 'application/pdf',
            buffer: Buffer.from(fileName),
            size: fileName.length,
          },
        ],
        'editor',
      );

    await Promise.all([
      submit('recConcurrentFollowupA', 'first-overview.pdf'),
      submit('recConcurrentFollowupB', 'second-overview.pdf'),
    ]);
    await flushBackgroundTasks(60);

    const finalTokens = (
      storedOverviewFields[attachmentField] as Array<{ file_token: string }>
    ).map((file) => file.file_token);
    expect(finalTokens).toEqual([
      'tokOverviewOriginal',
      'tok-first-overview.pdf',
      'tok-second-overview.pdf',
    ]);
  });

  it('keeps the administrator retained set when uploading an overview attachment', async () => {
    const service = createServiceWithAxios({});
    const attachmentField =
      CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS.constructionIssueFiles;
    service.fetchBitableRecordById = jest.fn(async () => ({
      record_id: 'recAdminOverview',
      fields: {
        [attachmentField]: [
          { file_token: 'tokRetained' },
          { file_token: 'tokProtected' },
        ],
      },
    }));
    service.downloadConstructionAttachment = jest.fn(async () => ({
      buffer: Buffer.from('existing-overview-attachment'),
    }));
    service.uploadConstructionAttachmentFieldValues = jest.fn(
      async (_tenantToken: string, appToken: string) =>
        appToken === 'overviewApp'
          ? {
              [attachmentField]: [{ file_token: 'tokNew' }],
            }
          : {},
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    await service.createConstructionFollowup(
      {
        constructionRecordId: 'recAdminOverview',
        followupRecordId: 'recAdminFollowup',
        followupMode: 'supplemental',
        retainedAttachmentTokens: {
          constructionIssueFiles: ['tokRetained'],
        },
      },
      [
        {
          fieldname: 'constructionIssueFiles',
          originalname: 'new-overview.pdf',
          mimetype: 'application/pdf',
          buffer: Buffer.from('new-overview'),
          size: 12,
        },
      ],
      'admin',
    );
    await flushBackgroundTasks();

    const overviewUpdateCall =
      service.updateBitableRecordFields.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'overviewApp' && call[3] === 'recAdminOverview',
      );
    expect(overviewUpdateCall?.[4]).toEqual(
      expect.objectContaining({
        [attachmentField]: [
          { file_token: 'tokRetained' },
          { file_token: 'tokNew' },
        ],
      }),
    );
    expect(
      service.fetchBitableRecordById.mock.calls.filter(
        (call: unknown[]) => call[0] === 'overviewApp',
      ),
    ).toHaveLength(2);
  });

  it.each([
    {
      role: 'editor',
      expectedTokens: ['tokRetained', 'tokProtected'],
    },
    {
      role: 'construction_admin',
      expectedTokens: ['tokRetained', 'tokProtected'],
    },
    {
      role: 'admin',
      expectedTokens: ['tokRetained'],
    },
  ])(
    '$role cannot exceed its attachment-retention authority',
    async ({ role, expectedTokens }) => {
      const service = createServiceWithAxios({});
      (service as any).constructionOverviewConfig = {
        appToken: '',
        wikiToken: '',
        tableId: '',
        viewId: '',
        tableName: 'construction overview',
        sourceUrl: '',
      };
      const attachmentField =
        CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles;
      const existingAttachments = [
        { file_token: 'tokRetained' },
        { file_token: 'tokProtected' },
      ];
      service.fetchConstructionFollowupRecordById = jest.fn(async () => ({
        record_id: 'recExistingFollowup',
        fields: {
          [attachmentField]: existingAttachments,
        },
      }));
      service.updateBitableRecordFields = jest.fn(async () => undefined);
      service.ensureConstructionFollowupOverviewLink = jest.fn(
        async () => undefined,
      );

      await service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupRecordId: 'recExistingFollowup',
          followupMode: 'supplemental',
          workTypes: ['一般作业'],
          retainedAttachmentTokens: {
            applicationFiles: ['tokRetained'],
          },
        },
        [],
        role,
      );

      const updateCall = service.updateBitableRecordFields.mock.calls.find(
        (call: unknown[]) => call[3] === 'recExistingFollowup',
      );
      expect(updateCall).toBeDefined();
      const updatedFields = updateCall?.[4] as Record<string, unknown>;
      const effectiveAttachments =
        updatedFields[attachmentField] ?? existingAttachments;
      expect(effectiveAttachments).toEqual(
        expectedTokens.map((fileToken) => ({ file_token: fileToken })),
      );
    },
  );

  it('namespaces construction sync tasks while keeping general task IDs as UUIDs', () => {
    const service = createServiceWithAxios({});
    const createSyncTask = service.createSyncTask.bind(service) as (
      kind?: 'general' | 'construction',
    ) => { id: string };

    expect(createSyncTask().id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createSyncTask('construction').id).toMatch(
      /^construction-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('creates a construction-namespaced task for crew-roster upload', async () => {
    const service = createServiceWithAxios({});
    const task = {
      id: 'construction-123e4567-e89b-42d3-a456-426614174000',
      status: 'pending' as const,
      startTime: new Date(),
    };
    service.createSyncTask = jest.fn(() => task);
    service.syncConstructionCrewRosterFromUploadAsync = jest.fn(
      async () => undefined,
    );

    await expect(
      service.syncConstructionCrewRosterFromUpload(
        {
          recordId: 'recOverview',
          constructionCode: 'NT-2026-001',
          authorizationStartDate: '2026-07-20',
          authorizationEndDate: '2026-07-21',
        },
        [
          {
            fieldname: 'crewRosterFiles',
            originalname: 'crew.xlsx',
            mimetype:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 1,
            buffer: Buffer.from('x'),
          },
        ],
      ),
    ).resolves.toMatchObject({ taskId: task.id, pending: true });
    expect(service.createSyncTask).toHaveBeenCalledWith('construction');
  });

  it.each([
    ['string', 'false'],
    ['number', 0],
    ['null', null],
    ['array', []],
    ['object', {}],
  ])(
    'rejects a %s clearAdjustment before writing',
    async (_label, clearAdjustment) => {
      const service = createServiceWithAxios({});
      (service as any).calendarChangeConfig = {
        appToken: 'changeApp',
        wikiToken: '',
        tableId: 'tblChange',
        viewId: '',
        tableName: 'change info',
        sourceUrl: '',
      };
      service.updateBitableRecordFields = jest.fn(async () => undefined);

      await expect(
        service.updateChangeScheduleAdjustment(
          {
            recordId: 'recChange',
            clearAdjustment,
          } as never,
          'admin',
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
    },
  );

  it('rejects editor clear-adjustment requests with 403 before writing', async () => {
    const service = createServiceWithAxios({});
    (service as any).calendarChangeConfig = {
      appToken: 'changeApp',
      wikiToken: '',
      tableId: 'tblChange',
      viewId: '',
      tableName: 'change info',
      sourceUrl: '',
    };
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    await expect(
      service.updateChangeScheduleAdjustment(
        { recordId: 'recChange', clearAdjustment: true },
        'editor',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(service.updateBitableRecordFields).not.toHaveBeenCalled();
  });

  it('allows editor adjustment updates and administrator clears', async () => {
    const service = createServiceWithAxios({});
    (service as any).calendarChangeConfig = {
      appToken: 'changeApp',
      wikiToken: '',
      tableId: 'tblChange',
      viewId: '',
      tableName: 'change info',
      sourceUrl: '',
    };
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    await expect(
      service.updateChangeScheduleAdjustment(
        {
          recordId: 'recChange',
          clearAdjustment: false,
          plannedDelayStartDate: '2026-07-15T08:00',
          plannedDelayEndDate: '2026-07-15T09:00',
        },
        'editor',
      ),
    ).resolves.toMatchObject({ success: true, recordId: 'recChange' });
    await expect(
      service.updateChangeScheduleAdjustment(
        { recordId: 'recChange', clearAdjustment: true },
        'admin',
      ),
    ).resolves.toMatchObject({ success: true, recordId: 'recChange' });
  });

  it.each([
    {
      source: 'followup' as const,
      recordId: 'recConcurrentFollowupDelete',
      followupRecordId: 'recConcurrentFollowupDelete',
      fieldKey: 'applicationFiles',
      uploadFieldKey: 'applicationFiles',
      attachmentField: CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles,
      uploadAppToken: 'followupApp',
    },
    {
      source: 'overview' as const,
      recordId: 'recConcurrentOverviewDelete',
      followupRecordId: 'recOverviewUploadFollowup',
      fieldKey: 'constructionIssueFiles',
      uploadFieldKey: 'constructionIssueFiles',
      attachmentField:
        CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS.constructionIssueFiles,
      uploadAppToken: 'overviewApp',
    },
  ])(
    'serializes $source attachment deletion with an in-flight editor upload',
    async ({
      source,
      recordId,
      followupRecordId,
      fieldKey,
      uploadFieldKey,
      attachmentField,
      uploadAppToken,
    }) => {
      const service = createServiceWithAxios({});
      if (source === 'followup') {
        (service as any).constructionOverviewConfig = {
          appToken: '',
          wikiToken: '',
          tableId: '',
          viewId: '',
          tableName: 'construction overview',
          sourceUrl: '',
        };
      }
      let storedFields: Record<string, unknown> = {
        [attachmentField]: [
          { file_token: 'tokRemove' },
          { file_token: 'tokKeep' },
        ],
      };
      let releaseUpload: (() => void) | null = null;
      let releaseDeletion: (() => void) | null = null;
      let signalUploadReady: (() => void) | null = null;
      let signalDeletionReady: (() => void) | null = null;
      let signalUploadWritten: (() => void) | null = null;
      const uploadCanStart = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      const deletionCanFinish = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      const uploadReady = new Promise<void>((resolve) => {
        signalUploadReady = resolve;
      });
      const deletionReady = new Promise<void>((resolve) => {
        signalDeletionReady = resolve;
      });
      const uploadWritten = new Promise<void>((resolve) => {
        signalUploadWritten = resolve;
      });
      service.fetchConstructionFollowupRecordById = jest.fn(
        async (_appToken: string, requestedRecordId: string) => ({
          record_id: requestedRecordId,
          fields:
            source === 'followup'
              ? structuredClone(storedFields)
              : ({} as Record<string, unknown>),
        }),
      );
      service.fetchBitableRecordById = jest.fn(async () => ({
        record_id: recordId,
        fields: structuredClone(storedFields),
      }));
      service.downloadConstructionAttachment = jest.fn(async () => ({
        buffer: Buffer.from('existing attachment'),
      }));
      service.uploadConstructionAttachmentFieldValues = jest.fn(
        async (
          _tenantToken: string,
          appToken: string,
          files: Array<{ originalname: string }>,
        ) => {
          if (appToken !== uploadAppToken) return {};
          signalUploadReady?.();
          await uploadCanStart;
          return {
            [attachmentField]: files.map(() => ({ file_token: 'tokNew' })),
          };
        },
      );
      service.updateBitableRecordFields = jest.fn(
        async (
          appToken: string,
          _tableId: string,
          _tableName: string,
          _recordId: string,
          fields: Record<string, unknown>,
        ) => {
          const tokens = (
            fields[attachmentField] as Array<{ file_token: string }> | undefined
          )?.map((file) => file.file_token);
          if (
            appToken === uploadAppToken &&
            tokens?.length === 1 &&
            tokens[0] === 'tokKeep'
          ) {
            signalDeletionReady?.();
            await deletionCanFinish;
          }
          storedFields = { ...storedFields, ...structuredClone(fields) };
          if (appToken === uploadAppToken && tokens?.includes('tokNew')) {
            signalUploadWritten?.();
          }
        },
      );
      service.ensureConstructionFollowupOverviewLink = jest.fn(
        async () => undefined,
      );

      await service.createConstructionFollowup(
        {
          constructionRecordId:
            source === 'overview' ? recordId : 'recOverview',
          followupRecordId,
          followupMode: 'supplemental',
        },
        [
          {
            fieldname: uploadFieldKey,
            originalname: 'new-attachment.pdf',
            mimetype: 'application/pdf',
            buffer: Buffer.from('new attachment'),
            size: 14,
          },
        ],
        'editor',
      );
      await uploadReady;

      const deletion = service.deleteConstructionAttachment({
        source,
        recordId,
        fieldKey,
        fileToken: 'tokRemove',
      });
      await deletionReady;
      releaseUpload?.();
      await flushBackgroundTasks(40);
      releaseDeletion?.();
      await Promise.all([uploadWritten, deletion]);

      expect(storedFields[attachmentField]).toEqual([
        { file_token: 'tokKeep' },
        { file_token: 'tokNew' },
      ]);
      await flushBackgroundTasks();
      expect((service as any).constructionAttachmentWriteTails.size).toBe(0);
    },
  );

  it('continues attachment writes after a rejected operation and releases the lock tail', async () => {
    const service = createServiceWithAxios({});
    const operations: string[] = [];
    const first = (service as any).withConstructionAttachmentWriteLock(
      'followup:recRejectedWrite',
      async () => {
        operations.push('first');
        throw new Error('expected write failure');
      },
    );
    const second = (service as any).withConstructionAttachmentWriteLock(
      'followup:recRejectedWrite',
      async () => {
        operations.push('second');
        return 'recovered';
      },
    );

    await expect(first).rejects.toThrow('expected write failure');
    await expect(second).resolves.toBe('recovered');
    expect(operations).toEqual(['first', 'second']);
    expect((service as any).constructionAttachmentWriteTails.size).toBe(0);
  });

  it('deletes one uploaded construction follow-up attachment token from Bitable', async () => {
    const service = createServiceWithAxios({});
    service.fetchBitableRecordById = jest.fn(async () => ({
      record_id: 'recInitialFollowup',
      fields: {
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles]: [
          { file_token: 'tokRemove' },
          { file_token: 'tokKeep' },
        ],
      },
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const result = await service.deleteConstructionAttachment({
      source: 'followup',
      recordId: 'recInitialFollowup',
      fieldKey: 'applicationFiles',
      fileToken: 'tokRemove',
    });

    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recInitialFollowup',
      {
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles]: [
          { file_token: 'tokKeep' },
        ],
      },
      'tenant-token',
      expect.any(Object),
    );
    expect(result).toMatchObject({
      success: true,
      source: 'followup',
      recordId: 'recInitialFollowup',
      fieldKey: 'applicationFiles',
      fileToken: 'tokRemove',
      remaining: 1,
    });
  });

  it('marks follow-up materials uploaded after supplemental approval material submission', async () => {
    const service = createServiceWithAxios({});
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles]: [
        { file_token: 'tokApplication' },
      ],
    }));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.createBitableRecord = jest.fn(async () => 'recSupplemental');
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );

    await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'supplemental',
      },
      [
        {
          fieldname: 'applicationFiles',
          originalname: '施工作业申请单.pdf',
          mimetype: 'application/pdf',
          buffer: Buffer.from('application'),
          size: 4,
        },
      ],
    );
    await flushBackgroundTasks();

    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      expect.objectContaining({
        材料是否上传完成: true,
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining(['材料是否上传完成']),
      }),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recSupplemental',
      expect.objectContaining({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles]: [
          { file_token: 'tokApplication' },
        ],
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('copies valid permit audit and manual review fields into the first daily prepare record', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    const temporaryPowerField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
    const heightWorkField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.heightWorkPermitFiles;
    const temporaryPowerFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles
        .feedbackField;
    const heightWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.heightWorkPermitFiles
        .feedbackField;
    const temporaryPowerReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.temporaryPowerPermitFiles;
    const heightWorkReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.heightWorkPermitFiles;
    const temporaryPowerFiles = [
      {
        file_token: 'tokTemporaryPower',
        name: '临时用电作业票.jpg',
      },
    ];
    const heightWorkFiles = [
      {
        file_token: 'tokHeightWork',
        name: '高处作业票.jpg',
      },
    ];
    const temporaryPowerFeedback =
      '校验日期：2026-06-05；结论：通过；有效期至：2026-06-19；问题：无';
    const heightWorkFeedback =
      '校验日期：2026-06-05；结论：通过；有效期至：2026-06-18；问题：无';
    const temporaryPowerFingerprint =
      buildConstructionPermitManualReviewFingerprint(
        temporaryPowerFiles,
        '2026-06-19',
      );
    const heightWorkFingerprint =
      buildConstructionPermitManualReviewFingerprint(
        heightWorkFiles,
        '2026-06-18',
      );
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      {
        record_id: 'recPreviousFollowup',
        created_time: new Date('2026-06-04T09:00:00+08:00').getTime(),
        fields: {
          施工总览: ['recOverview'],
          [temporaryPowerField]: temporaryPowerFiles,
          [heightWorkField]: heightWorkFiles,
          [temporaryPowerFeedbackField]: temporaryPowerFeedback,
          [heightWorkFeedbackField]: heightWorkFeedback,
          [temporaryPowerReviewConfig.reviewField]: true,
          [heightWorkReviewConfig.reviewField]: true,
          [temporaryPowerReviewConfig.fingerprintField]:
            temporaryPowerFingerprint,
          [heightWorkReviewConfig.fingerprintField]: [
            {
              type: 'text',
              text: heightWorkFingerprint,
            },
          ],
        },
      },
    ]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工总览',
      sourceUrl: '',
    };
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles]: [
        { file_token: 'tokChecklist' },
      ],
      [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
        { file_token: 'tokIsolation' },
      ],
    }));
    service.auditConstructionIsolationPhotos = jest.fn(
      async () => '挂牌隔离审核通过',
    );
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    const result = await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        followupDate: '2026-06-05',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck: '已核对施工人员台账',
        workTypes: ['临时用电作业', '高处作业'],
        dailyCrewMembers: JSON.stringify([
          {
            recordId: 'recCrew1',
            name: '示例人员008',
            certificateSummary: '低压电工证、高处作业证',
            complianceStatus: '合规',
            issueSummary: null,
          },
        ]),
      },
      [
        {
          fieldname: 'dailyPersonnelChecklistFiles',
          originalname: '每日人员核查清单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: Buffer.from('checklist'),
          size: 9,
        },
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '挂牌.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('photo'),
          size: 5,
        },
      ],
    );

    expect(result.attachmentSyncPending).toBe(true);
    expect(service.createBitableRecord).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      expect.any(String),
      expect.not.objectContaining({
        [temporaryPowerField]: expect.anything(),
        [heightWorkField]: expect.anything(),
      }),
      'tenant-token',
      expect.any(Object),
    );

    await flushBackgroundTasks();

    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      expect.any(String),
      'recTodayFollowup',
      expect.objectContaining({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles]:
          [{ file_token: 'tokChecklist' }],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
          { file_token: 'tokIsolation' },
        ],
        [temporaryPowerField]: temporaryPowerFiles,
        [heightWorkField]: heightWorkFiles,
        [temporaryPowerFeedbackField]: temporaryPowerFeedback,
        [heightWorkFeedbackField]: heightWorkFeedback,
        [temporaryPowerReviewConfig.reviewField]: '通过',
        [heightWorkReviewConfig.reviewField]: '通过',
        [temporaryPowerReviewConfig.fingerprintField]:
          temporaryPowerFingerprint,
        [heightWorkReviewConfig.fingerprintField]: heightWorkFingerprint,
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('keeps inherited permit and manual review fields without AI feedback when the master switch is disabled', async () => {
    process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'false';
    try {
      const bitableDirectRead = jest.requireMock(
        '@server/common/feishu/bitable-direct-read',
      ) as { fetchBitableRecords: jest.Mock };
      const temporaryPowerField =
        CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
      const temporaryPowerAuditConfig =
        CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles;
      const temporaryPowerReviewConfig =
        CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.temporaryPowerPermitFiles;
      const temporaryPowerFiles = [
        {
          file_token: 'tokTemporaryPower',
          name: '临时用电作业票.jpg',
        },
      ];
      const temporaryPowerFeedback =
        '校验日期：2026-06-05；结论：通过；有效期至：2026-06-19；问题：无';
      const temporaryPowerFingerprint =
        buildConstructionPermitManualReviewFingerprint(
          temporaryPowerFiles,
          '2026-06-19',
        );
      bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
        {
          record_id: 'recPreviousFollowup',
          created_time: new Date('2026-06-04T09:00:00+08:00').getTime(),
          fields: {
            施工总览: ['recOverview'],
            [temporaryPowerField]: temporaryPowerFiles,
            [temporaryPowerAuditConfig.feedbackField]: temporaryPowerFeedback,
            ...Object.fromEntries(
              (temporaryPowerAuditConfig.fallbackFeedbackFields || []).map(
                (fieldName) => [fieldName, temporaryPowerFeedback],
              ),
            ),
            [temporaryPowerReviewConfig.reviewField]: true,
            [temporaryPowerReviewConfig.fingerprintField]:
              temporaryPowerFingerprint,
          },
        },
      ]);
      const service = createServiceWithAxios({});
      (service as any).constructionOverviewConfig = {
        appToken: '',
        wikiToken: '',
        tableId: '',
        viewId: '',
        tableName: '施工总览',
        sourceUrl: '',
      };
      service.buildDailyPersonnelChecklistUploadFile = jest.fn(
        async () => null,
      );
      service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.dailyPersonnelChecklistFiles]:
          [{ file_token: 'tokChecklist' }],
        [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
          { file_token: 'tokIsolation' },
        ],
      }));
      service.createBitableRecord = jest.fn(async () => 'recTodayFollowup');
      service.updateBitableRecordFields = jest.fn(async () => undefined);
      service.syncConstructionFollowupPostSaveSideEffects = jest.fn(
        async () => undefined,
      );

      await service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage: 'prepare',
          followupDate: '2026-06-05',
          followupStaffIds: ['ou_1'],
          dailyPersonnelCheck: '已核对施工人员台账',
          workTypes: ['临时用电作业'],
          dailyCrewMembers: JSON.stringify([
            {
              recordId: 'recCrew1',
              name: '示例人员008',
              certificateSummary: '低压电工证',
              complianceStatus: '合规',
              issueSummary: null,
            },
          ]),
        },
        [
          {
            fieldname: 'dailyPersonnelChecklistFiles',
            originalname: '每日人员核查清单.xlsx',
            mimetype:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer: Buffer.from('checklist'),
            size: 9,
          },
          {
            fieldname: 'isolationPhotoFiles',
            originalname: '挂牌.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('photo'),
            size: 5,
          },
        ],
      );
      await waitForCondition(
        () =>
          service.updateBitableRecordFields.mock.calls.some((call: unknown[]) =>
            Object.prototype.hasOwnProperty.call(
              call[4] as Record<string, unknown>,
              temporaryPowerField,
            ),
          ),
        'inherited permit attachment update',
      );

      const inheritedUpdate = service.updateBitableRecordFields.mock.calls
        .map((call: unknown[]) => call[4] as Record<string, unknown>)
        .find((fields: Record<string, unknown>) =>
          Object.prototype.hasOwnProperty.call(fields, temporaryPowerField),
        );
      expect(inheritedUpdate).toEqual(
        expect.objectContaining({
          [temporaryPowerField]: temporaryPowerFiles,
          [temporaryPowerReviewConfig.reviewField]: '通过',
          [temporaryPowerReviewConfig.fingerprintField]:
            temporaryPowerFingerprint,
        }),
      );
      expect(inheritedUpdate).not.toHaveProperty(
        temporaryPowerAuditConfig.feedbackField,
      );
      for (const fallbackField of temporaryPowerAuditConfig.fallbackFeedbackFields ||
        []) {
        expect(inheritedUpdate).not.toHaveProperty(fallbackField);
      }
      expect(
        Object.keys(inheritedUpdate || {}).filter((fieldName) =>
          /^(AI|OCR)/i.test(fieldName),
        ),
      ).toEqual([]);
    } finally {
      process.env.CONSTRUCTION_AI_AUDIT_ENABLED = 'true';
    }
  });

  it('requests EHS manual review by updating the watched hot-work permit field', async () => {
    const hotWorkField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles;
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    const hotWorkReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.hotWorkPermitFiles;
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [hotWorkField]: [
                {
                  file_token: 'tokHot',
                  name: 'hot-work-permit-old-record.png',
                },
              ],
              [hotWorkFeedbackField]:
                '核验日期：2026-06-04；核验版本：6；结论：不通过；有效期至：2026-05-31；问题：动火许可证审核未通过',
              [hotWorkReviewConfig.reviewField]: true,
              EHS工程师: [{ id: 'ou_ehs' }],
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });

    const result = await service.requestConstructionPermitManualReview({
      followupRecordId: 'recFollowup',
      fileKey: 'hotWorkPermitFiles',
    });

    expect(result).toMatchObject({
      success: true,
      recordId: 'recFollowup',
      fileKey: 'hotWorkPermitFiles',
      workflowTriggered: true,
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: expect.objectContaining({
          [hotWorkField]: [{ file_token: 'tokHot' }],
          [hotWorkReviewConfig.reviewField]: false,
          [hotWorkReviewConfig.fingerprintField]: expect.stringMatching(/^v1:/),
        }),
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('updates a construction permit manual review decision in Bitable', async () => {
    const hotWorkField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles;
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    const hotWorkReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.hotWorkPermitFiles;
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [hotWorkField]: [
                {
                  file_token: 'tokHot',
                  name: 'hot-work-permit.png',
                },
              ],
              [hotWorkFeedbackField]:
                '核验日期：2026-06-04；核验版本：6；结论：不通过；有效期至：2026-06-18；问题：动火许可证审核未通过',
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });

    const result = await service.updateConstructionPermitManualReview({
      followupRecordId: 'recFollowup',
      fileKey: 'hotWorkPermitFiles',
      decision: 'passed',
      validUntil: '2026-06-18',
      permitFingerprint: buildConstructionPermitManualReviewFingerprint(
        [{ file_token: 'tokHot' }],
        '2026-06-18',
      ),
    });

    expect(result).toMatchObject({
      success: true,
      recordId: 'recFollowup',
      fileKey: 'hotWorkPermitFiles',
      reviewField: hotWorkReviewConfig.reviewField,
      decision: 'passed',
      message: '动火作业票人工审核已标记为通过',
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: expect.objectContaining({
          [hotWorkReviewConfig.reviewField]: '通过',
          [hotWorkReviewConfig.fingerprintField]:
            buildConstructionPermitManualReviewFingerprint(
              [{ file_token: 'tokHot' }],
              '2026-06-18',
              'manual',
            ),
        }),
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('writes a v3 fingerprint when a passed manual review provides a validity range', async () => {
    const hotWorkField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles;
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    const hotWorkReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.hotWorkPermitFiles;
    const permitFiles = [{ file_token: 'tokHotRange' }];
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [hotWorkField]: permitFiles,
              [hotWorkFeedbackField]:
                '核验日期：2026-07-28；结论：通过；有效期至：2026-07-31；问题：无',
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });

    const result = await service.updateConstructionPermitManualReview({
      followupRecordId: 'recFollowup',
      fileKey: 'hotWorkPermitFiles',
      decision: 'passed',
      validFrom: '2026-07-28',
      validUntil: '2026-07-31',
      permitFingerprint: buildConstructionPermitManualReviewFingerprint(
        permitFiles,
        '2026-07-31',
      ),
    });

    const expectedFingerprint = buildConstructionPermitManualReviewFingerprint(
      permitFiles,
      '2026-07-31',
      'manual',
      '2026-07-28',
    );
    expect(expectedFingerprint).toMatch(/^v3:/);
    expect(result).toMatchObject({
      success: true,
      validFrom: '2026-07-28',
      validUntil: '2026-07-31',
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: expect.objectContaining({
          [hotWorkReviewConfig.reviewField]: '通过',
          [hotWorkReviewConfig.fingerprintField]: expectedFingerprint,
        }),
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('rejects a passed manual review whose validity start is after its end', async () => {
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ put });

    await expect(
      service.updateConstructionPermitManualReview({
        followupRecordId: 'recFollowup',
        fileKey: 'hotWorkPermitFiles',
        decision: 'passed',
        validFrom: '2026-08-01',
        validUntil: '2026-07-31',
      }),
    ).rejects.toThrow('授权有效期开始日期不得晚于结束日期');
    expect(put).not.toHaveBeenCalled();
  });

  it('writes rejected manual review decisions as rejection text', async () => {
    const tempPowerField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
    const tempPowerReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.temporaryPowerPermitFiles;
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [tempPowerField]: [{ file_token: 'tokTemp' }],
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });

    await service.updateConstructionPermitManualReview({
      followupRecordId: 'recFollowup',
      fileKey: 'temporaryPowerPermitFiles',
      decision: 'rejected',
    });

    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: expect.objectContaining({
          [tempPowerReviewConfig.reviewField]: '驳回',
        }),
      },
      expect.anything(),
    );
  });

  it('updates an isolation photo manual review decision in Bitable', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
                {
                  file_token: 'tokIso',
                  name: 'isolation-photo.jpg',
                },
              ],
              '挂牌&隔离合规反馈':
                '结论：不通过｜水印核验：通过｜现场核验：不通过',
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });
    service.fetchBitableFieldMetas = jest.fn(async () => [
      { field_id: 'fldIsolation', field_name: '挂牌与隔离是否合规', type: 3 },
    ]);

    const result = await service.updateConstructionIsolationPhotoManualReview({
      followupRecordId: 'recFollowup',
      decision: 'passed',
    });

    expect(result).toMatchObject({
      success: true,
      recordId: 'recFollowup',
      field: '挂牌与隔离照片',
      reviewField: '挂牌与隔离是否合规',
      decision: 'passed',
      message: '挂牌与隔离照片人工审核已标记为通过',
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: expect.objectContaining({
          挂牌与隔离是否合规: '通过',
        }),
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('writes isolation photo manual review to the existing compatible field only', async () => {
    const legacyReviewField = '挂牌&隔离是否合规';
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
                { file_token: 'tokIso', name: 'isolation-photo.jpg' },
              ],
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });
    service.fetchBitableFieldMetas = jest.fn(async () => [
      {
        field_id: 'fldLegacyIsolation',
        field_name: legacyReviewField,
        type: 3,
      },
    ]);

    await service.updateConstructionIsolationPhotoManualReview({
      followupRecordId: 'recFollowup',
      decision: 'passed',
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: {
          [legacyReviewField]: '通过',
        },
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('writes isolation photo manual review to the manual approval field used in Bitable', async () => {
    const actualReviewField = '人工审核-挂牌&隔离审核';
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
                { file_token: 'tokIso', name: 'isolation-photo.jpg' },
              ],
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });
    service.fetchBitableFieldMetas = jest.fn(async () => [
      {
        field_id: 'fldManualIsolation',
        field_name: actualReviewField,
        type: 3,
      },
    ]);

    const result = await service.updateConstructionIsolationPhotoManualReview({
      followupRecordId: 'recFollowup',
      decision: 'passed',
    });

    expect(result.reviewField).toBe(actualReviewField);
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: {
          [actualReviewField]: '通过',
        },
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('fails isolation photo manual review when no compatible review field exists', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
                { file_token: 'tokIso', name: 'isolation-photo.jpg' },
              ],
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });
    service.fetchBitableFieldMetas = jest.fn(async () => [
      { field_id: 'fldOther', field_name: '其他字段', type: 1 },
    ]);

    await expect(
      service.updateConstructionIsolationPhotoManualReview({
        followupRecordId: 'recFollowup',
        decision: 'passed',
      }),
    ).rejects.toThrow('未找到挂牌隔离人工审核字段');
    expect(put).not.toHaveBeenCalled();
  });

  it('writes boolean value for checkbox isolation photo manual review fields', async () => {
    const reviewField = '挂牌与隔离是否合规';
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
                { file_token: 'tokIso', name: 'isolation-photo.jpg' },
              ],
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });
    service.fetchBitableFieldMetas = jest.fn(async () => [
      { field_id: 'fldIsolation', field_name: reviewField, type: 7 },
    ]);

    await service.updateConstructionIsolationPhotoManualReview({
      followupRecordId: 'recFollowup',
      decision: 'passed',
    });

    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: {
          [reviewField]: true,
        },
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('falls back to the legacy isolation review field when the primary field is missing', async () => {
    const reviewField = '挂牌与隔离是否合规';
    const legacyReviewField = '挂牌&隔离是否合规';
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recFollowup',
            fields: {
              [CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.isolationPhotoFiles]: [
                {
                  file_token: 'tokIso',
                  name: 'isolation-photo.jpg',
                },
              ],
            },
          },
        },
      },
    });
    const put = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 1254045,
          msg: 'FieldNameNotFound',
          error: {
            message: `Invalid request parameter: fields.${reviewField}: Correct format : field_name not found.`,
          },
        },
      })
      .mockResolvedValueOnce({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });
    service.fetchBitableFieldMetas = jest.fn(async () => [
      { field_id: 'fldIsolation', field_name: reviewField, type: 3 },
      {
        field_id: 'fldLegacyIsolation',
        field_name: legacyReviewField,
        type: 3,
      },
    ]);

    await expect(
      service.updateConstructionIsolationPhotoManualReview({
        followupRecordId: 'recFollowup',
        decision: 'passed',
      }),
    ).resolves.toMatchObject({
      success: true,
      recordId: 'recFollowup',
      reviewField,
      decision: 'passed',
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(
      expect.stringContaining('/records/recFollowup'),
      {
        fields: {
          [legacyReviewField]: '通过',
        },
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('writes manual review decisions to the target follow-up using source permit tokens when the target has no attachment', async () => {
    const hotWorkReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.hotWorkPermitFiles;
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recTodayFollowup',
            fields: {},
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });

    await service.updateConstructionPermitManualReview({
      followupRecordId: 'recTodayFollowup',
      fileKey: 'hotWorkPermitFiles',
      decision: 'rejected',
      permitFileTokens: ['tokHotSource'],
      sourceFeedback:
        '核验日期：2026-06-04；核验版本：6；结论：不通过；有效期至：2026-05-29；问题：动火许可证审核未通过',
      permitFingerprint: buildConstructionPermitManualReviewFingerprint(
        [{ file_token: 'tokHotSource' }],
        '2026-05-29',
      ),
    });

    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/recTodayFollowup'),
      {
        fields: expect.objectContaining({
          [hotWorkReviewConfig.reviewField]: '驳回',
          [hotWorkReviewConfig.fingerprintField]:
            buildConstructionPermitManualReviewFingerprint(
              [{ file_token: 'tokHotSource' }],
              '2026-05-29',
            ),
        }),
      },
      expect.anything(),
    );
  });

  it('rejects a permit manual review when the ticket changed after the reviewer opened it', async () => {
    const hotWorkField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles;
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    const feedback =
      '核验日期：2026-06-04；核验版本：6；结论：通过；有效期至：2026-06-19；问题：无';
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'recTodayFollowup',
            fields: {
              [hotWorkField]: [
                { file_token: 'tokHotCurrent', name: 'hot-current.jpg' },
              ],
              [hotWorkFeedbackField]: feedback,
            },
          },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const service = createServiceWithAxios({ get, put });

    await expect(
      service.updateConstructionPermitManualReview({
        followupRecordId: 'recTodayFollowup',
        fileKey: 'hotWorkPermitFiles',
        decision: 'passed',
        validUntil: '2026-06-19',
        permitFileTokens: ['tokHotOpened'],
        permitFingerprint: buildConstructionPermitManualReviewFingerprint(
          [{ file_token: 'tokHotOpened' }],
          '2026-06-19',
        ),
      }),
    ).rejects.toThrow('作业票已变化，请刷新后重新人工审核');
    expect(put).not.toHaveBeenCalled();
  });

  it('auto-checks a valid current permit when the same permit was manually approved before', async () => {
    const tempPowerField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
    const tempPowerFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles
        .feedbackField;
    const tempPowerReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.temporaryPowerPermitFiles;
    const feedback =
      '核验日期：2026-06-04；核验版本：6；结论：通过；有效期至：2026-06-19；说明：临时用电作业许可证有效期未过期；问题：无';
    const fingerprint = buildConstructionPermitManualReviewFingerprint(
      [{ file_token: 'tokTempPower' }],
      '2026-06-19',
    );
    const service = createServiceWithAxios({});
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [],
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const refreshed = await service.refreshDailyPermitAuditFeedbacksIfNeeded({
      referenceDate: new Date('2026-06-04T08:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业', '临时用电作业'],
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recCurrentFollowup',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业', '临时用电作业'],
            [tempPowerField]: [
              {
                file_token: 'tokTempPower',
                name: '临时用电作业票.jpg',
                size: 123,
              },
            ],
            [tempPowerFeedbackField]: feedback,
            [tempPowerReviewConfig.reviewField]: false,
            [tempPowerReviewConfig.fingerprintField]: fingerprint,
          },
        },
        {
          record_id: 'recApprovedFollowup',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业', '临时用电作业'],
            [tempPowerField]: [
              {
                file_token: 'tokTempPower',
                name: '临时用电作业票.jpg',
                size: 123,
              },
            ],
            [tempPowerFeedbackField]: feedback,
            [tempPowerReviewConfig.reviewField]: true,
            [tempPowerReviewConfig.fingerprintField]: fingerprint,
          },
        },
      ],
      crewRecords: [],
    });

    expect(refreshed).toBe(true);
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recCurrentFollowup',
      expect.objectContaining({
        [tempPowerReviewConfig.reviewField]: '通过',
        [tempPowerReviewConfig.fingerprintField]: fingerprint,
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          tempPowerReviewConfig.reviewField,
          tempPowerReviewConfig.fingerprintField,
        ]),
      }),
    );
  });

  it('refreshes safety notice AI feedback without daily validity audit mode', async () => {
    const safetyNoticeField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.safetyNoticePhotoFiles;
    const safetyNoticeConfig =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.safetyNoticePhotoFiles;
    const service = createServiceWithAxios({});
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [],
    );
    service.downloadPermitAttachmentUploadFiles = jest.fn(async () => [
      {
        fieldname: 'safetyNoticePhotoFiles',
        originalname: '安全告知书.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('safety-notice'),
        size: 13,
      },
    ]);
    service.auditConstructionPermitFiles = jest.fn(
      async () => '结论：通过；分组：安全告知书；问题：无',
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const refreshed = await service.refreshDailyPermitAuditFeedbacksIfNeeded({
      referenceDate: new Date('2026-06-12T08:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recSafetyFollowup',
          updated_time: '2026-06-12T08:00:00.000Z',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
            [safetyNoticeField]: [
              {
                file_token: 'tokSafety',
                name: '安全告知书.jpg',
                size: 123,
              },
            ],
            [safetyNoticeConfig.feedbackField]:
              '结论：需人工复核；分组：安全告知书；问题：旧结果（有效期至 2026-05-22）',
          },
        },
        {
          record_id: 'recOlderSafetyFollowup',
          updated_time: '2026-06-11T08:00:00.000Z',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
            [safetyNoticeField]: [
              {
                file_token: 'tokOlderSafety',
                name: '安全告知书-旧记录.jpg',
                size: 123,
              },
            ],
          },
        },
      ],
      crewRecords: [],
    });

    expect(refreshed).toBe(true);
    expect(service.auditConstructionPermitFiles).toHaveBeenCalledTimes(2);
    expect(service.auditConstructionPermitFiles).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      '安全告知书',
      expect.any(Array),
      expect.any(Date),
      expect.objectContaining({
        dailyValidityRefresh: false,
        requiresValidity: false,
      }),
    );
    expect(service.auditConstructionPermitFiles).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      '安全告知书',
      expect.any(Array),
      expect.any(Date),
      expect.objectContaining({
        dailyValidityRefresh: false,
        requiresValidity: false,
      }),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recSafetyFollowup',
      expect.objectContaining({
        [safetyNoticeConfig.feedbackField]:
          '结论：通过；分组：安全告知书；问题：无',
        'AI审核结果-安全告知书照片': '结论：通过；分组：安全告知书；问题：无',
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          'AI审核结果-安全告知书',
          'AI审核结果-安全告知书照片',
        ]),
      }),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recOlderSafetyFollowup',
      expect.objectContaining({
        [safetyNoticeConfig.feedbackField]:
          '结论：通过；分组：安全告知书；问题：无',
        'AI审核结果-安全告知书照片': '结论：通过；分组：安全告知书；问题：无',
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('refreshes hot work risk disclosure AI feedback into the risk disclosure field', async () => {
    const riskDisclosureField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkRiskDisclosureFiles;
    const riskDisclosureConfig =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkRiskDisclosureFiles;
    const service = createServiceWithAxios({});
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [],
    );
    service.downloadPermitAttachmentUploadFiles = jest.fn(async () => [
      {
        fieldname: 'hotWorkRiskDisclosureFiles',
        originalname: '动火作业风险交底单.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('risk-disclosure'),
        size: 15,
      },
    ]);
    service.auditConstructionPermitFiles = jest.fn(
      async () =>
        '结论：通过；1. 填写：关键项可见；2. 人员：疑似5人；3. 日期：交底早于作业',
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const refreshed = await service.refreshDailyPermitAuditFeedbacksIfNeeded({
      referenceDate: new Date('2026-06-12T08:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recRiskFollowup',
          updated_time: '2026-06-12T08:00:00.000Z',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
            [riskDisclosureField]: [
              {
                file_token: 'tokRisk',
                name: '动火作业风险交底单.jpg',
                size: 123,
              },
            ],
          },
        },
      ],
      crewRecords: [],
    });

    expect(refreshed).toBe(true);
    expect(service.auditConstructionPermitFiles).toHaveBeenCalledWith(
      expect.any(Array),
      '动火作业风险交底单',
      expect.any(Array),
      expect.any(Date),
      expect.objectContaining({
        dailyValidityRefresh: false,
        requiresValidity: false,
      }),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recRiskFollowup',
      expect.objectContaining({
        [riskDisclosureConfig.feedbackField]:
          '结论：通过；1. 填写：关键项可见；2. 人员：疑似5人；3. 日期：交底早于作业',
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          riskDisclosureConfig.feedbackField,
        ]),
      }),
    );
  });

  it('refreshes construction application form AI feedback with crew ledger context', async () => {
    const applicationField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles;
    const applicationConfig =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.applicationFiles;
    const service = createServiceWithAxios({});
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [],
    );
    service.downloadPermitAttachmentUploadFiles = jest.fn(async () => [
      {
        fieldname: 'applicationFiles',
        originalname: '施工作业申请单.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('application-form'),
        size: 16,
      },
    ]);
    service.auditConstructionPermitFiles = jest.fn(
      async () =>
        '结论：需人工复核；1. 填写：待核；2. 人员：需核对台账；3. 有效期：至2026-06-20',
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const refreshed = await service.refreshDailyPermitAuditFeedbacksIfNeeded({
      referenceDate: new Date('2026-06-12T08:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recApplicationFollowup',
          updated_time: '2026-06-12T08:00:00.000Z',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
            [applicationField]: [
              {
                file_token: 'tokApplication',
                name: '施工作业申请单.jpg',
                size: 123,
              },
            ],
            [applicationConfig.feedbackField]:
              '结论：不通过；1. 完整性：作业内容；2. 人员：但施工人员签字处手写姓名与身份证号模糊；3. 有效期：至2026-06-20',
          },
        },
        {
          record_id: 'recOlderApplicationFollowup',
          updated_time: '2026-06-11T08:00:00.000Z',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
            [applicationField]: [
              {
                file_token: 'tokOlderApplication',
                name: '施工作业申请单-旧.jpg',
                size: 123,
              },
            ],
            [applicationConfig.feedbackField]:
              '结论：需人工复核；1. 填写：待核；2. 人员：待核；3. 有效期：未识别',
          },
        },
      ],
      crewRecords: [
        {
          record_id: 'recCrew',
          fields: {
            施工编码: 'SG260605-1035',
            姓名: '张鹏',
            身份证号码: '411024199110154959',
            授权状态: '授权有效',
            证件摘要: '低压电工证',
          },
        },
      ],
    });

    expect(refreshed).toBe(true);
    expect(service.auditConstructionPermitFiles).toHaveBeenCalledTimes(2);
    expect(service.auditConstructionPermitFiles).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      '施工申请单',
      expect.any(Array),
      expect.any(Date),
      expect.objectContaining({
        dailyValidityRefresh: false,
        requiresValidity: true,
        context: expect.objectContaining({
          workContent: '测试-A',
          workTypes: ['一般作业'],
          crewMembers: expect.arrayContaining([
            expect.objectContaining({
              name: '张鹏',
              certificateNo: '411024199110154959',
            }),
          ]),
        }),
      }),
    );
    expect(service.auditConstructionPermitFiles).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      '施工申请单',
      expect.any(Array),
      expect.any(Date),
      expect.objectContaining({
        dailyValidityRefresh: false,
        requiresValidity: true,
      }),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recApplicationFollowup',
      expect.objectContaining({
        [applicationConfig.feedbackField]:
          '结论：需人工复核；1. 填写：待核；2. 人员：需核对台账；3. 有效期：至2026-06-20',
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          applicationConfig.feedbackField,
        ]),
      }),
    );
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recOlderApplicationFollowup',
      expect.objectContaining({
        [applicationConfig.feedbackField]:
          '结论：需人工复核；1. 填写：待核；2. 人员：需核对台账；3. 有效期：至2026-06-20',
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it('refreshes training assessment AI feedback by comparing sign-in count and assessment files', async () => {
    const signInField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.entryTrainingSignInFiles;
    const assessmentField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.entryTrainingAssessmentFiles;
    const service = createServiceWithAxios({});
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [],
    );
    service.downloadPermitAttachmentUploadFiles = jest.fn(
      async (fieldKey: string) => {
        if (fieldKey === 'entryTrainingSignInFiles') {
          return [
            {
              fieldname: fieldKey,
              originalname: '入场培训签到表.xlsx',
              mimetype:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              buffer: buildTrainingSignInWorkbookBuffer([
                '张一',
                '张二',
                '示例人员008',
                '张四',
                '张五',
              ]),
              size: 128,
            },
          ];
        }
        if (fieldKey === 'entryTrainingAssessmentFiles') {
          return ['1', '2', '3', '4'].map((index) => ({
            fieldname: fieldKey,
            originalname: `入场培训考核-${index}.jpg`,
            mimetype: 'image/jpeg',
            buffer: Buffer.from(`exam-${index}`),
            size: 6,
          }));
        }
        return [];
      },
    );
    service.auditConstructionPermitFiles = jest.fn(async () => null);
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const refreshed = await service.refreshDailyPermitAuditFeedbacksIfNeeded({
      referenceDate: new Date('2026-06-12T08:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recTrainingFollowup',
          updated_time: '2026-06-12T08:00:00.000Z',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业'],
            [signInField]: [
              {
                file_token: 'tokTrainingSignIn',
                name: '入场培训签到表.xlsx',
                size: 123,
              },
            ],
            [assessmentField]: [
              { file_token: 'tokExam1', name: '入场培训考核-1.jpg', size: 6 },
              { file_token: 'tokExam2', name: '入场培训考核-2.jpg', size: 6 },
              { file_token: 'tokExam3', name: '入场培训考核-3.jpg', size: 6 },
              { file_token: 'tokExam4', name: '入场培训考核-4.jpg', size: 6 },
            ],
          },
        },
      ],
      crewRecords: [],
    });

    expect(refreshed).toBe(true);
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recTrainingFollowup',
      expect.objectContaining({
        [CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD]:
          '结论：不通过；1. 人数：签到疑似5人；2. 文件：考核4份；3. 匹配：缺1份',
      }),
      'tenant-token',
      expect.objectContaining({
        optionalMissingFieldNames: expect.arrayContaining([
          CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD,
        ]),
      }),
    );
  });

  it('does not expose vision audit failure details in construction application feedback', async () => {
    const service = createServiceWithAxios({});
    service.getConstructionImageAuditConfig = jest.fn(() => ({
      apiKey: 'test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-vl-max-latest',
      timeoutMs: 120000,
      retryAttempts: 1,
      retryBaseDelayMs: 0,
    }));
    service.postConstructionImageAudit = jest.fn(async () => {
      throw new Error(
        'Client network socket disconnected before secure TLS connection was established',
      );
    });

    const feedback = await service.auditConstructionPermitFiles(
      [
        {
          fieldname: 'applicationFiles',
          originalname: '作业申请单6.7-6.21.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('application-form'),
          size: 16,
        },
      ],
      '施工申请单',
      [],
      new Date('2026-06-12T08:00:00+08:00'),
      { requiresValidity: true },
    );

    expect(feedback).toBe(
      '结论：需人工复核；1. 填写：待核；2. 人员：作业人数待核，身份证待核；3. 有效期：至2026-06-21',
    );
    expect(feedback).not.toContain('视觉审核失败');
    expect(feedback).not.toContain('Client network');
  });

  it('auto-checks the current permit when the same permit was manually approved before even if AI now rejects it', async () => {
    const hotWorkField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles;
    const hotWorkFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkPermitFiles
        .feedbackField;
    const hotWorkReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.hotWorkPermitFiles;
    const approvedFeedback =
      '核验日期：2026-06-04；核验版本：6；结论：通过；有效期至：2026-06-19；说明：动火许可证有效期未过期；问题：无';
    const invalidFeedback =
      '核验日期：2026-06-04；核验版本：6；结论：不通过；有效期至：2026-06-19；问题：动火许可证审核未通过';
    const fingerprint = buildConstructionPermitManualReviewFingerprint(
      [{ file_token: 'tokHotWork' }],
      '2026-06-19',
    );
    const service = createServiceWithAxios({});
    service.fetchConstructionPermitAuditRequirementRecords = jest.fn(
      async () => [],
    );
    service.updateBitableRecordFields = jest.fn(async () => undefined);

    const refreshed = await service.refreshDailyPermitAuditFeedbacksIfNeeded({
      referenceDate: new Date('2026-06-04T08:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业', '动火作业'],
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recCurrentFollowup',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业', '动火作业'],
            [hotWorkField]: [
              {
                file_token: 'tokHotWork',
                name: '动火作业票.jpg',
                size: 123,
              },
            ],
            [hotWorkFeedbackField]: invalidFeedback,
            [hotWorkReviewConfig.reviewField]: false,
            [hotWorkReviewConfig.fingerprintField]: fingerprint,
          },
        },
        {
          record_id: 'recApprovedFollowup',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            作业类型: ['一般作业', '动火作业'],
            [hotWorkField]: [
              {
                file_token: 'tokHotWork',
                name: '动火作业票.jpg',
                size: 123,
              },
            ],
            [hotWorkFeedbackField]: approvedFeedback,
            [hotWorkReviewConfig.reviewField]: true,
            [hotWorkReviewConfig.fingerprintField]: fingerprint,
          },
        },
      ],
      crewRecords: [],
    });

    expect(refreshed).toBe(true);
    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'recCurrentFollowup',
      {
        [hotWorkReviewConfig.reviewField]: '通过',
        [hotWorkReviewConfig.fingerprintField]: fingerprint,
      },
      expect.any(String),
      expect.any(Object),
    );
  });

  it('auto-checks an existing daily prepare record during submit when a same permit was manually approved before', async () => {
    const bitableDirectRead = jest.requireMock(
      '@server/common/feishu/bitable-direct-read',
    ) as { fetchBitableRecords: jest.Mock };
    const tempPowerField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
    const tempPowerFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles
        .feedbackField;
    const tempPowerReviewConfig =
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.temporaryPowerPermitFiles;
    const feedback =
      '核验日期：2026-06-09；核验版本：6；结论：通过；有效期至：2026-06-19；说明：临时用电作业许可证有效期未过期；问题：无';
    const fingerprint = buildConstructionPermitManualReviewFingerprint(
      [{ file_token: 'tokTempPower' }],
      '2026-06-19',
    );
    const currentFollowup = {
      record_id: 'recCurrentFollowup',
      created_time: new Date().toISOString(),
      fields: {
        施工编码: 'SG260505-1040',
        施工总览: ['recOverview'],
        挂牌与隔离照片: [{ file_token: 'tokIsolation' }],
        [tempPowerField]: [
          { file_token: 'tokTempPower', name: '临时用电作业票.jpg', size: 123 },
        ],
        [tempPowerFeedbackField]: feedback,
        [tempPowerReviewConfig.reviewField]: false,
        [tempPowerReviewConfig.fingerprintField]: fingerprint,
      },
    };
    bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([
      currentFollowup,
      {
        record_id: 'recApprovedFollowup',
        created_time: new Date(Date.now() - 3600_000).toISOString(),
        fields: {
          施工编码: 'SG260505-1040',
          施工总览: ['recOverview'],
          [tempPowerField]: [
            {
              file_token: 'tokTempPower',
              name: '临时用电作业票.jpg',
              size: 123,
            },
          ],
          [tempPowerFeedbackField]: feedback,
          [tempPowerReviewConfig.reviewField]: true,
          [tempPowerReviewConfig.fingerprintField]: fingerprint,
        },
      },
    ]);
    const service = createServiceWithAxios({});
    (service as any).constructionOverviewConfig = {
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
      tableName: '施工项目总览',
      sourceUrl: '',
    };
    service.fetchConstructionFollowupRecordById = jest.fn(
      async () => currentFollowup,
    );
    service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
      每日人员核查清单: [{ file_token: 'tokChecklist' }],
    }));
    service.auditConstructionIsolationPhotos = jest.fn(async () => null);
    service.auditConstructionPermitAttachments = jest.fn(async () => ({}));
    service.updateBitableRecordFields = jest.fn(async () => undefined);
    service.ensureConstructionFollowupOverviewLink = jest.fn(
      async () => undefined,
    );
    service.ensureConstructionCrewLedgerProjectView = jest.fn(
      async () => undefined,
    );

    await service.createConstructionFollowup(
      {
        constructionRecordId: 'recOverview',
        followupRecordId: 'recCurrentFollowup',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        followupDate: '2026-06-09',
        followupStaffIds: ['ou_1'],
        dailyPersonnelCheck: '已核对施工人员台账',
        dailyCrewMembers: JSON.stringify([
          {
            recordId: 'crew-1',
            name: '示例人员008',
            certificateSummary: '低压电工证',
          },
        ]),
        checklistConstructionCode: 'SG260505-1040',
        workTypes: ['一般作业', '临时用电作业'],
      },
      [],
    );
    await flushBackgroundTasks();

    expect(service.updateBitableRecordFields).toHaveBeenCalledWith(
      'followupApp',
      'tblFollowup',
      '施工跟进',
      'recCurrentFollowup',
      expect.objectContaining({
        [tempPowerReviewConfig.reviewField]: '通过',
        [tempPowerReviewConfig.fingerprintField]: fingerprint,
      }),
      'tenant-token',
      expect.any(Object),
    );
  });

  it.each(['prepare', 'process', 'close'] as const)(
    'infers permit-only upload for legacy daily %s permit renewal submissions',
    async (dailyFollowupStage) => {
      const bitableDirectRead = jest.requireMock(
        '@server/common/feishu/bitable-direct-read',
      ) as { fetchBitableRecords: jest.Mock };
      bitableDirectRead.fetchBitableRecords.mockResolvedValueOnce([]);
      const service = createServiceWithAxios({});
      (service as any).constructionOverviewConfig = {
        appToken: '',
        wikiToken: '',
        tableId: '',
        viewId: '',
        tableName: '施工项目总览',
        sourceUrl: '',
      };
      service.uploadConstructionAttachmentFieldValues = jest.fn(async () => ({
        动火许可证: [{ file_token: 'tokHot' }],
      }));
      service.auditConstructionIsolationPhotos = jest.fn(async () => null);
      service.auditConstructionPermitAttachments = jest.fn(async () => ({
        'AI审核结果-动火许可证': '动火票审核通过',
      }));
      service.createBitableRecord = jest.fn(async () => 'recPermitRenewal');
      service.ensureConstructionFollowupOverviewLink = jest.fn(
        async () => undefined,
      );
      service.ensureConstructionCrewLedgerProjectView = jest.fn(
        async () => undefined,
      );

      const result = await service.createConstructionFollowup(
        {
          constructionRecordId: 'recOverview',
          followupMode: 'daily',
          dailyFollowupStage,
          followupStaffIds: JSON.stringify([]),
        },
        [
          {
            fieldname: 'hotWorkPermitFiles',
            originalname: '动火作业票.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('permit'),
            size: 6,
          },
        ],
      );

      expect(result.message).toContain('新作业票已提交');
      expect(result.message).toContain('后台同步');
      expect(result.attachmentSyncPending).toBe(true);
      expect(service.createBitableRecord).toHaveBeenCalledWith(
        'followupApp',
        'tblFollowup',
        '施工跟进',
        expect.not.objectContaining({
          每日人员核查: expect.anything(),
        }),
        'tenant-token',
        expect.any(Object),
      );
    },
  );
});
