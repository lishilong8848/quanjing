import { ConflictException } from '@nestjs/common';
import {
  TodayOperationsAnomalyGateway,
  buildTodayOperationsFollowUpUpdateFields,
  normalizeTodayOperationsFollowUpRecord,
} from '../../server/modules/bitable-sync/today-operations-anomaly.gateway';
import type { TodayOperationsFollowUpRecord, TodayOperationsFollowUpUpdate } from '../../server/modules/bitable-sync/today-operations-anomaly.types';

type Fields = Record<string, unknown>;
type GatewayInternals = {
  target(): Promise<{ appToken: string; tableId: string }>;
  getTenantAccessToken(): Promise<string>;
  readMutationId(target: unknown, token: string, recordId: string): Promise<string>;
  verifyRecord(recordId: string, fields: Fields): Promise<void>;
};

function sample(recordId = 'recA'): TodayOperationsFollowUpRecord {
  return { recordId, issueKey: `issue-${recordId}`, date: '2026-10-29', source: '每日巡视',
    item: '合成巡视异常', description: '仅用于隔离测试', building: 'A楼', acknowledged: false,
    completed: false, treatmentMeasure: '', handlerName: '', handledAt: '' };
}

function update(recordId = 'recA', mutation = 'synthetic-mutation-first'): TodayOperationsFollowUpUpdate {
  return { recordId, acknowledged: true, completed: false, treatmentMeasure: '合成检查措施',
    handlerName: '合成处理人', clientMutationId: mutation };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (predicate()) return;
    await new Promise<void>(done => setImmediate(done));
  }
  throw new Error('Synthetic asynchronous work did not reach the expected boundary');
}

