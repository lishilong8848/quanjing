import { ThresholdBitableGateway } from '../../server/modules/threshold-management/threshold-bitable.gateway';
import { THRESHOLD_BITABLE_SCHEMA as schema, thresholdToBitableFields } from '../../shared/threshold-bitable';
import electrical from '../../shared/electrical-thresholds.seed.json';
import hvac from '../../shared/hvac-thresholds.seed.json';
import type { ThresholdRecord } from '../../shared/threshold-management.interface';

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue('isolated-token'),
}));

function fixture() {
  const tables = Object.entries(schema.tables);
  const revisions = new Map(tables.map(([, table]) => [table, 1]));
  let metadataReads = 0, active = 0, peak = 0, changedDuringRead = false;
  const pages: string[] = [];
  const request = jest.fn(async (config) => {
    let data;
    if (config.url.endsWith('/tables')) {
      metadataReads++;
      data = { tables: tables.map(([, id], at) => ({ id, records_count: 1, rev: revisions.get(id)! + (changedDuringRead && metadataReads % 2 === 0 && at === 0 ? 1 : 0) })), total: tables.length };
    } else if (config.url.endsWith('/fields')) {
      data = { items: Object.values(schema.fields).map(field_name => ({ field_name, type: 1 })), has_more: false };
    } else {
      expect(config.method).toBe('POST');
      expect(config.url.endsWith('/records/search')).toBe(true);
      const [profession, table] = tables.find(([, table]) => config.url.includes(table))!;
      pages.push(table); active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => setImmediate(resolve)); active--;
      const record = (profession === '电气' ? electrical.records[0] : hvac.records[0]) as ThresholdRecord;
      data = { items: [{ record_id: 'remote-' + table, fields: thresholdToBitableFields(record) }], has_more: false };
    }
    return { data: { code: 0, data } };
  });
  return { gateway: new ThresholdBitableGateway({ axiosRef: { request } } as never), request, pages, revisions,
    tables, peak: () => peak, changeDuringRead: (value: boolean) => { changedDuringRead = value; } };
}

test('parallelizes table reads and reuses only snapshots with unchanged cloud revision and count', async () => {
  const f = fixture();
  const first = await f.gateway.readSnapshot();
  expect(first).toHaveLength(2); expect(f.peak()).toBe(2); expect(f.pages).toHaveLength(2);
  first[0].value = 'caller must not change the verified snapshot';
  const second = await f.gateway.readSnapshot();
  expect(second[0].value).not.toBe(first[0].value); expect(f.pages).toHaveLength(2);
  f.revisions.set(f.tables[0][1], 2);
  await f.gateway.readSnapshot();
  expect(f.pages).toEqual([f.tables[0][1], f.tables[1][1], f.tables[0][1]]);
});

test('does not cache a snapshot whose revision changed during the read', async () => {
  const f = fixture(); f.changeDuringRead(true);
  await expect(f.gateway.readSnapshot()).rejects.toThrow('内容已变化');
  expect(f.pages).toHaveLength(2);
  f.changeDuringRead(false);
  await f.gateway.readSnapshot();
  expect(f.pages).toHaveLength(4);
});

test('allows a slow complete snapshot beyond the former one-minute limit without skipping validation', async () => {
  const f = fixture(); let clock = 0;
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (config) => {
    if (config.url.endsWith('/fields')) clock += 35000;
    return original(config);
  });
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  try { await expect(f.gateway.readSnapshot()).resolves.toHaveLength(2); }
  finally { jest.restoreAllMocks(); }
  expect(f.pages).toHaveLength(2);
});
