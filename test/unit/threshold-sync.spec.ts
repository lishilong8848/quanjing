import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThresholdStore } from '../../server/modules/threshold-management/threshold.store';
import {
  thresholdFieldsMatch,
  thresholdToBitableFields,
  thresholdContentFingerprint,
  thresholdFromBitableFields,
} from '../../shared/threshold-bitable';
import electricalSeed from '../../shared/electrical-thresholds.seed.json';
import hvacSeed from '../../shared/hvac-thresholds.seed.json';
import {
  mergeThresholdReceipt,
  type ThresholdRecord,
} from '../../shared/threshold-management.interface';
import { ThresholdBitableGateway } from '../../server/modules/threshold-management/threshold-bitable.gateway';
import { THRESHOLD_BITABLE_SCHEMA as schema } from '../../shared/threshold-bitable';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue('qa-no-credential'),
}));

const record: ThresholdRecord = {
  id: 'hvac-test',
  profession: '暖通',
  device: '冷水机组',
  section: '告警',
  parameter: '负荷',
  building: 'E楼',
  location: 'SCAL502UES（厂商）',
  value: '30%',
  range: '0-100%',
  unit: '%',
  kind: '设定',
  enabled: '',
  note: '',
  version: 1,
  updatedAt: '',
  source: {
    sheet: '01冷水机组',
    cell: 'F12',
    originalValue: '30%',
    parameterCell: 'A12',
  },
};
describe('阈值同步台账', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nt-threshold-sync-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  test('记录和 outbox 同次提交，受理后重启可继续；重复 mutation 不新增任务', () => {
    const path = join(directory, 'ledger.json');
    let store = new ThresholdStore(path, [record], [], true);
    const command = {
      operation: 'update' as const,
      clientMutationId: 'sync-test-update',
      id: record.id,
      expectedVersion: 1,
      record: { ...record, value: '28.50' },
    };
    const result = store.mutate(command, 'admin:qa');
    expect(result.sync?.state).toBe('pending');
    store = new ThresholdStore(path, [record], [], true);
    expect(
      store.pendingSync().map((job) => job.result.clientMutationId),
    ).toEqual([command.clientMutationId]);
    expect(store.mutate(command, 'admin:qa').id).toBe(result.id);
    expect(store.pendingSync()).toHaveLength(1);
    expect(() =>
      store.mutate(
        { ...command, clientMutationId: 'sync-test-next', expectedVersion: 2 },
        'admin:qa',
      ),
    ).toThrow('同步');
    store.finishSync(command.clientMutationId, { state: 'success' });
    expect(store.pendingSync()).toHaveLength(0);
    expect(store.syncResults([command.clientMutationId])[0].sync?.state).toBe(
      'success',
    );
  });
  test('失败可见且可重试，删除任务保留原记录定位，身份不符不能重试', () => {
    const store = new ThresholdStore(
      join(directory, 'ledger.json'),
      [record],
      [],
      true,
    );
    store.mutate(
      {
        operation: 'delete',
        clientMutationId: 'sync-test-delete',
        id: record.id,
        expectedVersion: 1,
      },
      'admin:qa',
    );
    expect(store.pendingSync()[0].before?.id).toBe(record.id);
    store.finishSync('sync-test-delete', {
      state: 'error',
      error: '飞书不可用',
    });
    expect(store.list().syncResults?.[0].sync?.state).toBe('error');
    expect(() => store.retrySync('sync-test-delete', 'editor:other')).toThrow(
      '无权',
    );
    store.retrySync('sync-test-delete', 'admin:qa');
    expect(store.pendingSync()).toHaveLength(1);
  });
  test('多个进程只能领取一次任务，过期租约恢复；旧完成响应不能覆盖新所有者', () => {
    const path = join(directory, 'ledger.json');
    const first = new ThresholdStore(path, [record], [], true);
    const second = new ThresholdStore(path, [record], [], true);
    first.mutate(
      {
        operation: 'delete',
        clientMutationId: 'sync-test-lease',
        id: record.id,
        expectedVersion: 1,
      },
      'admin:qa',
    );
    expect(first.claimSync('sync-test-lease', 'worker-1')).toBe(true);
    expect(second.claimSync('sync-test-lease', 'worker-2')).toBe(false);
    expect(second.pendingSync()).toHaveLength(0);
    first.bindSync('sync-test-lease', 'worker-1', 'table', 'record');
    second.finishSync('sync-test-lease', { state: 'success' }, 'worker-2');
    expect(second.syncResults(['sync-test-lease'])[0].sync?.state).toBe(
      'pending',
    );
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 121000);
    try {
      expect(second.claimSync('sync-test-lease', 'worker-2')).toBe(true);
      first.finishSync('sync-test-lease', { state: 'success' }, 'worker-1');
      expect(second.syncResults(['sync-test-lease'])[0].sync?.state).toBe(
        'pending',
      );
      second.finishSync('sync-test-lease', { state: 'success' }, 'worker-2');
      expect(
        second.syncResults(['sync-test-lease'])[0].sync?.cloudRecords,
      ).toEqual({ table: 'record' });
    } finally {
      jest.restoreAllMocks();
    }
  });
  test('云端刷新保留待同步改动和删除，不覆盖读取期间的新版本；空表不恢复种子', () => {
    const store = new ThresholdStore(
      join(directory, 'ledger.json'),
      [record],
      [],
      true,
    );
    const revision = store.list().revision;
    store.mutate(
      {
        operation: 'update',
        clientMutationId: 'sync-test-protect',
        id: record.id,
        expectedVersion: 1,
        record: { ...record, value: '40%' },
      },
      'admin:qa',
    );
    expect(store.adoptCloud([record], revision)).toBe(false);
    expect(store.adoptCloud([record], store.list().revision)).toBe(true);
    expect(store.list().records[0].value).toBe('40%');
    const readingRevision = store.list().revision;
    store.finishSync('sync-test-protect', { state: 'success' });
    expect(store.adoptCloud([record], readingRevision)).toBe(false);
    expect(store.adoptCloud([], store.list().revision)).toBe(true);
    expect(store.list().records).toHaveLength(0);
  });
  test('冲突可采用云端新值，保留原提交的审计草稿，终态不会再次排队', () => {
    const store = new ThresholdStore(
      join(directory, 'ledger.json'),
      [record],
      [],
      true,
    );
    store.mutate(
      {
        operation: 'update',
        clientMutationId: 'sync-test-conflict',
        id: record.id,
        expectedVersion: 1,
        record: { ...record, value: '40%' },
      },
      'admin:qa',
    );
    store.finishSync('sync-test-conflict', {
      state: 'error',
      error: '多维表记录已变化，请核对后重试',
    });
    const result = store.acceptCloud('sync-test-conflict', 'admin:qa', {
      ...record,
      value: '80%',
    });
    expect(result.record?.value).toBe('80%');
    expect(result.sync?.state).toBe('cancelled');
    expect(store.list().records[0].value).toBe('80%');
    expect(store.list().syncResults).toHaveLength(0);
    expect(store.retrySync('sync-test-conflict', 'admin:qa').sync?.state).toBe(
      'cancelled',
    );
    expect(store.syncResults(['sync-test-conflict'])[0].record?.value).toBe(
      '40%',
    );
  });
  test('云端人工修改未递增版本时，旧表单仍被内容指纹拦截', () => {
    const store = new ThresholdStore(
      join(directory, 'ledger.json'),
      [record],
      [],
      true,
    );
    store.adoptCloud([{ ...record, value: '80%' }], 0);
    expect(() =>
      store.mutate(
        {
          operation: 'update',
          clientMutationId: 'sync-stale-content',
          id: record.id,
          expectedVersion: 1,
          expectedContent: thresholdContentFingerprint(record),
          record: { ...record, value: '40%' },
        },
        'admin:qa',
      ),
    ).toThrow('已变化');
    expect(store.list().records[0].value).toBe('80%');
    expect(store.pendingSync()).toHaveLength(0);
  });
});
test('文本字段保留百分比、范围和来源，按文本语义回读而非 JSON 深比较', () => {
  const fields = thresholdToBitableFields(record, 'sync-test-create');
  expect(fields['设定值']).toBe('30%');
  expect(fields['设备型号']).toBe('SCAL502UES');
  expect(fields['品牌']).toBe('厂商');
  expect(fields['参数名单元格']).toBe('A12');
  const rich = Object.fromEntries(
    Object.entries(fields).map(([name, text]) => [
      name,
      text ? [{ text, type: 'text' }] : null,
    ]),
  );
  expect(thresholdFieldsMatch(fields, rich)).toBe(true);
  expect(
    thresholdFieldsMatch(fields, { ...rich, 设定值: [{ text: '0.3' }] }),
  ).toBe(false);
});