describe('native follow-up gateway write serialization and recovery', () => {
  let gateway: TodayOperationsAnomalyGateway;
  let records: Map<string, TodayOperationsFollowUpRecord>, mutations: Map<string, string>;
  let put: jest.Mock, persist: (url: string, body: { fields: Fields }) => Promise<{ data: { code: number } }>;
  let verify: jest.SpyInstance;

  beforeEach(() => {
    records = new Map([['recA', sample()], ['recB', sample('recB')]]);
    mutations = new Map();
    persist = async (url, { fields }) => {
      const recordId = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
      const current = records.get(recordId);
      if (!current) throw new Error('Unexpected synthetic record');
      records.set(recordId, { ...current, acknowledged: fields['已知悉'] === true,
        completed: fields['已处理完成'] === true, treatmentMeasure: String(fields['处理措施']),
        handlerName: String(fields['处理人姓名']), handledAt: fields['处理时间'] ? new Date(Number(fields['处理时间'])).toISOString() : '' });
      mutations.set(recordId, String(fields['客户端变更ID']));
      return { data: { code: 0 } };
    };
    put = jest.fn(persist);
    const forbiddenTransport = () => { throw new Error('Unexpected external transport in isolated gateway test'); };
    gateway = new TodayOperationsAnomalyGateway({ axiosRef: {
      put, get: jest.fn(forbiddenTransport), post: jest.fn(forbiddenTransport),
      patch: jest.fn(forbiddenTransport), delete: jest.fn(forbiddenTransport),
    } } as never);
    const internals = gateway as unknown as GatewayInternals;
    jest.spyOn(internals, 'target').mockResolvedValue({ appToken: 'synthetic_base', tableId: 'synthetic_table' });
    jest.spyOn(internals, 'getTenantAccessToken').mockResolvedValue('synthetic-token-never-sent');
    jest.spyOn(internals, 'readMutationId').mockImplementation(async (_target, _token, recordId) => mutations.get(recordId) || '');
    verify = jest.spyOn(internals, 'verifyRecord').mockResolvedValue(undefined);
    jest.spyOn(gateway, 'getFollowUp').mockImplementation(async recordId => {
      const current = records.get(recordId);
      if (!current) throw new Error('Unknown synthetic record');
      return structuredClone(current);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('serializes two stale-snapshot updates of one record: first PUT wins and second conflicts', async () => {
    const expected = structuredClone(records.get('recA')!);
    const first = update(), second = { ...update('recA', 'synthetic-mutation-second'), treatmentMeasure: '不得覆盖首个结果' };
    const results = await Promise.allSettled([
      gateway.updateFollowUp(first, expected), gateway.updateFollowUp(second, expected),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(ConflictException) });
    expect(put).toHaveBeenCalledTimes(1);
    expect(records.get('recA')?.treatmentMeasure).toBe(first.treatmentMeasure);
    expect(mutations.get('recA')).toBe(first.clientMutationId);
  });

  it('does not block another record while the first record PUT is slow', async () => {
    const gate = deferred<void>();
    let secondFinished = false;
    put.mockImplementation(async (url: string, body: { fields: Fields }) => {
      if (url.endsWith('/recA')) await gate.promise;
      return persist(url, body);
    });
    const first = gateway.updateFollowUp(update(), structuredClone(records.get('recA')!));
    const second = gateway.updateFollowUp(update('recB', 'synthetic-other-record'), structuredClone(records.get('recB')!))
      .then(value => { secondFinished = true; return value; });
    try {
      await until(() => secondFinished);
      expect(records.get('recA')?.acknowledged).toBe(false);
      expect(records.get('recB')?.acknowledged).toBe(true);
    } finally {
      gate.resolve();
      await Promise.all([first, second]);
    }
  });

  it('does not repeat a successful PUT when readback failed and the same mutation is retried', async () => {
    const expected = structuredClone(records.get('recA')!), request = update();
    verify.mockRejectedValueOnce(new Error('synthetic readback failure after accepted PUT'));
    await expect(gateway.updateFollowUp(request, expected)).rejects.toThrow('synthetic readback failure');
    expect(mutations.get('recA')).toBe(request.clientMutationId);
    records.set('recA', { ...records.get('recA')!, description: '回读失败后又取得的当前现场描述' });

    const retried = await gateway.updateFollowUp(request, expected);

    expect(retried).toEqual(records.get('recA'));
    expect(retried.description).toBe('回读失败后又取得的当前现场描述');
    expect(put).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('continues the record queue after a rejected PUT', async () => {
    const expected = structuredClone(records.get('recA')!);
    put.mockRejectedValueOnce(new Error('synthetic transport failure before acceptance'));
    const results = await Promise.allSettled([
      gateway.updateFollowUp(update(), expected),
      gateway.updateFollowUp(update('recA', 'synthetic-retry-after-failure'), expected),
    ]);

    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    expect(put).toHaveBeenCalledTimes(2);
    expect(mutations.get('recA')).toBe('synthetic-retry-after-failure');
  });

  it('refuses to overwrite a record changed outside this queue', async () => {
    const expected = structuredClone(records.get('recA')!);
    records.set('recA', { ...expected, treatmentMeasure: '外部已保存措施', handlerName: '外部人员' });

    await expect(gateway.updateFollowUp(update(), expected)).rejects.toBeInstanceOf(ConflictException);

    expect(put).not.toHaveBeenCalled();
    expect(records.get('recA')?.treatmentMeasure).toBe('外部已保存措施');
  });

  it('captures input and expected snapshot before queued caller mutations', async () => {
    const request = update(), expected = structuredClone(records.get('recA')!);
    const acceptedMeasure = request.treatmentMeasure, acceptedMutationId = request.clientMutationId;
    const pending = gateway.updateFollowUp(request, expected);
    request.recordId = 'recB'; request.treatmentMeasure = '调用后篡改内容'; request.clientMutationId = 'synthetic-mutated-id';
    expected.description = '调用后篡改预期快照';

    const result = await pending;

    expect(result.recordId).toBe('recA');
    expect(result.treatmentMeasure).toBe(acceptedMeasure);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toMatch(/\/records\/recA$/u);
    expect(put.mock.calls[0][1].fields['客户端变更ID']).toBe(acceptedMutationId);
    expect(records.get('recB')).toEqual(sample('recB'));
  });
});

describe('native follow-up measure Unicode boundaries at the real field adapters', () => {
  it.each([300, 500])('round-trips %i supplementary Unicode characters without truncation', size => {
    const measure = '😀'.repeat(size);
    const fields = buildTodayOperationsFollowUpUpdateFields({ ...update(), completed: true, treatmentMeasure: measure });
    const normalized = normalizeTodayOperationsFollowUpRecord({ record_id: 'recA', fields: {
      日期: Date.parse('2026-10-29T00:00:00.000Z'), 异常唯一键: 'synthetic-issue', 来源: '每日巡视',
      异常项: '合成异常', 异常说明: '合成说明', 楼栋: 'A楼', ...fields,
    } });

    expect(fields['处理措施']).toBe(measure);
    expect(normalized?.treatmentMeasure).toBe(measure);
    expect(Array.from(normalized!.treatmentMeasure)).toHaveLength(size);
  });

  it.each(['字'.repeat(501), '😀'.repeat(501)])('rejects 501 code points instead of silently truncating', measure => {
    expect(() => buildTodayOperationsFollowUpUpdateFields({ ...update(), treatmentMeasure: measure })).toThrow();
  });

  it('rejects completion with one supplementary character even though it has two UTF-16 code units', () => {
    expect(() => buildTodayOperationsFollowUpUpdateFields({ ...update(), completed: true, treatmentMeasure: '😀' })).toThrow();
  });
});
