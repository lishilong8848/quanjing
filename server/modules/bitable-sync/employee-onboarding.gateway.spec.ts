const mockInvalidateBitableRecordCache = jest.fn();
const mockInvalidateFeishuTenantAccessTokenCacheForApp = jest.fn();
const mockGetTenantAccessToken = jest.fn();
const mockResolveBitableAppToken = jest.fn();
const mockReadEmployeeOnboardingConfig = jest.fn();

const TEST_FEISHU_APP_ID = 'app-id-for-tests';

jest.mock('@server/common/config/external-services.config', () => ({
  getFeishuAuthPayload: () => ({
    app_id: TEST_FEISHU_APP_ID,
    app_secret: 'auth-secret-for-tests',
  }),
}));

jest.mock('@server/common/feishu/bitable-direct-read', () => ({
  extractDisplayText: (value: unknown) => typeof value === 'string' ? value : '',
  getTenantAccessToken: mockGetTenantAccessToken,
  invalidateBitableRecordCache: mockInvalidateBitableRecordCache,
  invalidateFeishuTenantAccessTokenCacheForApp:
    mockInvalidateFeishuTenantAccessTokenCacheForApp,
  resolveBitableAppToken: mockResolveBitableAppToken,
}));

jest.mock('./employee-onboarding.config', () => ({
  readEmployeeOnboardingConfig: mockReadEmployeeOnboardingConfig,
}));

import {
  EmployeeOnboardingClientTokenConflictError,
  EmployeeOnboardingCreateIndeterminateError,
  EmployeeOnboardingGateway,
  type EmployeeOnboardingUploadFile,
} from './employee-onboarding.gateway';

const AUTH_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MEDIA_URL = 'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all';
const APP_TOKEN = 'appEmployee123';
const WIKI_TOKEN = 'wikEmployee123';
const TABLE_ID = 'tblEmployee123';
const TABLE_NAME = '员工信息池（全量）';
const RECORDS_URL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`;
const FIELDS_URL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`;
const CLIENT_MUTATION_ID =
  'employee-onboarding-123e4567-e89b-42d3-a456-426614174000';
const FEISHU_CLIENT_TOKEN = '123e4567-e89b-42d3-a456-426614174000';

const REQUIRED_FIELD_METAS = [
  { field_id: 'fldName', field_name: '姓名', type: 1 },
  { field_id: 'fldEmployment', field_name: '用工性质', type: 3 },
  { field_id: 'fldCompany', field_name: '公司名称', type: 3 },
  { field_id: 'fldPosition', field_name: '岗位', type: 3 },
  { field_id: 'fldIdentity', field_name: '身份证号', type: 1 },
  { field_id: 'fldPhone', field_name: '联系方式', type: 13 },
  { field_id: 'fldEntryDate', field_name: '入职日期', type: 5 },
  { field_id: 'fldEducation', field_name: '学历', type: 3 },
  { field_id: 'fldSchool', field_name: '毕业院校', type: 1 },
  { field_id: 'fldMajor', field_name: '所学专业', type: 1 },
  { field_id: 'fldGraduation', field_name: '毕业时间', type: 1 },
  { field_id: 'fldHobbies', field_name: '兴趣爱好', type: 4 },
  { field_id: 'fldPlate', field_name: '车牌号', type: 1 },
  { field_id: 'fldPhoto', field_name: '照片', type: 17 },
  { field_id: 'fldMbti', field_name: 'MBTI', type: 3 },
] as const;

