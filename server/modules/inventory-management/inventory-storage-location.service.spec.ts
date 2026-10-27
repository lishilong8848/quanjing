import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  BitableRecordItem,
  BitableRecordSearchFilter,
} from '../../common/feishu/bitable-direct-read';
import { InventoryWorkflowRecordNotFoundError } from './inventory-workflow.gateway';
import { InventoryStorageLocationService } from './inventory-storage-location.service';

const originalEnv = process.env;

describe('InventoryStorageLocationService', () => {
  let gateway: {
    listRecords: jest.Mock;
    searchRecords: jest.Mock;
    createRecord: jest.Mock;
    getRecord: jest.Mock;
  };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      FEISHU_WAREHOUSE_APP_TOKEN: 'warehouse-app',
      FEISHU_WAREHOUSE_SOURCE_URL: '',
      FEISHU_WAREHOUSE_STORAGE_LOCATION_TABLE_ID: '',
    };
    gateway = {
      listRecords: jest.fn().mockResolvedValue([]),
      searchRecords: jest.fn().mockResolvedValue([]),
      createRecord: jest.fn().mockResolvedValue('rec-created'),
      getRecord: jest.fn().mockResolvedValue(
        locationRecord('rec-created', {
          楼栋: 'H楼',
          所属公司: '南通承宏',
          存放位置分类: '库内',
          存放位置: 'H-1F-101',
        }),
      ),
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses structured records search for a building read', async () => {
    const service = createService(gateway);

    await service.list({ building: 'H楼' });

    expect(gateway.searchRecords).toHaveBeenCalledWith({
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
      filter: {
        conjunction: 'and',
        conditions: [{ field_name: '楼栋', operator: 'is', value: ['H楼'] }],
      },
    });
    expect(gateway.listRecords).not.toHaveBeenCalled();
  });

  it('uses unfiltered records search for create-time duplicate detection', async () => {
    const existing = locationRecord('existing', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.searchRecords.mockResolvedValue([existing]);
    const service = createService(gateway);

    await expect(
      service.create({
        building: 'H楼',
        category: '库内',
        name: 'H-1F-101',
        clientMutationId: 'search-create',
      }),
    ).resolves.toEqual(expect.objectContaining({ alreadyExists: true }));
    expect(gateway.searchRecords).toHaveBeenCalledWith({
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
    });
    expect(gateway.listRecords).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('caches building-filtered reads while validating company, building, query, and limit locally', async () => {
    gateway.searchRecords.mockResolvedValue([
      locationRecord('h-2', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库外',
        存放位置: 'H-2F-201',
      }),
      locationRecord('h-1', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: 'H-1F-101',
      }),
      locationRecord('other-company', {
        楼栋: 'H楼',
        所属公司: '其他公司',
        存放位置分类: '库内',
        存放位置: 'H-1F-102',
      }),
      locationRecord('a-1', {
        楼栋: 'A楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: 'A-1F-101',
      }),
    ]);
    const service = createService(gateway);

    await expect(
      service.list({ building: 'H楼', query: '1F', limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({ recordId: 'h-1', name: 'H-1F-101' }),
    ]);
    await expect(service.list({ building: 'H楼' })).resolves.toHaveLength(2);

    expect(gateway.searchRecords).toHaveBeenCalledTimes(1);
    expect(gateway.searchRecords).toHaveBeenCalledWith({
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
      filter: buildingSearchFilter('H楼'),
    });
  });

  it('keeps building caches separate and still reads the full table before create', async () => {
    gateway.searchRecords.mockImplementation(
      ({ filter }: { filter?: BitableRecordSearchFilter }) =>
        Promise.resolve(
          filter?.conditions[0]?.value?.[0] === 'A楼'
            ? [
                locationRecord('a-1', {
                  楼栋: 'A楼',
                  所属公司: '南通承宏',
                  存放位置分类: '库内',
                  存放位置: 'A-1F-101',
                }),
              ]
            : [
                locationRecord('h-1', {
                  楼栋: 'H楼',
                  所属公司: '南通承宏',
                  存放位置分类: '库内',
                  存放位置: 'H-1F-101',
                }),
              ],
        ),
    );
    const service = createService(gateway);

    await expect(service.list({ building: 'H楼' })).resolves.toHaveLength(1);
    await expect(service.list({ building: 'A楼' })).resolves.toHaveLength(1);
    await expect(service.list({ building: 'H楼' })).resolves.toHaveLength(1);
    expect(gateway.searchRecords).toHaveBeenCalledTimes(2);
    expect(gateway.searchRecords).toHaveBeenNthCalledWith(1, {
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
      filter: buildingSearchFilter('H楼'),
    });
    expect(gateway.searchRecords).toHaveBeenNthCalledWith(2, {
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
      filter: buildingSearchFilter('A楼'),
    });

    await expect(
      service.create({
        building: 'H楼',
        category: '库内',
        name: 'H-1F-101',
        clientMutationId: 'full-table-create',
      }),
    ).resolves.toEqual(expect.objectContaining({ alreadyExists: true }));
    expect(gateway.searchRecords).toHaveBeenNthCalledWith(3, {
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
    });
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error('InvalidFilter'), { feishuCode: 1254018 }),
    new Error('field type does not support filter'),
  ])(
    'falls back to an unfiltered read when Feishu rejects the building filter',
    async (invalidFilter) => {
      gateway.searchRecords
        .mockRejectedValueOnce(invalidFilter)
        .mockResolvedValueOnce([
          locationRecord('h-1', {
            楼栋: 'H楼',
            所属公司: '南通承宏',
            存放位置分类: '库内',
            存放位置: 'H-1F-101',
          }),
          locationRecord('a-1', {
            楼栋: 'A楼',
            所属公司: '南通承宏',
            存放位置分类: '库内',
            存放位置: 'A-1F-101',
          }),
        ]);
      const service = createService(gateway);

      await expect(service.list({ building: 'H楼' })).resolves.toEqual([
        expect.objectContaining({ recordId: 'h-1' }),
      ]);
      expect(gateway.searchRecords).toHaveBeenCalledTimes(2);
      expect(gateway.searchRecords).toHaveBeenNthCalledWith(1, {
        appToken: 'warehouse-app',
        tableId: 'tbl98EPSzfPIxkDG',
        tableName: '配置库房货架名称',
        filter: buildingSearchFilter('H楼'),
      });
      expect(gateway.searchRecords).toHaveBeenNthCalledWith(2, {
        appToken: 'warehouse-app',
        tableId: 'tbl98EPSzfPIxkDG',
        tableName: '配置库房货架名称',
      });
    },
  );

  it('does not turn a transient filtered-read failure into a full-table scan', async () => {
    const timeout = networkError('read timed out', 'ETIMEDOUT');
    gateway.searchRecords.mockRejectedValueOnce(timeout);
    const service = createService(gateway);

    await expect(service.list({ building: 'H楼' })).rejects.toBe(timeout);
    expect(gateway.searchRecords).toHaveBeenCalledTimes(1);
  });

  it('invalidates a cached building read after creating a location', async () => {
    const created = locationRecord('rec-created', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.searchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);
    gateway.getRecord.mockResolvedValue(created);
    const service = createService(gateway);

    await expect(service.list({ building: 'H楼' })).resolves.toEqual([]);
    await expect(
      service.create({
        building: 'H楼',
        category: '库内',
        name: 'H-1F-101',
        clientMutationId: 'building-cache-create',
      }),
    ).resolves.toEqual(expect.objectContaining({ alreadyExists: false }));
    await expect(service.list({ building: 'H楼' })).resolves.toEqual([
      expect.objectContaining({ recordId: 'rec-created' }),
    ]);
    expect(gateway.searchRecords).toHaveBeenCalledTimes(3);
    expect(gateway.searchRecords).toHaveBeenNthCalledWith(2, {
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
    });
    expect(gateway.searchRecords).toHaveBeenNthCalledWith(3, {
      appToken: 'warehouse-app',
      tableId: 'tbl98EPSzfPIxkDG',
      tableName: '配置库房货架名称',
      filter: buildingSearchFilter('H楼'),
    });
  });

  it('coalesces concurrent cold reads', async () => {
    const pending = deferred<BitableRecordItem[]>();
    gateway.searchRecords.mockReturnValue(pending.promise);
    const service = createService(gateway);

    const first = service.list({ building: 'H楼' });
    const second = service.list({ building: 'H楼', query: '101' });
    await waitForMockCall(gateway.searchRecords);
    expect(gateway.searchRecords).toHaveBeenCalledTimes(1);

    pending.resolve([]);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  it('rejects an invalid building before reading Feishu', async () => {
    const service = createService(gateway);

    await expect(
      service.list({ building: '不存在' as 'H楼' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.searchRecords).not.toHaveBeenCalled();
  });

  it('creates exactly four writable fields and verifies the persisted record', async () => {
    gateway.getRecord.mockResolvedValue(
      locationRecord('rec-created', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: 'H-1F 101',
      }),
    );
    const service = createService(gateway);

    await expect(
      service.create({
        building: 'H楼',
        category: '库内',
        name: '  H-1F   101 ',
        clientMutationId: ' mutation-1 ',
      }),
    ).resolves.toEqual({
      item: {
        recordId: 'rec-created',
        building: 'H楼',
        company: '南通承宏',
        category: '库内',
        name: 'H-1F 101',
      },
      alreadyExists: false,
      clientMutationId: 'mutation-1',
    });

    expect(gateway.createRecord).toHaveBeenCalledWith(
      'warehouse-app',
      'tbl98EPSzfPIxkDG',
      {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: 'H-1F 101',
      },
      '配置库房货架名称',
    );
    expect(gateway.getRecord).toHaveBeenCalledWith(
      'warehouse-app',
      'tbl98EPSzfPIxkDG',
      'rec-created',
      '配置库房货架名称',
    );
  });

  it('returns an existing same-company location without writing', async () => {
    gateway.searchRecords.mockResolvedValue([
      locationRecord('existing', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库外',
        存放位置: 'H-Zone-A',
      }),
    ]);
    const service = createService(gateway);

    await expect(
      service.create({
        building: 'H楼',
        category: '库内',
        name: 'h-zone-a',
        clientMutationId: 'existing-1',
      }),
    ).resolves.toEqual({
      item: expect.objectContaining({ recordId: 'existing' }),
      alreadyExists: true,
      clientMutationId: 'existing-1',
    });
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('coalesces the same mutation and rejects a different payload using it', async () => {
    const read = deferred<BitableRecordItem[]>();
    gateway.searchRecords.mockReturnValue(read.promise);
    const service = createService(gateway);
    const request = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
      clientMutationId: 'same-mutation',
    };

    const first = service.create(request);
    const second = service.create({ ...request });
    await expect(
      service.create({ ...request, name: 'H-1F-102' }),
    ).rejects.toBeInstanceOf(ConflictException);
    read.resolve([]);
    await Promise.all([first, second]);

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('serializes different mutations for the same business key', async () => {
    const created = locationRecord('rec-created', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.searchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);
    gateway.getRecord.mockResolvedValue(created);
    const service = createService(gateway);
    const base = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
    };

    const [first, second] = await Promise.all([
      service.create({ ...base, clientMutationId: 'business-1' }),
      service.create({ ...base, clientMutationId: 'business-2' }),
    ]);

    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(first.alreadyExists).toBe(false);
    expect(second.alreadyExists).toBe(true);
  });

  it('remembers a completed mutation and rejects later payload reuse', async () => {
    const created = locationRecord('rec-created', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.getRecord.mockResolvedValue(created);
    const service = createService(gateway);
    const request = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
      clientMutationId: 'completed-mutation',
    };

    const first = await service.create(request);
    const replay = await service.create(request);

    expect(replay).toEqual(first);
    expect(gateway.searchRecords).toHaveBeenCalledTimes(1);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    await expect(
      service.create({ ...request, name: 'H-1F-999' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not let a late stale read repopulate cache after create succeeds', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const createResponse = deferred<string>();
    const lateRead = deferred<BitableRecordItem[]>();
    const created = locationRecord('rec-created', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.searchRecords
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(lateRead.promise)
      .mockResolvedValueOnce([created]);
    gateway.createRecord.mockReturnValue(createResponse.promise);
    gateway.getRecord.mockResolvedValue(created);
    const service = createService(gateway);

    try {
      const creating = service.create({
        building: 'H楼',
        category: '库内',
        name: 'H-1F-101',
        clientMutationId: 'late-read-create',
      });
      await waitForMockCall(gateway.createRecord);

      now += 31_000;
      const staleList = service.list({ building: 'H楼' });
      await waitForMockCallCount(gateway.searchRecords, 2);

      createResponse.resolve('rec-created');
      await creating;
      lateRead.resolve([]);
      await expect(staleList).resolves.toEqual([]);

      await expect(service.list({ building: 'H楼' })).resolves.toEqual([
        expect.objectContaining({ recordId: 'rec-created' }),
      ]);
      expect(gateway.searchRecords).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not attach a post-create list request to an older read epoch', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const createResponse = deferred<string>();
    const lateRead = deferred<BitableRecordItem[]>();
    const created = locationRecord('rec-created', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.searchRecords
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(lateRead.promise)
      .mockResolvedValueOnce([created]);
    gateway.createRecord.mockReturnValue(createResponse.promise);
    gateway.getRecord.mockResolvedValue(created);
    const service = createService(gateway);

    try {
      const creating = service.create({
        building: 'H楼',
        category: '库内',
        name: 'H-1F-101',
        clientMutationId: 'new-epoch-list',
      });
      await waitForMockCall(gateway.createRecord);

      now += 31_000;
      const staleList = service.list({ building: 'H楼' });
      await waitForMockCallCount(gateway.searchRecords, 2);

      createResponse.resolve('rec-created');
      await creating;
      const freshList = service.list({ building: 'H楼' });
      await waitForMockCallCount(gateway.searchRecords, 3);
      const callCountBeforeOldReadSettled =
        gateway.searchRecords.mock.calls.length;

      lateRead.resolve([]);
      await expect(staleList).resolves.toEqual([]);
      await expect(freshList).resolves.toEqual([
        expect.objectContaining({ recordId: 'rec-created' }),
      ]);
      expect(callCountBeforeOldReadSettled).toBe(3);
    } finally {
      lateRead.resolve([]);
      nowSpy.mockRestore();
    }
  });

  it('recovers with the original mutation after a lost create response', async () => {
    const persisted = locationRecord('persisted', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.searchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([persisted]);
    gateway.createRecord.mockRejectedValueOnce(
      networkError('response lost', 'ECONNRESET'),
    );
    const service = createService(gateway);
    const base = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
    };

    await expect(
      service.create({ ...base, clientMutationId: 'lost-1' }),
    ).rejects.toThrow('response lost');
    await expect(
      service.create({ ...base, clientMutationId: 'lost-1' }),
    ).resolves.toEqual({
      item: expect.objectContaining({ recordId: 'persisted' }),
      alreadyExists: true,
      clientMutationId: 'lost-1',
    });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it.each([
    networkError('browser network failed', 'ERR_NETWORK'),
    networkError('socket pipe failed', 'EPIPE'),
    Object.assign(new Error('proxy timeout'), { response: { status: 504 } }),
  ])(
    'reconciles broader unknown write outcomes without another POST',
    async (writeError) => {
      const persisted = locationRecord('persisted', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: 'H-1F-101',
      });
      gateway.searchRecords
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([persisted]);
      gateway.createRecord.mockRejectedValueOnce(writeError);
      const service = createService(gateway);
      const request = {
        building: 'H楼' as const,
        category: '库内' as const,
        name: 'H-1F-101',
        clientMutationId: `unknown-${String((writeError as { code?: string }).code || '504')}`,
      };

      await expect(service.create(request)).rejects.toBe(writeError);
      await expect(service.create(request)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(service.create(request)).resolves.toEqual({
        item: expect.objectContaining({ recordId: 'persisted' }),
        alreadyExists: true,
        clientMutationId: request.clientMutationId,
      });
      expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed without another POST while an uncertain write is not visible', async () => {
    gateway.searchRecords.mockResolvedValue([]);
    gateway.createRecord.mockRejectedValueOnce(
      networkError('response lost', 'ETIMEDOUT'),
    );
    const service = createService(gateway);
    const base = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
    };

    await expect(
      service.create({ ...base, clientMutationId: 'uncertain-1' }),
    ).rejects.toThrow('response lost');
    await expect(
      service.create({ ...base, clientMutationId: 'uncertain-2' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(gateway.searchRecords).toHaveBeenCalledTimes(2);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('reconciles the created record id after a transient read-back failure', async () => {
    const created = locationRecord('rec-created', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库内',
      存放位置: 'H-1F-101',
    });
    gateway.getRecord
      .mockRejectedValueOnce(
        new InventoryWorkflowRecordNotFoundError(
          '配置库房货架名称',
          'rec-created',
        ),
      )
      .mockResolvedValueOnce(created);
    const service = createService(gateway);
    const request = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
      clientMutationId: 'read-back-retry',
    };

    await expect(service.create(request)).rejects.toThrow('记录不存在');
    await expect(service.create(request)).resolves.toEqual({
      item: expect.objectContaining({ recordId: 'rec-created' }),
      alreadyExists: true,
      clientMutationId: 'read-back-retry',
    });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects a reconciled record id whose category differs from the request', async () => {
    const wrongCategory = locationRecord('rec-created', {
      楼栋: 'H楼',
      所属公司: '南通承宏',
      存放位置分类: '库外',
      存放位置: 'H-1F-101',
    });
    gateway.getRecord
      .mockRejectedValueOnce(
        new InventoryWorkflowRecordNotFoundError(
          '配置库房货架名称',
          'rec-created',
        ),
      )
      .mockResolvedValueOnce(wrongCategory);
    const service = createService(gateway);
    const request = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
      clientMutationId: 'wrong-category-reconcile',
    };

    await expect(service.create(request)).rejects.toThrow('记录不存在');
    await expect(service.create(request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the pre-write read fails and clears running state', async () => {
    gateway.searchRecords
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce([]);
    const service = createService(gateway);
    const request = {
      building: 'H楼' as const,
      category: '库内' as const,
      name: 'H-1F-101',
      clientMutationId: 'retry-after-read',
    };

    await expect(service.create(request)).rejects.toThrow('read failed');
    expect(gateway.createRecord).not.toHaveBeenCalled();
    await expect(service.create(request)).resolves.toEqual(
      expect.objectContaining({ alreadyExists: false }),
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
  });

  it('resolves only a matching same-company location', async () => {
    gateway.getRecord.mockResolvedValue(
      locationRecord('selected', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: 'H-1F-101',
      }),
    );
    const service = createService(gateway);

    await expect(
      service.resolveSelectedLocation('H楼', 'selected', ' h-1f-101 '),
    ).resolves.toEqual(expect.objectContaining({ recordId: 'selected' }));
    await expect(
      service.resolveSelectedLocation('A楼', 'selected', 'H-1F-101'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.resolveSelectedLocation('H楼', 'selected', 'H-1F-999'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a missing selected record to a business error', async () => {
    gateway.getRecord.mockRejectedValue(
      new InventoryWorkflowRecordNotFoundError('配置库房货架名称', 'missing'),
    );
    const service = createService(gateway);

    await expect(
      service.resolveSelectedLocation('H楼', 'missing', 'H-1F-101'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function createService(gateway: unknown): InventoryStorageLocationService {
  return new InventoryStorageLocationService(
    { axiosRef: {} } as never,
    gateway as never,
  );
}

function locationRecord(
  recordId: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: recordId, fields } as BitableRecordItem;
}

function buildingSearchFilter(building: string): BitableRecordSearchFilter {
  return {
    conjunction: 'and',
    conditions: [{ field_name: '楼栋', operator: 'is', value: [building] }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function networkError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function waitForMockCall(mock: jest.Mock): Promise<void> {
  await waitForMockCallCount(mock, 1);
}

async function waitForMockCallCount(
  mock: jest.Mock,
  count: number,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 20 && mock.mock.calls.length < count;
    attempt += 1
  ) {
    await Promise.resolve();
  }
}
