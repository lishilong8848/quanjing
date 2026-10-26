import { InventoryStocktakeResultsGateway } from '../../server/modules/inventory-management/inventory-stocktake-results.gateway';
import { STOCKTAKE_RESULT_FIELDS } from '../../server/modules/inventory-management/inventory-stocktake-results.model';

describe('盘点结果飞书网关', () => {
  function setup() {
    const http = {
      axiosRef: {
        post: jest.fn().mockResolvedValue({
          data: { code: 0, tenant_access_token: 'test-token', expire: 3600 },
        }),
        request: jest.fn(),
      },
    };
    const inventory = {
      getFieldSchemas: jest.fn().mockResolvedValue(
        Object.entries(STOCKTAKE_RESULT_FIELDS).map(([fieldName, type]) => ({
          fieldName,
          type,
          writable: true,
        })),
      ),
      ensureTextField: jest.fn().mockResolvedValue(undefined),
    };
    const gateway = new InventoryStocktakeResultsGateway(
      http as any,
      inventory as any,
    );
    (gateway as any).token = {
      value: 'test-token',
      expiresAt: Date.now() + 100000,
    };
    return { gateway, http, inventory };
  }
  it('checks all typed fields and ensures only one month field, rejects a string impersonating a person field', async () => {
    const { gateway, inventory } = setup();
    await gateway.ensureSchema(['2026-10', '2026-10']);
    expect(inventory.ensureTextField).toHaveBeenCalledTimes(1);
    expect(inventory.ensureTextField.mock.calls[0][2]).toBe('2026年10月');
    const bad = setup();
    bad.inventory.getFieldSchemas.mockResolvedValue([
      { fieldName: '确认人', type: 1, writable: true },
    ]);
    await expect(bad.gateway.ensureSchema(['2026-10'])).rejects.toThrow(
      '缺失或类型不符',
    );
  });
  it('queries only identity fields, ignores user blank rows and rejects duplicate identities', async () => {
    const { gateway, http } = setup();
    http.axiosRef.request.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [
            { record_id: 'blank', fields: {} },
            {
              record_id: 'remote1',
              fields: { 库存条目ID: [{ text: 'stock1' }] },
            },
          ],
          has_more: false,
        },
      },
    });
    expect(await gateway.index()).toEqual(new Map([['stock1', 'remote1']]));
    expect(http.axiosRef.request.mock.calls[0][0].data).toMatchObject({
      field_names: ['库存条目ID'],
    });
    http.axiosRef.request.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [
            { record_id: 'a', fields: { 库存条目ID: 'dup' } },
            { record_id: 'b', fields: { 库存条目ID: 'dup' } },
          ],
          has_more: false,
        },
      },
    });
    await expect(gateway.index()).rejects.toThrow('库存条目ID重复');
  });
  it('uses the durable client token and fixed identity-only create payload', async () => {
    const { gateway, http } = setup();
    http.axiosRef.request.mockResolvedValue({
      data: { code: 0, data: { records: [{ record_id: 'remote' }] } },
    });
    await gateway.create(['stock1'], 'stable-uuid-token');
    expect(http.axiosRef.request.mock.calls[0][0]).toMatchObject({
      method: 'post',
      params: { client_token: 'stable-uuid-token', user_id_type: 'open_id' },
      data: { records: [{ fields: { 库存条目ID: 'stock1' } }] },
    });
  });
  it('does not report success until separate semantic readback matches typed values and stable IDs', async () => {
    const { gateway, http } = setup();
    const records = [
      {
        record_id: 'remote1',
        fields: {
          盘点状态: '已确认',
          实盘数量: 0,
          确认人: [{ id: 'ou_test' }],
        },
      },
    ];
    http.axiosRef.request
      .mockResolvedValueOnce({ data: { code: 0, data: {} } })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            records: [
              {
                record_id: 'remote1',
                fields: {
                  盘点状态: '已确认',
                  实盘数量: 0,
                  确认人: [{ id: 'ou_test', name: '外部名称' }],
                },
              },
            ],
          },
        },
      });
    await gateway.update(records);
    http.axiosRef.request
      .mockResolvedValueOnce({ data: { code: 0, data: {} } })
      .mockResolvedValueOnce({ data: { code: 0, data: { records: [] } } });
    await expect(gateway.update(records)).rejects.toThrow('回读记录缺失');
  });
  it('never returns or persists axios request headers in an error', async () => {
    const { gateway, http } = setup();
    http.axiosRef.request.mockRejectedValue({
      config: { headers: { Authorization: 'test-secret' } },
      message: 'test-secret',
    });
    await expect(gateway.index()).rejects.toThrow('网络或权限异常');
  });
});
