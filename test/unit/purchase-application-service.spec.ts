jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'app',
      app_secret: 'secret',
    })),
    parseFeishuBitableLink: jest.fn(() => ({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
    readEnv: jest.fn((name: string, aliases: string[] = []) => {
      for (const key of [name, ...aliases]) {
        const value = process.env[key]?.trim();
        if (value) return value;
      }
      return '';
    }),
  }),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn().mockResolvedValue('app-token'),
  fetchBitableRecords: jest.fn().mockResolvedValue([]),
  invalidateBitableRecordCache: jest.fn(),
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PurchaseApplicationBatchRequest } from '../../shared/purchase-application.interface';
import {
  fetchBitableRecords,
  invalidateBitableRecordCache,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
import { PurchaseApplicationTaskLedgerStore } from '../../server/modules/purchase-inventory/purchase-application-task-ledger.store';
import {
  buildPurchaseApplicationSubmissionFingerprint,
  PurchaseApplicationService,
} from '../../server/modules/purchase-inventory/purchase-application.service';

const temporaryLedgerDirectories: string[] = [];
const TEST_PURCHASE_PRINCIPAL_FINGERPRINT = 'purchase-test-principal-A';

afterAll(() => {
  for (const directory of temporaryLedgerDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PurchaseApplicationService catalog reads', () => {
  const originalEnv = {
    sourceUrl: process.env.FEISHU_PURCHASE_INVENTORY_SOURCE_URL,
    catalogTableId: process.env.FEISHU_ITEM_CATEGORY_TABLE_ID,
    submissionTableId: process.env.FEISHU_PURCHASE_SUBMISSION_TABLE_ID,
    executionTableId: process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID,
    employeeSourceUrl: process.env.FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL,
    employeeAppToken: process.env.FEISHU_ACTIVE_EMPLOYEE_APP_TOKEN,
    employeeWikiToken: process.env.FEISHU_ACTIVE_EMPLOYEE_WIKI_TOKEN,
    employeeTableId: process.env.FEISHU_ACTIVE_EMPLOYEE_TABLE_ID,
    employeeViewId: process.env.FEISHU_ACTIVE_EMPLOYEE_VIEW_ID,
    orgSourceUrl: process.env.FEISHU_ORG_SOURCE_URL,
    orgAppToken: process.env.FEISHU_ORG_APP_TOKEN,
    orgWikiToken: process.env.FEISHU_ORG_WIKI_TOKEN,
    orgTableId: process.env.FEISHU_ORG_TABLE_ID,
    orgViewId: process.env.FEISHU_ORG_VIEW_ID,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEISHU_PURCHASE_INVENTORY_SOURCE_URL =
      'https://vnet.feishu.cn/wiki/SiW9wuy9DiIsykkTkNUcM0HfnSb';
    process.env.FEISHU_ITEM_CATEGORY_TABLE_ID = 'tblhdbfhazvxIlmX';
    process.env.FEISHU_PURCHASE_SUBMISSION_TABLE_ID = 'tblIfmOB4VTUMmMh';
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = 'tblKmajonrdwW7Z0';
    process.env.FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL =
      'https://vnet.feishu.cn/wiki/AdQmwOqwei6Xr4kag3pcp1Flnmg';
    process.env.FEISHU_ACTIVE_EMPLOYEE_TABLE_ID = 'tblOu75UtJTDNHIM';
    process.env.FEISHU_ACTIVE_EMPLOYEE_VIEW_ID = 'vewrQcypV4';
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('app-token');
  });

  afterAll(() => {
    restoreEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL', originalEnv.sourceUrl);
    restoreEnv('FEISHU_ITEM_CATEGORY_TABLE_ID', originalEnv.catalogTableId);
    restoreEnv(
      'FEISHU_PURCHASE_SUBMISSION_TABLE_ID',
      originalEnv.submissionTableId,
    );
    restoreEnv(
      'FEISHU_PURCHASE_EXECUTION_TABLE_ID',
      originalEnv.executionTableId,
    );
    restoreEnv(
      'FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL',
      originalEnv.employeeSourceUrl,
    );
    restoreEnv(
      'FEISHU_ACTIVE_EMPLOYEE_APP_TOKEN',
      originalEnv.employeeAppToken,
    );
    restoreEnv(
      'FEISHU_ACTIVE_EMPLOYEE_WIKI_TOKEN',
      originalEnv.employeeWikiToken,
    );
    restoreEnv('FEISHU_ACTIVE_EMPLOYEE_TABLE_ID', originalEnv.employeeTableId);
    restoreEnv('FEISHU_ACTIVE_EMPLOYEE_VIEW_ID', originalEnv.employeeViewId);
    restoreEnv('FEISHU_ORG_SOURCE_URL', originalEnv.orgSourceUrl);
    restoreEnv('FEISHU_ORG_APP_TOKEN', originalEnv.orgAppToken);
    restoreEnv('FEISHU_ORG_WIKI_TOKEN', originalEnv.orgWikiToken);
    restoreEnv('FEISHU_ORG_TABLE_ID', originalEnv.orgTableId);
    restoreEnv('FEISHU_ORG_VIEW_ID', originalEnv.orgViewId);
  });

  it('filters catalog records and trims dirty Feishu option values', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      {
        record_id: 'rec-a4-paper',
        fields: {
          SourceID: 'source-a4',
          名称: ' A4纸 ',
          楼栋: ' H楼 ',
          专业: ' 其他 ',
          一级分类: ' D消耗类 ',
          二级分类: ' 办公耗材D2 ',
          '规格型号、设备序列号': '80g 500张',
          品牌: '得力',
          计数单位: ' 包 ',
          物品类别号: 'D2-001',
        },
      },
      {
        record_id: 'rec-a4-label',
        fields: {
          名称: 'A4标签纸',
          楼栋: 'A楼',
          一级分类: 'D消耗类',
          二级分类: '办公耗材D2',
          计数单位: '包',
          物品类别号: 'D2-002',
        },
      },
    ]);

    const service = new PurchaseApplicationService({ axiosRef: {} } as never);
    const result = await service.searchCatalog({
      building: 'H楼',
      primaryCategory: 'D消耗类',
      secondaryCategory: '办公耗材D2',
      query: 'A4',
      limit: 50,
    });

    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app-token',
        tableId: 'tblhdbfhazvxIlmX',
      }),
    );
    expect(result).toEqual([
      {
        recordId: 'rec-a4-paper',
        sku: 'D2-001',
        name: 'A4纸',
        building: 'H楼',
        specialty: '其他',
        primaryCategory: 'D消耗类',
        secondaryCategory: '办公耗材D2',
        specification: '80g 500张',
        brand: '得力',
        unit: '包',
      },
    ]);
  });

  it('sorts exact name matches first and clamps the result to 50 rows', async () => {
    const records = Array.from({ length: 60 }, (_, index) => ({
      record_id: `rec-${index}`,
      fields: {
        名称: index === 59 ? 'A4' : `A4纸-${index}`,
        楼栋: 'H楼',
        一级分类: 'D消耗类',
        二级分类: '办公耗材D2',
        物品类别号: `D2-${index}`,
      },
    }));
    (fetchBitableRecords as jest.Mock).mockResolvedValue(records);

    const service = new PurchaseApplicationService({ axiosRef: {} } as never);
    const result = await service.searchCatalog({ query: 'a4', limit: 999 });

    expect(result).toHaveLength(50);
    expect(result[0]?.name).toBe('A4');
  });

  it('bypasses the catalog cache when a caller requires a fresh building-scoped read', async () => {
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);

    await service.searchCatalog({ building: 'A楼' }, true);

    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it('returns the verified form option sets', () => {
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);

    expect(service.getOptions()).toEqual(
      expect.objectContaining({
        buildings: ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'],
        purchaseMethods: ['需求自采（楼内）', '综合采购'],
        purchaseChannels: ['线上', '线下'],
        procurementForms: ['三方比价', '单一采购'],
        primaryCategories: [
          'A备品备件类',
          'B工具类',
          'C物资类',
          'D消耗类',
          '//',
        ],
      }),
    );
  });

  it('returns isolated procurement form options on every call', () => {
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);
    const first = service.getOptions();

    first.procurementForms.length = 0;

    expect(service.getOptions().procurementForms).toEqual([
      '三方比价',
      '单一采购',
    ]);
  });

  it('fuzzy searches active employees and excludes departed or unmapped users', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      {
        record_id: 'rec-ma',
        fields: {
          姓名: '马金玉',
          员工姓名: [{ id: 'ou_ma', name: '马金玉' }],
          员工工号: 'NT-001',
          岗位: '综合管理',
          '机楼/专业': ['H楼', '电气'],
          楼栋: ['optInternalBuildingId'],
          '离职/异动情况': false,
        },
      },
      {
        record_id: 'rec-departed',
        fields: {
          姓名: '马金山',
          员工姓名: [{ id: 'ou_departed', name: '马金山' }],
          员工工号: 'NT-002',
          岗位: '运维工程师',
          '离职/异动情况': true,
        },
      },
      {
        record_id: 'rec-no-user',
        fields: {
          姓名: '马金海',
          员工工号: 'NT-003',
          岗位: '运维工程师',
          '离职/异动情况': false,
        },
      },
      {
        record_id: 'rec-other',
        fields: {
          姓名: '李明',
          员工姓名: [{ id: 'ou_li', name: '李明' }],
          员工工号: 'NT-004',
          岗位: '运维工程师',
          '离职/异动情况': false,
        },
      },
    ]);
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);

    const result = await service.searchApplicants({ query: '马金', limit: 99 });

    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app-token',
        tableId: 'tblOu75UtJTDNHIM',
        viewId: 'vewrQcypV4',
      }),
    );
    expect(result).toEqual([
      {
        recordId: 'rec-ma',
        openId: 'ou_ma',
        name: '马金玉',
        employeeNo: 'NT-001',
        position: '综合管理',
        building: 'H楼',
        specialty: 'H楼、电气',
      },
    ]);
  });

  it('falls back to the deployed organization source when active employee keys are absent', async () => {
    delete process.env.FEISHU_ACTIVE_EMPLOYEE_SOURCE_URL;
    delete process.env.FEISHU_ACTIVE_EMPLOYEE_APP_TOKEN;
    delete process.env.FEISHU_ACTIVE_EMPLOYEE_WIKI_TOKEN;
    delete process.env.FEISHU_ACTIVE_EMPLOYEE_TABLE_ID;
    delete process.env.FEISHU_ACTIVE_EMPLOYEE_VIEW_ID;
    process.env.FEISHU_ORG_APP_TOKEN = 'legacy-org-app-token';
    process.env.FEISHU_ORG_TABLE_ID = 'tbl-legacy-org';
    process.env.FEISHU_ORG_VIEW_ID = 'vew-legacy-org';
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      activeApplicantRecord('rec-liu', 'ou-liu', '刘小杏', 'H楼'),
    ]);
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);

    await expect(
      service.searchApplicants({ query: '刘小杏', limit: 30 }),
    ).resolves.toEqual([
      expect.objectContaining({
        recordId: 'rec-liu',
        openId: 'ou-liu',
        name: '刘小杏',
      }),
    ]);
    expect(resolveBitableAppToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'legacy-org-app-token',
        tableName: '在职人员',
      }),
    );
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tbl-legacy-org',
        viewId: 'vew-legacy-org',
      }),
    );
  });

  it('filters active applicants by building and supports a forced fresh read', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      activeApplicantRecord('rec-a', 'ou-a', '申请人甲', 'A楼'),
      activeApplicantRecord('rec-b', 'ou-b', '申请人乙', 'B楼'),
    ]);
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);

    const result = await service.searchApplicants({ building: 'A楼' }, true);

    expect(result.map((item) => item.recordId)).toEqual(['rec-a']);
    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it('resolves exactly one active applicant matching record, open id, and building', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      activeApplicantRecord('rec-a', 'ou-a', '权威姓名', 'A楼'),
      activeApplicantRecord('rec-b', 'ou-b', '其他楼人员', 'B楼'),
    ]);
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);

    await expect(
      service.resolveApplicantForBuilding(
        { recordId: 'rec-a', openId: 'ou-a', building: 'A楼' },
        true,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        recordId: 'rec-a',
        openId: 'ou-a',
        name: '权威姓名',
        building: 'A楼',
      }),
    );
    await expect(
      service.resolveApplicantForBuilding(
        { recordId: 'rec-b', openId: 'ou-b', building: 'A楼' },
        true,
      ),
    ).resolves.toBeNull();
  });

  it('rejects ambiguous or departed applicant identities', async () => {
    const duplicate = activeApplicantRecord('rec-a', 'ou-a', '重复人员', 'A楼');
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      duplicate,
      { ...duplicate },
      {
        ...activeApplicantRecord(
          'rec-departed',
          'ou-departed',
          '离职人员',
          'A楼',
        ),
        fields: {
          ...activeApplicantRecord(
            'rec-departed',
            'ou-departed',
            '离职人员',
            'A楼',
          ).fields,
          '离职/异动情况': true,
        },
      },
    ]);
    const service = new PurchaseApplicationService({ axiosRef: {} } as never);

    await expect(
      service.resolveApplicantForBuilding(
        { recordId: 'rec-a', openId: 'ou-a', building: 'A楼' },
        true,
      ),
    ).resolves.toBeNull();
    await expect(
      service.resolveApplicantForBuilding(
        {
          recordId: 'rec-departed',
          openId: 'ou-departed',
          building: 'A楼',
        },
        true,
      ),
    ).resolves.toBeNull();
  });

  it('validates every row before uploading files or creating records', async () => {
    const httpService = { axiosRef: { post: jest.fn(), get: jest.fn() } };
    const service = testPurchaseApplicationService(httpService as never);
    const request = comparisonRequest();
    request.items[1].quantity = 0;

    await expect(
      service.submitApplications(
        request,
        comparisonImages(),
        '2026-07-10',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    expect(httpService.axiosRef.get).not.toHaveBeenCalled();
  });

  it('requires a comparison quotation attachment for offline procurement', async () => {
    const httpService = { axiosRef: { post: jest.fn(), get: jest.fn() } };
    const service = new PurchaseApplicationService(httpService as never);
    const request = validRequest();
    request.shared.purchaseChannel = '线下';
    request.shared.procurementForm = '三方比价';
    request.shared.onlineUrl = '';

    await expect(
      service.submitApplications(request, [], '2026-07-10'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: 'shared.comparisonAttachment',
          }),
        ]),
      }),
    });
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
  });

  it('submits offline single procurement without a comparison attachment', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260710-601');
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: 'rec-single' } },
            },
          });
        }),
      },
    };
    const service = testPurchaseApplicationService(
      httpService as never,
      undefined,
      { allocate } as never,
    );
    const request = validRequest();
    request.items = [request.items[0]];
    request.shared.purchaseChannel = '线下';
    request.shared.onlineUrl = '';
    request.shared.procurementForm = '单一采购';
    request.shared.comparisonSatisfied = '否';
    request.shared.singleReason = '原厂独家供应，无法进行三方比价';

    const result = await service.submitApplications(request, [], '2026-07-10');

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        created: [
          expect.objectContaining({
            lineId: 'line-1',
            recordId: 'rec-single',
          }),
        ],
      }),
    );
    const createCall = httpService.axiosRef.post.mock.calls.find(([url]) =>
      String(url).endsWith('/tables/tblKmajonrdwW7Z0/records'),
    );
    expect(createCall?.[1].fields).toEqual(
      expect.objectContaining({
        单一原因: '原厂独家供应，无法进行三方比价',
        '是否满足三家比价（线下）': '否',
      }),
    );
    expect(createCall?.[1].fields).not.toHaveProperty(
      '三方比价依据（邮件/报价单）',
    );
  });

  it.each([
    [
      '网络无响应',
      Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
        request: {},
      }),
    ],
    [
      'HTTP 503',
      Object.assign(new Error('service unavailable'), {
        response: { status: 503 },
      }),
    ],
  ])(
    'marks an accepted task uncertain when a record write has an %s outcome',
    async (_label, recordWriteError) => {
      const allocate = jest.fn().mockResolvedValue('CG260710-699');
      const httpService = {
        axiosRef: {
          post: jest.fn().mockImplementation((url: string) => {
            if (url.includes('/auth/v3/tenant_access_token/internal')) {
              return Promise.resolve({
                data: {
                  code: 0,
                  tenant_access_token: 'tenant-token',
                  expire: 7200,
                },
              });
            }
            if (url.endsWith('/records')) {
              return Promise.reject(recordWriteError);
            }
            throw new Error(`unexpected POST ${url}`);
          }),
        },
      };
      const service = testPurchaseApplicationService(
        httpService as never,
        undefined,
        { allocate } as never,
      );
      const request = validRequest();
      request.items = [request.items[0]];
      const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
        request,
        [],
      );
      const accepted = service.acceptApplications(
        request,
        [],
        '2026-07-10',
        'purchase-uncertain-write',
        fingerprint,
        request,
        TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
      );

      const status = await waitForSubmissionTerminal(service, accepted.taskId);

      expect(status).toEqual(
        expect.objectContaining({
          success: true,
          task: expect.objectContaining({
            status: 'uncertain',
            message: expect.stringContaining('结果暂不确定'),
          }),
        }),
      );
      expect(status.task).not.toHaveProperty('result');
      expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
        appToken: 'app-token',
        tableId: 'tblKmajonrdwW7Z0',
      });

      expect(
        service.acceptApplications(
          structuredClone(request),
          [],
          '2026-07-10',
          'purchase-uncertain-write',
          fingerprint,
          request,
          TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
        ).taskId,
      ).toBe(accepted.taskId);
      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records'),
        ),
      ).toHaveLength(1);
    },
  );

  it('marks a successful record response without record_id as uncertain', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260710-698');
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          return Promise.resolve({ data: { code: 0, data: {} } });
        }),
      },
    };
    const service = testPurchaseApplicationService(
      httpService as never,
      undefined,
      { allocate } as never,
    );
    const request = validRequest();
    request.items = [request.items[0]];
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    const accepted = service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-missing-record-id',
      fingerprint,
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );

    await expect(
      waitForSubmissionTerminal(service, accepted.taskId),
    ).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ status: 'uncertain' }),
      }),
    );
  });

  it('keeps a definite HTTP 400 record rejection as a line failure', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260710-697');
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          return Promise.reject(
            Object.assign(new Error('bad request'), {
              response: { status: 400 },
            }),
          );
        }),
      },
    };
    const service = testPurchaseApplicationService(
      httpService as never,
      undefined,
      { allocate } as never,
    );
    const request = validRequest();
    request.items = [request.items[0]];

    await expect(
      service.submitApplications(request, [], '2026-07-10'),
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        created: [],
        failed: [
          expect.objectContaining({ lineId: 'line-1', message: 'bad request' }),
        ],
      }),
    );
  });

  it('ignores invalid comparison files for single procurement', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260710-602');
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          if (url.includes('/drive/v1/medias/upload_all')) {
            throw new Error(
              'single procurement must not upload comparison files',
            );
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: 'rec-single-invalid-file' } },
            },
          });
        }),
      },
    };
    const ServiceWithCodeAllocator =
      PurchaseApplicationService as unknown as new (
        http: never,
        legacyWorkflowService: undefined,
        codeService: { allocate: jest.Mock },
      ) => PurchaseApplicationService;
    const service = new ServiceWithCodeAllocator(
      httpService as never,
      undefined,
      { allocate },
    );
    const request = validRequest();
    request.items = [request.items[0]];
    request.shared.purchaseChannel = '线下';
    request.shared.onlineUrl = '';
    request.shared.procurementForm = '单一采购';
    request.shared.comparisonSatisfied = '否';
    request.shared.singleReason = '指定专利产品，仅原厂可供应';

    const result = await service.submitApplications(
      request,
      [
        uploadFile(
          'irrelevant.txt',
          'text/plain',
          Buffer.from('not a comparison quotation'),
        ),
      ],
      '2026-07-10',
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        created: [
          expect.objectContaining({
            lineId: 'line-1',
            recordId: 'rec-single-invalid-file',
          }),
        ],
      }),
    );
    const uploadCalls = httpService.axiosRef.post.mock.calls.filter(([url]) =>
      String(url).includes('/drive/v1/medias/upload_all'),
    );
    expect(uploadCalls).toHaveLength(0);
    const createCall = httpService.axiosRef.post.mock.calls.find(([url]) =>
      String(url).endsWith('/tables/tblKmajonrdwW7Z0/records'),
    );
    expect(createCall?.[1].fields).not.toHaveProperty(
      '三方比价依据（邮件/报价单）',
    );
  });

  it('does not read ignored comparison files before background submission', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260710-603');
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          if (url.includes('/drive/v1/medias/upload_all')) {
            throw new Error(
              'single procurement must not upload comparison files',
            );
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: 'rec-single-background' } },
            },
          });
        }),
      },
    };
    const ServiceWithCodeAllocator =
      PurchaseApplicationService as unknown as new (
        http: never,
        legacyWorkflowService: undefined,
        codeService: { allocate: jest.Mock },
        ledger: PurchaseApplicationTaskLedgerStore,
      ) => PurchaseApplicationService;
    const service = new ServiceWithCodeAllocator(
      httpService as never,
      undefined,
      { allocate },
      testSubmissionLedger(),
    );
    const request = validRequest();
    request.items = [request.items[0]];
    request.shared.purchaseChannel = '线下';
    request.shared.onlineUrl = '';
    request.shared.procurementForm = '单一采购';
    request.shared.comparisonSatisfied = '否';
    request.shared.singleReason = '设备锁定原厂配套件';
    const readBuffer = jest.fn(() => Buffer.from('ignored'));
    const ignoredFile = {
      originalname: 'ignored.txt',
      mimetype: 'text/plain',
      size: 7,
      get buffer() {
        return readBuffer();
      },
    };

    const accepted = service.acceptApplications(
      request,
      [ignoredFile],
      '2026-07-10',
      'purchase-ignore-file-001',
      buildPurchaseApplicationSubmissionFingerprint(request, []),
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    const terminalStatus = await waitForSubmissionTerminal(
      service,
      accepted.taskId,
    );

    expect(terminalStatus).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(readBuffer).not.toHaveBeenCalled();
    expect(
      httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).includes('/drive/v1/medias/upload_all'),
      ),
    ).toHaveLength(0);
  });

  it('reports a failed background task when comparison attachment upload fails', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260710-604');
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          if (url.includes('/drive/v1/medias/upload_all')) {
            return Promise.reject(new Error('三方比价附件上传失败：quote-1.png'));
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: 'unexpected-record' } },
            },
          });
        }),
      },
    };
    const service = testPurchaseApplicationService(
      httpService as never,
      undefined,
      { allocate } as never,
    );
    const request = validRequest();
    request.items = [request.items[0]];
    request.shared.purchaseChannel = '线下';
    request.shared.onlineUrl = '';
    request.shared.procurementForm = '三方比价';
    request.shared.comparisonSatisfied = '是';
    request.shared.singleReason = '前端残留原因不得被改写';
    request.shared.notes = '附件失败后仍需保留的备注';
    const snapshot = structuredClone(request);

    const quoteFiles = comparisonImages();
    const accepted = service.acceptApplications(
      request,
      quoteFiles,
      '2026-07-10',
      'purchase-upload-fail-001',
      buildPurchaseApplicationSubmissionFingerprint(request, quoteFiles),
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    const terminalStatus = await waitForSubmissionTerminal(
      service,
      accepted.taskId,
    );

    expect(terminalStatus).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          status: 'failed',
          message: expect.stringContaining('同步飞书多维表失败'),
          completedAt: expect.any(String),
        }),
      }),
    );
    expect(request).toEqual(snapshot);
    expect(
      httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).includes('/drive/v1/medias/upload_all'),
      ),
    ).toHaveLength(1);
    expect(
      httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).endsWith('/tables/tblKmajonrdwW7Z0/records'),
      ),
    ).toHaveLength(0);
  });

  it('keeps a confirmed record successful when post-write cache invalidation fails', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260722-601');
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: 'rec-execution-only' } },
            },
          });
        }),
      },
    };
    const ServiceWithCodeAllocator =
      PurchaseApplicationService as unknown as new (
        http: never,
        legacyWorkflowService: undefined,
        codeService: { allocate: jest.Mock },
      ) => PurchaseApplicationService;
    const service = new ServiceWithCodeAllocator(
      httpService as never,
      undefined,
      { allocate },
    );
    const request = validRequest();
    request.items = [request.items[0]];
    request.shared.expectedDeliveryDate = '2026-07-25';
    (invalidateBitableRecordCache as jest.Mock).mockImplementationOnce(() => {
      throw new Error('simulated cache invalidation failure');
    });

    const result = await service.submitApplications(request, [], '2026-07-22');

    const recordCreateUrls = httpService.axiosRef.post.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.endsWith('/records'));
    expect(recordCreateUrls).toEqual([
      expect.stringContaining('/tables/tblKmajonrdwW7Z0/records'),
    ]);
    expect(result.created).toEqual([
      {
        lineId: 'line-1',
        recordId: 'rec-execution-only',
        requestCode: 'CG260722-601',
        executionRecordId: 'rec-execution-only',
      },
    ]);
    expect(invalidateBitableRecordCache).toHaveBeenCalledTimes(1);
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'app-token',
      tableId: 'tblKmajonrdwW7Z0',
    });
  });

  it('creates missing secondary online-link URL fields before writing records', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260723-601');
    let recordIndex = 0;
    const httpService = {
      axiosRef: {
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: {
              items: [{ field_name: '线上链接（仅线上需填写）' }],
              has_more: false,
            },
          },
        }),
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          if (url.endsWith('/fields')) {
            return Promise.resolve({ data: { code: 0, data: {} } });
          }
          recordIndex += 1;
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: `rec-link-${recordIndex}` } },
            },
          });
        }),
      },
    };
    const ServiceWithCodeAllocator =
      PurchaseApplicationService as unknown as new (
        http: never,
        legacyWorkflowService: undefined,
        codeService: { allocate: jest.Mock },
      ) => PurchaseApplicationService;
    const service = new ServiceWithCodeAllocator(
      httpService as never,
      undefined,
      { allocate },
    );
    const request = validRequest();
    request.shared.expectedDeliveryDate = '2026-07-25';
    request.items[0].onlineUrls = [
      'https://shop.example.com/1',
      'https://shop.example.com/2',
      'https://shop.example.com/3',
    ];
    request.items[1].onlineUrls = ['https://shop.example.com/4'];

    await expect(
      service.submitApplications(request, [], '2026-07-23'),
    ).resolves.toMatchObject({ success: true });

    const fieldBodies = httpService.axiosRef.post.mock.calls
      .filter(([url]) => String(url).endsWith('/fields'))
      .map(([, body]) => body);
    expect(fieldBodies).toEqual([
      { field_name: '线上链接2', type: 15 },
      { field_name: '线上链接3', type: 15 },
    ]);
  });

  it('accepts immediately with the program workflow disabled while Feishu data synchronization continues', async () => {
    const previousEnabled = process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED;
    const previousExecutionTable =
      process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID;
    const previousApprovers = process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS;
    const previousPurchaseAdmin =
      process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID;
    const previousVerificationToken =
      process.env.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN;
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = 'tblKmajonrdwW7Z0';
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = '';
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = '';
    process.env.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN = '';
    let releaseTenantToken!: () => void;
    const tenantTokenGate = new Promise<void>((resolve) => {
      releaseTenantToken = resolve;
    });
    let createIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            await tenantTokenGate;
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          createIndex += 1;
          return {
            data: {
              code: 0,
              data: { record: { record_id: `rec-fast-${createIndex}` } },
            },
          };
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: { record: { fields: { 采购编码: 'PR-FAST' } } },
          },
        }),
      },
    };
    const service = testPurchaseApplicationService(httpService as never);
    const backgroundApi = service as unknown as {
      acceptApplications: (
        request: PurchaseApplicationBatchRequest,
        files: ReturnType<typeof uploadFile>[],
        today: string,
        idempotencyKey: string,
        submissionFingerprint: string,
        fingerprintRequest: PurchaseApplicationBatchRequest,
        principalFingerprint: string,
      ) => {
        pending: true;
        taskId: string;
        message: string;
      };
      getSubmissionTaskStatus: (
        taskId: string,
        building?: string,
        principalFingerprint?: string,
      ) => {
        success: boolean;
        task?: {
          status: 'pending' | 'running' | 'completed' | 'failed';
          result?: { created: Array<{ recordId: string }> };
        };
      };
    };

    expect(typeof backgroundApi.acceptApplications).toBe('function');
    expect(typeof backgroundApi.getSubmissionTaskStatus).toBe('function');

    const backgroundRequest = validRequest();
    const accepted = backgroundApi.acceptApplications(
      backgroundRequest,
      [],
      '2026-07-10',
      'purchase-background-001',
      buildPurchaseApplicationSubmissionFingerprint(backgroundRequest, []),
      backgroundRequest,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );

    expect(accepted).toEqual(
      expect.objectContaining({
        pending: true,
        taskId: expect.stringMatching(/^purchase-application-/),
        message: expect.stringContaining('后台同步'),
      }),
    );
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
    const crossBuildingStatus = backgroundApi.getSubmissionTaskStatus(
      accepted.taskId,
      'A楼',
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    expect(crossBuildingStatus).toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(crossBuildingStatus.task).toBeUndefined();
    expect(
      backgroundApi.getSubmissionTaskStatus(
        accepted.taskId,
        'H楼',
        TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
      ),
    ).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'pending' }),
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(
      backgroundApi.getSubmissionTaskStatus(
        accepted.taskId,
        undefined,
        TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
      ),
    ).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({ status: 'running' }),
      }),
    );

    releaseTenantToken();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      backgroundApi.getSubmissionTaskStatus(
        accepted.taskId,
        undefined,
        TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
      ),
    ).toEqual(
      expect.objectContaining({
        success: true,
        task: expect.objectContaining({
          status: 'completed',
          result: expect.objectContaining({
            created: [
              expect.objectContaining({
                recordId: 'rec-fast-1',
                executionRecordId: 'rec-fast-1',
              }),
              expect.objectContaining({
                recordId: 'rec-fast-2',
                executionRecordId: 'rec-fast-2',
              }),
            ],
          }),
        }),
      }),
    );
    restoreEnv('PURCHASE_WORKFLOW_PROGRAM_ENABLED', previousEnabled);
    restoreEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID', previousExecutionTable);
    restoreEnv('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS', previousApprovers);
    restoreEnv(
      'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
      previousPurchaseAdmin,
    );
    restoreEnv(
      'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
      previousVerificationToken,
    );
  });

  it('reuses the original task for the same building, idempotency key, and payload without requiring retry attachments', async () => {
    const service = testPurchaseApplicationService({ axiosRef: {} } as never);
    jest.spyOn(service, 'submitApplications').mockResolvedValue({
      success: true,
      created: [],
      failed: [],
      warnings: [],
      message: '已完成',
    });
    const request = comparisonRequest();
    request.shared.purchaseChannel = '线下';
    request.shared.onlineUrl = '';
    request.items = request.items.map((item) => ({
      ...item,
      onlineUrls: [],
    }));
    const attachments = comparisonImages();
    const submissionFingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      attachments,
    );

    const first = service.acceptApplications(
      request,
      attachments,
      '2026-07-10',
      'purchase-mutation-001',
      submissionFingerprint,
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    const duplicate = service.acceptApplications(
      structuredClone(request),
      [],
      '2026-07-10',
      'purchase-mutation-001',
      submissionFingerprint,
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );

    expect(duplicate.taskId).toBe(first.taskId);
    await waitForSubmissionTerminal(service, first.taskId);
    expect(service.submitApplications).toHaveBeenCalledTimes(1);
  });

  it('uses a stable payload fingerprint independent of object key order', async () => {
    const service = testPurchaseApplicationService({ axiosRef: {} } as never);
    jest.spyOn(service, 'submitApplications').mockResolvedValue({
      success: true,
      created: [],
      failed: [],
      warnings: [],
      message: '已完成',
    });
    const request = validRequest();
    const reorderedRequest = {
      items: request.items.map(
        (item) =>
          Object.fromEntries(
            Object.entries(item).reverse(),
          ) as unknown as PurchaseApplicationBatchRequest['items'][number],
      ),
      shared: Object.fromEntries(
        Object.entries(request.shared).reverse(),
      ) as unknown as PurchaseApplicationBatchRequest['shared'],
    } satisfies PurchaseApplicationBatchRequest;
    const submissionFingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    expect(
      buildPurchaseApplicationSubmissionFingerprint(reorderedRequest, []),
    ).toBe(submissionFingerprint);

    const first = service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-mutation-002',
      submissionFingerprint,
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    const duplicate = service.acceptApplications(
      reorderedRequest,
      [],
      '2026-07-10',
      'purchase-mutation-002',
      submissionFingerprint,
      reorderedRequest,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );

    expect(duplicate.taskId).toBe(first.taskId);
    await waitForSubmissionTerminal(service, first.taskId);
  });

  it('rejects a changed payload that reuses an existing building idempotency key', () => {
    const service = testPurchaseApplicationService({ axiosRef: {} } as never);
    jest.spyOn(service, 'submitApplications').mockResolvedValue({
      success: true,
      created: [],
      failed: [],
      warnings: [],
      message: '已完成',
    });
    const request = validRequest();
    const submissionFingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-mutation-003',
      submissionFingerprint,
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    const changedRequest = structuredClone(request);
    changedRequest.items[0].quantity += 1;

    expect(() =>
      service.acceptApplications(
        changedRequest,
        [],
        '2026-07-10',
        'purchase-mutation-003',
        buildPurchaseApplicationSubmissionFingerprint(changedRequest, []),
        changedRequest,
        TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
      ),
    ).toThrow(ConflictException);
  });

  it('scopes identical idempotency keys to the authoritative building', () => {
    const service = testPurchaseApplicationService({ axiosRef: {} } as never);
    jest.spyOn(service, 'submitApplications').mockResolvedValue({
      success: true,
      created: [],
      failed: [],
      warnings: [],
      message: '已完成',
    });
    const hBuildingRequest = validRequest();
    const aBuildingRequest = structuredClone(hBuildingRequest);
    aBuildingRequest.shared.building = 'A楼';
    aBuildingRequest.shared.applicantBuilding = 'A楼';

    const hBuilding = service.acceptApplications(
      hBuildingRequest,
      [],
      '2026-07-10',
      'purchase-mutation-004',
      buildPurchaseApplicationSubmissionFingerprint(hBuildingRequest, []),
      hBuildingRequest,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    const aBuilding = service.acceptApplications(
      aBuildingRequest,
      [],
      '2026-07-10',
      'purchase-mutation-004',
      buildPurchaseApplicationSubmissionFingerprint(aBuildingRequest, []),
      aBuildingRequest,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );

    expect(aBuilding.taskId).not.toBe(hBuilding.taskId);
  });

  it('removes idempotency index entries when completed tasks are pruned', async () => {
    const service = testPurchaseApplicationService({ axiosRef: {} } as never);
    jest.spyOn(service, 'submitApplications').mockResolvedValue({
      success: true,
      created: [],
      failed: [],
      warnings: [],
      message: '已完成',
    });
    const taskIds: string[] = [];
    const request = validRequest();
    const submissionFingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );
    for (let index = 0; index <= 100; index += 1) {
      taskIds.push(
        service.acceptApplications(
          request,
          [],
          '2026-07-10',
          `purchase-mutation-${String(index).padStart(3, '0')}`,
          submissionFingerprint,
          request,
          TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
        ).taskId,
      );
    }
    await waitForSubmissionTerminal(service, taskIds.at(-1)!, 200);
    const internals = service as unknown as {
      submissionTaskIdsByIdempotencyKey?: Map<string, string>;
    };

    expect(internals.submissionTaskIdsByIdempotencyKey).toBeInstanceOf(Map);
    expect(internals.submissionTaskIdsByIdempotencyKey?.size).toBe(100);
    expect([
      ...internals.submissionTaskIdsByIdempotencyKey!.values(),
    ]).not.toContain(taskIds[0]);
  }, 60_000);

  it('uses one tenant token for attachments and every application record', async () => {
    const events: string[] = [];
    let createIndex = 0;
    let uploadIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          if (url.includes('/drive/v1/medias/upload_all')) {
            events.push('upload');
            uploadIndex += 1;
            return Promise.resolve({
              data: { code: 0, data: { file_token: `file-token-${uploadIndex}` } },
            });
          }
          events.push(`create-${createIndex + 1}`);
          createIndex += 1;
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: `rec-${createIndex}` } },
            },
          });
        }),
        get: jest.fn().mockImplementation((url: string) => {
          const recordId = url.split('/').pop();
          return Promise.resolve({
            data: {
              code: 0,
              data: {
                record: {
                  fields: {
                    采购编码: recordId === 'rec-1' ? 'PR-001' : 'PR-002',
                  },
                },
              },
            },
          });
        }),
      },
    };
    const service = new PurchaseApplicationService(httpService as never);
    const request = comparisonRequest();

    const result = await service.submitApplications(
      request,
      comparisonImages(),
      '2026-07-10',
    );

    expect(events).toEqual(['upload', 'upload', 'upload', 'create-1', 'create-2']);
    expect(
      httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).includes('/drive/v1/medias/upload_all'),
      ),
    ).toHaveLength(3);
    const allRecordCreateCalls = httpService.axiosRef.post.mock.calls.filter(
      ([url]) =>
        String(url).includes('/bitable/v1/apps/app-token/tables/') &&
        String(url).endsWith('/records'),
    );
    expect(allRecordCreateCalls).toHaveLength(2);
    for (const [, , config] of allRecordCreateCalls) {
      expect(config.headers.Authorization).toBe('Bearer tenant-token');
    }
    const createCalls = httpService.axiosRef.post.mock.calls.filter(([url]) =>
      String(url).includes(
        '/bitable/v1/apps/app-token/tables/tblKmajonrdwW7Z0/records',
      ),
    );
    expect(createCalls).toHaveLength(2);
    for (const [, body, config] of createCalls) {
      expect(config.headers.Authorization).toBe('Bearer tenant-token');
      expect(body.fields).toEqual(
        expect.objectContaining({
          '三方比价依据（邮件/报价单）': [
            { file_token: 'file-token-1' },
            { file_token: 'file-token-2' },
            { file_token: 'file-token-3' },
          ],
          需求人: [{ id: 'ou_ma' }],
          采购流程: '未开始（待审批）',
        }),
      );
      expect(body.fields).toHaveProperty('采购编码', 'CG260710-601');
      expect(body.fields).not.toHaveProperty('总价');
      expect(body.fields).not.toHaveProperty('创建日期');
    }
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        created: [
          {
            lineId: 'line-1',
            recordId: 'rec-1',
            requestCode: 'CG260710-601',
            executionRecordId: 'rec-1',
          },
          {
            lineId: 'line-2',
            recordId: 'rec-2',
            requestCode: 'CG260710-601',
            executionRecordId: 'rec-2',
          },
        ],
        failed: [],
      }),
    );
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'app-token',
      tableId: 'tblKmajonrdwW7Z0',
    });
    const uploadCall = httpService.axiosRef.post.mock.calls.find(([url]) =>
      String(url).includes('/drive/v1/medias/upload_all'),
    );
    expect(uploadCall?.[2].headers.Authorization).toBe('Bearer tenant-token');
  });

  it('continues after a row failure and reports the original line IDs', async () => {
    let createIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          createIndex += 1;
          if (createIndex === 2) {
            return Promise.resolve({
              data: { code: 1254002, msg: '字段无效' },
            });
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: `rec-success-${createIndex}` } },
            },
          });
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: { record: { fields: { 采购编码: 'PR-SUCCESS' } } },
          },
        }),
      },
    };
    const service = new PurchaseApplicationService(httpService as never);

    const result = await service.submitApplications(
      validRequest(),
      [],
      '2026-07-10',
    );

    expect(result.success).toBe(false);
    expect(result.created).toEqual([
      {
        lineId: 'line-1',
        recordId: 'rec-success-1',
        requestCode: 'CG260710-601',
        executionRecordId: 'rec-success-1',
      },
    ]);
    expect(result.failed).toEqual([
      { lineId: 'line-2', message: expect.stringContaining('字段无效') },
    ]);
    expect(invalidateBitableRecordCache).toHaveBeenCalled();
  });

  it('suppresses the duplicate submission trigger and synchronizes one real-applicant execution record while program workflow is disabled', async () => {
    const previousEnabled = process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED;
    const previousExecutionTable =
      process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID;
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = 'tblKmajonrdwW7Z0';
    let submissionIndex = 0;
    let executionIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string, body: unknown) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          if (url.includes('/tables/tblIfmOB4VTUMmMh/')) {
            expect(body).toEqual({
              fields: expect.objectContaining({
                '提交成功（无需点击🚫）': false,
              }),
            });
            submissionIndex += 1;
            return Promise.resolve({
              data: {
                code: 0,
                data: { record: { record_id: `rec-sub-${submissionIndex}` } },
              },
            });
          }
          if (url.includes('/tables/tblKmajonrdwW7Z0/')) {
            executionIndex += 1;
            expect(body).toEqual({
              fields: expect.objectContaining({
                采购流程: '未开始（待审批）',
                需求人: [{ id: 'ou_ma' }],
                采购编码: 'CG260710-601',
                物品名称: expect.any(String),
              }),
            });
            expect(body.fields).not.toHaveProperty('2️⃣审批已完成（无需点击）');
            expect(body.fields).not.toHaveProperty('2️⃣审批通过（无需点击）');
            expect(body.fields).not.toHaveProperty('2️⃣审批驳回（无需点击）');
            return Promise.resolve({
              data: {
                code: 0,
                data: { record: { record_id: `rec-exe-${executionIndex}` } },
              },
            });
          }
          throw new Error(`unexpected url: ${url}`);
        }),
        get: jest.fn().mockImplementation((url: string) => {
          const recordId = url.split('/').pop();
          return Promise.resolve({
            data: {
              code: 0,
              data: {
                record: {
                  fields: {
                    采购编码: `南通运维小帮手-测试物品-${recordId}`,
                  },
                },
              },
            },
          });
        }),
      },
    };
    const service = new PurchaseApplicationService(httpService as never);

    try {
      const result = await service.submitApplications(
        validRequest(),
        [],
        '2026-07-10',
      );

      expect(executionIndex).toBe(2);
      expect(submissionIndex).toBe(0);
      expect(result.created.map((item) => item.executionRecordId)).toEqual([
        'rec-exe-1',
        'rec-exe-2',
      ]);
      expect(result.created.map((item) => item.requestCode)).toEqual([
        'CG260710-601',
        'CG260710-601',
      ]);
    } finally {
      restoreEnv('PURCHASE_WORKFLOW_PROGRAM_ENABLED', previousEnabled);
      restoreEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID', previousExecutionTable);
    }
  });

  it('enqueues manager approval once for every created execution record', async () => {
    let createIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          createIndex += 1;
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: `rec-created-${createIndex}` } },
            },
          });
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: { record: { fields: { 采购编码: 'PR-CREATED' } } },
          },
        }),
      },
    };
    const managerApprovalService = {
      enqueueApprovalRequest: jest.fn().mockResolvedValue(undefined),
    };
    const purchaseCodeService = {
      allocate: jest.fn().mockResolvedValue('CG260710-777'),
    };
    const service = new PurchaseApplicationService(
      httpService as never,
      managerApprovalService as never,
      purchaseCodeService as never,
    );

    const result = await service.submitApplications(
      validRequest(),
      [],
      '2026-07-10',
    );

    expect(result.success).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.created.map((item) => item.executionRecordId)).toEqual([
      'rec-created-1',
      'rec-created-2',
    ]);
    expect(result.created.map((item) => item.requestCode)).toEqual([
      'CG260710-777',
      'CG260710-777',
    ]);
    expect(purchaseCodeService.allocate).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual([]);
    expect(managerApprovalService.enqueueApprovalRequest.mock.calls).toEqual([
      ['rec-created-1'],
      ['rec-created-2'],
    ]);
    expect(result.message).toBe('已成功提交 2 项采购申请');
  });

  it('registers one manager approval batch after the accepted task is durable', async () => {
    let createIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          createIndex += 1;
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: `rec-batch-${createIndex}` } },
            },
          });
        }),
      },
    };
    const managerApprovalService = {
      enqueueApprovalRequest: jest.fn().mockResolvedValue(undefined),
      enqueueApprovalBatch: jest.fn().mockResolvedValue(undefined),
    };
    const service = testPurchaseApplicationService(
      httpService as never,
      managerApprovalService as never,
      { allocate: jest.fn().mockResolvedValue('CG260710-778') } as never,
    );
    const request = validRequest();
    const fingerprint = buildPurchaseApplicationSubmissionFingerprint(
      request,
      [],
    );

    const accepted = service.acceptApplications(
      request,
      [],
      '2026-07-10',
      'purchase-batch-approval-01',
      fingerprint,
      request,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    await waitForSubmissionTerminal(service, accepted.taskId);

    expect(managerApprovalService.enqueueApprovalRequest).not.toHaveBeenCalled();
    expect(managerApprovalService.enqueueApprovalBatch).toHaveBeenCalledTimes(1);
    expect(managerApprovalService.enqueueApprovalBatch).toHaveBeenCalledWith({
      approvalBatchId: accepted.taskId,
      requesterOpenId: request.shared.applicantOpenId,
      recordIds: ['rec-batch-1', 'rec-batch-2'],
    });
    const createdRecordBodies = httpService.axiosRef.post.mock.calls
      .filter(([url]) => String(url).includes('/records'))
      .map(([, body]) => body as { fields?: Record<string, unknown> });
    expect(createdRecordBodies).toHaveLength(2);
    expect(
      createdRecordBodies.every(
        (body) => body.fields?.['采购审批批次号'] === accepted.taskId,
      ),
    ).toBe(true);
  });

  it('keeps a created row successful and adds one sanitized warning when manager enqueue fails', async () => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: 'rec-manager-warning' } },
            },
          });
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: { record: { fields: { 采购编码: 'PR-CREATED' } } },
          },
        }),
      },
    };
    const managerApprovalService = {
      enqueueApprovalRequest: jest
        .fn()
        .mockRejectedValue(
          new Error('token=private-token; open_id=ou_private_manager'),
        ),
    };
    const request = validRequest();
    request.items = [request.items[0]];
    const service = new PurchaseApplicationService(
      httpService as never,
      managerApprovalService as never,
    );

    const result = await service.submitApplications(request, [], '2026-07-10');

    expect(result.success).toBe(true);
    expect(result.created).toEqual([
      expect.objectContaining({
        lineId: 'line-1',
        recordId: 'rec-manager-warning',
        executionRecordId: 'rec-manager-warning',
      }),
    ]);
    expect(result.failed).toEqual([]);
    expect(result.warnings).toEqual([
      {
        lineId: 'line-1',
        executionRecordId: 'rec-manager-warning',
        message: '经理审批消息登记失败，请人工核对',
      },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain('private-token');
    expect(JSON.stringify(result.warnings)).not.toContain('ou_private_manager');
    expect(managerApprovalService.enqueueApprovalRequest).toHaveBeenCalledWith(
      'rec-manager-warning',
    );
  });

  it('keeps duplicate manager queue no-ops warning-free', async () => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: 'rec-idempotent' } },
            },
          });
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: { record: { fields: { 采购编码: 'PR-IDEMPOTENT' } } },
          },
        }),
      },
    };
    const managerApprovalService = {
      enqueueApprovalRequest: jest.fn().mockResolvedValue(undefined),
    };
    const request = validRequest();
    request.items = [request.items[0]];
    const service = new PurchaseApplicationService(
      httpService as never,
      managerApprovalService as never,
    );

    const first = await service.submitApplications(request, [], '2026-07-10');
    const duplicate = await service.submitApplications(
      request,
      [],
      '2026-07-10',
    );

    expect(first.failed).toEqual([]);
    expect(first.warnings).toEqual([]);
    expect(duplicate.failed).toEqual([]);
    expect(duplicate.warnings).toEqual([]);
    expect(managerApprovalService.enqueueApprovalRequest.mock.calls).toEqual([
      ['rec-idempotent'],
      ['rec-idempotent'],
    ]);
  });

  it('retains mixed created and failed rows without enqueueing failed Base rows', async () => {
    const previousEnabled = process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED;
    const previousExecutionTable =
      process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID;
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.FEISHU_PURCHASE_EXECUTION_TABLE_ID = 'tblKmajonrdwW7Z0';
    let executionIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          if (url.includes('/tables/tblIfmOB4VTUMmMh/')) {
            throw new Error('采购提交表不应接收新增记录');
          }
          if (url.includes('/tables/tblKmajonrdwW7Z0/')) {
            executionIndex += 1;
            if (executionIndex === 2) {
              return Promise.resolve({
                data: { code: 1254002, msg: '第二行字段无效' },
              });
            }
            return Promise.resolve({
              data: {
                code: 0,
                data: { record: { record_id: 'rec-exe-success' } },
              },
            });
          }
          throw new Error(`unexpected url: ${url}`);
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: { record: { fields: { 采购编码: 'PR-PARTIAL' } } },
          },
        }),
      },
    };
    const managerApprovalService = {
      enqueueApprovalRequest: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseApplicationService(
      httpService as never,
      managerApprovalService as never,
    );

    try {
      const result = await service.submitApplications(
        validRequest(),
        [],
        '2026-07-10',
      );

      expect(result.success).toBe(false);
      expect(result.failed).toEqual([
        {
          lineId: 'line-2',
          message: expect.stringContaining('第二行字段无效'),
        },
      ]);
      expect(result.warnings).toEqual([]);
      expect(managerApprovalService.enqueueApprovalRequest.mock.calls).toEqual([
        ['rec-exe-success'],
      ]);
      expect(result.message).toContain('1 项失败');
      expect(result.message).not.toContain('审批通知');
    } finally {
      restoreEnv('PURCHASE_WORKFLOW_PROGRAM_ENABLED', previousEnabled);
      restoreEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID', previousExecutionTable);
    }
  });
  it('keeps the third purchase code slot source-compatible when manager approval is absent', async () => {
    const allocate = jest.fn().mockResolvedValue('CG260721-601');
    let createIndex = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation((url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          createIndex += 1;
          return Promise.resolve({
            data: {
              code: 0,
              data: { record: { record_id: `rec-code-${createIndex}` } },
            },
          });
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: { record: { fields: { 采购编码: '旧编码' } } },
          },
        }),
      },
    };
    const service = new PurchaseApplicationService(
      httpService as never,
      undefined,
      {
        allocate,
      } as never,
    );

    const request = validRequest();
    request.shared.expectedDeliveryDate = '2026-07-25';
    const result = await service.submitApplications(request, [], '2026-07-21');

    expect(allocate).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-07-21', building: 'H楼' }),
    );
    expect(result.created.map((item) => item.requestCode)).toEqual([
      'CG260721-601',
      'CG260721-601',
    ]);
    expect(result.warnings).toEqual([]);

    const submissionBodies = httpService.axiosRef.post.mock.calls
      .filter(([url]) => String(url).includes('/tables/tblIfmOB4VTUMmMh/'))
      .map(([, body]) => body);
    const executionBodies = httpService.axiosRef.post.mock.calls
      .filter(([url]) => String(url).includes('/tables/tblKmajonrdwW7Z0/'))
      .map(([, body]) => body);
    expect(submissionBodies).toHaveLength(0);
    expect(executionBodies).toHaveLength(2);
    for (const body of executionBodies) {
      expect(body).toEqual(
        expect.objectContaining({
          fields: expect.objectContaining({ 采购编码: 'CG260721-601' }),
        }),
      );
    }
  });
});