test('原表UPS标题是型号、楼栋是楼栋，旧错误型号也能正确拆分', () => {
  const source = electricalSeed.records.find(
    (r) => r.device === 'UPS' && r.location === '400K UPS · D楼',
  ) as ThresholdRecord;
  const fields = thresholdToBitableFields({ ...source, model: 'D楼' });
  expect(fields['楼栋']).toBe('D楼');
  expect(fields['设备型号']).toBe('400K UPS');
  expect(fields['位置']).toBe('');
});

test('暖通型号和品牌与位置分开，水泵定位及蓄冷罐区域保留', () => {
  const cold = thresholdToBitableFields(record);
  expect(cold['位置']).toBe('');
  const pump = hvacSeed.records.find(
    (r) => r.device === '水泵',
  ) as ThresholdRecord;
  const fields = thresholdToBitableFields(pump);
  expect(fields['位置']).toBe('一次泵');
  expect(fields['设备型号']).toBe('HSC-S 10*12*12');
  const tank = hvacSeed.records.find(
    (r) => r.device === '蓄冷罐',
  ) as ThresholdRecord;
  expect(thresholdToBitableFields(tank)['位置']).toBe('西区');
  expect(thresholdToBitableFields(tank)['设备型号']).toBe('');
});

test('电气楼层和设备位置不冒充型号，带楼栋前缀的实际位置保留', () => {
  for (const [device, location, expected] of [
    ['变频器', '冷塔 · A楼', '冷塔'],
    ['SVG', '一层 · A楼', '一层'],
    ['直流屏', 'B-279直流屏', '279直流屏'],
    ['HVDC', 'A楼', ''],
  ]) {
    const fields = thresholdToBitableFields({
      ...record,
      profession: '电气',
      device,
      location,
      building: location.includes('B-') ? 'B楼' : 'A楼',
    });
    expect(fields['位置']).toBe(expected);
    expect(fields['设备型号']).toBe('');
  }
});