describe('EmployeeOnboardingGateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadEmployeeOnboardingConfig.mockReturnValue({
      appToken: '',
      wikiToken: WIKI_TOKEN,
      tableId: TABLE_ID,
      tableName: TABLE_NAME,
    });
    mockResolveBitableAppToken.mockResolvedValue(APP_TOKEN);
    mockGetTenantAccessToken.mockResolvedValue('tenant-token');
  });

  describe('updateMbti', () => {
    it('updates only the configured MBTI option and verifies the readback', async () => {
      const put = jest.fn().mockResolvedValue(feishuSuccess({ record: { record_id: 'recMbti123' } }));
      const gateway = new EmployeeOnboardingGateway({ axiosRef: { put } } as never);
      jest.spyOn(gateway, 'fetchFieldMetas').mockResolvedValue([
        { field_id: 'fldMbti', field_name: 'MBTI', type: 3 },
      ]);
      jest.spyOn(gateway, 'readRecord').mockResolvedValue({ 姓名: '测试员工', MBTI: 'ENFJ' });
      await gateway.updateMbti('recMbti123', 'ENFJ');
      expect(put).toHaveBeenCalledWith(
        `${RECORDS_URL}/recMbti123`,
        { fields: { MBTI: 'ENFJ' } },
        expect.objectContaining({ params: { user_id_type: 'open_id' } }),
      );
    });

    it('refuses invalid type codes before writing', async () => {
      const put = jest.fn();
      const gateway = new EmployeeOnboardingGateway({ axiosRef: { put } } as never);
      await expect(gateway.updateMbti('recMbti123', 'INVALID')).rejects.toThrow('MBTI 类型无效');
      expect(put).not.toHaveBeenCalled();
    });
  });

  describe('fetchFieldMetas', () => {
    it('resolves the fixed wiki target and returns minimal metadata from every page', async () => {
      const get = jest
        .fn()
        .mockResolvedValueOnce(
          feishuSuccess({
            items: REQUIRED_FIELD_METAS.slice(0, 8).map((item) => ({
              ...item,
              description: 'must not escape the gateway',
            })),
            has_more: true,
            page_token: 'page-2',
          }),
        )
        .mockResolvedValueOnce(
          feishuSuccess({
            items: REQUIRED_FIELD_METAS.slice(8),
            has_more: false,
          }),
        );
      const { gateway, post } = gatewayWith({ get });

      await expect(gateway.fetchFieldMetas()).resolves.toEqual(
        REQUIRED_FIELD_METAS,
      );

      expect(mockResolveBitableAppToken).toHaveBeenCalledWith(
        expect.objectContaining({ axiosRef: expect.any(Object) }),
        {
          appToken: '',
          wikiToken: WIKI_TOKEN,
          tableName: TABLE_NAME,
          requestTimeoutMs: expect.any(Function),
        },
      );
      expect(
        mockResolveBitableAppToken.mock.calls[0][1].requestTimeoutMs('wiki'),
      ).toBe(8_000);
      expect(post).not.toHaveBeenCalled();
      expect(get).toHaveBeenNthCalledWith(
        1,
        FIELDS_URL,
        expect.objectContaining({
          headers: { Authorization: 'Bearer tenant-token' },
          params: { page_size: 100, page_token: undefined },
          timeout: 8_000,
        }),
      );
      expect(get).toHaveBeenNthCalledWith(
        2,
        FIELDS_URL,
        expect.objectContaining({
          params: { page_size: 100, page_token: 'page-2' },
        }),
      );
    });

    it.each([
      [
        '缺失',
        REQUIRED_FIELD_METAS.filter((item) => item.field_name !== '照片'),
        '新员工入职字段配置异常：照片（期望类型 17）',
      ],
      [
        '重复',
        [...REQUIRED_FIELD_METAS, REQUIRED_FIELD_METAS[0]],
        '新员工入职字段配置异常：姓名（期望类型 1）',
      ],
      [
        '类型错误',
        REQUIRED_FIELD_METAS.map((item) =>
          item.field_name === '岗位' ? { ...item, type: 1 } : item,
        ),
        '新员工入职字段配置异常：岗位（期望类型 3）',
      ],
    ])(
      'rejects a required field that is %s without echoing remote data',
      async (_label, items, message) => {
        const get = jest.fn().mockResolvedValue(
          feishuSuccess({
            items,
            has_more: false,
            remote_secret: 'field-remote-secret',
          }),
        );
        const { gateway } = gatewayWith({ get });

        const error = await gateway.fetchFieldMetas().catch((reason) => reason);

        expect(String(error)).toContain(message);
        expect(serialiseError(error)).not.toContain('field-remote-secret');
      },
    );

    it('stops repeated pagination tokens before another HTTP request', async () => {
      const get = jest
        .fn()
        .mockResolvedValueOnce(
          feishuSuccess({ items: [], has_more: true, page_token: 'repeat' }),
        )
        .mockResolvedValueOnce(
          feishuSuccess({ items: [], has_more: true, page_token: 'repeat' }),
        );
      const { gateway } = gatewayWith({ get });

      await expect(gateway.fetchFieldMetas()).rejects.toThrow(
        '读取新员工入职字段失败',
      );
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('invalidates only this app token cache and retries one HTTP 401 with a fresh token', async () => {
      mockGetTenantAccessToken
        .mockResolvedValueOnce('expired-tenant-token')
        .mockResolvedValueOnce('fresh-tenant-token');
      const get = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('expired'), {
            response: { status: 401, data: { code: 99991663 } },
          }),
        )
        .mockResolvedValueOnce(
          feishuSuccess({ items: REQUIRED_FIELD_METAS, has_more: false }),
        );
      const { gateway } = gatewayWith({ get });

      await expect(gateway.fetchFieldMetas()).resolves.toEqual(
        REQUIRED_FIELD_METAS,
      );

      expect(
        mockInvalidateFeishuTenantAccessTokenCacheForApp,
      ).toHaveBeenCalledWith(TEST_FEISHU_APP_ID);
      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer expired-tenant-token',
      );
      expect(get.mock.calls[1][1].headers.Authorization).toBe(
        'Bearer fresh-tenant-token',
      );
    });

    it('stops field pagination at the bounded page limit', async () => {
      let page = 0;
      const get = jest.fn().mockImplementation(async () => {
        page += 1;
        return feishuSuccess({
          items: [],
          has_more: true,
          page_token: `page-${page}`,
        });
      });
      const { gateway } = gatewayWith({ get });

      await expect(gateway.fetchFieldMetas()).rejects.toThrow(
        '读取新员工入职字段失败',
      );
      expect(get).toHaveBeenCalledTimes(20);
    });
  });

  describe('uploadAttachment', () => {
    it('uploads the exact multipart bitable_file fields and returns only file_token', async () => {
      let uploadBody: { getBuffer(): Buffer } | undefined;
      const post = jest.fn().mockImplementation(async (url, body) => {
        if (url === MEDIA_URL) {
          uploadBody = body;
          return feishuSuccess({ file_token: 'boxPhoto123' });
        }
        throw new Error(`unexpected POST ${String(url)}`);
      });
      const { gateway } = gatewayWith({ post });
      const file = uploadFile('employee-photo.png', 'photo-bytes');

      await expect(gateway.uploadAttachment(file)).resolves.toBe('boxPhoto123');

      expect(post).toHaveBeenNthCalledWith(
        1,
        MEDIA_URL,
        expect.objectContaining({ append: expect.any(Function) }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer tenant-token',
          }),
          maxBodyLength: Infinity,
          timeout: 25_000,
        }),
      );
      const multipart = uploadBody?.getBuffer().toString('utf8') || '';
      expect(multipart).toContain('name="file_name"');
      expect(multipart).toContain('employee-photo.png');
      expect(multipart).toContain('name="parent_type"');
      expect(multipart).toContain('bitable_file');
      expect(multipart).toContain('name="parent_node"');
      expect(multipart).toContain(APP_TOKEN);
      expect(multipart).toContain('name="size"');
      expect(multipart).toContain(String(file.size));
      expect(multipart).toContain('name="file"');
      expect(multipart).toContain('photo-bytes');
    });

    it('limits actual upload HTTP concurrency to three across Promise.all', async () => {
      let activeUploads = 0;
      let maximumActiveUploads = 0;
      let uploadSequence = 0;
      const post = jest.fn().mockImplementation(async (url) => {
        if (url !== MEDIA_URL) throw new Error('unexpected HTTP call');
        activeUploads += 1;
        maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
        const sequence = ++uploadSequence;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        activeUploads -= 1;
        return feishuSuccess({ file_token: `boxUpload${sequence}` });
      });
      const { gateway } = gatewayWith({ post });

      const tokens = await Promise.all(
        Array.from({ length: 7 }, (_, index) =>
          gateway.uploadAttachment(
            uploadFile(`photo-${index}.png`, `bytes-${index}`),
          ),
        ),
      );

      expect(tokens).toHaveLength(7);
      expect(maximumActiveUploads).toBe(3);
    });

    it('releases an upload slot after failure so queued uploads still execute', async () => {
      const pendingUploads: Deferred<unknown>[] = [];
      let uploadCalls = 0;
      const post = jest.fn().mockImplementation((url) => {
        if (url !== MEDIA_URL) return Promise.reject(new Error('unexpected'));
        uploadCalls += 1;
        const pending = deferred<unknown>();
        pendingUploads.push(pending);
        return pending.promise;
      });
      const { gateway } = gatewayWith({ post });

      const resultPromise = Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          gateway.uploadAttachment(
            uploadFile(`photo-${index}.png`, `bytes-${index}`),
          ),
        ),
      );
      await waitUntil(() => uploadCalls === 3);
      pendingUploads[0].reject(
        Object.assign(new Error('upload socket reset'), {
          code: 'ECONNRESET',
        }),
      );
      await waitUntil(() => uploadCalls === 4);
      pendingUploads.slice(1).forEach((pending, index) => {
        pending.resolve(feishuSuccess({ file_token: `boxQueued${index}` }));
      });

      const results = await resultPromise;
      expect(results.filter((item) => item.status === 'rejected')).toHaveLength(
        1,
      );
      expect(
        results.filter((item) => item.status === 'fulfilled'),
      ).toHaveLength(3);
      expect(uploadCalls).toBe(4);
    });

    it.each([
      [
        'empty buffer',
        { ...uploadFile('photo.png', 'x'), buffer: Buffer.alloc(0), size: 0 },
      ],
      ['mismatched size', { ...uploadFile('photo.png', 'abc'), size: 99 }],
      ['unsafe filename length', uploadFile(`${'x'.repeat(201)}.png`, 'abc')],
    ])('rejects %s locally without issuing HTTP', async (_label, file) => {
      const { gateway, get, post, del } = gatewayWith();

      const error = await gateway
        .uploadAttachment(file)
        .catch((reason) => reason);

      expect(String(error)).toContain('附件文件无效');
      expect(serialiseError(error)).not.toContain(file.originalname);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
      expect(mockGetTenantAccessToken).not.toHaveBeenCalled();
      expect(mockResolveBitableAppToken).not.toHaveBeenCalled();
    });
  });

  describe('createRecord', () => {
    it('creates with the guarded client_token without invalidating before strict readback', async () => {
      const fields = { 姓名: '网关测试员工' };
      const post = jest.fn().mockImplementation(async (url) => {
        if (url === RECORDS_URL) {
          return feishuSuccess({ record: { record_id: 'recEmployee123' } });
        }
        throw new Error('unexpected POST');
      });
      const { gateway } = gatewayWith({ post });

      await expect(
        gateway.createRecord(fields, CLIENT_MUTATION_ID),
      ).resolves.toBe('recEmployee123');

      expect(post).toHaveBeenNthCalledWith(
        1,
        RECORDS_URL,
        { fields },
        expect.objectContaining({
          params: {
            client_token: FEISHU_CLIENT_TOKEN,
            user_id_type: 'open_id',
          },
          timeout: 8_000,
        }),
      );
      expect(mockInvalidateBitableRecordCache).not.toHaveBeenCalled();
    });

    it('retries one transient create failure with the identical client_token', async () => {
      const post = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        )
        .mockResolvedValueOnce(
          feishuSuccess({ record: { record_id: 'recRetried123' } }),
        );
      const { gateway } = gatewayWith({ post });

      await expect(
        withFakeRetryTimers(() =>
          gateway.createRecord({ 姓名: '重试测试' }, CLIENT_MUTATION_ID),
        ),
      ).resolves.toBe('recRetried123');

      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[0][2].params.client_token).toBe(
        FEISHU_CLIENT_TOKEN,
      );
      expect(post.mock.calls[1][2].params.client_token).toBe(
        FEISHU_CLIENT_TOKEN,
      );
    });

    it('retries one unknown transport failure because its create result is ambiguous', async () => {
      const post = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('unknown transport failure'), {
            code: 'ERR_FUTURE_TRANSPORT',
          }),
        )
        .mockResolvedValueOnce(
          feishuSuccess({ record: { record_id: 'recUnknownRetry123' } }),
        );
      const { gateway } = gatewayWith({ post });

      await expect(
        withFakeRetryTimers(() =>
          gateway.createRecord({ 姓名: '未知错误重试' }, CLIENT_MUTATION_ID),
        ),
      ).resolves.toBe('recUnknownRetry123');
      expect(post).toHaveBeenCalledTimes(2);
    });

    it.each([
      1254290, 1254291, 1254607, 1254608, 1255001, 1255002, 1255003, 1255004,
      1255005, 1255040, 99991400,
    ])(
      'retries HTTP 200 transient Feishu business code %s with the same UUID token',
      async (code) => {
        const post = jest
          .fn()
          .mockResolvedValueOnce({
            data: { code, msg: 'transient business failure' },
          })
          .mockResolvedValueOnce(
            feishuSuccess({ record: { record_id: 'recBusinessRetry123' } }),
          );
        const { gateway } = gatewayWith({ post });

        await expect(
          withFakeRetryTimers(() =>
            gateway.createRecord({ 姓名: '业务码重试' }, CLIENT_MUTATION_ID),
          ),
        ).resolves.toBe('recBusinessRetry123');

        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[0][2].params.client_token).toBe(
          FEISHU_CLIENT_TOKEN,
        );
        expect(post.mock.calls[1][2].params.client_token).toBe(
          FEISHU_CLIENT_TOKEN,
        );
      },
    );

    it('retries one transient Feishu code carried by an HTTP error response', async () => {
      const post = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('temporary business failure'), {
            response: {
              status: 400,
              data: { code: 1255003, msg: 'internal transient' },
            },
          }),
        )
        .mockResolvedValueOnce(
          feishuSuccess({ record: { record_id: 'recHttpCodeRetry123' } }),
        );
      const { gateway } = gatewayWith({ post });

      await expect(
        withFakeRetryTimers(() =>
          gateway.createRecord({ 姓名: 'HTTP业务码重试' }, CLIENT_MUTATION_ID),
        ),
      ).resolves.toBe('recHttpCodeRetry123');
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('retries HTTP 429 platform throttling code 99991400 with the same UUID token', async () => {
      const post = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('platform throttled'), {
            response: {
              status: 429,
              data: { code: 99991400, msg: 'too many requests' },
            },
          }),
        )
        .mockResolvedValueOnce(
          feishuSuccess({ record: { record_id: 'recThrottleRetry123' } }),
        );
      const { gateway } = gatewayWith({ post });

      await expect(
        withFakeRetryTimers(() =>
          gateway.createRecord({ 姓名: '频控重试' }, CLIENT_MUTATION_ID),
        ),
      ).resolves.toBe('recThrottleRetry123');

      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[0][2].params.client_token).toBe(
        FEISHU_CLIENT_TOKEN,
      );
      expect(post.mock.calls[1][2].params.client_token).toBe(
        FEISHU_CLIENT_TOKEN,
      );
    });

    it('refreshes a resolved invalid-token business response exactly once', async () => {
      mockGetTenantAccessToken
        .mockResolvedValueOnce('expired-tenant-token')
        .mockResolvedValueOnce('fresh-tenant-token');
      const post = jest
        .fn()
        .mockResolvedValueOnce({ data: { code: 99991664, msg: 'expired' } })
        .mockResolvedValueOnce(
          feishuSuccess({ record: { record_id: 'recAuthRefresh123' } }),
        );
      const { gateway } = gatewayWith({ post });

      await expect(
        gateway.createRecord({ 姓名: '令牌刷新' }, CLIENT_MUTATION_ID),
      ).resolves.toBe('recAuthRefresh123');

      expect(
        mockInvalidateFeishuTenantAccessTokenCacheForApp,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockInvalidateFeishuTenantAccessTokenCacheForApp,
      ).toHaveBeenCalledWith(TEST_FEISHU_APP_ID);
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[0][2].headers.Authorization).toBe(
        'Bearer expired-tenant-token',
      );
      expect(post.mock.calls[1][2].headers.Authorization).toBe(
        'Bearer fresh-tenant-token',
      );
    });

    it('does not refresh authentication more than once when the fresh token is also rejected', async () => {
      mockGetTenantAccessToken
        .mockResolvedValueOnce('expired-tenant-token')
        .mockResolvedValueOnce('also-invalid-token');
      const post = jest
        .fn()
        .mockResolvedValue({ data: { code: 99991668, msg: 'still invalid' } });
      const { gateway } = gatewayWith({ post });

      await expect(
        gateway.createRecord({ 姓名: '认证失败' }, CLIENT_MUTATION_ID),
      ).rejects.toThrow('飞书访问令牌暂时失效');

      expect(post).toHaveBeenCalledTimes(2);
      expect(
        mockInvalidateFeishuTenantAccessTokenCacheForApp,
      ).toHaveBeenCalledTimes(1);
    });

    it('does not classify a shared token provider failure as an unknown create result', async () => {
      const tokenSecret = 'shared-provider-secret';
      mockGetTenantAccessToken.mockRejectedValue(new Error(tokenSecret));
      const post = jest.fn();
      const { gateway } = gatewayWith({ post });

      const error = await withFakeRetryTimers(() =>
        gateway
          .createRecord({ 姓名: '认证前失败' }, CLIENT_MUTATION_ID)
          .catch((reason) => reason),
      );

      expect(error).not.toBeInstanceOf(
        EmployeeOnboardingCreateIndeterminateError,
      );
      expect(String(error)).toContain('飞书访问令牌暂时失效');
      expect(serialiseError(error)).not.toContain(tokenSecret);
      expect(mockGetTenantAccessToken).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
    });

    it.each([
      [
        'HTTP 200 payload',
        () => Promise.resolve({ data: { code: 1255006, msg: 'conflict' } }),
      ],
      [
        'HTTP 400 payload',
        () =>
          Promise.reject(
            Object.assign(new Error('conflict'), {
              response: {
                status: 400,
                data: { code: 1255006, msg: 'conflict' },
              },
            }),
          ),
      ],
    ])(
      'maps client-token conflict from %s to a safe HTTP 409',
      async (_label, response) => {
        const post = jest.fn().mockImplementationOnce(response);
        const { gateway } = gatewayWith({ post });

        const error = await gateway
          .createRecord({ 姓名: '冲突核对' }, CLIENT_MUTATION_ID)
          .catch((reason) => reason);

        expect(error).toBeInstanceOf(
          EmployeeOnboardingClientTokenConflictError,
        );
        expect(error.getStatus()).toBe(409);
        expect(serialiseError(error)).not.toContain(CLIENT_MUTATION_ID);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][2].params.client_token).toBe(
          FEISHU_CLIENT_TOKEN,
        );
      },
    );

    it('does not retry a permanent HTTP 200 Feishu business code', async () => {
      const post = jest.fn().mockResolvedValue({
        data: { code: 1254060, msg: 'invalid field' },
      });
      const { gateway } = gatewayWith({ post });

      await expect(
        gateway.createRecord({ 姓名: '永久错误' }, CLIENT_MUTATION_ID),
      ).rejects.toThrow('新增新员工入职记录失败');
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not retry an explicit upstream 4xx response', async () => {
      const post = jest.fn().mockRejectedValueOnce(
        Object.assign(new Error('request failed'), {
          response: {
            status: 400,
            data: { msg: 'remote field value: private-name' },
          },
        }),
      );
      const { gateway } = gatewayWith({ post });

      const error = await withFakeRetryTimers(() =>
        gateway
          .createRecord({ 姓名: 'private-name' }, CLIENT_MUTATION_ID)
          .catch((reason) => reason),
      );

      expect(post).toHaveBeenCalledTimes(1);
      expect(error).not.toBeInstanceOf(
        EmployeeOnboardingCreateIndeterminateError,
      );
      expect(serialiseError(error)).not.toContain('private-name');
    });

    it('returns a safe indeterminate error after two transient failures', async () => {
      const firstSecret = 'tenant-secret-first';
      const secondSecret = 'field-secret-second';
      const post = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error(firstSecret), { code: 'ECONNRESET' }),
        )
        .mockRejectedValueOnce({
          response: { status: 503, data: { msg: secondSecret } },
        });
      const { gateway } = gatewayWith({ post });

      const error = await withFakeRetryTimers(() =>
        gateway
          .createRecord({ 姓名: 'private-name' }, CLIENT_MUTATION_ID)
          .catch((reason) => reason),
      );

      expect(error).toBeInstanceOf(EmployeeOnboardingCreateIndeterminateError);
      expect(error).toEqual(
        expect.objectContaining({ clientMutationId: CLIENT_MUTATION_ID }),
      );
      expect(serialiseError(error)).toContain(CLIENT_MUTATION_ID);
      expect(serialiseError(error)).not.toContain(firstSecret);
      expect(serialiseError(error)).not.toContain(secondSecret);
      expect(serialiseError(error)).not.toContain('private-name');
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('rejects a successful create response without a strict record_id', async () => {
      const post = jest
        .fn()
        .mockResolvedValueOnce(feishuSuccess({ record: {} }));
      const { gateway } = gatewayWith({ post });

      await expect(
        gateway.createRecord({ 姓名: '测试' }, CLIENT_MUTATION_ID),
      ).rejects.toThrow('新增新员工入职记录失败');
      expect(mockInvalidateBitableRecordCache).not.toHaveBeenCalled();
    });

    it('rejects an invalid mutation ID locally with zero HTTP calls', async () => {
      const { gateway, get, post, del } = gatewayWith();

      await expect(
        gateway.createRecord({ 姓名: '测试' }, 'not-a-valid-mutation-id'),
      ).rejects.toThrow('clientMutationId 无效');

      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
      expect(mockGetTenantAccessToken).not.toHaveBeenCalled();
      expect(mockResolveBitableAppToken).not.toHaveBeenCalled();
    });
  });

  describe('readRecord and deleteRecordForSelfTest', () => {
    it('reads one exact record ID and returns only its fields', async () => {
      const get = jest.fn().mockResolvedValue(
        feishuSuccess({
          record: {
            record_id: 'recRead123',
            fields: { 姓名: '读取测试', 照片: [{ file_token: 'boxSecret' }] },
            created_time: 'not returned',
          },
        }),
      );
      const { gateway } = gatewayWith({ get });

      await expect(gateway.readRecord('recRead123')).resolves.toEqual({
        姓名: '读取测试',
        照片: [{ file_token: 'boxSecret' }],
      });
      expect(get).toHaveBeenCalledWith(
        `${RECORDS_URL}/recRead123`,
        expect.objectContaining({
          params: { user_id_type: 'open_id' },
          timeout: 8_000,
        }),
      );
    });

    it('returns null for the exact Feishu record-not-found code', async () => {
      const get = jest.fn().mockResolvedValue({
        data: { code: 1254043, msg: 'record missing remote detail' },
      });
      const { gateway } = gatewayWith({ get });

      await expect(gateway.readRecord('recMissing123')).resolves.toBeNull();
    });

    it('deletes only one exact record ID and invalidates the fixed cache target', async () => {
      const del = jest.fn().mockResolvedValue({ data: { code: 0 } });
      const get = jest.fn().mockResolvedValue({
        data: { code: 1254043, msg: 'confirmed missing' },
      });
      const { gateway } = gatewayWith({ get, delete: del });

      await expect(
        gateway.deleteRecordForSelfTest('recDelete123'),
      ).resolves.toBeUndefined();

      expect(del).toHaveBeenCalledWith(
        `${RECORDS_URL}/recDelete123`,
        expect.objectContaining({
          params: { user_id_type: 'open_id' },
          timeout: 8_000,
        }),
      );
      expect(get).toHaveBeenCalledWith(
        `${RECORDS_URL}/recDelete123`,
        expect.objectContaining({ params: { user_id_type: 'open_id' } }),
      );
      expect(mockInvalidateBitableRecordCache).toHaveBeenCalledWith({
        appToken: APP_TOKEN,
        tableId: TABLE_ID,
      });
    });

    it('treats Feishu not-found as already deleted and invalidates stale target cache', async () => {
      const del = jest.fn().mockResolvedValue({
        data: { code: 1254043, msg: 'already missing' },
      });
      const get = jest.fn().mockResolvedValue({
        data: { code: 1254043, msg: 'confirmed missing' },
      });
      const { gateway } = gatewayWith({ get, delete: del });

      await expect(
        gateway.deleteRecordForSelfTest('recMissing123'),
      ).resolves.toBeUndefined();
      expect(mockInvalidateBitableRecordCache).toHaveBeenCalledWith({
        appToken: APP_TOKEN,
        tableId: TABLE_ID,
      });
    });

    it('waits until the exact deleted record becomes not found before succeeding', async () => {
      const del = jest.fn().mockResolvedValue({ data: { code: 0 } });
      const get = jest
        .fn()
        .mockResolvedValueOnce(
          feishuSuccess({
            record: { record_id: 'recEventuallyGone123', fields: {} },
          }),
        )
        .mockResolvedValueOnce({
          data: { code: 1254043, msg: 'now missing' },
        });
      const { gateway } = gatewayWith({ get, delete: del });

      await expect(
        withFakeRetryTimers(() =>
          gateway.deleteRecordForSelfTest('recEventuallyGone123'),
        ),
      ).resolves.toBeUndefined();

      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls.map((call) => call[0])).toEqual([
        `${RECORDS_URL}/recEventuallyGone123`,
        `${RECORDS_URL}/recEventuallyGone123`,
      ]);
      expect(mockInvalidateBitableRecordCache).toHaveBeenCalledTimes(1);
    });

    it('fails safely when the exact record still exists after three confirmations', async () => {
      const del = jest.fn().mockResolvedValue({ data: { code: 0 } });
      const get = jest.fn().mockResolvedValue(
        feishuSuccess({
          record: { record_id: 'recStillExists123', fields: { 姓名: '测试' } },
        }),
      );
      const { gateway } = gatewayWith({ get, delete: del });

      await expect(
        withFakeRetryTimers(() =>
          gateway.deleteRecordForSelfTest('recStillExists123'),
        ),
      ).rejects.toThrow('删除新员工入职测试记录未确认');

      expect(get).toHaveBeenCalledTimes(3);
      expect(mockInvalidateBitableRecordCache).not.toHaveBeenCalled();
    });

    it.each([
      [
        'read',
        (gateway: EmployeeOnboardingGateway) =>
          gateway.readRecord('../records'),
      ],
      [
        'delete',
        (gateway: EmployeeOnboardingGateway) =>
          gateway.deleteRecordForSelfTest('recValid/../../other'),
      ],
    ])(
      'rejects an invalid ID before %s performs any external work',
      async (_label, operation) => {
        const { gateway, get, post, del } = gatewayWith();

        await expect(operation(gateway)).rejects.toThrow('recordId 无效');

        expect(get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
        expect(mockGetTenantAccessToken).not.toHaveBeenCalled();
        expect(mockResolveBitableAppToken).not.toHaveBeenCalled();
      },
    );
  });

  describe('safe failures and cache targeting', () => {
    it('keeps target invalidation a no-op until the exact target is resolved', async () => {
      const { gateway } = gatewayWith();

      gateway.invalidateTargetCache();
      expect(mockInvalidateBitableRecordCache).not.toHaveBeenCalled();

      const get = jest
        .fn()
        .mockResolvedValue(
          feishuSuccess({ items: REQUIRED_FIELD_METAS, has_more: false }),
        );
      const resolved = gatewayWith({ get });
      await resolved.gateway.fetchFieldMetas();
      mockInvalidateBitableRecordCache.mockClear();

      resolved.gateway.invalidateTargetCache();
      expect(mockInvalidateBitableRecordCache).toHaveBeenCalledTimes(1);
      expect(mockInvalidateBitableRecordCache).toHaveBeenCalledWith({
        appToken: APP_TOKEN,
        tableId: TABLE_ID,
      });
    });

    it('does not expose app or wiki tokens when target resolution fails', async () => {
      const appSecret = 'app-secret-resolution-value';
      mockResolveBitableAppToken.mockRejectedValueOnce(new Error(appSecret));
      const { gateway } = gatewayWith();

      const error = await gateway.fetchFieldMetas().catch((reason) => reason);

      expect(serialiseError(error)).not.toContain(appSecret);
      expect(serialiseError(error)).not.toContain(WIKI_TOKEN);
      expect(serialiseError(error)).not.toContain(APP_TOKEN);
    });

    it('does not expose auth payload or tenant token errors', async () => {
      const tenantSecret = 'tenant-access-token-secret';
      mockGetTenantAccessToken.mockRejectedValueOnce(new Error(tenantSecret));
      const { gateway } = gatewayWith();

      const error = await gateway.fetchFieldMetas().catch((reason) => reason);

      expect(serialiseError(error)).not.toContain(tenantSecret);
      expect(serialiseError(error)).not.toContain('auth-secret-for-tests');
    });

    it('rejects an unsafe tenant token before it can enter an HTTP header', async () => {
      const unsafeToken = 'tenant-token\r\nunsafe-header';
      mockGetTenantAccessToken.mockResolvedValueOnce(unsafeToken);
      const get = jest.fn();
      const { gateway } = gatewayWith({ get });

      const error = await gateway.fetchFieldMetas().catch((reason) => reason);

      expect(get).not.toHaveBeenCalled();
      expect(serialiseError(error)).not.toContain(unsafeToken);
    });

    it('does not expose attachment names, tokens, or remote response bodies', async () => {
      const file = uploadFile('private-employee-photo.png', 'private-bytes');
      const post = jest.fn().mockImplementation(async (url) => {
        throw {
          response: {
            status: 502,
            data: {
              msg: `${file.originalname} boxPrivateToken private-bytes`,
            },
          },
        };
      });
      const { gateway } = gatewayWith({ post });

      const error = await gateway
        .uploadAttachment(file)
        .catch((reason) => reason);
      const serialised = serialiseError(error);

      expect(serialised).not.toContain(file.originalname);
      expect(serialised).not.toContain('boxPrivateToken');
      expect(serialised).not.toContain('private-bytes');
    });

    it('does not expose record field values or remote business response details', async () => {
      const privateValue = 'private-employee-field-value';
      const post = jest.fn().mockResolvedValueOnce({
        data: {
          code: 1254060,
          msg: `${privateValue} ${APP_TOKEN} boxPrivateToken`,
        },
      });
      const { gateway } = gatewayWith({ post });

      const error = await gateway
        .createRecord({ 姓名: privateValue }, CLIENT_MUTATION_ID)
        .catch((reason) => reason);
      const serialised = serialiseError(error);

      expect(serialised).not.toContain(privateValue);
      expect(serialised).not.toContain(APP_TOKEN);
      expect(serialised).not.toContain('boxPrivateToken');
    });
  });

  describe('shared tenant token provider', () => {
    it('coalesces a concurrent cold start and refreshes only after exact app invalidation', async () => {
      const actual = jest.requireActual<
        typeof import('@server/common/feishu/bitable-direct-read')
      >('@server/common/feishu/bitable-direct-read');
      const auth = {
        appId: 'employee-onboarding-shared-token-test-app',
        appSecret: 'shared-token-test-secret',
      };
      const post = jest.fn().mockImplementation(async (url) => {
        if (url !== AUTH_URL) throw new Error('unexpected shared-token HTTP');
        return {
          status: 200,
          data: {
            code: 0,
            tenant_access_token: `shared-tenant-token-${post.mock.calls.length}`,
            expire: 7200,
          },
        };
      });
      const httpService = { axiosRef: { post } } as never;

      try {
        const [first, concurrent] = await Promise.all([
          actual.getTenantAccessToken(httpService, auth),
          actual.getTenantAccessToken(httpService, auth),
        ]);
        expect(first).toBe('shared-tenant-token-1');
        expect(concurrent).toBe(first);
        expect(post).toHaveBeenCalledTimes(1);

        actual.invalidateFeishuTenantAccessTokenCacheForApp('');
        await expect(
          actual.getTenantAccessToken(httpService, auth),
        ).resolves.toBe(first);
        expect(post).toHaveBeenCalledTimes(1);

        actual.invalidateFeishuTenantAccessTokenCacheForApp(auth.appId);
        await expect(
          actual.getTenantAccessToken(httpService, auth),
        ).resolves.toBe('shared-tenant-token-2');
        expect(post).toHaveBeenCalledTimes(2);
      } finally {
        actual.invalidateFeishuTenantAccessTokenCacheForApp(auth.appId);
      }
    });
  });
});

