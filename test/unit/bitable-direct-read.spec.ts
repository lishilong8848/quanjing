import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const previousLocalCacheDir = process.env.FEISHU_LOCAL_CACHE_DIR;
const localCacheDir = resolve(
  tmpdir(),
  `nantong-bitable-direct-read-${process.pid}-${Date.now()}`,
);
process.env.FEISHU_LOCAL_CACHE_DIR = localCacheDir;

jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'app',
      app_secret: 'secret',
    })),
  }),
  { virtual: true },
);

const bitableDirectRead =
  require('../../server/common/feishu/bitable-direct-read') as typeof import('../../server/common/feishu/bitable-direct-read');
const {
  extractDateTimeIso,
  extractDateValue,
  fetchBitableRecords,
  invalidateFeishuTenantAccessTokenCache,
  invalidateBitableRecordCache,
  readLatestPersistedBitableRecordSnapshot,
  readLatestPersistedBitableRecords,
  resolveBitableAppToken,
  resolveBitableTableIdByName,
  warmLatestPersistedBitableRecordSnapshotIndex,
} = bitableDirectRead;

afterAll(async () => {
  await rm(localCacheDir, { force: true, recursive: true });
  if (previousLocalCacheDir === undefined) {
    delete process.env.FEISHU_LOCAL_CACHE_DIR;
  } else {
    process.env.FEISHU_LOCAL_CACHE_DIR = previousLocalCacheDir;
  }
});

function getProjectedCachePath(cacheKey: string): string {
  return join(
    localCacheDir,
    `${createHash('sha1').update(cacheKey).digest('hex')}.json`,
  );
}

async function expectPathToDisappear(cachePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(cachePath);
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'ENOENT') return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error(`Expected cache path to disappear: ${cachePath}`);
}

function createRecordSearchHttpService(
  getItems: () => Array<{
    record_id: string;
    fields: Record<string, unknown>;
  }> = () => [],
) {
  return {
    axiosRef: {
      post: jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/auth/v3/tenant_access_token/')) {
          return {
            data: {
              code: 0,
              tenant_access_token: 'tenant-token',
              expire: 7200,
            },
          };
        }
        if (url.endsWith('/records/search')) {
          return {
            data: {
              code: 0,
              data: { items: getItems(), has_more: false },
            },
          };
        }
        throw new Error(`Unexpected POST request: ${url}`);
      }),
      get: jest.fn(),
    },
  };
}

