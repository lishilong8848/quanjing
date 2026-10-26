const invalidateBitableRecordCache = jest.fn();

jest.mock('../../common/config/external-services.config', () => ({
  getFeishuAuthPayload: () => ({ app_id: 'app-id', app_secret: '***' }),
  parseFeishuBitableLink: () => ({ appToken: 'app-contract' }),
  readEnv: (key: string) =>
    ({
      FEISHU_CONTRACT_APP_TOKEN: 'app-contract',
      FEISHU_CONTRACT_FRAMEWORK_TABLE_ID: 'tbl-framework',
      FEISHU_CONTRACT_EXECUTION_TABLE_ID: 'tbl-execution',
      FEISHU_CONTRACT_SUPPLIER_TABLE_ID: 'tbl-supplier',
      FEISHU_CONTRACT_ORGANIZATION_TABLE_ID: 'tbl-organization',
    })[key] || '',
}));

jest.mock('../../common/feishu/bitable-direct-read', () => ({
  invalidateBitableRecordCache,
  resolveBitableAppToken: async () => 'app-contract',
}));

import {
  ContractCreateIndeterminateError,
  ContractCreationGateway,
  type ContractCreateUploadFile,
} from './contract-creation.gateway';

describe('ContractCreationGateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists every page of the real field metadata', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ field_id: 'fld-code', field_name: '合同编号', type: 1 }],
            has_more: true,
            page_token: 'page-2',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ field_id: 'fld-name', field_name: '合同名称', type: 1 }],
            has_more: false,
          },
        },
      });
    const gateway = gatewayWith({
      get,
      post: tenantTokenPost(),
      put: jest.fn(),
      delete: jest.fn(),
    });

    await expect(gateway.listFields('execution')).resolves.toEqual([
      { field_id: 'fld-code', field_name: '合同编号', type: 1 },
      { field_id: 'fld-name', field_name: '合同名称', type: 1 },
    ]);
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/tables/tbl-execution/fields'),
      expect.objectContaining({
        params: { page_size: 200, page_token: 'page-2' },
      }),
    );
  });

  it('lists every record page for option resolution', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec-1', fields: { 公司单位: '供应商 A' } }],
            has_more: true,
            page_token: 'page-2',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [{ record_id: 'rec-2', fields: { 公司单位: '供应商 B' } }],
            has_more: false,
          },
        },
      });
    const gateway = gatewayWith({
      get,
      post: tenantTokenPost(),
      put: jest.fn(),
      delete: jest.fn(),
    });

    const records = await gateway.listRecords('supplier');
    expect(records.map((item) => item.record_id)).toEqual(['rec-1', 'rec-2']);
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/tables/tbl-supplier/records'),
      expect.objectContaining({
        params: {
          page_size: 500,
          page_token: 'page-2',
          user_id_type: 'open_id',
        },
      }),
    );
  });

  it('creates idempotently, reads, updates and deletes one Base record', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({
        data: { code: 0, data: { record: { record_id: 'rec-created' } } },
      });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: { record_id: 'rec-created', fields: { 合同名称: '测试' } },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const del = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const gateway = gatewayWith({ get, post, put, delete: del });

    const recordId = await gateway.createRecord(
      'execution',
      { 合同名称: '测试' },
      '6b8fbc5a-1047-4e40-b083-906960893894',
    );
    await expect(gateway.getRecord('execution', recordId)).resolves.toEqual(
      expect.objectContaining({ record_id: recordId }),
    );
    await gateway.updateRecord('execution', recordId, {
      合同附件: [{ file_token: 'box-pdf' }],
    });
    await gateway.deleteRecord('execution', recordId);

    expect(post).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/tables/tbl-execution/records'),
      { fields: { 合同名称: '测试' } },
      expect.objectContaining({
        params: {
          client_token: '6b8fbc5a-1047-4e40-b083-906960893894',
          ignore_consistency_check: true,
          user_id_type: 'open_id',
        },
      }),
    );
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('/records/rec-created'),
      { fields: { 合同附件: [{ file_token: 'box-pdf' }] } },
      expect.objectContaining({
        params: { ignore_consistency_check: true, user_id_type: 'open_id' },
      }),
    );
    expect(del).toHaveBeenCalledWith(
      expect.stringContaining('/records/rec-created'),
      expect.objectContaining({
        params: { ignore_consistency_check: true },
      }),
    );
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'app-contract',
      tableId: 'tbl-execution',
    });
  });

  it.each([
    ['a missing code', {}],
    ['a null code', { code: null }],
    ['a null payload', null],
    ['a non-object payload', 'ok'],
  ])('rejects delete responses with %s', async (_label, payload) => {
    const del = jest.fn().mockResolvedValue({ data: payload });
    const gateway = gatewayWith({
      get: jest.fn(),
      post: tenantTokenPost(),
      put: jest.fn(),
      delete: del,
    });

    await expect(
      gateway.deleteRecord('execution', 'rec-created'),
    ).rejects.toThrow('删除01-执行合同信息记录失败');
    expect(invalidateBitableRecordCache).not.toHaveBeenCalled();
  });

  it('retries one ambiguous create failure with the same client token', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce({
        data: { code: 0, data: { record: { record_id: 'rec-created' } } },
      });
    const gateway = gatewayWith({
      get: jest.fn(),
      post,
      put: jest.fn(),
      delete: jest.fn(),
    });
    const clientToken = '6b8fbc5a-1047-4e40-b083-906960893894';

    await expect(
      gateway.createRecord('execution', { contractName: 'test' }, clientToken),
    ).resolves.toBe('rec-created');

    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[1][2].params.client_token).toBe(clientToken);
    expect(post.mock.calls[2][2].params.client_token).toBe(clientToken);
  });

  it('does not retry a Base business error response', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({ data: { code: 1254060, msg: 'invalid field' } });
    const gateway = gatewayWith({
      get: jest.fn(),
      post,
      put: jest.fn(),
      delete: jest.fn(),
    });

    await expect(
      gateway.createRecord('execution', { contractName: 'test' }, 'token'),
    ).rejects.toThrow('invalid field');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('reports the table and client token after a second ambiguous create failure', async () => {
    const secondError = new Error('request timed out again');
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockRejectedValueOnce(secondError);
    const gateway = gatewayWith({
      get: jest.fn(),
      post,
      put: jest.fn(),
      delete: jest.fn(),
    });

    const error = await gateway
      .createRecord('execution', { contractName: 'test' }, 'token')
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(ContractCreateIndeterminateError);
    expect(error).toEqual(
      expect.objectContaining({
        kind: 'execution',
        clientToken: 'token',
        cause: secondError,
      }),
    );
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('uploads a PDF as bitable_file and returns the file token', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({
        data: { code: 0, data: { file_token: 'box-pdf' } },
      });
    const gateway = gatewayWith({
      get: jest.fn(),
      post,
      put: jest.fn(),
      delete: jest.fn(),
    });
    const file: ContractCreateUploadFile = {
      originalname: '../合同原件.pdf',
      mimetype: 'application/pdf',
      size: 8,
      buffer: Buffer.from('%PDF-1.4'),
    };

    await expect(gateway.uploadPdf(file)).resolves.toBe('box-pdf');
    expect(post).toHaveBeenNthCalledWith(
      2,
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
      expect.objectContaining({ append: expect.any(Function) }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tenant-token',
        }),
        maxBodyLength: Infinity,
      }),
    );
  });
});

function tenantTokenPost() {
  return jest.fn().mockResolvedValue(tenantTokenResponse());
}

function tenantTokenResponse() {
  return {
    data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
  };
}

function gatewayWith(axiosRef: {
  get: jest.Mock;
  post: jest.Mock;
  put: jest.Mock;
  delete: jest.Mock;
}) {
  return new ContractCreationGateway({ axiosRef } as never);
}
