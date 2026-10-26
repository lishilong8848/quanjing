jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'test-app',
      app_secret: 'test-secret',
    })),
    readEnv: jest.fn(),
  }),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  invalidateBitableRecordCache: jest.fn(),
}));

import { invalidateBitableRecordCache } from '../../server/common/feishu/bitable-direct-read';
import {
  InventoryWorkflowGateway,
  InventoryWorkflowRecordDefinitelyNotDeletedError,
  InventoryWorkflowRecordDeleteUncertainError,
  InventoryWorkflowRecordDefinitelyNotWrittenError,
  InventoryWorkflowRecordNotFoundError,
  InventoryWorkflowRecordWriteUncertainError,
} from '../../server/modules/inventory-management/inventory-workflow.gateway';

type NumberFieldGateway = InventoryWorkflowGateway & {
  ensureNumberField(
    appToken: string,
    tableId: string,
    fieldName: string,
    tableName: string,
  ): Promise<void>;
};

function asNumberFieldGateway(
  gateway: InventoryWorkflowGateway,
): NumberFieldGateway {
  const candidate = gateway as NumberFieldGateway;
  expect(typeof candidate.ensureNumberField).toBe('function');
  return candidate;
}

describe('InventoryWorkflowGateway', () => {
  const post = jest.fn();
  const get = jest.fn();
  const put = jest.fn();
  const del = jest.fn();
  let gateway: InventoryWorkflowGateway;

  beforeEach(() => {
    jest.clearAllMocks();
    post.mockReset();
    get.mockReset();
    put.mockReset();
    del.mockReset();
    gateway = new InventoryWorkflowGateway({
      axiosRef: { post, get, put, delete: del },
    } as never);
    post.mockResolvedValueOnce({
      data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
    });
  });

  it('paginates Base records and forwards a server-side filter', async () => {
    get
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec-1', fields: { 状态: '待处理' } }],
            has_more: true,
            page_token: 'page-2',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec-2', fields: { 状态: '待处理' } }],
            has_more: false,
          },
        },
      });

    const records = await gateway.listRecords({
      appToken: 'app-token',
      tableId: 'tbl-source',
      tableName: '来源表',
      filter: 'CurrentValue.[状态]="待处理"',
    });

    expect(records.map((item) => item.record_id)).toEqual(['rec-1', 'rec-2']);
    expect(get).toHaveBeenNthCalledWith(
      1,
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/tbl-source/records',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        params: expect.objectContaining({
          page_size: 500,
          filter: 'CurrentValue.[状态]="待处理"',
        }),
      }),
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({ page_token: 'page-2' }),
      }),
    );
  });

  it('searches Base records with a structured filter and paginates results', async () => {
    post
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'location-1', fields: { 楼栋: 'H楼' } }],
            has_more: true,
            page_token: 'page-2',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'location-2', fields: { 楼栋: 'H楼' } }],
            has_more: false,
          },
        },
      });
    const filter = {
      conjunction: 'and' as const,
      conditions: [{ field_name: '楼栋', operator: 'is', value: ['H楼'] }],
    };

    const records = await gateway.searchRecords({
      appToken: 'app-token',
      tableId: 'tbl-locations',
      tableName: '配置库房货架名称',
      filter,
    });

    expect(records.map((item) => item.record_id)).toEqual([
      'location-1',
      'location-2',
    ]);
    expect(post).toHaveBeenNthCalledWith(
      2,
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/tbl-locations/records/search',
      { filter },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        params: { page_size: 500, page_token: undefined },
      }),
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      { filter },
      expect.objectContaining({
        params: { page_size: 500, page_token: 'page-2' },
      }),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('uses structured search for an outbound list query when the legacy GET is unavailable', async () => {
    get.mockRejectedValue(new Error('legacy GET unavailable'));
    post.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [
            { record_id: 'outbound-1', fields: { 出库创建标识: 'mutation-1' } },
          ],
          has_more: false,
        },
      },
    });
    const searchFilter = {
      conjunction: 'and' as const,
      conditions: [
        { field_name: '出库创建标识', operator: 'is', value: ['mutation-1'] },
      ],
    };

    const records = await gateway.listRecords({
      appToken: 'app-token',
      tableId: 'tbl-outbound',
      tableName: '出库填写',
      searchFilter,
    } as never);

    expect(records.map((record) => record.record_id)).toEqual(['outbound-1']);
    expect(post).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/tbl-outbound/records/search'),
      { filter: searchFilter },
      expect.any(Object),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects malformed search pages without retrying or silently succeeding', async () => {
    post.mockResolvedValueOnce({ data: { code: 0, data: { items: [] } } });

    await expect(
      gateway.searchRecords({
        appToken: 'app-token',
        tableId: 'tbl-locations',
        tableName: '配置库房货架名称',
      }),
    ).rejects.toThrow('读取配置库房货架名称失败');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an empty payload', {}],
    ['a null success code', { code: null }],
    ['a false success code', { code: false }],
    ['a success code without data', { code: 0 }],
    ['a success code without items', { code: 0, data: { has_more: false } }],
    ['a success code without has_more', { code: 0, data: { items: [] } }],
    [
      'a success code with non-array items',
      { code: 0, data: { items: {}, has_more: false } },
    ],
    [
      'a success code with non-boolean has_more',
      { code: 0, data: { items: [], has_more: 'false' } },
    ],
    [
      'a paginated success code without page_token',
      { code: 0, data: { items: [], has_more: true } },
    ],
  ])(
    'rejects a malformed HTTP 200 record page with %s',
    async (_label, payload) => {
      get.mockResolvedValueOnce({ data: payload });

      await expect(
        gateway.listRecords({
          appToken: 'app-token',
          tableId: 'tbl-source',
          tableName: '来源表',
          filter: 'CurrentValue.[出库创建标识]="outbound-1"',
        }),
      ).rejects.toThrow('读取来源表失败');
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts Feishu successful empty pages that omit items', async () => {
    get.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          total: 0,
          has_more: false,
        },
      },
    });

    await expect(
      gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-source',
        tableName: '采购提交',
        filter: 'CurrentValue.[采购编码]="CG260724-201"',
      }),
    ).resolves.toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('retries a transient data-not-ready response for a filtered record query', async () => {
    jest.useFakeTimers();
    const transientFilterError = {
      response: {
        status: 400,
        data: { code: 1254607, msg: 'Data not ready' },
      },
    };
    try {
      get.mockRejectedValueOnce(transientFilterError).mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec-ready', fields: {} }],
            has_more: false,
          },
        },
      });

      const operation = gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-source',
        tableName: '来源表',
        filter: 'CurrentValue.[入库来源]="手工:test"',
      });
      const assertion = expect(operation).resolves.toEqual([
        { record_id: 'rec-ready', fields: {} },
      ]);
      await jest.advanceTimersByTimeAsync(250);

      await assertion;
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a Feishu HTTP 400 rate limit on a structured record search', async () => {
    jest.useFakeTimers();
    const rateLimit = {
      response: {
        status: 400,
        data: { code: 99991400, msg: 'request trigger frequency limit' },
      },
    };
    try {
      post.mockRejectedValueOnce(rateLimit).mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      });
      const operation = gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-outbound',
        tableName: '出库填写',
        searchFilter: {
          conjunction: 'and',
          conditions: [
            { field_name: '出库创建标识', operator: 'is', value: ['same-id'] },
          ],
        },
      });
      const assertion = expect(operation).resolves.toEqual([]);
      await jest.advanceTimersByTimeAsync(250);
      await assertion;
      expect(recordPostCalls(post)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a TooManyRequest response before treating a structured search as failed', async () => {
    jest.useFakeTimers();
    try {
      post
        .mockResolvedValueOnce({ data: { code: 1254290, msg: 'TooManyRequest' } })
        .mockResolvedValueOnce({
          data: { code: 0, data: { items: [], has_more: false } },
        });
      const operation = gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-outbound',
        tableName: '出库填写',
        searchFilter: {
          conjunction: 'and',
          conditions: [
            { field_name: '出库创建标识', operator: 'is', value: ['same-id'] },
          ],
        },
      });
      const assertion = expect(operation).resolves.toEqual([]);
      await jest.advanceTimersByTimeAsync(250);
      await assertion;
      expect(recordPostCalls(post)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a transient data-not-ready response for an unfiltered record query', async () => {
    jest.useFakeTimers();
    const transientReadError = {
      response: {
        status: 400,
        data: { code: 1254607, msg: 'Data not ready' },
      },
    };
    try {
      get.mockRejectedValueOnce(transientReadError).mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec-ready', fields: {} }],
            has_more: false,
          },
        },
      });

      const operation = gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-source',
        tableName: '来源表',
      });
      const assertion = expect(operation).resolves.toEqual([
        { record_id: 'rec-ready', fields: {} },
      ]);
      await jest.advanceTimersByTimeAsync(250);

      await assertion;
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a timed-out record list GET within the read budget', async () => {
    jest.useFakeTimers();
    const timeout = Object.assign(new Error('timeout of 10000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    try {
      get.mockRejectedValueOnce(timeout).mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      });

      const operation = gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-source',
        tableName: '来源表',
      });
      const assertion = expect(operation).resolves.toEqual([]);
      await jest.advanceTimersByTimeAsync(250);

      await assertion;
      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls[0][1].timeout).toBe(10_000);
      expect(get.mock.calls[1][1].timeout).toBeLessThanOrEqual(10_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry a permanent business error for a filtered record query', async () => {
    const permanentFilterError = {
      response: {
        status: 400,
        data: { code: 1254018, msg: 'InvalidFilter' },
      },
    };
    get.mockRejectedValueOnce(permanentFilterError);

    await expect(
      gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-source',
        tableName: '来源表',
        filter: 'CurrentValue.[入库来源]="手工:test"',
      }),
    ).rejects.toBe(permanentFilterError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not retry FieldNameNotFound outside a field-propagation probe', async () => {
    const missingFieldError = {
      response: {
        status: 400,
        data: { code: 1254045, msg: 'FieldNameNotFound' },
      },
    };
    get.mockRejectedValueOnce(missingFieldError);

    await expect(
      gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-source',
        tableName: '来源表',
        filter: 'CurrentValue.[不存在字段]="test"',
      }),
    ).rejects.toBe(missingFieldError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('caps the last record query attempt to the remaining retry window', async () => {
    jest.useFakeTimers();
    const transientReadError = {
      response: {
        status: 400,
        data: { code: 1254607, msg: 'Data not ready' },
      },
    };
    const requestTimeouts: number[] = [];
    try {
      get.mockImplementation(
        (_url: string, options: { timeout?: number }): Promise<never> => {
          const requestTimeout = Number(options.timeout);
          requestTimeouts.push(requestTimeout);
          return new Promise((_, reject) => {
            setTimeout(() => reject(transientReadError), requestTimeout);
          });
        },
      );

      const operation = gateway.listRecords({
        appToken: 'app-token',
        tableId: 'tbl-source',
        tableName: '来源表',
      });
      void operation.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(20_750);

      expect(requestTimeouts).toEqual([10_000, 10_000, 9_250]);
      await jest.advanceTimersByTimeAsync(9_250);
      await expect(operation).rejects.toBe(transientReadError);
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates, updates and deletes Base records with tenant authorization', async () => {
    post.mockResolvedValueOnce({
      data: { code: 0, data: { record: { record_id: 'rec-created' } } },
    });
    put.mockResolvedValueOnce({ data: { code: 0, data: {} } });
    del.mockResolvedValueOnce({ data: { code: 0, data: {} } });

    const recordId = await gateway.createRecord(
      'app-token',
      'tbl-target',
      { 名称: '测试', 数量: 1 },
      '目标表',
    );
    await gateway.updateRecord(
      'app-token',
      'tbl-target',
      recordId,
      { 已处理: true },
      '目标表',
    );
    await gateway.deleteRecord('app-token', 'tbl-target', recordId, '目标表');

    expect(recordId).toBe('rec-created');
    expect(post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/tbl-target/records',
      { fields: { 名称: '测试', 数量: 1 } },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/rec-created'),
      { fields: { 已处理: true } },
      expect.any(Object),
    );
    expect(del).toHaveBeenCalledWith(
      expect.stringContaining('/records/rec-created'),
      expect.any(Object),
    );
    expect(invalidateBitableRecordCache).toHaveBeenCalledTimes(3);
    expect(invalidateBitableRecordCache).toHaveBeenNthCalledWith(1, {
      appToken: 'app-token',
      tableId: 'tbl-target',
      deletePersisted: true,
    });
    expect(invalidateBitableRecordCache).toHaveBeenNthCalledWith(2, {
      appToken: 'app-token',
      tableId: 'tbl-target',
      deletePersisted: true,
    });
    expect(invalidateBitableRecordCache).toHaveBeenNthCalledWith(3, {
      appToken: 'app-token',
      tableId: 'tbl-target',
      deletePersisted: true,
    });
  });

  it.each([
    ['no response', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })],
    ['HTTP 408', { response: { status: 408 } }],
    ['HTTP 418', { response: { status: 418 } }],
    ['HTTP 425', { response: { status: 425 } }],
    ['HTTP 429', { response: { status: 429 } }],
    ['HTTP 451', { response: { status: 451 } }],
    ['HTTP 500', { response: { status: 500 } }],
    ['HTTP 503', { response: { status: 503 } }],
  ])(
    'classifies an outbound-record POST with %s as uncertain without retrying',
    async (_label, failure) => {
      post.mockRejectedValueOnce(failure);

      await expect(
        gateway.createRecord(
          'app-token',
          'tbl-target',
          { 名称: '测试' },
          '目标表',
        ),
      ).rejects.toBeInstanceOf(InventoryWorkflowRecordWriteUncertainError);

      expect(recordPostCalls(post)).toHaveLength(1);
    },
  );

  it('classifies a successful POST response without record_id as uncertain', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        msg: 'success',
        data: { ignoredBusinessField: 'must-not-leak' },
      },
    });

    let failure: unknown;
    try {
      await gateway.createRecord(
        'app-token',
        'tbl-target',
        { 名称: '测试' },
        '目标表',
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InventoryWorkflowRecordWriteUncertainError);
    const causeMessage = (failure as Error & { cause?: Error }).cause?.message;
    expect(causeMessage).toContain('http=200');
    expect(causeMessage).toContain('code=0');
    expect(causeMessage).toContain('dataKeys=ignoredBusinessField');
    expect(causeMessage).not.toContain('must-not-leak');
    expect(recordPostCalls(post)).toHaveLength(1);
  });

  it('classifies an HTTP 2xx business error without a valid record_id as uncertain', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: { code: 1255001, msg: 'InternalError', data: {} },
    });

    let failure: unknown;
    try {
      await gateway.createRecord(
        'app-token',
        'tbl-target',
        { 名称: '测试' },
        '目标表',
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InventoryWorkflowRecordWriteUncertainError);
    expect((failure as Error & { cause?: Error }).cause?.message).toContain(
      'InternalError',
    );
    expect(recordPostCalls(post)).toHaveLength(1);
  });

  it('classifies a deterministic single-select conversion rejection as definitely not written', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: { code: 1254062, msg: 'SingleSelectFieldConvFail', data: {} },
    });

    await expect(
      gateway.createRecord(
        'app-token',
        'tbl-target',
        { 存放位置: 'H-2F-226储存间01-0F' },
        '库存台账',
      ),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordDefinitelyNotWrittenError);
    expect(recordPostCalls(post)).toHaveLength(1);
  });

  it('classifies an explicit Feishu rate-limit rejection as not written without retrying the POST', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: { code: 99991400, msg: 'request trigger frequency limit' },
    });

    await expect(
      gateway.createRecord(
        'app-token',
        'tbl-target',
        { 名称: '测试' },
        '目标表',
      ),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordDefinitelyNotWrittenError);
    expect(recordPostCalls(post)).toHaveLength(1);
  });

  it('classifies a TooManyRequest record POST as definitely not written', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: { code: 1254290, msg: 'TooManyRequest' },
    });

    await expect(
      gateway.createRecord('app-token', 'tbl-target', { 名称: '测试' }, '目标表'),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordDefinitelyNotWrittenError);
    expect(recordPostCalls(post)).toHaveLength(1);
  });

  it.each([
    ['missing code', { data: { record: { record_id: 'rec-written' } } }],
    [
      'null code',
      { code: null, data: { record: { record_id: 'rec-written' } } },
    ],
    [
      'boolean code',
      { code: false, data: { record: { record_id: 'rec-written' } } },
    ],
    [
      'nonzero code',
      { code: 123, data: { record: { record_id: 'rec-written' } } },
    ],
  ])(
    'classifies a 2xx record response with %s as uncertain',
    async (_label, payload) => {
      post.mockResolvedValueOnce({ status: 200, data: payload });

      await expect(
        gateway.createRecord(
          'app-token',
          'tbl-target',
          { 鍚嶇О: '娴嬭瘯' },
          'target-table',
        ),
      ).rejects.toBeInstanceOf(InventoryWorkflowRecordWriteUncertainError);
      expect(recordPostCalls(post)).toHaveLength(1);
    },
  );

  it.each([400, 401, 403, 404, 409, 422])(
    'classifies an explicit HTTP %s rejection as definitely not written',
    async (status) => {
      post.mockRejectedValueOnce({ response: { status } });

      await expect(
        gateway.createRecord(
          'app-token',
          'tbl-target',
          { 名称: '测试' },
          '目标表',
        ),
      ).rejects.toBeInstanceOf(
        InventoryWorkflowRecordDefinitelyNotWrittenError,
      );
      expect(recordPostCalls(post)).toHaveLength(1);
    },
  );

  it('classifies token acquisition failure as definitely not written and never starts the record POST', async () => {
    post.mockReset();
    post.mockRejectedValueOnce(
      Object.assign(new Error('token offline'), {
        code: 'ETIMEDOUT',
      }),
    );

    await expect(
      gateway.createRecord(
        'app-token',
        'tbl-target',
        { 名称: '测试' },
        '目标表',
      ),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordDefinitelyNotWrittenError);
    expect(recordPostCalls(post)).toHaveLength(0);
  });

  it('reads one record through the batch-get endpoint', async () => {
    const record = { record_id: 'rec-target', fields: { 名称: '测试' } };
    post.mockResolvedValueOnce({
      data: { code: 0, data: { records: [record] } },
    });

    await expect(
      gateway.getRecord('app-token', 'tbl-target', 'rec-target', '目标表'),
    ).resolves.toEqual(record);
    expect(recordPostCalls(post)).toEqual([
      [
        'https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/tbl-target/records/batch_get',
        { record_ids: ['rec-target'] },
        expect.objectContaining({
          headers: { Authorization: 'Bearer tenant-token' },
          timeout: 10_000,
        }),
      ],
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it('reads only requested IDs in sequential batches of 100, restores order and never lists the table', async () => {
    const ids = Array.from({ length: 400 }, (_, index) => `rec-${index}`);
    post.mockImplementation(async (_url, body) => ({ data: { code: 0, data: { records: [...body.record_ids].reverse().map((id: string) => ({ record_id: id, fields: {} })) } } }));
    const records = await gateway.getRecords('app-token', 'tbl-target', ids, '库存台账');
    expect(records.map(record => record.record_id)).toEqual(ids);
    expect(recordPostCalls(post).map(call => (call[1] as { record_ids: string[] }).record_ids.length)).toEqual([100, 100, 100, 100]);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { records: [], absent_record_ids: ['rec-target'] },
    { records: [], forbidden_record_ids: ['rec-target'] },
    { records: [{ record_id: 'rec-other', fields: {} }] },
    { records: [{ record_id: 'rec-target', fields: {} }, { record_id: 'rec-target', fields: {} }] },
    {},
  ])('rejects incomplete or unauthorized batch responses: %p', async (data) => {
    post.mockResolvedValueOnce({ data: { code: 0, data } });
    await expect(gateway.getRecords('app-token', 'tbl-target', ['rec-target'], '库存台账')).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('maps an absent batch-get record to a typed record-not-found error', async () => {
    post.mockResolvedValueOnce({
      data: {
        code: 0,
        data: { records: [], absent_record_ids: ['rec-missing'] },
      },
    });

    await expect(
      gateway.getRecord('app-token', 'tbl-target', 'rec-missing', '目标表'),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordNotFoundError);
    expect(recordPostCalls(post)).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('retries a timed-out batch-get read without retrying a write', async () => {
    jest.useFakeTimers();
    const timeout = Object.assign(new Error('timeout of 10000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const record = { record_id: 'rec-target', fields: { 名称: '测试' } };
    try {
      post.mockRejectedValueOnce(timeout).mockResolvedValueOnce({
        data: { code: 0, data: { records: [record] } },
      });

      const operation = gateway.getRecord(
        'app-token',
        'tbl-target',
        'rec-target',
        '目标表',
      );
      const assertion = expect(operation).resolves.toEqual(record);
      await jest.advanceTimersByTimeAsync(250);

      await assertion;
      const reads = recordPostCalls(post);
      expect(reads).toHaveLength(2);
      expect((reads[0]?.[2] as { timeout?: number }).timeout).toBe(10_000);
      expect(
        (reads[1]?.[2] as { timeout?: number }).timeout,
      ).toBeLessThanOrEqual(10_000);
      expect(get).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a TooManyRequest batch-get read without repeating a write', async () => {
    jest.useFakeTimers();
    const record = { record_id: 'rec-target', fields: { 名称: '测试' } };
    try {
      post
        .mockResolvedValueOnce({ data: { code: 1254290, msg: 'TooManyRequest' } })
        .mockResolvedValueOnce({
          data: { code: 0, data: { records: [record] } },
        });
      const operation = gateway.getRecord(
        'app-token',
        'tbl-target',
        'rec-target',
        '目标表',
      );
      const assertion = expect(operation).resolves.toEqual(record);
      await jest.advanceTimersByTimeAsync(250);
      await assertion;
      expect(recordPostCalls(post)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry a batch-get read for an HTTP business failure', async () => {
    const businessFailure = { response: { status: 503 } };
    post.mockRejectedValueOnce(businessFailure);

    await expect(
      gateway.getRecord('app-token', 'tbl-target', 'rec-target', '目标表'),
    ).rejects.toBe(businessFailure);
    expect(recordPostCalls(post)).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('bounds batch-get retries by one 30-second read budget', async () => {
    jest.useFakeTimers();
    const timeout = Object.assign(new Error('timeout'), {
      code: 'ETIMEDOUT',
    });
    const requestTimeouts: number[] = [];
    try {
      post.mockImplementation(
        (
          url: string,
          _body: unknown,
          options: { timeout?: number },
        ): Promise<unknown> => {
          if (url.includes('/tenant_access_token/')) {
            return Promise.resolve({
              data: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200,
              },
            });
          }
          const requestTimeout = Number(options?.timeout);
          requestTimeouts.push(requestTimeout);
          return new Promise((_, reject) => {
            setTimeout(() => reject(timeout), requestTimeout);
          });
        },
      );

      const operation = gateway.getRecord(
        'app-token',
        'tbl-target',
        'rec-target',
        '目标表',
      );
      void operation.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(operation).rejects.toBe(timeout);
      expect(requestTimeouts).toEqual([10_000, 10_000, 9_250]);
      expect(recordPostCalls(post)).toHaveLength(3);
      expect(get).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns undefined from an optional batch-get read when the record is absent', async () => {
    post.mockResolvedValueOnce({
      data: {
        code: 0,
        data: { records: [], absent_record_ids: ['rec-missing'] },
      },
    });

    await expect(
      gateway.tryGetRecord('app-token', 'tbl-target', 'rec-missing', '目标表'),
    ).resolves.toBeUndefined();
  });

  it('explicitly invalidates a Base records cache after an authoritative absent read', () => {
    gateway.invalidateRecordsCache('app-token', 'tbl-target');

    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'app-token',
      tableId: 'tbl-target',
      deletePersisted: true,
    });
  });

  it('deletes a record and confirms it is absent', async () => {
    del.mockResolvedValueOnce({ data: { code: 0, data: {} } });
    post.mockResolvedValueOnce({
      data: {
        code: 0,
        data: { records: [], absent_record_ids: ['rec-delete'] },
      },
    });

    await expect(
      gateway.deleteRecordAndConfirmAbsent(
        'app-token',
        'tbl-target',
        'rec-delete',
        '目标表',
      ),
    ).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
    expect(recordPostCalls(post)).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('treats an already absent record as an idempotent delete success', async () => {
    del.mockRejectedValueOnce({ response: { status: 404 } });

    await expect(
      gateway.deleteRecordAndConfirmAbsent(
        'app-token',
        'tbl-target',
        'rec-missing',
        '目标表',
      ),
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('treats a Feishu record-not-found delete payload as idempotent success', async () => {
    del.mockResolvedValueOnce({
      status: 200,
      data: { code: 1254043, msg: 'RecordIdNotFound' },
    });

    await expect(
      gateway.deleteRecordAndConfirmAbsent(
        'app-token',
        'tbl-target',
        'rec-missing',
        '目标表',
      ),
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 409, 422])(
    'classifies an explicit delete HTTP %s rejection as definitely not deleted',
    async (status) => {
      del.mockRejectedValueOnce({ response: { status } });

      await expect(
        gateway.deleteRecordAndConfirmAbsent(
          'app-token',
          'tbl-target',
          'rec-delete',
          '目标表',
        ),
      ).rejects.toBeInstanceOf(
        InventoryWorkflowRecordDefinitelyNotDeletedError,
      );
    },
  );

  it.each([
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    { response: { status: 408 } },
    { response: { status: 429 } },
    { response: { status: 500 } },
    { response: { status: 503 } },
  ])('classifies an ambiguous delete failure as uncertain', async (failure) => {
    del.mockRejectedValueOnce(failure);

    await expect(
      gateway.deleteRecordAndConfirmAbsent(
        'app-token',
        'tbl-target',
        'rec-delete',
        '目标表',
      ),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordDeleteUncertainError);
  });

  it('classifies a successful delete with an existing readback as definitely not deleted', async () => {
    del.mockResolvedValueOnce({ data: { code: 0, data: {} } });
    post.mockResolvedValueOnce({
      data: {
        code: 0,
        data: { records: [{ record_id: 'rec-delete', fields: {} }] },
      },
    });

    await expect(
      gateway.deleteRecordAndConfirmAbsent(
        'app-token',
        'tbl-target',
        'rec-delete',
        '目标表',
      ),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordDefinitelyNotDeletedError);
  });

  it('classifies a successful delete with an unreadable readback as uncertain', async () => {
    const readbackFailure = Object.assign(new Error('readback timeout'), {
      code: 'ETIMEDOUT',
    });
    del.mockResolvedValueOnce({ data: { code: 0, data: {} } });
    post.mockRejectedValueOnce(readbackFailure);

    await expect(
      gateway.deleteRecordAndConfirmAbsent(
        'app-token',
        'tbl-target',
        'rec-delete',
        '目标表',
      ),
    ).rejects.toBeInstanceOf(InventoryWorkflowRecordDeleteUncertainError);
  });

  it.each([{}, { code: null }, { code: false }, { data: {} }])(
    'classifies a malformed HTTP 2xx delete payload %p as uncertain',
    async (payload) => {
      del.mockResolvedValueOnce({ status: 200, data: payload });

      await expect(
        gateway.deleteRecordAndConfirmAbsent(
          'app-token',
          'tbl-target',
          'rec-delete',
          '目标表',
        ),
      ).rejects.toBeInstanceOf(InventoryWorkflowRecordDeleteUncertainError);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('preserves non-transient batch-get read failures', async () => {
    const networkFailure = new Error('network unavailable');
    post.mockRejectedValueOnce(networkFailure);

    await expect(
      gateway.getRecord('app-token', 'tbl-target', 'rec-missing', '目标表'),
    ).rejects.toBe(networkFailure);
  });

  it('creates a missing text field once and caches the schema check', async () => {
    get
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      });
    post.mockResolvedValueOnce({
      data: { code: 0, data: { field: { field_id: 'fld-source' } } },
    });

    await gateway.ensureTextField(
      'app-token',
      'tbl-inbound',
      '入库来源',
      '入库填写',
    );
    await gateway.ensureTextField(
      'app-token',
      'tbl-inbound',
      '入库来源',
      '入库填写',
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/tbl-inbound/fields',
      { field_name: '入库来源', type: 1 },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('creates a missing number field once, caches success, and skips filter probing', async () => {
    get.mockResolvedValueOnce({
      data: { code: 0, data: { items: [], has_more: false } },
    });
    post.mockResolvedValueOnce({
      data: { code: 0, data: { field: { field_id: 'fld-quantity' } } },
    });
    const numberGateway = asNumberFieldGateway(gateway);

    await numberGateway.ensureNumberField(
      'app-token',
      'tbl-outbound',
      '程序出库申请数量',
      '出库填写',
    );
    await numberGateway.ensureNumberField(
      'app-token',
      'tbl-outbound',
      '程序出库申请数量',
      '出库填写',
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/tbl-outbound/fields',
      { field_name: '程序出库申请数量', type: 2 },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('accepts and caches an existing number field without creating or probing', async () => {
    get.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ field_name: '程序出库申请数量', type: 2 }],
          has_more: false,
        },
      },
    });
    const numberGateway = asNumberFieldGateway(gateway);

    await numberGateway.ensureNumberField(
      'app-token',
      'tbl-outbound',
      '程序出库申请数量',
      '出库填写',
    );
    await numberGateway.ensureNumberField(
      'app-token',
      'tbl-outbound',
      '程序出库申请数量',
      '出库填写',
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rejects an existing number field with a non-number type', async () => {
    get.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ field_name: '程序出库申请数量', type: 1 }],
          has_more: false,
        },
      },
    });
    const numberGateway = asNumberFieldGateway(gateway);

    await expect(
      numberGateway.ensureNumberField(
        'app-token',
        'tbl-outbound',
        '程序出库申请数量',
        '出库填写',
      ),
    ).rejects.toThrow('必须是数字类型');
  });

  it('coalesces concurrent checks for the same missing number field', async () => {
    get.mockResolvedValue({
      data: { code: 0, data: { items: [], has_more: false } },
    });
    post.mockResolvedValueOnce({
      data: { code: 0, data: { field: { field_id: 'fld-quantity' } } },
    });
    const numberGateway = asNumberFieldGateway(gateway);

    await Promise.all([
      numberGateway.ensureNumberField(
        'app-token',
        'tbl-outbound',
        '程序出库申请数量',
        '出库填写',
      ),
      numberGateway.ensureNumberField(
        'app-token',
        'tbl-outbound',
        '程序出库申请数量',
        '出库填写',
      ),
    ]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed number field creation and allows a retry', async () => {
    const creationFailure = new Error('field creation failed');
    get
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      });
    post.mockRejectedValueOnce(creationFailure).mockResolvedValueOnce({
      data: { code: 0, data: { field: { field_id: 'fld-quantity' } } },
    });
    const numberGateway = asNumberFieldGateway(gateway);

    await expect(
      numberGateway.ensureNumberField(
        'app-token',
        'tbl-outbound',
        '程序出库申请数量',
        '出库填写',
      ),
    ).rejects.toBe(creationFailure);
    await numberGateway.ensureNumberField(
      'app-token',
      'tbl-outbound',
      '程序出库申请数量',
      '出库填写',
    );
    await numberGateway.ensureNumberField(
      'app-token',
      'tbl-outbound',
      '程序出库申请数量',
      '出库填写',
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('returns normalized Base field schemas and writability', async () => {
    get.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [
            {
              field_name: '采购流程',
              type: 3,
              ui_type: 'SingleSelect',
            },
            {
              field_name: '实际采购数量',
              type: 2,
              ui_type: 'Number',
            },
            { field_name: '计算结果', type: 20, ui_type: 'Formula' },
          ],
          has_more: false,
        },
      },
    });

    await expect(
      gateway.getFieldSchemas('app-token', 'tbl-execution', '采购执行'),
    ).resolves.toEqual([
      {
        fieldName: '采购流程',
        type: 3,
        uiType: 'SingleSelect',
        writable: true,
      },
      {
        fieldName: '实际采购数量',
        type: 2,
        uiType: 'Number',
        writable: true,
      },
      {
        fieldName: '计算结果',
        type: 20,
        uiType: 'Formula',
        writable: false,
      },
    ]);
  });

  it('retries a timed-out field list GET and preserves the next page token', async () => {
    jest.useFakeTimers();
    const timeout = Object.assign(new Error('timeout of 10000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    try {
      get
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              items: [{ field_name: '类别号', type: 1 }],
              has_more: true,
              page_token: 'next-page',
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              items: [{ field_name: '楼栋', type: 3 }],
              has_more: false,
            },
          },
        });

      const operation = gateway.getFieldSchemas(
        'app-token',
        'tbl-catalog',
        '物品类别',
      );
      const assertion = expect(operation).resolves.toEqual([
        expect.objectContaining({ fieldName: '类别号' }),
        expect.objectContaining({ fieldName: '楼栋' }),
      ]);
      await jest.advanceTimersByTimeAsync(250);

      await assertion;
      expect(get).toHaveBeenCalledTimes(3);
      expect(get.mock.calls[0][1].timeout).toBe(10_000);
      expect(get.mock.calls[1][1].timeout).toBeLessThanOrEqual(10_000);
      expect(get.mock.calls[2][1].params.page_token).toBe('next-page');
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry a permanent field list HTTP error or create a field', async () => {
    const forbidden = { response: { status: 403 } };
    get.mockRejectedValueOnce(forbidden);

    await expect(
      gateway.getFieldSchemas('app-token', 'tbl-catalog', '物品类别'),
    ).rejects.toBe(forbidden);
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('shares one 30-second field read budget across pages and retries', async () => {
    jest.useFakeTimers();
    const timeout = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const requestTimeouts: number[] = [];
    try {
      get.mockImplementation(
        (_url: string, options: { timeout?: number }): Promise<unknown> => {
          const requestTimeout = Number(options.timeout);
          requestTimeouts.push(requestTimeout);
          if (requestTimeouts.length === 1) {
            return new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve({
                    data: {
                      code: 0,
                      data: {
                        items: [{ field_name: '类别号', type: 1 }],
                        has_more: true,
                        page_token: 'next-page',
                      },
                    },
                  }),
                requestTimeout,
              );
            });
          }
          return new Promise((_, reject) => {
            setTimeout(() => reject(timeout), requestTimeout);
          });
        },
      );

      const operation = gateway.getFieldSchemas(
        'app-token',
        'tbl-catalog',
        '物品类别',
      );
      void operation.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(20_250);

      expect(requestTimeouts).toEqual([10_000, 10_000, 9_750]);
      expect(get.mock.calls[2][1].params.page_token).toBe('next-page');
      await jest.advanceTimersByTimeAsync(9_750);
      await expect(operation).rejects.toBe(timeout);
      expect(get).toHaveBeenCalledTimes(3);
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for a newly created text field to become filterable', async () => {
    jest.useFakeTimers();
    try {
      get
        .mockResolvedValueOnce({
          data: { code: 0, data: { items: [], has_more: false } },
        })
        .mockResolvedValueOnce({
          data: { code: 1254045, msg: 'FieldNameNotFound' },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: { items: [], has_more: false },
          },
        });
      post.mockResolvedValueOnce({
        data: { code: 0, data: { field: { field_id: 'fld-source' } } },
      });

      const operation = gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      );
      const assertion = expect(operation).resolves.toBeUndefined();
      await jest.advanceTimersByTimeAsync(250);

      await assertion;
      expect(get).toHaveBeenCalledTimes(3);
      expect(get).toHaveBeenLastCalledWith(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/tbl-inbound/records',
        expect.objectContaining({
          timeout: 1_500,
          params: {
            page_size: 1,
            filter:
              'CurrentValue.[入库来源]="__CODEX_TEXT_FIELD_READY_PROBE__"',
          },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a resolved data-not-ready business response during field propagation', async () => {
    jest.useFakeTimers();
    try {
      get
        .mockResolvedValueOnce({
          data: { code: 0, data: { items: [], has_more: false } },
        })
        .mockResolvedValueOnce({
          data: { code: 1254607, msg: 'Data not ready' },
        })
        .mockResolvedValueOnce({
          data: { code: 0, data: { items: [], has_more: false } },
        });
      post.mockResolvedValueOnce({
        data: { code: 0, data: { field: { field_id: 'fld-source' } } },
      });

      const operation = gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      );
      const assertion = expect(operation).resolves.toBeUndefined();
      await jest.advanceTimersByTimeAsync(250);

      await assertion;
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves a permanent Feishu business code and fails the field probe immediately', async () => {
    get
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      })
      .mockResolvedValueOnce({
        data: { code: 1254018, msg: 'InvalidFilter' },
      });
    post.mockResolvedValueOnce({
      data: { code: 0, data: { field: { field_id: 'fld-source' } } },
    });

    await expect(
      gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('InvalidFilter'),
      feishuCode: 1254018,
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each(['ECONNABORTED', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'])(
    'retries a transient %s field filter probe within the readiness window',
    async (errorCode) => {
      jest.useFakeTimers();
      try {
        get
          .mockResolvedValueOnce({
            data: { code: 0, data: { items: [], has_more: false } },
          })
          .mockRejectedValueOnce(
            Object.assign(new Error('probe timeout'), {
              code: errorCode,
            }),
          )
          .mockResolvedValueOnce({
            data: {
              code: 0,
              data: { items: [], has_more: false },
            },
          });
        post.mockResolvedValueOnce({
          data: {
            code: 0,
            data: { field: { field_id: 'fld-source' } },
          },
        });

        const operation = gateway.ensureTextField(
          'app-token',
          'tbl-inbound',
          '入库来源',
          '入库填写',
        );
        const assertion = expect(operation).resolves.toBeUndefined();
        await jest.advanceTimersByTimeAsync(250);

        await assertion;
        expect(get).toHaveBeenCalledTimes(3);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('stops waiting for a newly created text field after the bounded retry window', async () => {
    jest.useFakeTimers();
    const transientFilterError = {
      response: {
        status: 400,
        data: { code: 1254045, msg: 'FieldNameNotFound' },
      },
    };
    try {
      get
        .mockResolvedValueOnce({
          data: { code: 0, data: { items: [], has_more: false } },
        })
        .mockRejectedValue(transientFilterError);
      post.mockResolvedValueOnce({
        data: { code: 0, data: { field: { field_id: 'fld-source' } } },
      });

      const operation = gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      );
      const assertion = expect(operation).rejects.toBe(transientFilterError);
      let settled = false;
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await jest.advanceTimersByTimeAsync(9_999);
      const settledBeforeDeadline = settled;
      await jest.advanceTimersByTimeAsync(1);

      await assertion;
      expect(settledBeforeDeadline).toBe(false);
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues probing on the next ensure after readiness times out', async () => {
    jest.useFakeTimers();
    const transientFilterError = {
      response: {
        status: 400,
        data: { code: 1254045, msg: 'FieldNameNotFound' },
      },
    };
    try {
      get
        .mockResolvedValueOnce({
          data: { code: 0, data: { items: [], has_more: false } },
        })
        .mockRejectedValue(transientFilterError);
      post.mockResolvedValueOnce({
        data: { code: 0, data: { field: { field_id: 'fld-source' } } },
      });

      const firstAttempt = gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      );
      const firstAssertion =
        expect(firstAttempt).rejects.toBe(transientFilterError);
      await jest.advanceTimersByTimeAsync(10_000);
      await firstAssertion;

      get.mockReset();
      get
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              items: [{ field_name: '入库来源', type: 1 }],
              has_more: false,
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: { items: [], has_more: false },
          },
        });

      await expect(
        gateway.ensureTextField(
          'app-token',
          'tbl-inbound',
          '入库来源',
          '入库填写',
        ),
      ).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry a non-transient field filter probe failure', async () => {
    const networkFailure = new Error('network unavailable');
    get
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      })
      .mockRejectedValueOnce(networkFailure);
    post.mockResolvedValueOnce({
      data: { code: 0, data: { field: { field_id: 'fld-source' } } },
    });

    await expect(
      gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      ),
    ).rejects.toBe(networkFailure);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a field filter probe permission failure', async () => {
    const permissionFailure = {
      response: { status: 403, data: { code: 1254302 } },
    };
    get
      .mockResolvedValueOnce({
        data: { code: 0, data: { items: [], has_more: false } },
      })
      .mockRejectedValueOnce(permissionFailure);
    post.mockResolvedValueOnce({
      data: { code: 0, data: { field: { field_id: 'fld-source' } } },
    });

    await expect(
      gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      ),
    ).rejects.toBe(permissionFailure);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not probe an existing valid text field', async () => {
    get.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ field_name: '入库来源', type: 1 }],
          has_more: false,
        },
      },
    });

    await gateway.ensureTextField(
      'app-token',
      'tbl-inbound',
      '入库来源',
      '入库填写',
    );

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent checks for the same missing text field', async () => {
    get.mockResolvedValue({
      data: { code: 0, data: { items: [], has_more: false } },
    });
    post.mockResolvedValue({
      data: { code: 0, data: { field: { field_id: 'fld-source' } } },
    });

    await Promise.all([
      gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      ),
      gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      ),
    ]);

    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('rejects an existing idempotency field with the wrong type', async () => {
    get.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ field_name: '入库来源', type: 2 }],
          has_more: false,
        },
      },
    });

    await expect(
      gateway.ensureTextField(
        'app-token',
        'tbl-inbound',
        '入库来源',
        '入库填写',
      ),
    ).rejects.toThrow('必须是文本类型');
  });

  it('sends an interactive card to an OpenID and returns the message id', async () => {
    post.mockResolvedValueOnce({
      data: { code: 0, data: { message_id: 'om_message' } },
    });
    const card = {
      header: { title: { tag: 'plain_text', content: '采购入库' } },
      elements: [],
    };

    await expect(
      gateway.sendInteractiveCard('ou_receiver', card),
    ).resolves.toBe('om_message');
    expect(post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: 'ou_receiver',
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });
});

function recordPostCalls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls.filter(
    ([url]) => typeof url === 'string' && url.includes('/records'),
  );
}