describe('exact persistent snapshot lookup', () => {
  it('reads only the normalized projected file without scanning unrelated snapshots', async () => {
    const options = {
      appToken: 'direct-projected-base',
      tableId: 'direct-projected-table',
      tableName: 'direct projected',
      fieldNames: ['姓名', '班组'],
    };
    const http = createRecordSearchHttpService(() => [
      { record_id: 'direct-record', fields: {} },
    ]);
    const fsPromises =
      require('node:fs/promises') as typeof import('node:fs/promises');
    const spy = jest.spyOn(fsPromises, 'readdir');
    try {
      await fetchBitableRecords(http as never, {
        ...options,
        forceRefresh: true,
      });
      invalidateBitableRecordCache();
      spy.mockClear();
      const query = {
        ...options,
        fieldNames: [' 班组 ', '姓名', '姓名'],
        directOnly: true,
      };
      const snapshot = await readLatestPersistedBitableRecordSnapshot(query);
      expect(snapshot).toMatchObject({
        records: [{ record_id: 'direct-record' }],
      });
      expect(snapshot?.contentFingerprint).toBe(
        createHash('sha256')
          .update(
            readFileSync(
              getProjectedCachePath(
                `${options.appToken}:${options.tableId}::${['姓名', '班组'].sort().join('\u001f')}`,
              ),
            ),
          )
          .digest('hex'),
      );
      expect(spy).not.toHaveBeenCalled();
      expect(
        await readLatestPersistedBitableRecordSnapshot({
          ...query,
          fieldNames: ['新增字段'],
        }),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      invalidateBitableRecordCache({ ...options, deletePersisted: true });
    }
  });

  it('honors source invalidation and refuses foreign metadata in an exact cache file', async () => {
    const options = {
      appToken: 'direct-invalidation-base',
      tableId: 'direct-invalidation-table',
      tableName: 'direct invalidation',
    };
    const cachePath = getProjectedCachePath(
      `${options.appToken}:${options.tableId}:`,
    );
    const query = { ...options, directOnly: true };
    try {
      await fetchBitableRecords(createRecordSearchHttpService() as never, {
        ...options,
        forceRefresh: true,
      });
      const payload = JSON.parse(readFileSync(cachePath, 'utf8'));
      await writeFile(
        cachePath,
        JSON.stringify({ ...payload, appToken: 'foreign' }),
      );
      expect(await readLatestPersistedBitableRecordSnapshot(query)).toBeNull();
      await writeFile(cachePath, JSON.stringify(payload));
      expect(
        await readLatestPersistedBitableRecordSnapshot(query),
      ).not.toBeNull();
      invalidateBitableRecordCache({ ...options, deletePersisted: true });
      expect(await readLatestPersistedBitableRecordSnapshot(query)).toBeNull();
    } finally {
      invalidateBitableRecordCache({ ...options, deletePersisted: true });
      await rm(cachePath, { force: true });
    }
  });
});

describe('fetchBitableRecords local cache', () => {
  const appToken = 'app-cache-refresh-test';
  const tableId = 'tbl-cache-refresh-test';
  const cacheKey = `${appToken}:${tableId}:`;
  const cachePath = getProjectedCachePath(cacheKey);

  afterEach(async () => {
    invalidateFeishuTenantAccessTokenCache();
    invalidateBitableRecordCache({ appToken, tableId });
    await rm(cachePath, { force: true });
  });

  it('uses a call-specific app identity to resolve a Wiki Bitable token', async () => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          status: 200,
          data: {
            code: 0,
            tenant_access_token: 'risk-tenant-token',
            expire: 7200,
          },
        }),
        get: jest.fn().mockResolvedValue({
          status: 200,
          data: {
            code: 0,
            data: {
              node: {
                obj_type: 'bitable',
                obj_token: 'risk-bitable-app-token',
              },
            },
          },
        }),
      },
    };

    await expect(
      resolveBitableAppToken(httpService as never, {
        wikiToken: 'wik_risk_call_specific_auth',
        tableName: 'risk-auth-test',
        auth: {
          appId: 'risk-app-id',
          appSecret: 'risk-app-secret',
        },
      }),
    ).resolves.toBe('risk-bitable-app-token');
    expect(httpService.axiosRef.post).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: 'risk-app-id',
        app_secret: 'risk-app-secret',
      },
      { timeout: 30000 },
    );
    expect(httpService.axiosRef.get).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
      expect.objectContaining({
        headers: { Authorization: 'Bearer risk-tenant-token' },
      }),
    );
  });

  it('resolves and caches one uniquely named Bitable table across pages', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 0,
          data: {
            items: [{ table_id: 'tbl_other', name: '其他表' }],
            has_more: true,
            page_token: 'page-2',
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 0,
          data: {
            items: [
              {
                table_id: 'tbl_leave_shift_detail',
                name: '请假替班班次明细',
              },
            ],
            has_more: false,
          },
        },
      });
    const httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          status: 200,
          data: {
            code: 0,
            tenant_access_token: 'table-list-tenant-token',
            expire: 7200,
          },
        }),
        get,
      },
    };
    const options = {
      appToken: 'app-table-name-resolution',
      tableName: '请假替班班次明细',
      auth: {
        appId: 'table-list-app-id',
        appSecret: 'table-list-app-secret',
      },
    };

    await expect(
      resolveBitableTableIdByName(httpService as never, options),
    ).resolves.toBe('tbl_leave_shift_detail');
    await expect(
      resolveBitableTableIdByName(httpService as never, options),
    ).resolves.toBe('tbl_leave_shift_detail');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][1]).toMatchObject({
      params: { page_size: 100, page_token: 'page-2' },
    });
  });

  it('applies a caller deadline control to tenant-token and Wiki requests', async () => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          status: 200,
          data: {
            code: 0,
            tenant_access_token: 'deadline-tenant-token',
            expire: 7200,
          },
        }),
        get: jest.fn().mockResolvedValue({
          status: 200,
          data: {
            code: 0,
            data: {
              node: {
                obj_type: 'bitable',
                obj_token: 'deadline-bitable-app-token',
              },
            },
          },
        }),
      },
    };
    const requestTimeoutMs = jest
      .fn()
      .mockReturnValueOnce(4_321)
      .mockReturnValueOnce(3_210);
    const waitFor = jest.fn(async <T>(promise: Promise<T>) => promise);

    await expect(
      resolveBitableAppToken(httpService as never, {
        wikiToken: 'wik_deadline_control',
        tableName: 'deadline-control-test',
        requestTimeoutMs,
        waitFor,
      }),
    ).resolves.toBe('deadline-bitable-app-token');
    expect(httpService.axiosRef.post.mock.calls[0][2]).toMatchObject({
      timeout: 4_321,
    });
    expect(httpService.axiosRef.get.mock.calls[0][1]).toMatchObject({
      timeout: 3_210,
    });
    expect(waitFor).toHaveBeenCalledWith(
      expect.any(Promise),
      'tenant access token',
    );
    expect(waitFor).toHaveBeenCalledWith(
      expect.any(Promise),
      'deadline-control-test',
    );
  });

  it('does not call Wiki when tenant token API returns a nonzero code', async () => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          status: 200,
          data: { code: 99991663, msg: 'app unavailable' },
        }),
        get: jest.fn(),
      },
    };

    await expect(
      resolveBitableAppToken(httpService as never, {
        wikiToken: 'wik_token_code_failure',
        tableName: 'token-code-test',
      }),
    ).rejects.toThrow('app unavailable');
    expect(httpService.axiosRef.get).not.toHaveBeenCalled();
  });

  it('does not call Wiki when tenant token response omits the token', async () => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          status: 200,
          data: { code: 0, expire: 7200 },
        }),
        get: jest.fn(),
      },
    };

    await expect(
      resolveBitableAppToken(httpService as never, {
        wikiToken: 'wik_token_missing',
        tableName: 'token-missing-test',
      }),
    ).rejects.toThrow('tenant_access_token is missing');
    expect(httpService.axiosRef.get).not.toHaveBeenCalled();
  });

  it.each([
    ['missing code', { tenant_access_token: 'tenant-token', expire: 7200 }],
    [
      'string code',
      { code: '0', tenant_access_token: 'tenant-token', expire: 7200 },
    ],
  ])('rejects tenant token responses with %s', async (_label, data) => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({ status: 200, data }),
        get: jest.fn(),
      },
    };

    await expect(
      resolveBitableAppToken(httpService as never, {
        wikiToken: `wik_token_invalid_auth_${_label}`,
        tableName: 'invalid-auth-code-test',
      }),
    ).rejects.toThrow();
    expect(httpService.axiosRef.get).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing code',
      { data: { node: { obj_type: 'bitable', obj_token: 'app' } } },
    ],
    [
      'string code',
      {
        code: '0',
        data: { node: { obj_type: 'bitable', obj_token: 'app' } },
      },
    ],
  ])('rejects Wiki responses with %s', async (_label, data) => {
    const httpService = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          status: 200,
          data: {
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          },
        }),
        get: jest.fn().mockResolvedValue({ status: 200, data }),
      },
    };

    await expect(
      resolveBitableAppToken(httpService as never, {
        wikiToken: `wik_token_invalid_wiki_${_label}`,
        tableName: 'invalid-wiki-code-test',
      }),
    ).rejects.toThrow();
  });

  it('persists force refresh results even when the fresh read skips cache ttl', async () => {
    await rm(cachePath, { force: true });
    invalidateBitableRecordCache({ appToken, tableId });
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) =>
          url.includes('/auth/v3/tenant_access_token/')
            ? { data: { code: 0, tenant_access_token: 'tenant-token' } }
            : {
                data: {
                  code: 0,
                  data: {
                    items: [
                      {
                        record_id: 'recFresh',
                        fields: { 状态: '新值' },
                      },
                    ],
                    has_more: false,
                  },
                },
              },
        ),
        get: jest.fn(),
      },
    };

    const freshRecords = await fetchBitableRecords(httpService as never, {
      appToken,
      tableId,
      tableName: '缓存测试',
      cacheTtlMs: 0,
      forceRefresh: true,
    });
    invalidateBitableRecordCache({ appToken, tableId });
    const cachedRecords = await fetchBitableRecords(httpService as never, {
      appToken,
      tableId,
      tableName: '缓存测试',
      cacheTtlMs: 60_000,
    });

    expect(freshRecords).toEqual(cachedRecords);
    expect(cachedRecords).toEqual([
      { record_id: 'recFresh', fields: { 状态: '新值' } },
    ]);
    expect(httpService.axiosRef.get).not.toHaveBeenCalled();
    expect(httpService.axiosRef.post).toHaveBeenCalledTimes(2);
  });

  it('deletes the persisted cache when a mutation explicitly invalidates it', async () => {
    await rm(cachePath, { force: true });
    invalidateBitableRecordCache({ appToken, tableId });
    const recordResponses = [
      {
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec', fields: { 状态: '旧值' } }],
            has_more: false,
          },
        },
      },
      {
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec', fields: { 状态: '新值' } }],
            has_more: false,
          },
        },
      },
    ];
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return { data: { code: 0, tenant_access_token: 'tenant-token' } };
          }
          return recordResponses.shift();
        }),
        get: jest.fn(),
      },
    };

    await fetchBitableRecords(httpService as never, {
      appToken,
      tableId,
      tableName: '缓存测试',
      forceRefresh: true,
    });
    invalidateBitableRecordCache({
      appToken,
      tableId,
      deletePersisted: true,
    });
    const refreshedRecords = await fetchBitableRecords(httpService as never, {
      appToken,
      tableId,
      tableName: '缓存测试',
    });

    expect(refreshedRecords).toEqual([
      { record_id: 'rec', fields: { 状态: '新值' } },
    ]);
    expect(httpService.axiosRef.get).not.toHaveBeenCalled();
    expect(httpService.axiosRef.post).toHaveBeenCalledTimes(3);
  });

  it('reuses one tenant access token across table reads', async () => {
    const tokenApp = 'app-token-reuse-test';
    const tableIds = ['tbl-token-reuse-a', 'tbl-token-reuse-b'];
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) =>
          url.includes('/auth/v3/tenant_access_token/')
            ? {
                data: {
                  code: 0,
                  tenant_access_token: 'tenant-token',
                  expire: 7200,
                },
              }
            : {
                data: {
                  code: 0,
                  data: { items: [], has_more: false },
                },
              },
        ),
        get: jest.fn(),
      },
    };

    try {
      for (const currentTableId of tableIds) {
        await fetchBitableRecords(httpService as never, {
          appToken: tokenApp,
          tableId: currentTableId,
          tableName: currentTableId,
          cacheTtlMs: 0,
          forceRefresh: true,
        });
      }

      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).includes('/auth/v3/tenant_access_token/'),
        ),
      ).toHaveLength(1);
    } finally {
      for (const currentTableId of tableIds) {
        invalidateBitableRecordCache({
          appToken: tokenApp,
          tableId: currentTableId,
          deletePersisted: true,
        });
      }
    }
  });

  it('uses the records search endpoint and keeps the view id in the request body', async () => {
    const searchApp = 'app-record-search-test';
    const searchTable = 'tbl-record-search-test';
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          if (url.endsWith('/records/search')) {
            return {
              data: {
                code: 0,
                data: {
                  items: [{ record_id: 'rec-search', fields: {} }],
                  has_more: false,
                },
              },
            };
          }
          throw new Error(`Unexpected POST request: ${url}`);
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: {
              items: [{ record_id: 'rec-list', fields: {} }],
              has_more: false,
            },
          },
        }),
      },
    };

    try {
      const records = await fetchBitableRecords(httpService as never, {
        appToken: searchApp,
        tableId: searchTable,
        tableName: 'record-search',
        viewId: 'vew-record-search',
        automaticFields: true,
        cacheTtlMs: 0,
        forceRefresh: true,
      });

      expect(records).toEqual([{ record_id: 'rec-search', fields: {} }]);
      expect(httpService.axiosRef.get).not.toHaveBeenCalled();
      expect(httpService.axiosRef.post).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(
          `/apps/${searchApp}/tables/${searchTable}/records/search`,
        ),
        { view_id: 'vew-record-search', automatic_fields: true },
        expect.objectContaining({
          params: expect.objectContaining({ page_size: 500 }),
        }),
      );
    } finally {
      invalidateBitableRecordCache({
        appToken: searchApp,
        tableId: searchTable,
        viewId: 'vew-record-search',
        deletePersisted: true,
      });
    }
  });

  it('isolates automatic-field snapshots from legacy persisted caches', async () => {
    const automaticApp = 'app-record-search-automatic-fields-test';
    const automaticTable = 'tbl-record-search-automatic-fields-test';
    const httpService = createRecordSearchHttpService(() => [
      { record_id: 'rec-automatic-fields', fields: {} },
    ]);

    try {
      await fetchBitableRecords(httpService as never, {
        appToken: automaticApp,
        tableId: automaticTable,
        tableName: 'record-search-automatic-fields',
        cacheTtlMs: 60_000,
      });
      invalidateBitableRecordCache({
        appToken: automaticApp,
        tableId: automaticTable,
      });
      await fetchBitableRecords(httpService as never, {
        appToken: automaticApp,
        tableId: automaticTable,
        tableName: 'record-search-automatic-fields',
        automaticFields: true,
        cacheTtlMs: 60_000,
      });

      const recordCalls = httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).endsWith('/records/search'),
      );
      expect(recordCalls).toHaveLength(2);
      expect(recordCalls[0][1]).toEqual({});
      expect(recordCalls[1][1]).toEqual({ automatic_fields: true });
    } finally {
      invalidateBitableRecordCache({
        appToken: automaticApp,
        tableId: automaticTable,
        deletePersisted: true,
      });
    }
  });

  it('normalizes projected field names in the records search request body', async () => {
    const projectionApp = 'app-record-search-fields-test';
    const projectionTable = 'tbl-record-search-fields-test';
    const httpService = createRecordSearchHttpService();

    try {
      await fetchBitableRecords(httpService as never, {
        appToken: projectionApp,
        tableId: projectionTable,
        tableName: 'record-search-fields',
        fieldNames: ['月份', '楼栋', '月份', ' '],
        cacheTtlMs: 0,
      });

      const recordCalls = httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).endsWith('/records/search'),
      );
      expect(recordCalls).toHaveLength(1);
      expect(recordCalls[0][1]).toEqual({
        field_names: ['月份', '楼栋'],
      });
    } finally {
      invalidateBitableRecordCache({
        appToken: projectionApp,
        tableId: projectionTable,
      });
    }
  });

  it('normalizes filter and sort in the records search request body', async () => {
    const queryApp = 'app-record-search-query-test';
    const queryTable = 'tbl-record-search-query-test';
    const httpService = createRecordSearchHttpService();

    try {
      await fetchBitableRecords(httpService as never, {
        appToken: queryApp,
        tableId: queryTable,
        tableName: 'record-search-query',
        filter: {
          conjunction: ' AND ' as never,
          conditions: [
            {
              field_name: ' occurredAt ',
              operator: ' isGreater ',
              value: ['ExactDate(2026-07-12)'],
            },
          ],
        },
        sort: [{ field_name: ' occurredAt ', desc: true }],
        cacheTtlMs: 0,
      });

      const recordCalls = httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).endsWith('/records/search'),
      );
      expect(recordCalls).toHaveLength(1);
      expect(recordCalls[0][1]).toEqual({
        filter: {
          conjunction: 'and',
          conditions: [
            {
              field_name: 'occurredAt',
              operator: 'isGreater',
              value: ['ExactDate(2026-07-12)'],
            },
          ],
        },
        sort: [{ field_name: 'occurredAt', desc: true }],
      });
    } finally {
      invalidateBitableRecordCache({
        appToken: queryApp,
        tableId: queryTable,
        deletePersisted: true,
      });
    }
  });

  it('shares normalized query caches and isolates different persisted queries', async () => {
    const queryApp = 'app-record-search-query-cache-test';
    const queryTable = 'tbl-record-search-query-cache-test';
    const queryTableName = 'record-search-query-cache';
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(
          async (
            url: string,
            body?: {
              filter?: {
                conditions?: Array<{ value?: string[] }>;
              };
            },
          ) => {
            if (url.includes('/auth/v3/tenant_access_token/')) {
              return {
                data: {
                  code: 0,
                  tenant_access_token: 'tenant-token',
                  expire: 7200,
                },
              };
            }
            const boundary =
              body?.filter?.conditions?.[0]?.value?.[0] ?? 'missing';
            return {
              data: {
                code: 0,
                data: {
                  items: [{ record_id: `rec-${boundary}`, fields: {} }],
                  has_more: false,
                },
              },
            };
          },
        ),
        get: jest.fn(),
      },
    };
    const createQuery = (boundary: string, padded = false) => ({
      filter: {
        conjunction: (padded ? ' AND ' : 'and') as 'and',
        conditions: [
          {
            field_name: padded ? ' occurredAt ' : 'occurredAt',
            operator: padded ? ' isGreater ' : 'isGreater',
            value: [boundary],
          },
        ],
      },
      sort: [
        {
          field_name: padded ? ' occurredAt ' : 'occurredAt',
          desc: true,
        },
      ],
    });

    try {
      const firstQuery = createQuery('ExactDate(2026-07-12)');
      const firstRecords = await fetchBitableRecords(httpService as never, {
        appToken: queryApp,
        tableId: queryTable,
        tableName: queryTableName,
        ...firstQuery,
        cacheTtlMs: 60_000,
      });
      const memoryCachedRecords = await fetchBitableRecords(
        httpService as never,
        {
          appToken: queryApp,
          tableId: queryTable,
          tableName: queryTableName,
          ...createQuery('ExactDate(2026-07-12)', true),
          cacheTtlMs: 60_000,
        },
      );

      invalidateBitableRecordCache({ appToken: queryApp, tableId: queryTable });
      const persistedRecords = await fetchBitableRecords(httpService as never, {
        appToken: queryApp,
        tableId: queryTable,
        tableName: queryTableName,
        ...createQuery('ExactDate(2026-07-12)', true),
        cacheTtlMs: 60_000,
      });
      const distinctRecords = await fetchBitableRecords(httpService as never, {
        appToken: queryApp,
        tableId: queryTable,
        tableName: queryTableName,
        ...createQuery('ExactDate(2026-07-13)'),
        cacheTtlMs: 60_000,
      });

      expect(firstRecords).toEqual([
        { record_id: 'rec-ExactDate(2026-07-12)', fields: {} },
      ]);
      expect(memoryCachedRecords).toEqual(firstRecords);
      expect(persistedRecords).toEqual(firstRecords);
      expect(distinctRecords).toEqual([
        { record_id: 'rec-ExactDate(2026-07-13)', fields: {} },
      ]);
      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records/search'),
        ),
      ).toHaveLength(2);
    } finally {
      invalidateBitableRecordCache({
        appToken: queryApp,
        tableId: queryTable,
        deletePersisted: true,
      });
    }
  });

  it('shares cached records across equivalent field projections', async () => {
    const projectionApp = 'app-equivalent-field-cache-test';
    const projectionTable = 'tbl-equivalent-field-cache-test';
    const cacheKey = `${projectionApp}:${projectionTable}::月份\u001f楼栋`;
    const httpService = createRecordSearchHttpService();

    try {
      await rm(getProjectedCachePath(cacheKey), { force: true });
      await fetchBitableRecords(httpService as never, {
        appToken: projectionApp,
        tableId: projectionTable,
        tableName: 'equivalent-field-cache',
        fieldNames: ['楼栋', '月份'],
        cacheTtlMs: 60_000,
      });
      await fetchBitableRecords(httpService as never, {
        appToken: projectionApp,
        tableId: projectionTable,
        tableName: 'equivalent-field-cache',
        fieldNames: ['月份', '楼栋', '月份'],
        cacheTtlMs: 60_000,
      });

      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records/search'),
        ),
      ).toHaveLength(1);
    } finally {
      invalidateBitableRecordCache({
        appToken: projectionApp,
        tableId: projectionTable,
      });
      await rm(getProjectedCachePath(cacheKey), { force: true });
    }
  });

  it('keeps different field projections in separate caches', async () => {
    const projectionApp = 'app-distinct-field-cache-test';
    const projectionTable = 'tbl-distinct-field-cache-test';
    const cacheKeys = [
      `${projectionApp}:${projectionTable}::员工`,
      `${projectionApp}:${projectionTable}::课程`,
    ];
    const httpService = createRecordSearchHttpService();

    try {
      await Promise.all(
        cacheKeys.map((cacheKey) =>
          rm(getProjectedCachePath(cacheKey), { force: true }),
        ),
      );
      await fetchBitableRecords(httpService as never, {
        appToken: projectionApp,
        tableId: projectionTable,
        tableName: 'distinct-field-cache',
        fieldNames: ['员工'],
        cacheTtlMs: 60_000,
      });
      await fetchBitableRecords(httpService as never, {
        appToken: projectionApp,
        tableId: projectionTable,
        tableName: 'distinct-field-cache',
        fieldNames: ['课程'],
        cacheTtlMs: 60_000,
      });

      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records/search'),
        ),
      ).toHaveLength(2);
    } finally {
      invalidateBitableRecordCache({
        appToken: projectionApp,
        tableId: projectionTable,
      });
      await Promise.all(
        cacheKeys.map((cacheKey) =>
          rm(getProjectedCachePath(cacheKey), { force: true }),
        ),
      );
    }
  });

  it('yields the app request slot between pages instead of blocking an interactive lookup behind a full table', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstPage = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const http = createRecordSearchHttpService();
    http.axiosRef.post.mockImplementation(async (url: string, _body?: unknown, config?: any) => {
      if (url.includes('/auth/')) return { data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 } };
      if (url.includes('/tables/bulk/')) {
        const next = Boolean(config?.params?.page_token);
        order.push(next ? 'bulk-page-2' : 'bulk-page-1');
        if (!next) { firstStarted(); await firstPage; }
        return { data: { code: 0, data: { items: [], has_more: !next, ...(!next ? { page_token: 'next' } : {}) } } };
      }
      order.push('interactive');
      return { data: { code: 0, data: { items: [], has_more: false } } };
    });
    const bulk = fetchBitableRecords(http as never, { appToken: 'page-fairness-app', tableId: 'bulk', tableName: 'bulk', cacheTtlMs: 0, strict: true });
    await started;
    const interactive = fetchBitableRecords(http as never, { appToken: 'page-fairness-app', tableId: 'lookup', tableName: 'lookup', cacheTtlMs: 0, strict: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally { releaseFirst(); }
    await Promise.all([bulk, interactive]);
    expect(order).toEqual(['bulk-page-1', 'interactive', 'bulk-page-2']);
  });

  it('releases the app request slot during retry backoff while preserving the failed read', async () => {
    const order: string[] = [];
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    let attempts = 0;
    const http = createRecordSearchHttpService();
    http.axiosRef.post.mockImplementation(async (url: string) => {
      if (url.includes('/auth/')) return { data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 } };
      if (url.includes('/tables/retrying/')) {
        attempts++;
        order.push(`retrying-${attempts}`);
        if (attempts === 1) { failed(); throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }); }
      } else { order.push('interactive'); }
      return { data: { code: 0, data: { items: [], has_more: false } } };
    });
    const slow = fetchBitableRecords(http as never, { appToken: 'retry-fairness-app', tableId: 'retrying', tableName: 'retrying', cacheTtlMs: 0, strict: true });
    await failure;
    const quick = fetchBitableRecords(http as never, { appToken: 'retry-fairness-app', tableId: 'lookup', tableName: 'lookup', cacheTtlMs: 0, strict: true });
    await Promise.all([slow, quick]);
    expect(order).toEqual(['retrying-1', 'interactive', 'retrying-2']);
    expect(attempts).toBe(2);
  });

  it('serializes concurrent table reads within the same bitable app', async () => {
    const serialApp = 'app-serial-read-test';
    const tableIds = ['tbl-serial-a', 'tbl-serial-b'];
    let activeReads = 0;
    let maxActiveReads = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeReads -= 1;
          return {
            data: {
              code: 0,
              data: { items: [], has_more: false },
            },
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      await Promise.all(
        tableIds.map((currentTableId) =>
          fetchBitableRecords(httpService as never, {
            appToken: serialApp,
            tableId: currentTableId,
            tableName: currentTableId,
            cacheTtlMs: 0,
            forceRefresh: true,
          }),
        ),
      );

      expect(maxActiveReads).toBe(1);
    } finally {
      for (const currentTableId of tableIds) {
        invalidateBitableRecordCache({
          appToken: serialApp,
          tableId: currentTableId,
          deletePersisted: true,
        });
      }
    }
  });

  it('retries data-not-ready responses with a smaller page size', async () => {
    const retryApp = 'app-data-not-ready-test';
    const retryTable = 'tbl-data-not-ready-test';
    let recordReadAttempt = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          recordReadAttempt += 1;
          if (recordReadAttempt === 1) {
            throw {
              response: {
                status: 400,
                data: { code: 1254607, msg: 'Data not ready' },
              },
            };
          }
          return {
            data: {
              code: 0,
              data: {
                items: [{ record_id: 'rec-retried', fields: {} }],
                has_more: false,
              },
            },
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      const records = await fetchBitableRecords(httpService as never, {
        appToken: retryApp,
        tableId: retryTable,
        tableName: 'data-not-ready',
        cacheTtlMs: 0,
        forceRefresh: true,
      });

      expect(records).toEqual([{ record_id: 'rec-retried', fields: {} }]);
      const recordCalls = httpService.axiosRef.post.mock.calls.filter(([url]) =>
        String(url).endsWith('/records/search'),
      );
      expect(recordCalls).toHaveLength(2);
      const firstPageSize = recordCalls[0][2].params.page_size;
      const retriedPageSize = recordCalls[1][2].params.page_size;
      expect(retriedPageSize).toBeLessThan(firstPageSize);
    } finally {
      invalidateBitableRecordCache({
        appToken: retryApp,
        tableId: retryTable,
        deletePersisted: true,
      });
    }
  });

  it('returns the last persisted snapshot when a force refresh fails', async () => {
    const staleApp = 'app-stale-fallback-test';
    const staleTable = 'tbl-stale-fallback-test';
    const staleRecords = [
      { record_id: 'rec-last-good', fields: { status: 'last-good' } },
    ];
    const successfulHttpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) =>
          url.includes('/auth/v3/tenant_access_token/')
            ? {
                data: {
                  code: 0,
                  tenant_access_token: 'tenant-token',
                  expire: 7200,
                },
              }
            : {
                data: {
                  code: 0,
                  data: { items: staleRecords, has_more: false },
                },
              },
        ),
        get: jest.fn(),
      },
    };
    const failingHttpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          throw {
            code: 'ECONNABORTED',
            message: 'timeout of 30000ms exceeded',
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      await fetchBitableRecords(successfulHttpService as never, {
        appToken: staleApp,
        tableId: staleTable,
        tableName: 'stale-fallback',
        forceRefresh: true,
      });
      invalidateBitableRecordCache({ appToken: staleApp, tableId: staleTable });

      const records = await fetchBitableRecords(failingHttpService as never, {
        appToken: staleApp,
        tableId: staleTable,
        tableName: 'stale-fallback',
        forceRefresh: true,
      });

      expect(records).toEqual(staleRecords);
    } finally {
      invalidateBitableRecordCache({
        appToken: staleApp,
        tableId: staleTable,
        deletePersisted: true,
      });
    }
  });

  it('throws a refresh failure in strict mode instead of serving the persisted snapshot', async () => {
    const strictApp = 'app-strict-fallback-test';
    const strictTable = 'tbl-strict-fallback-test';
    const successfulHttpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) =>
          url.includes('/auth/v3/tenant_access_token/')
            ? {
                data: {
                  code: 0,
                  tenant_access_token: 'tenant-token',
                  expire: 7200,
                },
              }
            : {
                data: {
                  code: 0,
                  data: {
                    items: [{ record_id: 'rec-last-good', fields: {} }],
                    has_more: false,
                  },
                },
              },
        ),
        get: jest.fn(),
      },
    };
    const failingHttpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          throw {
            response: {
              status: 403,
              data: { code: 91403, msg: 'forbidden' },
            },
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      await fetchBitableRecords(successfulHttpService as never, {
        appToken: strictApp,
        tableId: strictTable,
        tableName: 'strict-fallback',
        forceRefresh: true,
      });
      invalidateBitableRecordCache({
        appToken: strictApp,
        tableId: strictTable,
      });

      await expect(
        fetchBitableRecords(failingHttpService as never, {
          appToken: strictApp,
          tableId: strictTable,
          tableName: 'strict-fallback',
          forceRefresh: true,
          strict: true,
        }),
      ).rejects.toThrow();
    } finally {
      invalidateBitableRecordCache({
        appToken: strictApp,
        tableId: strictTable,
        deletePersisted: true,
      });
    }
  });

  it('keeps stale-while-revalidate enabled by default for expired memory cache', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-03T00:00:00.000Z') });
    const staleApp = 'app-default-stale-memory-test';
    const staleTable = 'tbl-default-stale-memory-test';
    const staleRecords = [{ record_id: 'rec-stale', fields: {} }];
    const freshRecords = [{ record_id: 'rec-fresh', fields: {} }];
    let recordRequestCount = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          recordRequestCount += 1;
          return {
            data: {
              code: 0,
              data: {
                items: recordRequestCount === 1 ? staleRecords : freshRecords,
                has_more: false,
              },
            },
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      await fetchBitableRecords(httpService as never, {
        appToken: staleApp,
        tableId: staleTable,
        tableName: 'default-stale-memory',
        cacheTtlMs: 100,
      });
      jest.setSystemTime(new Date('2026-08-03T00:00:00.101Z'));

      await expect(
        fetchBitableRecords(httpService as never, {
          appToken: staleApp,
          tableId: staleTable,
          tableName: 'default-stale-memory',
          cacheTtlMs: 100,
        }),
      ).resolves.toEqual(staleRecords);
      await expect(
        fetchBitableRecords(httpService as never, {
          appToken: staleApp,
          tableId: staleTable,
          tableName: 'default-stale-memory',
          cacheTtlMs: 100,
          forceRefresh: true,
        }),
      ).resolves.toEqual(freshRecords);
    } finally {
      jest.useRealTimers();
      invalidateBitableRecordCache({
        appToken: staleApp,
        tableId: staleTable,
        deletePersisted: true,
      });
    }
  });

  it('waits for fresh records when stale memory cache is explicitly disabled', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-03T00:00:00.000Z') });
    const strictApp = 'app-no-stale-memory-test';
    const strictTable = 'tbl-no-stale-memory-test';
    const staleRecords = [{ record_id: 'rec-stale', fields: {} }];
    const freshRecords = [{ record_id: 'rec-fresh', fields: {} }];
    let recordRequestCount = 0;
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          recordRequestCount += 1;
          return {
            data: {
              code: 0,
              data: {
                items: recordRequestCount === 1 ? staleRecords : freshRecords,
                has_more: false,
              },
            },
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      await fetchBitableRecords(httpService as never, {
        appToken: strictApp,
        tableId: strictTable,
        tableName: 'no-stale-memory',
        cacheTtlMs: 100,
      });
      jest.setSystemTime(new Date('2026-08-03T00:00:00.101Z'));

      await expect(
        fetchBitableRecords(httpService as never, {
          appToken: strictApp,
          tableId: strictTable,
          tableName: 'no-stale-memory',
          cacheTtlMs: 100,
          allowStale: false,
        }),
      ).resolves.toEqual(freshRecords);
      expect(recordRequestCount).toBe(2);
    } finally {
      jest.useRealTimers();
      invalidateBitableRecordCache({
        appToken: strictApp,
        tableId: strictTable,
        deletePersisted: true,
      });
    }
  });

  it('throws when strict refresh fails after stale persisted cache is explicitly disabled', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-03T00:00:00.000Z') });
    const strictApp = 'app-no-stale-persisted-test';
    const strictTable = 'tbl-no-stale-persisted-test';
    const successfulHttpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) =>
          url.includes('/auth/v3/tenant_access_token/')
            ? {
                data: {
                  code: 0,
                  tenant_access_token: 'tenant-token',
                  expire: 7200,
                },
              }
            : {
                data: {
                  code: 0,
                  data: {
                    items: [{ record_id: 'rec-stale', fields: {} }],
                    has_more: false,
                  },
                },
              },
        ),
        get: jest.fn(),
      },
    };
    const failingHttpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          throw {
            response: {
              status: 403,
              data: { code: 91403, msg: 'forbidden' },
            },
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      await fetchBitableRecords(successfulHttpService as never, {
        appToken: strictApp,
        tableId: strictTable,
        tableName: 'no-stale-persisted',
        cacheTtlMs: 100,
      });
      invalidateBitableRecordCache({
        appToken: strictApp,
        tableId: strictTable,
      });
      jest.setSystemTime(new Date('2026-08-03T00:00:00.101Z'));

      await expect(
        fetchBitableRecords(failingHttpService as never, {
          appToken: strictApp,
          tableId: strictTable,
          tableName: 'no-stale-persisted',
          cacheTtlMs: 100,
          allowStale: false,
          strict: true,
        }),
      ).rejects.toThrow();
    } finally {
      jest.useRealTimers();
      invalidateBitableRecordCache({
        appToken: strictApp,
        tableId: strictTable,
        deletePersisted: true,
      });
    }
  });

  it('runs a later strict caller validation when both callers share one in-flight request', async () => {
    const concurrentApp = 'app-concurrent-strict-test';
    const concurrentTable = 'tbl-concurrent-strict-test';
    const freshRecords = [{ record_id: 'rec-concurrent', fields: {} }];
    let markRecordRequestStarted = () => undefined;
    const recordRequestStarted = new Promise<void>((resolveStarted) => {
      markRecordRequestStarted = resolveStarted;
    });
    let finishRecordRequest = () => undefined;
    const pendingRecordResponse = new Promise<{
      data: {
        code: number;
        data: {
          items: typeof freshRecords;
          has_more: boolean;
        };
      };
    }>((resolveResponse) => {
      finishRecordRequest = () =>
        resolveResponse({
          data: {
            code: 0,
            data: { items: freshRecords, has_more: false },
          },
        });
    });
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          markRecordRequestStarted();
          return pendingRecordResponse;
        }),
        get: jest.fn(),
      },
    };
    const strictValidation = jest.fn(() => {
      throw new Error('strict caller rejected the records');
    });

    try {
      const weakRequest = fetchBitableRecords(httpService as never, {
        appToken: concurrentApp,
        tableId: concurrentTable,
        tableName: 'concurrent-strict',
        forceRefresh: true,
      });
      await recordRequestStarted;
      const strictRequest = fetchBitableRecords(httpService as never, {
        appToken: concurrentApp,
        tableId: concurrentTable,
        tableName: 'concurrent-strict',
        forceRefresh: true,
        strict: true,
        validateRecords: strictValidation,
      });
      const strictExpectation = expect(strictRequest).rejects.toThrow(
        'strict caller rejected the records',
      );
      finishRecordRequest();

      await expect(weakRequest).resolves.toEqual(freshRecords);
      await strictExpectation;
      expect(strictValidation).toHaveBeenCalledWith(freshRecords);
      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records/search'),
        ),
      ).toHaveLength(1);
    } finally {
      invalidateBitableRecordCache({
        appToken: concurrentApp,
        tableId: concurrentTable,
        deletePersisted: true,
      });
    }
  });

  it('persists a shared in-flight read when a force-refresh subscriber requires a local snapshot', async () => {
    const concurrentApp = 'app-concurrent-persist-test';
    const concurrentTable = 'tbl-concurrent-persist-test';
    const syncTableName = 'concurrent-persist-sync';
    const freshRecords = [{ record_id: 'rec-concurrent-persist', fields: {} }];
    let markRecordRequestStarted = () => undefined;
    const recordRequestStarted = new Promise<void>((resolveStarted) => {
      markRecordRequestStarted = resolveStarted;
    });
    let finishRecordRequest = () => undefined;
    const pendingRecordResponse = new Promise<{
      data: {
        code: number;
        data: {
          items: typeof freshRecords;
          has_more: boolean;
        };
      };
    }>((resolveResponse) => {
      finishRecordRequest = () =>
        resolveResponse({
          data: {
            code: 0,
            data: { items: freshRecords, has_more: false },
          },
        });
    });
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          markRecordRequestStarted();
          return pendingRecordResponse;
        }),
        get: jest.fn(),
      },
    };

    try {
      const noStoreRequest = fetchBitableRecords(httpService as never, {
        appToken: concurrentApp,
        tableId: concurrentTable,
        tableName: 'concurrent-persist-no-store',
        cacheTtlMs: 0,
      });
      await recordRequestStarted;
      const syncRequest = fetchBitableRecords(httpService as never, {
        appToken: concurrentApp,
        tableId: concurrentTable,
        tableName: syncTableName,
        forceRefresh: true,
      });
      finishRecordRequest();

      await expect(noStoreRequest).resolves.toEqual(freshRecords);
      await expect(syncRequest).resolves.toEqual(freshRecords);
      await expect(
        readLatestPersistedBitableRecords({
          appToken: concurrentApp,
          tableId: concurrentTable,
          tableName: syncTableName,
        }),
      ).resolves.toEqual(freshRecords);
      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records/search'),
        ),
      ).toHaveLength(1);
    } finally {
      invalidateBitableRecordCache({
        appToken: concurrentApp,
        tableId: concurrentTable,
        deletePersisted: true,
      });
    }
  });

  it('serializes persisted writes when force-refresh callers share one in-flight read', async () => {
    const concurrentApp = 'app-concurrent-write-test';
    const concurrentTable = 'tbl-concurrent-write-test';
    const tableName = 'concurrent-write';
    const freshRecords = [{ record_id: 'rec-concurrent-write', fields: {} }];
    let markRecordRequestStarted = () => undefined;
    const recordRequestStarted = new Promise<void>((resolveStarted) => {
      markRecordRequestStarted = resolveStarted;
    });
    let finishRecordRequest = () => undefined;
    const pendingRecordResponse = new Promise<{
      data: {
        code: number;
        data: {
          items: typeof freshRecords;
          has_more: boolean;
        };
      };
    }>((resolveResponse) => {
      finishRecordRequest = () =>
        resolveResponse({
          data: {
            code: 0,
            data: { items: freshRecords, has_more: false },
          },
        });
    });
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          markRecordRequestStarted();
          return pendingRecordResponse;
        }),
        get: jest.fn(),
      },
    };
    const fsPromises =
      require('node:fs/promises') as typeof import('node:fs/promises');
    const originalRename = fsPromises.rename;
    let activeRenames = 0;
    let maxActiveRenames = 0;
    const renameSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation((async (
        ...args: Parameters<typeof originalRename>
      ) => {
        activeRenames += 1;
        maxActiveRenames = Math.max(maxActiveRenames, activeRenames);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        try {
          return await originalRename(...args);
        } finally {
          activeRenames -= 1;
        }
      }) as typeof originalRename);

    try {
      const firstRequest = fetchBitableRecords(httpService as never, {
        appToken: concurrentApp,
        tableId: concurrentTable,
        tableName,
        forceRefresh: true,
      });
      await recordRequestStarted;
      const secondRequest = fetchBitableRecords(httpService as never, {
        appToken: concurrentApp,
        tableId: concurrentTable,
        tableName,
        forceRefresh: true,
      });
      finishRecordRequest();

      await expect(firstRequest).resolves.toEqual(freshRecords);
      await expect(secondRequest).resolves.toEqual(freshRecords);
      expect(maxActiveRenames).toBe(1);
      await expect(
        readLatestPersistedBitableRecords({
          appToken: concurrentApp,
          tableId: concurrentTable,
          tableName,
        }),
      ).resolves.toEqual(freshRecords);
    } finally {
      renameSpy.mockRestore();
      invalidateBitableRecordCache({
        appToken: concurrentApp,
        tableId: concurrentTable,
        deletePersisted: true,
      });
    }
  });

  it('finds only the latest persisted snapshot matching both table id and table name', async () => {
    const exactTableId = 'tbl-cold-start-exact-test';
    const exactTableName = 'cold-start-exact';
    const sources = [
      {
        appToken: 'app-cold-start-old',
        tableId: exactTableId,
        tableName: exactTableName,
        recordId: 'rec-old-match',
      },
      {
        appToken: 'app-cold-start-wrong-name',
        tableId: exactTableId,
        tableName: 'another-table-name',
        recordId: 'rec-wrong-name',
      },
      {
        appToken: 'app-cold-start-wrong-table',
        tableId: 'tbl-cold-start-other',
        tableName: exactTableName,
        recordId: 'rec-wrong-table',
      },
      {
        appToken: 'app-cold-start-new',
        tableId: exactTableId,
        tableName: exactTableName,
        recordId: 'rec-new-match',
      },
    ];
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(async (url: string) => {
          if (url.includes('/auth/v3/tenant_access_token/')) {
            return {
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            };
          }
          const appToken = sources.find(({ appToken }) =>
            url.includes(`/apps/${appToken}/`),
          )?.appToken;
          const source = sources.find((item) => item.appToken === appToken);
          return {
            data: {
              code: 0,
              data: {
                items: source
                  ? [{ record_id: source.recordId, fields: {} }]
                  : [],
                has_more: false,
              },
            },
          };
        }),
        get: jest.fn(),
      },
    };

    try {
      for (const [index, source] of sources.entries()) {
        if (index === sources.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        await fetchBitableRecords(httpService as never, {
          appToken: source.appToken,
          tableId: source.tableId,
          tableName: source.tableName,
          forceRefresh: true,
        });
      }

      await expect(
        readLatestPersistedBitableRecords({
          tableId: exactTableId,
          tableName: exactTableName,
        }),
      ).resolves.toEqual([{ record_id: 'rec-new-match', fields: {} }]);
    } finally {
      for (const source of sources) {
        invalidateBitableRecordCache({
          appToken: source.appToken,
          tableId: source.tableId,
          deletePersisted: true,
        });
      }
    }
  });

  it('isolates matching persisted snapshots by app token while preserving unscoped latest lookup', async () => {
    const tableId = 'tbl-latest-snapshot-app-isolation';
    const tableName = 'latest-snapshot-app-isolation';
    const firstAppToken = 'app-latest-snapshot-app-isolation-first';
    const secondAppToken = 'app-latest-snapshot-app-isolation-second';
    let recordId = 'rec-first-app';
    const httpService = createRecordSearchHttpService(() => [
      { record_id: recordId, fields: {} },
    ]);
    const baseOptions = { tableId, tableName };
    const firstOptions = {
      ...baseOptions,
      appToken: firstAppToken,
    } as Parameters<typeof readLatestPersistedBitableRecordSnapshot>[0] & {
      appToken: string;
    };
    const secondOptions = {
      ...baseOptions,
      appToken: secondAppToken,
    } as Parameters<typeof readLatestPersistedBitableRecordSnapshot>[0] & {
      appToken: string;
    };

    try {
      await fetchBitableRecords(httpService as never, {
        appToken: firstAppToken,
        tableId,
        tableName,
        forceRefresh: true,
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      recordId = 'rec-second-app';
      await fetchBitableRecords(httpService as never, {
        appToken: secondAppToken,
        tableId,
        tableName,
        forceRefresh: true,
      });
      invalidateBitableRecordCache();

      await expect(
        readLatestPersistedBitableRecordSnapshot(firstOptions),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-first-app', fields: {} }],
      });
      await expect(
        readLatestPersistedBitableRecordSnapshot(secondOptions),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-second-app', fields: {} }],
      });
      await expect(
        readLatestPersistedBitableRecordSnapshot(baseOptions),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-second-app', fields: {} }],
      });
    } finally {
      for (const appToken of [firstAppToken, secondAppToken]) {
        invalidateBitableRecordCache({
          appToken,
          tableId,
          deletePersisted: true,
        });
      }
    }
  });

  it('matches persisted full and projected snapshots by normalized field names', async () => {
    const projectionApp = 'app-cold-start-projection-test';
    const projectionTable = 'tbl-cold-start-projection-test';
    const projectionTableName = 'cold-start-projection';
    const fullCacheKey = `${projectionApp}:${projectionTable}:`;
    const projectedCacheKey = `${projectionApp}:${projectionTable}::月份\u001f楼栋`;
    const httpService = {
      axiosRef: {
        post: jest
          .fn()
          .mockImplementation(
            async (url: string, body?: { field_names?: string[] }) => {
              if (url.includes('/auth/v3/tenant_access_token/')) {
                return {
                  data: {
                    code: 0,
                    tenant_access_token: 'tenant-token',
                    expire: 7200,
                  },
                };
              }
              return {
                data: {
                  code: 0,
                  data: {
                    items: [
                      {
                        record_id: body?.field_names
                          ? 'rec-projected'
                          : 'rec-full',
                        fields: {},
                      },
                    ],
                    has_more: false,
                  },
                },
              };
            },
          ),
        get: jest.fn(),
      },
    };

    try {
      await Promise.all(
        [fullCacheKey, projectedCacheKey].map((currentCacheKey) =>
          rm(getProjectedCachePath(currentCacheKey), { force: true }),
        ),
      );
      await fetchBitableRecords(httpService as never, {
        appToken: projectionApp,
        tableId: projectionTable,
        tableName: projectionTableName,
        cacheTtlMs: 0,
        forceRefresh: true,
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      await fetchBitableRecords(httpService as never, {
        appToken: projectionApp,
        tableId: projectionTable,
        tableName: projectionTableName,
        fieldNames: ['楼栋', '月份'],
        cacheTtlMs: 0,
        forceRefresh: true,
      });

      await expect(
        readLatestPersistedBitableRecords({
          tableId: projectionTable,
          tableName: projectionTableName,
        }),
      ).resolves.toEqual([{ record_id: 'rec-full', fields: {} }]);
      await expect(
        readLatestPersistedBitableRecords({
          tableId: projectionTable,
          tableName: projectionTableName,
          fieldNames: [' 月份 ', '楼栋', '月份'],
        }),
      ).resolves.toEqual([{ record_id: 'rec-projected', fields: {} }]);
    } finally {
      invalidateBitableRecordCache({
        appToken: projectionApp,
        tableId: projectionTable,
        deletePersisted: true,
      });
      await Promise.all(
        [fullCacheKey, projectedCacheKey].map((currentCacheKey) =>
          rm(getProjectedCachePath(currentCacheKey), { force: true }),
        ),
      );
    }
  });

  it('matches persisted snapshots by normalized filter and sort', async () => {
    const queryApp = 'app-cold-start-query-test';
    const queryTable = 'tbl-cold-start-query-test';
    const queryTableName = 'cold-start-query';
    const httpService = {
      axiosRef: {
        post: jest.fn().mockImplementation(
          async (
            url: string,
            body?: {
              filter?: {
                conditions?: Array<{ value?: string[] }>;
              };
            },
          ) => {
            if (url.includes('/auth/v3/tenant_access_token/')) {
              return {
                data: {
                  code: 0,
                  tenant_access_token: 'tenant-token',
                  expire: 7200,
                },
              };
            }
            const boundary =
              body?.filter?.conditions?.[0]?.value?.[0] ?? 'missing';
            return {
              data: {
                code: 0,
                data: {
                  items: [{ record_id: `rec-${boundary}`, fields: {} }],
                  has_more: false,
                },
              },
            };
          },
        ),
        get: jest.fn(),
      },
    };
    const createQuery = (boundary: string, padded = false) => ({
      filter: {
        conjunction: (padded ? ' AND ' : 'and') as 'and',
        conditions: [
          {
            field_name: padded ? ' occurredAt ' : 'occurredAt',
            operator: padded ? ' isGreater ' : 'isGreater',
            value: [boundary],
          },
        ],
      },
      sort: [
        {
          field_name: padded ? ' occurredAt ' : 'occurredAt',
          desc: true,
        },
      ],
    });

    try {
      const firstQuery = createQuery('ExactDate(2026-07-12)');
      const secondQuery = createQuery('ExactDate(2026-07-13)');
      await fetchBitableRecords(httpService as never, {
        appToken: queryApp,
        tableId: queryTable,
        tableName: queryTableName,
        ...firstQuery,
        cacheTtlMs: 0,
        forceRefresh: true,
      });
      await fetchBitableRecords(httpService as never, {
        appToken: queryApp,
        tableId: queryTable,
        tableName: queryTableName,
        ...secondQuery,
        cacheTtlMs: 0,
        forceRefresh: true,
      });

      await expect(
        readLatestPersistedBitableRecords({
          tableId: queryTable,
          tableName: queryTableName,
          ...createQuery('ExactDate(2026-07-12)', true),
        }),
      ).resolves.toEqual([
        { record_id: 'rec-ExactDate(2026-07-12)', fields: {} },
      ]);
      await expect(
        readLatestPersistedBitableRecords({
          tableId: queryTable,
          tableName: queryTableName,
          ...secondQuery,
        }),
      ).resolves.toEqual([
        { record_id: 'rec-ExactDate(2026-07-13)', fields: {} },
      ]);
      await expect(
        readLatestPersistedBitableRecordSnapshot({
          tableId: queryTable,
          tableName: queryTableName,
          ...secondQuery,
        }),
      ).resolves.toEqual({
        records: [{ record_id: 'rec-ExactDate(2026-07-13)', fields: {} }],
        fetchedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      });
      await expect(
        readLatestPersistedBitableRecords({
          tableId: queryTable,
          tableName: queryTableName,
        }),
      ).resolves.toBeNull();
    } finally {
      invalidateBitableRecordCache({
        appToken: queryApp,
        tableId: queryTable,
        deletePersisted: true,
      });
    }
  });

  it('keeps the latest persisted snapshot in memory after the first local lookup', async () => {
    const appToken = 'app-latest-snapshot-memory';
    const tableId = 'tbl-latest-snapshot-memory';
    const tableName = 'latest-snapshot-memory';
    const cacheKey = `${appToken}:${tableId}:`;
    const cachePath = getProjectedCachePath(cacheKey);
    const httpService = createRecordSearchHttpService();

    try {
      await fetchBitableRecords(httpService as never, {
        appToken,
        tableId,
        tableName,
        cacheTtlMs: 4 * 60 * 60 * 1000,
        forceRefresh: true,
      });
      invalidateBitableRecordCache();

      const options = { tableId, tableName };
      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toEqual({
        records: [],
        fetchedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      });

      await rm(cachePath, { force: true });
      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toEqual({
        records: [],
        fetchedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      });
    } finally {
      invalidateBitableRecordCache({ appToken, tableId });
      await rm(cachePath, { force: true });
    }
  });

  it('keeps the last good local snapshot during ordinary network-cache invalidation', async () => {
    const appToken = 'app-latest-snapshot-soft-invalidate';
    const tableId = 'tbl-latest-snapshot-soft-invalidate';
    const tableName = 'latest-snapshot-soft-invalidate';
    const cachePath = getProjectedCachePath(`${appToken}:${tableId}:`);
    const httpService = createRecordSearchHttpService(() => [
      { record_id: 'rec-last-good-soft-invalidate', fields: {} },
    ]);
    const options = { appToken, tableId, tableName };

    try {
      await fetchBitableRecords(httpService as never, {
        ...options,
        forceRefresh: true,
      });
      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-last-good-soft-invalidate', fields: {} }],
      });

      invalidateBitableRecordCache({ appToken, tableId });
      await rm(cachePath, { force: true });
      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-last-good-soft-invalidate', fields: {} }],
      });
    } finally {
      invalidateBitableRecordCache({
        appToken,
        tableId,
        deletePersisted: true,
      });
      await rm(cachePath, { force: true });
    }
  });

  it('shares one cold directory scan across warmup and concurrent normalized queries', async () => {
    const projected = {
      appToken: 'app-latest-snapshot-concurrent-projected',
      tableId: 'tbl-latest-snapshot-concurrent-projected',
      tableName: 'latest-snapshot-concurrent-projected',
      fieldNames: ['班组', '姓名'],
    };
    const full = {
      appToken: 'app-latest-snapshot-concurrent-full',
      tableId: 'tbl-latest-snapshot-concurrent-full',
      tableName: 'latest-snapshot-concurrent-full',
    };
    const httpService = createRecordSearchHttpService(() => [
      { record_id: 'rec-concurrent', fields: {} },
    ]);
    const fsPromises =
      require('node:fs/promises') as typeof import('node:fs/promises');
    const readdirSpy = jest.spyOn(fsPromises, 'readdir');
    const readFileSpy = jest.spyOn(fsPromises, 'readFile');

    try {
      invalidateBitableRecordCache();
      await rm(localCacheDir, { force: true, recursive: true });
      for (const source of [projected, full]) {
        await fetchBitableRecords(httpService as never, {
          ...source,
          forceRefresh: true,
        });
      }
      invalidateBitableRecordCache();
      readdirSpy.mockClear();
      readFileSpy.mockClear();

      const projectedOptions = {
        tableId: projected.tableId,
        tableName: projected.tableName,
        fieldNames: [' 姓名 ', '班组', '姓名'],
      };
      const [, first, second, other] = await Promise.all([
        warmLatestPersistedBitableRecordSnapshotIndex(),
        readLatestPersistedBitableRecordSnapshot(projectedOptions),
        readLatestPersistedBitableRecordSnapshot({
          ...projectedOptions,
          fieldNames: ['班组', '姓名'],
        }),
        readLatestPersistedBitableRecordSnapshot({
          tableId: full.tableId,
          tableName: full.tableName,
        }),
      ]);

      expect(first).toEqual(second);
      expect(other).toMatchObject({
        records: [{ record_id: 'rec-concurrent', fields: {} }],
      });
      expect(readdirSpy).toHaveBeenCalledTimes(1);
      expect(readFileSpy).toHaveBeenCalledTimes(4);
    } finally {
      readdirSpy.mockRestore();
      readFileSpy.mockRestore();
      invalidateBitableRecordCache();
      await rm(localCacheDir, { force: true, recursive: true });
    }
  });

  it('updates the latest snapshot index after a successful persisted write', async () => {
    const appToken = 'app-latest-snapshot-write';
    const tableId = 'tbl-latest-snapshot-write';
    const tableName = 'latest-snapshot-write';
    const cacheKey = `${appToken}:${tableId}:`;
    const cachePath = getProjectedCachePath(cacheKey);
    let recordId = 'rec-before-write';
    const httpService = createRecordSearchHttpService(() => [
      { record_id: recordId, fields: {} },
    ]);
    const options = { tableId, tableName };

    try {
      await fetchBitableRecords(httpService as never, {
        appToken,
        tableId,
        tableName,
        forceRefresh: true,
      });
      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-before-write', fields: {} }],
      });

      recordId = 'rec-after-write';
      await fetchBitableRecords(httpService as never, {
        appToken,
        tableId,
        tableName,
        forceRefresh: true,
      });
      await rm(cachePath, { force: true });

      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-after-write', fields: {} }],
      });
    } finally {
      invalidateBitableRecordCache({ appToken, tableId });
      await rm(cachePath, { force: true });
    }
  });

  it('clears only matching latest snapshot index entries during invalidation', async () => {
    const target = {
      appToken: 'app-latest-snapshot-invalidate-target',
      tableId: 'tbl-latest-snapshot-invalidate-target',
      tableName: 'latest-snapshot-invalidate-target',
    };
    const preserved = {
      appToken: 'app-latest-snapshot-invalidate-preserved',
      tableId: 'tbl-latest-snapshot-invalidate-preserved',
      tableName: 'latest-snapshot-invalidate-preserved',
    };
    const targetPath = getProjectedCachePath(
      `${target.appToken}:${target.tableId}:`,
    );
    const preservedPath = getProjectedCachePath(
      `${preserved.appToken}:${preserved.tableId}:`,
    );
    const httpService = createRecordSearchHttpService();

    try {
      for (const source of [target, preserved]) {
        await fetchBitableRecords(httpService as never, {
          ...source,
          forceRefresh: true,
        });
        await readLatestPersistedBitableRecordSnapshot({
          tableId: source.tableId,
          tableName: source.tableName,
        });
      }
      await Promise.all([
        rm(targetPath, { force: true }),
        rm(preservedPath, { force: true }),
      ]);

      invalidateBitableRecordCache({
        appToken: target.appToken,
        tableId: target.tableId,
        deletePersisted: true,
      });

      await expect(
        readLatestPersistedBitableRecordSnapshot({
          tableId: target.tableId,
          tableName: target.tableName,
        }),
      ).resolves.toBeNull();
      await expect(
        readLatestPersistedBitableRecordSnapshot({
          tableId: preserved.tableId,
          tableName: preserved.tableName,
        }),
      ).resolves.toMatchObject({ records: [] });
    } finally {
      for (const source of [target, preserved]) {
        invalidateBitableRecordCache({
          appToken: source.appToken,
          tableId: source.tableId,
        });
      }
      await Promise.all([
        rm(targetPath, { force: true }),
        rm(preservedPath, { force: true }),
      ]);
    }
  });

  it('keeps the last good latest snapshot when a persisted write fails', async () => {
    const appToken = 'app-latest-snapshot-write-failure';
    const tableId = 'tbl-latest-snapshot-write-failure';
    const tableName = 'latest-snapshot-write-failure';
    let recordId = 'rec-last-good';
    const httpService = createRecordSearchHttpService(() => [
      { record_id: recordId, fields: {} },
    ]);
    const options = { tableId, tableName };

    try {
      await fetchBitableRecords(httpService as never, {
        appToken,
        tableId,
        tableName,
        forceRefresh: true,
      });
      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-last-good', fields: {} }],
      });

      await rm(localCacheDir, { force: true, recursive: true });
      await writeFile(localCacheDir, 'block-cache-directory', 'utf8');
      recordId = 'rec-not-persisted';
      await fetchBitableRecords(httpService as never, {
        appToken,
        tableId,
        tableName,
        forceRefresh: true,
      });

      await expect(
        readLatestPersistedBitableRecordSnapshot(options),
      ).resolves.toMatchObject({
        records: [{ record_id: 'rec-last-good', fields: {} }],
      });
    } finally {
      invalidateBitableRecordCache();
      await rm(localCacheDir, { force: true, recursive: true });
    }
  });

  it('deletes every persisted variant for only the targeted app and table', async () => {
    const targetApp = 'app-delete-variants-target';
    const otherApp = 'app-delete-variants-other';
    const targetTable = 'tbl-delete-variants-target';
    const otherTable = 'tbl-delete-variants-other';
    const targetView = 'vew-delete-variants-target';
    const targetVariants = [
      {
        cacheKey: `${targetApp}:${targetTable}:`,
        options: {},
      },
      {
        cacheKey: `${targetApp}:${targetTable}:${targetView}`,
        options: { viewId: targetView },
      },
      {
        cacheKey: `${targetApp}:${targetTable}::员工`,
        options: { fieldNames: ['员工'] },
      },
      {
        cacheKey: `${targetApp}:${targetTable}:${targetView}:员工`,
        options: { viewId: targetView, fieldNames: ['员工'] },
      },
    ] as const;
    const preservedVariants = [
      {
        appToken: otherApp,
        tableId: targetTable,
        cacheKey: `${otherApp}:${targetTable}:`,
      },
      {
        appToken: targetApp,
        tableId: otherTable,
        cacheKey: `${targetApp}:${otherTable}:`,
      },
    ] as const;
    const allCacheKeys = [
      ...targetVariants.map(({ cacheKey: currentCacheKey }) => currentCacheKey),
      ...preservedVariants.map(
        ({ cacheKey: currentCacheKey }) => currentCacheKey,
      ),
    ];
    const unrelatedLargeCachePath = join(
      localCacheDir,
      'unrelated-large-cache.json',
    );
    const unrelatedLargeCacheMarker = 'unrelated-large-cache-marker';
    const httpService = createRecordSearchHttpService();
    const fs = require('node:fs') as typeof import('node:fs');
    const readdirSyncSpy = jest.spyOn(fs, 'readdirSync');
    const readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
    const jsonParseSpy = jest.spyOn(JSON, 'parse');

    try {
      await Promise.all(
        allCacheKeys.map((currentCacheKey) =>
          rm(getProjectedCachePath(currentCacheKey), { force: true }),
        ),
      );
      for (const variant of targetVariants) {
        await fetchBitableRecords(httpService as never, {
          appToken: targetApp,
          tableId: targetTable,
          tableName: 'delete-variants-target',
          ...variant.options,
          forceRefresh: true,
        });
      }
      for (const variant of preservedVariants) {
        await fetchBitableRecords(httpService as never, {
          appToken: variant.appToken,
          tableId: variant.tableId,
          tableName: 'delete-variants-preserved',
          forceRefresh: true,
        });
      }
      await writeFile(
        unrelatedLargeCachePath,
        JSON.stringify({
          marker: unrelatedLargeCacheMarker,
          padding: 'x'.repeat(2 * 1024 * 1024),
        }),
        'utf8',
      );
      readdirSyncSpy.mockClear();
      readFileSyncSpy.mockClear();
      jsonParseSpy.mockClear();

      invalidateBitableRecordCache({
        appToken: targetApp,
        tableId: targetTable,
        deletePersisted: true,
      });

      expect(readdirSyncSpy).not.toHaveBeenCalled();
      expect(readFileSyncSpy).not.toHaveBeenCalled();
      expect(
        jsonParseSpy.mock.calls.some(([raw]) =>
          String(raw).includes(unrelatedLargeCacheMarker),
        ),
      ).toBe(false);

      for (const { cacheKey: currentCacheKey } of targetVariants) {
        await expectPathToDisappear(getProjectedCachePath(currentCacheKey));
      }
      for (const { cacheKey: currentCacheKey } of preservedVariants) {
        await expect(
          access(getProjectedCachePath(currentCacheKey)),
        ).resolves.toBeUndefined();
      }
      await expect(access(unrelatedLargeCachePath)).resolves.toBeUndefined();
    } finally {
      readdirSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
      jsonParseSpy.mockRestore();
      invalidateBitableRecordCache({
        appToken: targetApp,
        tableId: targetTable,
        deletePersisted: true,
      });
      for (const variant of preservedVariants) {
        invalidateBitableRecordCache({
          appToken: variant.appToken,
          tableId: variant.tableId,
          deletePersisted: true,
        });
      }
      await Promise.all([
        ...allCacheKeys.map((currentCacheKey) =>
          rm(getProjectedCachePath(currentCacheKey), { force: true }),
        ),
        rm(unrelatedLargeCachePath, { force: true }),
      ]);
    }
  });

  it('keeps a legacy persisted variant readable until targeted deletion safely invalidates it', async () => {
    const appToken = 'app-delete-legacy-variant';
    const tableId = 'tbl-delete-legacy-variant';
    const tableName = 'delete-legacy-variant';
    const viewId = 'vew-delete-legacy-variant';
    const restartViewId = 'vew-delete-legacy-variant-after-restart';
    const cachePath = getProjectedCachePath(`${appToken}:${tableId}:${viewId}`);
    const restartCachePath = getProjectedCachePath(
      `${appToken}:${tableId}:${restartViewId}`,
    );
    const now = Date.now();
    const httpService = createRecordSearchHttpService(() => [
      { record_id: 'rec-fresh-after-invalidation', fields: {} },
    ]);
    const options = {
      appToken,
      tableId,
      tableName,
      viewId,
      cacheTtlMs: 60_000,
    };

    try {
      await writeFile(
        cachePath,
        JSON.stringify({
          version: 1,
          tableName,
          tableId,
          viewId,
          fetchedAt: now,
          expiresAt: now + 60_000,
          recordCount: 1,
          records: [{ record_id: 'rec-legacy-persisted', fields: {} }],
        }),
        'utf8',
      );
      await writeFile(
        restartCachePath,
        JSON.stringify({
          version: 1,
          tableName,
          tableId,
          viewId: restartViewId,
          fetchedAt: now,
          expiresAt: now + 60_000,
          recordCount: 1,
          records: [{ record_id: 'rec-legacy-after-restart', fields: {} }],
        }),
        'utf8',
      );

      await expect(
        fetchBitableRecords(httpService as never, options),
      ).resolves.toEqual([{ record_id: 'rec-legacy-persisted', fields: {} }]);
      expect(httpService.axiosRef.post).not.toHaveBeenCalled();

      invalidateBitableRecordCache({
        appToken,
        tableId,
        deletePersisted: true,
      });

      await expect(
        fetchBitableRecords(httpService as never, options),
      ).resolves.toEqual([
        { record_id: 'rec-fresh-after-invalidation', fields: {} },
      ]);
      expect(
        httpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records/search'),
        ),
      ).toHaveLength(1);
      expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({
        invalidationToken: expect.any(String),
        records: [{ record_id: 'rec-fresh-after-invalidation', fields: {} }],
      });

      let reloadedBitableDirectRead!: typeof bitableDirectRead;
      jest.isolateModules(() => {
        reloadedBitableDirectRead =
          require('../../server/common/feishu/bitable-direct-read') as typeof bitableDirectRead;
      });
      const restartedHttpService = createRecordSearchHttpService(() => [
        { record_id: 'rec-fresh-after-restart', fields: {} },
      ]);
      await expect(
        reloadedBitableDirectRead.fetchBitableRecords(
          restartedHttpService as never,
          { ...options, viewId: restartViewId },
        ),
      ).resolves.toEqual([
        { record_id: 'rec-fresh-after-restart', fields: {} },
      ]);
      expect(
        restartedHttpService.axiosRef.post.mock.calls.filter(([url]) =>
          String(url).endsWith('/records/search'),
        ),
      ).toHaveLength(1);
    } finally {
      invalidateBitableRecordCache({
        appToken,
        tableId,
        deletePersisted: true,
      });
      await Promise.all([
        rm(cachePath, { force: true }),
        rm(restartCachePath, { force: true }),
      ]);
    }
  });

  it('runs cache warmup and periodic refresh without overlapping jobs', async () => {
    jest.useFakeTimers();
    const createBackgroundRefresh = (
      bitableDirectRead as unknown as {
        createBitableBackgroundRefresh?: (options: {
          intervalMs: number;
          name: string;
          refresh: () => Promise<void>;
          warm: () => Promise<void>;
        }) => { start: () => void; stop: () => void };
      }
    ).createBitableBackgroundRefresh;
    expect(createBackgroundRefresh).toBeDefined();

    const warm = jest.fn().mockResolvedValue(undefined);
    let finishRefresh = () => undefined;
    const refresh = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const controller = createBackgroundRefresh!({
      intervalMs: 1000,
      name: 'test-background-refresh',
      refresh,
      warm,
    });

    try {
      controller.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(warm).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(refresh).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1000);
      expect(refresh).toHaveBeenCalledTimes(1);

      finishRefresh();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      controller?.stop();
      jest.useRealTimers();
    }
  });
});