test('已分离的型号与真实位置可独立往返，不能重新拼回位置', () => {
  const current = {
    ...record,
    model: 'SCAL502UES',
    brand: '厂商',
    location: '二层机房',
  };
  const fields = thresholdToBitableFields(current);
  expect(fields['位置']).toBe('二层机房');
  expect(fields['设备型号']).toBe('SCAL502UES');
  expect(thresholdFromBitableFields(fields, '暖通')).toMatchObject(current);
  expect(thresholdToBitableFields({ ...current, brand: '' })['品牌']).toBe('');
});

test('两专业所有原表记录字段含义检查，设备型号不含楼栋，位置不重复型号', () => {
  for (const original of [...electricalSeed.records, ...hvacSeed.records]) {
    const source = original as ThresholdRecord;
    const fields = thresholdToBitableFields(source);
    expect(fields['设备型号']).not.toMatch(/(?:[A-EH]楼|原表[A-Z]+列)/);
    expect(fields['位置']).not.toMatch(/(?:[A-EH]楼|原表[A-Z]+列)/);
    if (fields['设备型号'])
      expect(fields['位置']).not.toContain(fields['设备型号']);
    expect(fields['设定值']).toBe(source.value);
    expect(fields['楼栋']).toBe(source.building);
    expect(fields['来源单元格']).toBe(source.source?.cell);
  }
});
test('迟到的编辑或删除响应不覆盖较新版本，其他记录的响应仍可合并', () => {
  const previous = {
    records: [{ ...record, version: 3, value: '80%' }],
    revision: 8,
    updatedAt: '',
  };
  const result = {
    clientMutationId: 'sync-old-response',
    id: record.id,
    operation: 'update' as const,
    record: { ...record, version: 2, value: '40%' },
    revision: 7,
    updatedAt: '',
  };
  expect(
    mergeThresholdReceipt(previous, result, record.id).records[0].value,
  ).toBe('80%');
  expect(
    mergeThresholdReceipt(
      previous,
      { ...result, operation: 'delete', record: null },
      record.id,
      2,
    ).records,
  ).toHaveLength(1);
  const other = { ...result, id: 'other', record: { ...record, id: 'other' } };
  expect(mergeThresholdReceipt(previous, other, 'temp').records).toHaveLength(
    2,
  );
});
describe('飞书定向写入与重试契约', () => {
  function gateway(
    options: {
      initial?: Record<string, unknown>;
      wrongType?: boolean;
      lostAcknowledgment?: boolean;
    } = {},
  ) {
    let current = options.initial
      ? { record_id: 'rec-qa', fields: options.initial }
      : null;
    let lose = options.lostAcknowledgment;
    const createdTokens: string[] = [];
    const request = jest.fn(async (config) => {
      if (config.url.endsWith('/fields'))
        return {
          data: {
            code: 0,
            data: {
              items: Object.values(schema.fields).map((name) => ({
                field_name: name,
                type: options.wrongType && name === schema.fields.value ? 2 : 1,
              })),
              has_more: false,
            },
          },
        };
      if (config.url.endsWith('/search'))
        return {
          data: {
            code: 0,
            data: { items: current ? [current] : [], has_more: false },
          },
        };
      if (config.method === 'POST') {
        current = { record_id: 'rec-qa', fields: config.data.fields };
        createdTokens.push(config.params.client_token);
        if (lose) {
          lose = false;
          throw new Error('模拟写成功但回包丢失');
        }
      } else if (config.method === 'PUT')
        current = { record_id: 'rec-qa', fields: config.data.fields };
      else if (config.method === 'DELETE') current = null;
      return { data: { code: 0, data: { record: current } } };
    });
    return {
      service: new ThresholdBitableGateway({ axiosRef: { request } } as never),
      request,
      createdTokens,
      current: () => current,
    };
  }
  const result = {
    clientMutationId: 'sync-gateway-create',
    operation: 'create' as const,
    id: record.id,
    record,
    revision: 1,
    updatedAt: '',
    sync: { state: 'pending' as const, attempts: 0 },
  };
  test('成功写入后回包丢失，重试只回读不重复创建，使用稳定 UUID client_token', async () => {
    const fake = gateway({ lostAcknowledgment: true });
    await expect(
      fake.service.sync({ actor: 'admin:qa', before: null, result }),
    ).rejects.toThrow('暂时不可用');
    await expect(
      fake.service.sync({ actor: 'admin:qa', before: null, result }),
    ).resolves.toBeUndefined();
    expect(fake.createdTokens).toHaveLength(1);
    expect(fake.createdTokens[0]).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  });
  test('外部值发生变化、字段类型不符时拒绝覆盖；不存在的已删除记录可重试', async () => {
    const changed = gateway({
      initial: { ...thresholdToBitableFields(record), 设定值: '80%' },
    });
    const deletion = { ...result, operation: 'delete' as const, record: null };
    await expect(
      changed.service.sync({
        actor: 'admin:qa',
        before: record,
        result: deletion,
      }),
    ).rejects.toThrow('已变化');
    expect(
      changed.request.mock.calls.some(([c]) => c.method === 'DELETE'),
    ).toBe(false);
    const badType = gateway({ wrongType: true });
    await expect(
      badType.service.sync({ actor: 'admin:qa', before: null, result }),
    ).rejects.toThrow('文本');
    await expect(
      gateway().service.sync({
        actor: 'admin:qa',
        before: record,
        result: deletion,
      }),
    ).resolves.toBeUndefined();
  });
});
