import {
  fetchEquipmentRepairRecords,
  EQUIPMENT_REPAIR_FIELDS,
} from '../../server/modules/equipment-lifecycle/equipment-repair-source.reader';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue('fixture'),
}));
const names = [...EQUIPMENT_REPAIR_FIELDS];
const schema = {
  fields: names.map((name, i) => ({ name, id: `f-${i}` })),
  has_more: false,
};
const page = (id = 'r1', rev = 10, more = false) => ({
  fields: names,
  record_id_list: [id],
  data: [names.map((n) => (n === '流程' ? ['未开始'] : null))],
  has_more: more,
  rev,
});
const http = (...pages: unknown[]) => ({
  axiosRef: {
    get: jest
      .fn()
      .mockResolvedValueOnce({ data: { code: 0, data: schema } })
      .mockImplementation(async () => ({
        data: { code: 0, data: pages.shift() },
      })),
  },
});
describe('current repair summary v3 reader', () => {
  it('reads the current status with repeated field projection and stable page revision', async () => {
    const client = http(page('r1', 10, true), page('r2'));
    const rows = await fetchEquipmentRepairRecords(client as never);
    expect(rows).toHaveLength(2);
    expect(rows[0].fields?.['流程']).toEqual(['未开始']);
    expect(client.axiosRef.get.mock.calls[1][1].paramsSerializer).toEqual({
      indexes: null,
    });
    expect(client.axiosRef.get.mock.calls[1][1].params.field_id).toHaveLength(
      names.length,
    );
  });
  it('rejects revision changes during pagination', async () =>
    expect(
      fetchEquipmentRepairRecords(
        http(page('r1', 10, true), page('r2', 11)) as never,
      ),
    ).rejects.toThrow('快照'));
  it('rejects duplicate record identities', async () =>
    expect(
      fetchEquipmentRepairRecords(
        http(page('r1', 10, true), page('r1')) as never,
      ),
    ).rejects.toThrow('重复'));
  it('rejects incomplete row projections', async () =>
    expect(
      fetchEquipmentRepairRecords(
        http({ ...page(), fields: names.slice(1) }) as never,
      ),
    ).rejects.toThrow('快照'));
  it('rejects a missing association field', async () => {
    const get = jest
      .fn()
      .mockResolvedValue({
        data: {
          code: 0,
          data: { fields: schema.fields.slice(1), has_more: false },
        },
      });
    await expect(
      fetchEquipmentRepairRecords({ axiosRef: { get } } as never),
    ).rejects.toThrow('字段结构');
  });
});