describe('extractDateValue', () => {
  it('reuses one Shanghai date formatter for batch record conversion', () => {
    const source = readFileSync(
      join(process.cwd(), 'server/common/feishu/bitable-direct-read.ts'),
      'utf8',
    );
    const formatterStart = source.indexOf(
      'const SHANGHAI_LOCAL_DATE_FORMATTER',
    );
    const functionStart = source.indexOf('function formatLocalDate');
    const functionEnd = source.indexOf(
      'function normalizeDateParts',
      functionStart,
    );
    const formatterFunction = source.slice(functionStart, functionEnd);

    expect(formatterStart).toBeGreaterThan(-1);
    expect(formatterFunction).toContain(
      'SHANGHAI_LOCAL_DATE_FORMATTER.formatToParts(date)',
    );
    expect(formatterFunction).not.toContain('new Intl.DateTimeFormat');
  });

  it('formats numeric Feishu timestamps in Asia/Shanghai when the host runs in UTC', () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'UTC';

    try {
      expect(extractDateValue(1786896000000)).toBe('2026-08-17');
      expect(extractDateValue('1786896000')).toBe('2026-08-17');
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });
});

describe('extractDateTimeIso', () => {
  it('normalizes numeric Feishu epoch seconds and milliseconds consistently', () => {
    const epochSeconds = 1_786_896_000;
    const epochMilliseconds = epochSeconds * 1000;
    const expected = new Date(epochMilliseconds).toISOString();

    expect(extractDateTimeIso(epochSeconds)).toBe(expected);
    expect(extractDateTimeIso(epochMilliseconds)).toBe(expected);
    expect(extractDateTimeIso(String(epochSeconds))).toBe(expected);
  });
});
