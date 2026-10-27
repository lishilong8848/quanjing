import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

const invalidateBitableRecordCache = jest.fn();
const resolveBitableAppToken = jest.fn(async () => 'app-actual');
const mockManagerSourceEnv: Record<string, string> = {};

function resetManagerSourceEnv() {
  for (const key of Object.keys(mockManagerSourceEnv)) {
    delete mockManagerSourceEnv[key];
  }
  Object.assign(mockManagerSourceEnv, {
    FEISHU_PURCHASE_INVENTORY_APP_TOKEN: 'app-organization',
    FEISHU_PURCHASE_ORGANIZATION_TABLE_ID: 'tblOrganization',
  });
}

resetManagerSourceEnv();

jest.mock('../../server/common/config/external-services.config', () => ({
  getFeishuAuthPayload: () => ({ app_id: 'test-app', app_secret: '***' }),
  parseFeishuBitableLink: (value: string) =>
    value.includes('app-manager-from-url')
      ? {
          appToken: 'app-manager-from-url',
          wikiToken: '',
          tableId: 'tblManagerFromUrl',
          viewId: '',
        }
      : {
          appToken: 'app-from-purchase-link',
          wikiToken: '',
          tableId: '',
          viewId: '',
        },
  readEnv: (name: string) => mockManagerSourceEnv[name] || '',
}));

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  invalidateBitableRecordCache,
  resolveBitableAppToken,
}));

jest.mock(
  '../../server/modules/weather-warning/weather-warning-registration.config',
  () => ({
    loadWeatherWarningRegistrationRuntimeConfig: () => ({
      appToken: 'app-from-link',
      wikiToken: '',
      registrationTableId: 'tblRegistrations',
      registrationFields: {
        checker: '检查人',
        manager: '机房经理',
      },
    }),
  }),
);

import {
  WEATHER_WARNING_REGISTRATION_MAX_IMAGE_BYTES,
  WeatherWarningRegistrationGateway,
  type WeatherWarningRegistrationUploadFile,
} from '../../server/modules/weather-warning/weather-warning-registration.gateway';

describe('WeatherWarningRegistrationGateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetManagerSourceEnv();
    resolveBitableAppToken.mockResolvedValue('app-actual');
  });

  it('lists fresh candidates with only checker and manager fields on every call', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce(recordSearchResponse('rec-first'))
      .mockResolvedValueOnce(recordSearchResponse('rec-second'));
    const gateway = gatewayWith({ get: jest.fn(), post });

    await expect(gateway.listCandidateRecords()).resolves.toEqual([
      expect.objectContaining({ record_id: 'rec-first' }),
    ]);
    await expect(gateway.listCandidateRecords()).resolves.toEqual([
      expect.objectContaining({ record_id: 'rec-second' }),
    ]);

    expect(post).toHaveBeenCalledTimes(3);
    for (const call of [post.mock.calls[1], post.mock.calls[2]]) {
      expect(call[0]).toContain(
        '/apps/app-actual/tables/tblRegistrations/records/search',
      );
      expect(call[1]).toEqual({ field_names: ['检查人', '机房经理'] });
      expect(call[2]).toEqual(
        expect.objectContaining({
          params: {
            page_size: 500,
            page_token: undefined,
            user_id_type: 'open_id',
          },
        }),
      );
    }
  });

  it('lists manager candidates from the organization table by manager positions', async () => {
    const post = jest.fn().mockResolvedValueOnce(tenantTokenResponse());
    const get = jest
      .fn()
      .mockResolvedValueOnce(organizationManagerSearchResponse());
    const gateway = gatewayWith({ get, post });

    await expect(gateway.listManagerCandidateRecords()).resolves.toEqual([
      expect.objectContaining({ record_id: 'rec-manager' }),
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toContain(
      '/apps/app-organization/tables/tblOrganization/records',
    );
    expect(get.mock.calls[0][0]).not.toContain('/search');
    expect(get.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        params: {
          page_size: 500,
          page_token: undefined,
          user_id_type: 'open_id',
        },
      }),
    );
    expect(JSON.stringify(get.mock.calls[0])).not.toContain('field_names');
    expect(JSON.stringify(get.mock.calls[0])).not.toContain('filter');
  });

  it('uses a dedicated manager Base URL without requiring purchase fallback variables', async () => {
    delete mockManagerSourceEnv.FEISHU_PURCHASE_INVENTORY_APP_TOKEN;
    delete mockManagerSourceEnv.FEISHU_PURCHASE_ORGANIZATION_TABLE_ID;
    mockManagerSourceEnv.FEISHU_WEATHER_WARNING_MANAGER_SOURCE_URL =
      'https://vnet.feishu.cn/base/app-manager-from-url?table=tblManagerFromUrl';
    const post = jest.fn().mockResolvedValueOnce(tenantTokenResponse());
    const get = jest
      .fn()
      .mockResolvedValueOnce(organizationManagerSearchResponse());
    const gateway = gatewayWith({ get, post });

    await expect(gateway.listManagerCandidateRecords()).resolves.toHaveLength(
      1,
    );

    expect(get.mock.calls[0][0]).toContain(
      '/apps/app-manager-from-url/tables/tblManagerFromUrl/records',
    );
  });

  it('keeps a dedicated manager Base URL together instead of mixing purchase fallback values', async () => {
    mockManagerSourceEnv.FEISHU_WEATHER_WARNING_MANAGER_SOURCE_URL =
      'https://vnet.feishu.cn/base/app-manager-from-url?table=tblManagerFromUrl';
    const post = jest.fn().mockResolvedValueOnce(tenantTokenResponse());
    const get = jest
      .fn()
      .mockResolvedValueOnce(organizationManagerSearchResponse());
    const gateway = gatewayWith({ get, post });

    await expect(gateway.listManagerCandidateRecords()).resolves.toHaveLength(
      1,
    );

    expect(get.mock.calls[0][0]).toContain(
      '/apps/app-manager-from-url/tables/tblManagerFromUrl/records',
    );
    expect(get.mock.calls[0][0]).not.toContain('app-organization');
    expect(get.mock.calls[0][0]).not.toContain('tblOrganization');
  });

  it('uploads a sanitized image as a bitable_file under the resolved app token', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({
        data: { code: 0, msg: 'success', data: { file_token: 'file-image' } },
      });
    const gateway = gatewayWith({ get: jest.fn(), post });
    const file: WeatherWarningRegistrationUploadFile = {
      originalname: '../现场\r\n图.PNG',
      mimetype: 'image/png',
      size: 8,
      buffer: imageBuffer('image/png'),
    };

    await expect(gateway.uploadImage(file)).resolves.toBe('file-image');

    const uploadCall = post.mock.calls[1];
    const form = uploadCall[1] as {
      getBuffer(): Buffer;
      getHeaders(): Record<string, string>;
    };
    const formBody = form.getBuffer().toString('utf8');
    expect(uploadCall[0]).toBe(
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
    );
    expect(formBody).toContain('name="parent_type"');
    expect(formBody).toContain('bitable_file');
    expect(formBody).toContain('name="parent_node"');
    expect(formBody).toContain('app-actual');
    expect(formBody).toContain('name="size"');
    expect(formBody).toContain('8');
    expect(formBody).toContain('filename=".._现场__图.PNG"');
    expect(formBody).not.toContain('../现场');
    expect(uploadCall[2]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tenant-token',
        }),
        maxBodyLength: Infinity,
      }),
    );
  });

  it('retries one timed-out media upload with a fresh multipart body and an upload-specific timeout', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(networkError('ECONNABORTED'))
      .mockResolvedValueOnce({
        data: { code: 0, msg: 'success', data: { file_token: 'file-image' } },
      });
    const gateway = gatewayWith({ get: jest.fn(), post });

    await expect(
      gateway.uploadImage(pngFile(), { deadlineAt: Date.now() + 50_000 }),
    ).resolves.toBe('file-image');

    expect(post).toHaveBeenCalledTimes(3);
    const firstUpload = post.mock.calls[1];
    const retryUpload = post.mock.calls[2];
    expect(firstUpload[1]).not.toBe(retryUpload[1]);
    for (const uploadCall of [firstUpload, retryUpload]) {
      expect(uploadCall[2]).toEqual(
        expect.objectContaining({
          timeout: expect.any(Number),
          maxBodyLength: Infinity,
        }),
      );
      expect(uploadCall[2].timeout).toBeGreaterThan(8_000);
      expect(uploadCall[2].timeout).toBeLessThanOrEqual(25_000);
      expect(
        (uploadCall[1] as { getBuffer(): Buffer }).getBuffer().toString('utf8'),
      ).toContain('name="file"');
    }
  });

  it('stops after one media upload retry when the outcome is still unknown', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(networkError('ETIMEDOUT'))
      .mockRejectedValueOnce(networkError('ECONNRESET'));

    await expect(
      gatewayWith({ get: jest.fn(), post }).uploadImage(pngFile()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('does not retry a media upload when Feishu returned an HTTP response', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(
        Object.assign(new Error('HTTP 502'), {
          response: {
            status: 502,
            data: { code: 234001, msg: 'invalid media', data: null },
          },
        }),
      );

    await expect(
      gatewayWith({ get: jest.fn(), post }).uploadImage(pngFile()),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('does not issue a media upload retry after cancellation during backoff', async () => {
    const controller = new AbortController();
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(networkError('ECONNRESET'));
    const result = gatewayWith({ get: jest.fn(), post }).uploadImage(pngFile(), {
      signal: controller.signal,
      deadlineAt: Date.now() + 50_000,
    });

    for (let attempt = 0; attempt < 20 && post.mock.calls.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(post).toHaveBeenCalledTimes(2);
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.webp', 'image/webp'],
    ['scan.pdf', 'application/pdf'],
  ])(
    'accepts an extension matching %s / %s',
    async (originalname, mimetype) => {
      const post = jest
        .fn()
        .mockResolvedValueOnce(tenantTokenResponse())
        .mockResolvedValueOnce({
          data: { code: 0, msg: 'success', data: { file_token: 'file-image' } },
        });
      const gateway = gatewayWith({ get: jest.fn(), post });

      await expect(
        gateway.uploadImage({
          originalname,
          mimetype,
          size: imageBuffer(mimetype).length,
          buffer: imageBuffer(mimetype),
        }),
      ).resolves.toBe('file-image');
    },
  );

  it.each([
    [
      'an empty file',
      {
        originalname: 'empty.png',
        mimetype: 'image/png',
        size: 0,
        buffer: Buffer.alloc(0),
      },
    ],
    [
      'a MIME-extension mismatch',
      {
        originalname: 'fake.jpg',
        mimetype: 'image/png',
        size: 4,
        buffer: Buffer.from('data'),
      },
    ],
    [
      'an unsupported MIME type',
      {
        originalname: 'image.gif',
        mimetype: 'image/gif',
        size: 4,
        buffer: Buffer.from('data'),
      },
    ],
    [
      'inconsistent size metadata',
      {
        originalname: 'image.png',
        mimetype: 'image/png',
        size: 5,
        buffer: Buffer.from('data'),
      },
    ],
    [
      'a file whose bytes do not match its declared image type',
      {
        originalname: 'disguised.png',
        mimetype: 'image/png',
        size: 8,
        buffer: Buffer.from('not-png!'),
      },
    ],
    [
      'a file whose bytes do not match its declared PDF type',
      {
        originalname: 'disguised.pdf',
        mimetype: 'application/pdf',
        size: 7,
        buffer: Buffer.from('not-pdf'),
      },
    ],
    [
      'an oversized image',
      {
        originalname: 'large.png',
        mimetype: 'image/png',
        size: WEATHER_WARNING_REGISTRATION_MAX_IMAGE_BYTES + 1,
        buffer: Buffer.alloc(WEATHER_WARNING_REGISTRATION_MAX_IMAGE_BYTES + 1),
      },
    ],
  ])('rejects %s before any network request', async (label, file) => {
    const post =
      label === 'a file whose bytes do not match its declared image type'
        ? jest
            .fn()
            .mockResolvedValueOnce(tenantTokenResponse())
            .mockResolvedValueOnce({
              data: {
                code: 0,
                msg: 'success',
                data: { file_token: 'unexpected-token' },
              },
            })
        : jest.fn();
    const gateway = gatewayWith({ get: jest.fn(), post });

    await expect(
      gateway.uploadImage(file as WeatherWarningRegistrationUploadFile),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('maps upload business errors and a missing file token to BadGateway', async () => {
    const businessPost = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({
        data: { code: 234001, msg: 'invalid media', data: null },
      });
    const missingIdPost = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({
        data: { code: 0, msg: 'success', data: {} },
      });

    await expect(
      gatewayWith({ get: jest.fn(), post: businessPost }).uploadImage(
        pngFile(),
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    await expect(
      gatewayWith({ get: jest.fn(), post: missingIdPost }).uploadImage(
        pngFile(),
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(businessPost).toHaveBeenCalledTimes(2);
    expect(missingIdPost).toHaveBeenCalledTimes(2);
  });

  it('creates with the mutation UUID and open_id mode without invalidating cache', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce(createResponse('rec-created'));
    const gateway = gatewayWith({ get: jest.fn(), post });
    const fields = { 楼栋: 'A楼' };
    const mutationId = '123e4567-e89b-42d3-a456-426614174000';

    await expect(gateway.createRecord(fields, mutationId)).resolves.toBe(
      'rec-created',
    );

    expect(post).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/tables/tblRegistrations/records'),
      { fields },
      expect.objectContaining({
        params: {
          client_token: mutationId,
          ignore_consistency_check: true,
          user_id_type: 'open_id',
        },
      }),
    );
    expect(invalidateBitableRecordCache).not.toHaveBeenCalled();
  });

  it('retries one unknown create result with the identical mutation UUID', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(networkError('ECONNRESET'))
      .mockResolvedValueOnce(createResponse('rec-created'));
    const gateway = gatewayWith({ get: jest.fn(), post });
    const mutationId = '123e4567-e89b-42d3-a456-426614174000';

    await expect(
      gateway.createRecord({ 楼栋: 'B楼' }, mutationId),
    ).resolves.toBe('rec-created');

    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[1][2].params.client_token).toBe(mutationId);
    expect(post.mock.calls[2][2].params.client_token).toBe(mutationId);
  });

  it('does not retry a create business error and rejects missing record_id', async () => {
    const businessPost = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({
        data: { code: 1254060, msg: 'invalid field', data: null },
      });
    const missingIdPost = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce({
        data: { code: 0, msg: 'success', data: { record: {} } },
      });

    await expect(
      gatewayWith({ get: jest.fn(), post: businessPost }).createRecord(
        {},
        '123e4567-e89b-42d3-a456-426614174000',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(businessPost).toHaveBeenCalledTimes(2);

    await expect(
      gatewayWith({ get: jest.fn(), post: missingIdPost }).createRecord(
        {},
        '123e4567-e89b-42d3-a456-426614174000',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('does not retry a rejected HTTP response whose outcome is known', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(
        Object.assign(new Error('request failed with status 400'), {
          response: {
            status: 400,
            data: { code: 1254060, msg: 'invalid field', data: null },
          },
        }),
      );

    await expect(
      gatewayWith({ get: jest.fn(), post }).createRecord(
        {},
        '123e4567-e89b-42d3-a456-426614174000',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('reports ServiceUnavailable after two unknown create outcomes', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(networkError('ETIMEDOUT'))
      .mockRejectedValueOnce(networkError('ECONNRESET'));

    await expect(
      gatewayWith({ get: jest.fn(), post }).createRecord(
        {},
        '123e4567-e89b-42d3-a456-426614174000',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['ERR_CANCELED', 'CanceledError'],
    ['ECANCELED', 'AbortError'],
    [undefined, 'Error'],
  ])(
    'does not retry a non-network create failure (%s / %s)',
    async (code, name) => {
      const error = Object.assign(new Error('internal failure'), {
        ...(code ? { code } : {}),
        name,
        isAxiosError: name !== 'Error',
      });
      const post = jest
        .fn()
        .mockResolvedValueOnce(tenantTokenResponse())
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(createResponse('unexpected-retry'));
      const gateway = gatewayWith({ get: jest.fn(), post });

      await expect(
        gateway.createRecord({}, '123e4567-e89b-42d3-a456-426614174000'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(post).toHaveBeenCalledTimes(2);
    },
  );

  it('retries an Axios network error without a response exactly once', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockRejectedValueOnce(
        Object.assign(new Error('socket reset'), {
          name: 'AxiosError',
          code: 'ECONNRESET',
          isAxiosError: true,
          request: {},
        }),
      )
      .mockResolvedValueOnce(createResponse('rec-created'));

    await expect(
      gatewayWith({ get: jest.fn(), post }).createRecord(
        {},
        '123e4567-e89b-42d3-a456-426614174000',
      ),
    ).resolves.toBe('rec-created');
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('fails an expired deadline before making an HTTP request', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce(createResponse('unexpected-create'));
    const gateway = controlledGateway(gatewayWith({ get: jest.fn(), post }));

    await expect(
      gateway.createRecord({}, '123e4567-e89b-42d3-a456-426614174000', {
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(post).not.toHaveBeenCalled();
  });

  it('passes AbortSignal and a bounded timeout to every Axios request', async () => {
    const controller = new AbortController();
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce(createResponse('rec-created'));
    const gateway = controlledGateway(gatewayWith({ get: jest.fn(), post }));
    const deadlineAt = Date.now() + 5_000;

    await gateway.createRecord({}, '123e4567-e89b-42d3-a456-426614174000', {
      signal: controller.signal,
      deadlineAt,
    });

    for (const config of [post.mock.calls[0][2], post.mock.calls[1][2]]) {
      expect(config.signal).toBe(controller.signal);
      expect(config.timeout).toBeGreaterThan(0);
      expect(config.timeout).toBeLessThanOrEqual(5_000);
      expect(config.timeout).toBeLessThanOrEqual(8_000);
    }
  });

  it('reads a record by ID with bounded retries without invalidating cache', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(networkError('ECONNRESET'))
      .mockResolvedValueOnce({
        data: { code: 1254043, msg: 'record not found', data: null },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          msg: 'success',
          data: {
            record: { record_id: 'rec/created', fields: { 楼栋: 'A楼' } },
          },
        },
      });
    const wait = jest.fn(async (_delayMs: number) => undefined);
    const gateway = gatewayWith({ get, post: tenantTokenPost() });

    await expect(gateway.getRecord('rec/created', wait)).resolves.toEqual({
      record_id: 'rec/created',
      fields: { 楼栋: 'A楼' },
    });

    expect(wait).toHaveBeenNthCalledWith(1, 250);
    expect(wait).toHaveBeenNthCalledWith(2, 500);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[0][0]).toContain('/records/rec%2Fcreated');
    expect(invalidateBitableRecordCache).not.toHaveBeenCalled();
  });

  it('deletes one exact simulation record and confirms the same record ID is absent', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          msg: 'success',
          data: { record: { record_id: 'rec/test', fields: {} } },
        },
      })
      .mockResolvedValueOnce({
        data: { code: 1254043, msg: 'record not found', data: null },
      });
    const remove = jest.fn().mockResolvedValue({
      data: { code: 0, msg: 'success', data: {} },
    });
    const wait = jest.fn(async (_delayMs: number) => undefined);
    const gateway = gatewayWith({
      get,
      post: tenantTokenPost(),
      delete: remove,
    });
    const cleanup = (
      gateway as unknown as {
        deleteRecordAndConfirmAbsent?: (
          recordId: string,
          waitBeforeRetry: (delayMs: number) => Promise<void>,
        ) => Promise<void>;
      }
    ).deleteRecordAndConfirmAbsent;

    expect(cleanup).toBeDefined();
    await expect(
      cleanup!.call(gateway, 'rec/test', wait),
    ).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toContain('/records/rec%2Ftest');
    expect(get).toHaveBeenCalledTimes(2);
    expect(
      get.mock.calls.every(([url]) => url.includes('/records/rec%2Ftest')),
    ).toBe(true);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it('fails cleanup when the exact simulation record still exists after bounded confirmation', async () => {
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        msg: 'success',
        data: { record: { record_id: 'rec-residue', fields: {} } },
      },
    });
    const remove = jest.fn().mockResolvedValue({
      data: { code: 0, msg: 'success', data: {} },
    });
    const wait = jest.fn(async (_delayMs: number) => undefined);
    const gateway = gatewayWith({
      get,
      post: tenantTokenPost(),
      delete: remove,
    });
    const cleanup = (
      gateway as unknown as {
        deleteRecordAndConfirmAbsent?: (
          recordId: string,
          waitBeforeRetry: (delayMs: number) => Promise<void>,
        ) => Promise<void>;
      }
    ).deleteRecordAndConfirmAbsent;

    expect(cleanup).toBeDefined();
    await expect(
      cleanup!.call(gateway, 'rec-residue', wait),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1000]);
  });

  it('treats an already deleted simulation record as idempotent after exact confirmation', async () => {
    const get = jest.fn().mockResolvedValue({
      data: { code: 1254043, msg: 'record not found', data: null },
    });
    const remove = jest.fn().mockResolvedValue({
      data: { code: 1254043, msg: 'record not found', data: null },
    });
    const gateway = gatewayWith({
      get,
      post: tenantTokenPost(),
      delete: remove,
    });
    const cleanup = (
      gateway as unknown as {
        deleteRecordAndConfirmAbsent?: (recordId: string) => Promise<void>;
      }
    ).deleteRecordAndConfirmAbsent;

    expect(cleanup).toBeDefined();
    await expect(
      cleanup!.call(gateway, 'rec-already-deleted'),
    ).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toContain('/records/rec-already-deleted');
    expect(get.mock.calls[0][0]).toContain('/records/rec-already-deleted');
  });

  it('invalidates the exact registration cache only when explicitly requested', async () => {
    const gateway = gatewayWith({ get: jest.fn(), post: jest.fn() });
    const invalidator = (
      gateway as unknown as {
        invalidateRegistrationCache?: () => Promise<void>;
      }
    ).invalidateRegistrationCache;

    expect(invalidator).toBeDefined();
    await invalidator!.call(gateway);

    expect(invalidateBitableRecordCache).toHaveBeenCalledTimes(1);
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'app-actual',
      tableId: 'tblRegistrations',
    });
  });

  it('stops readback after the bounded retries and maps it to ServiceUnavailable', async () => {
    const get = jest.fn().mockRejectedValue(networkError('ENETUNREACH'));
    const wait = jest.fn(async (_delayMs: number) => undefined);
    const gateway = gatewayWith({ get, post: tenantTokenPost() });

    await expect(gateway.getRecord('rec-missing', wait)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1000]);
    expect(get).toHaveBeenCalledTimes(4);
    expect(invalidateBitableRecordCache).not.toHaveBeenCalled();
  });

  it('cancels an in-progress readback backoff without issuing another request', async () => {
    const controller = new AbortController();
    const get = jest.fn().mockRejectedValue(networkError('ECONNRESET'));
    const wait = jest.fn(() => new Promise<void>(() => undefined));
    const gateway = controlledGateway(
      gatewayWith({ get, post: tenantTokenPost() }),
    );

    const result = gateway.getRecord(
      'rec-created',
      { signal: controller.signal, deadlineAt: Date.now() + 5_000 },
      wait,
    );
    await untilCalled(wait);
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('rejects a repeated pagination token instead of looping', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockResolvedValueOnce(recordPage('page-loop', true, 1))
      .mockResolvedValueOnce(recordPage('page-loop', true, 1))
      .mockResolvedValueOnce(recordPage('', false, 1));
    const gateway = gatewayWith({ get: jest.fn(), post });

    await expect(gateway.listCandidateRecords()).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('bounds candidate pagination pages and total records', async () => {
    let page = 0;
    const post = jest
      .fn()
      .mockResolvedValueOnce(tenantTokenResponse())
      .mockImplementation(async () => {
        page += 1;
        return recordPage(`page-${page}`, page < 21, 500);
      });
    const gateway = gatewayWith({ get: jest.fn(), post });

    await expect(gateway.listCandidateRecords()).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(page).toBeLessThanOrEqual(21);
  });
});

function tenantTokenPost() {
  return jest.fn().mockResolvedValue(tenantTokenResponse());
}

function tenantTokenResponse() {
  return {
    data: {
      code: 0,
      msg: 'success',
      tenant_access_token: 'tenant-token',
      expire: 7200,
    },
  };
}

function recordSearchResponse(recordId: string) {
  return {
    data: {
      code: 0,
      msg: 'success',
      data: {
        items: [
          {
            record_id: recordId,
            fields: {
              检查人: [{ id: 'ou_checker', name: '检查员' }],
              机房经理: [{ id: 'ou_manager', name: '经理' }],
            },
          },
        ],
        has_more: false,
        page_token: '',
      },
    },
  };
}

function organizationManagerSearchResponse() {
  return {
    data: {
      code: 0,
      msg: 'success',
      data: {
        items: [
          {
            record_id: 'rec-manager',
            fields: {
              职位: '设施运维副经理',
              主管: [{ id: 'ou_manager', name: '经理' }],
              '主管（文本）': '经理',
            },
          },
        ],
        has_more: false,
        page_token: '',
      },
    },
  };
}

function createResponse(recordId: string) {
  return {
    data: {
      code: 0,
      msg: 'success',
      data: { record: { record_id: recordId } },
    },
  };
}

function pngFile(): WeatherWarningRegistrationUploadFile {
  const buffer = imageBuffer('image/png');
  return {
    originalname: '现场.png',
    mimetype: 'image/png',
    size: buffer.length,
    buffer,
  };
}

function imageBuffer(mimetype: string): Buffer {
  if (mimetype === 'image/png') {
    return Buffer.from('89504e470d0a1a0a', 'hex');
  }
  if (mimetype === 'image/jpeg') {
    return Buffer.from('ffd8ff', 'hex');
  }
  if (mimetype === 'image/webp') {
    return Buffer.from('524946460000000057454250', 'hex');
  }
  if (mimetype === 'application/pdf') {
    return Buffer.from('%PDF-1.7\n', 'ascii');
  }
  return Buffer.from('invalid');
}

function networkError(code: string): Error {
  return Object.assign(new Error(`network failure: ${code}`), { code });
}

function recordPage(pageToken: string, hasMore: boolean, count: number) {
  return {
    data: {
      code: 0,
      msg: 'success',
      data: {
        items: Array.from({ length: count }, (_, index) => ({
          record_id: `${pageToken}-${index}`,
          fields: {},
        })),
        has_more: hasMore,
        page_token: hasMore ? pageToken : '',
      },
    },
  };
}

async function untilCalled(mock: jest.Mock): Promise<void> {
  for (
    let attempt = 0;
    attempt < 20 && mock.mock.calls.length === 0;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(mock).toHaveBeenCalled();
}

function controlledGateway(gateway: WeatherWarningRegistrationGateway) {
  return gateway as unknown as WeatherWarningRegistrationGateway & {
    createRecord(
      fields: Record<string, unknown>,
      clientToken: string,
      options?: { signal?: AbortSignal; deadlineAt?: number },
    ): Promise<string>;
    getRecord(
      recordId: string,
      options?: { signal?: AbortSignal; deadlineAt?: number },
      waitBeforeRetry?: (delayMs: number) => Promise<void>,
    ): Promise<unknown>;
  };
}

function gatewayWith(axiosRef: {
  get: jest.Mock;
  post: jest.Mock;
  delete?: jest.Mock;
}) {
  return new WeatherWarningRegistrationGateway({ axiosRef } as never);
}