function validRequest(): PurchaseApplicationBatchRequest {
  return {
    shared: {
      applicantRecordId: 'rec-ma',
      applicantOpenId: 'ou_ma',
      applicantName: '马金玉',
      applicantEmployeeNo: 'NT-001',
      applicantPosition: '综合管理',
      applicantBuilding: 'H楼',
      building: 'H楼',
      specialty: '其他',
      purchaseMethod: '综合采购',
      purchaseChannel: '线上',
      supplier: '南通供应商',
      onlineUrl: 'https://purchase.example.com/item',
      procurementForm: '单一采购',
      comparisonSatisfied: '否',
      singleReason: '合成用例的既定单一供应商',
      requirementSummary: '办公物资补充',
      expectedDeliveryDate: '2026-07-20',
      immediateOutbound: false,
      notes: '批量申请',
    },
    items: [
      {
        lineId: 'line-1',
        mode: 'existing',
        catalogRecordId: 'catalog-1',
        sku: 'D2-001',
        primaryCategory: 'D消耗类',
        secondaryCategory: '办公耗材D2',
        itemName: 'A4纸',
        specification: '80g 500张',
        brand: '得力',
        quantity: 2,
        unit: '包',
        unitPrice: 25.5,
        shippingFee: 5,
        discount: 1,
      },
      {
        lineId: 'line-2',
        mode: 'new',
        catalogRecordId: '',
        sku: '',
        primaryCategory: 'D消耗类',
        secondaryCategory: '办公耗材D2',
        itemName: '标签打印纸',
        specification: '50mm',
        brand: '',
        quantity: 1,
        unit: '卷',
        unitPrice: 120,
        shippingFee: 0,
        discount: 0,
      },
    ],
  };
}