function gatewayWith(
  overrides: Partial<{
    get: jest.Mock;
    post: jest.Mock;
    delete: jest.Mock;
  }> = {},
) {
  const get = overrides.get || jest.fn();
  const post = overrides.post || jest.fn();
  const del = overrides.delete || jest.fn();
  const axiosRef = { get, post, delete: del };
  return {
    gateway: new EmployeeOnboardingGateway({ axiosRef } as never),
    get,
    post,
    del,
  };
}

function tenantTokenResponse() {
  return {
    data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
  };
}

function feishuSuccess(data: Record<string, unknown>) {
  return { data: { code: 0, data } };
}

function uploadFile(
  originalname: string,
  content: string,
): EmployeeOnboardingUploadFile {
  const buffer = Buffer.from(content);
  return {
    buffer,
    originalname,
    mimetype: 'image/png',
    size: buffer.length,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('test condition was not reached');
}

async function withFakeRetryTimers<T>(operation: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  try {
    const settled = operation().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await jest.runAllTimersAsync();
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    jest.useRealTimers();
  }
}

function serialiseError(error: unknown): string {
  const candidate = error as { stack?: unknown; cause?: unknown };
  return [
    String(error),
    JSON.stringify(error),
    String(candidate?.stack || ''),
    JSON.stringify(candidate?.cause),
  ].join('\n');
}
