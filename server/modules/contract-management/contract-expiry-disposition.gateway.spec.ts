import { BadGatewayException } from '@nestjs/common';

const invalidateBitableRecordCache = jest.fn();

jest.mock('../../common/config/external-services.config', () => ({
  getFeishuAuthPayload: () => ({ app_id: 'app-id', app_secret: '***' }),
  parseFeishuBitableLink: () => ({ appToken: 'app-contract' }),
  readEnv: (key: string) =>
    ({
      FEISHU_CONTRACT_APP_TOKEN: 'app-contract',
      FEISHU_CONTRACT_EXECUTION_TABLE_ID: 'tbl-contracts',
    })[key] || '',
}));

jest.mock('../../common/feishu/bitable-direct-read', () => ({
  invalidateBitableRecordCache,
  resolveBitableAppToken: async () => 'app-contract',
}));

import { ContractExpiryDispositionGateway } from './contract-expiry-disposition.gateway';

describe('ContractExpiryDispositionGateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the missing disposition field before updating the contract record', async () => {
    const axiosRef = {
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                field_id: 'fld-end-date',
                field_name: '合同结束日期',
                type: 5,
              },
            ],
            has_more: false,
          },
        },
      }),
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({ data: { code: 0, data: { field: {} } } }),
      put: jest.fn().mockResolvedValue({ data: { code: 0 } }),
    };
    const gateway = new ContractExpiryDispositionGateway({ axiosRef } as never);
    const fields = {
      合同结束日期: Date.parse('2027-07-31T00:00:00+08:00'),
      合同到期处置: '已续期至 2027-07-31',
    };

    await gateway.updateContract('rec-contract-1', fields);

    expect(axiosRef.post).toHaveBeenNthCalledWith(
      2,
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-contract/tables/tbl-contracts/fields',
      { field_name: '合同到期处置', type: 1 },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
    expect(axiosRef.put).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-contract/tables/tbl-contracts/records/rec-contract-1',
      { fields },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'app-contract',
      tableId: 'tbl-contracts',
    });
  });

  it('rejects a non-date contract end field instead of sending an unsafe write', async () => {
    const axiosRef = {
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                field_id: 'fld-end-date',
                field_name: '合同结束日期',
                type: 1,
              },
              {
                field_id: 'fld-disposition',
                field_name: '合同到期处置',
                type: 1,
              },
            ],
            has_more: false,
          },
        },
      }),
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      put: jest.fn(),
    };
    const gateway = new ContractExpiryDispositionGateway({ axiosRef } as never);

    await expect(
      gateway.updateContract('rec-contract-2', {
        合同结束日期: Date.now(),
        合同到期处置: '已续期',
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(axiosRef.put).not.toHaveBeenCalled();
  });

  it('retries a transient record update and uses consistency-safe query params', async () => {
    const transientError = Object.assign(new Error('request timed out'), {
      code: 'ECONNABORTED',
      isAxiosError: true,
    });
    const axiosRef = {
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                field_id: 'fld-disposition',
                field_name: '合同到期处置',
                type: 1,
              },
            ],
            has_more: false,
          },
        },
      }),
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      put: jest
        .fn()
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ data: { code: 0 } }),
    };
    const gateway = new ContractExpiryDispositionGateway({ axiosRef } as never);

    await gateway.updateContract('rec-contract-retry', {
      合同到期处置: '到期作废',
    });

    expect(axiosRef.put).toHaveBeenCalledTimes(2);
    expect(axiosRef.put).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app-contract/tables/tbl-contracts/records/rec-contract-retry',
      { fields: { 合同到期处置: '到期作废' } },
      expect.objectContaining({
        params: {
          ignore_consistency_check: true,
          user_id_type: 'open_id',
        },
      }),
    );
    expect(invalidateBitableRecordCache).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized upstream error when the record update is rejected', async () => {
    const axiosRef = {
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                field_id: 'fld-disposition',
                field_name: '合同到期处置',
                type: 1,
              },
            ],
            has_more: false,
          },
        },
      }),
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      put: jest.fn().mockRejectedValue(
        Object.assign(new Error('Bearer secret-token'), {
          isAxiosError: true,
          response: { status: 403 },
        }),
      ),
    };
    const gateway = new ContractExpiryDispositionGateway({ axiosRef } as never);

    await expect(
      gateway.updateContract('rec-contract-denied', {
        合同到期处置: '到期作废',
      }),
    ).rejects.toMatchObject({
      message: '飞书多维表拒绝更新合同，请检查应用的记录编辑权限',
    });
    await gateway
      .updateContract('rec-contract-denied', { 合同到期处置: '到期作废' })
      .catch((error: unknown) => {
        expect(String(error)).not.toContain('secret-token');
      });
  });
});