function uploadFile(originalname: string, mimetype: string, buffer: Buffer) {
  return { originalname, mimetype, size: buffer.byteLength, buffer };
}

function comparisonRequest(): PurchaseApplicationBatchRequest {
  const request = validRequest();
  request.shared.procurementForm = '三方比价';
  request.shared.comparisonSatisfied = '是';
  request.shared.singleReason = '';
  return request;
}

function comparisonImages() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q3cAAAAASUVORK5CYII=',
    'base64',
  );
  return [1, 2, 3].map(index => uploadFile(`quote-${index}.png`, 'image/png', Buffer.from(png)));
}

function testSubmissionLedger(): PurchaseApplicationTaskLedgerStore {
  const directory = mkdtempSync(
    join(tmpdir(), 'purchase-application-existing-spec-ledger-'),
  );
  temporaryLedgerDirectories.push(directory);
  return new PurchaseApplicationTaskLedgerStore(
    join(directory, 'purchase-application-ledger.json'),
  );
}

function testPurchaseApplicationService(
  httpService: ConstructorParameters<typeof PurchaseApplicationService>[0],
  purchaseManagerApprovalService?: ConstructorParameters<
    typeof PurchaseApplicationService
  >[1],
  purchaseCodeService?: ConstructorParameters<
    typeof PurchaseApplicationService
  >[2],
): PurchaseApplicationService {
  return new PurchaseApplicationService(
    httpService,
    purchaseManagerApprovalService,
    purchaseCodeService,
    testSubmissionLedger(),
  );
}

async function waitForSubmissionTerminal(
  service: PurchaseApplicationService,
  taskId: string,
  maxAttempts = 50,
): Promise<ReturnType<PurchaseApplicationService['getSubmissionTaskStatus']>> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = service.getSubmissionTaskStatus(
      taskId,
      undefined,
      TEST_PURCHASE_PRINCIPAL_FINGERPRINT,
    );
    if (
      status.task?.status === 'completed' ||
      status.task?.status === 'failed' ||
      status.task?.status === 'uncertain'
    ) {
      return status;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`采购申请后台任务未在 ${maxAttempts} 次轮询内结束`);
}

function activeApplicantRecord(
  recordId: string,
  openId: string,
  name: string,
  building: string,
) {
  return {
    record_id: recordId,
    fields: {
      姓名: name,
      员工姓名: [{ id: openId, name }],
      员工工号: `NO-${recordId}`,
      岗位: '运维工程师',
      '机楼/专业': [building, '电气'],
      '离职/异动情况': false,
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
