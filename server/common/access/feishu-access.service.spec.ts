import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { createHash } from 'node:crypto';
import {
  FeishuAccessError,
  FeishuAccessService,
} from './feishu-access.service';

const FEISHU_ACCESS_ENV_NAMES = {
  admin: 'FEISHU_ACCESS_ADMIN_OPEN_IDS',
  duty_editor: 'FEISHU_ACCESS_DUTY_EDITOR_OPEN_IDS',
  supply_chain_admin: 'FEISHU_ACCESS_SUPPLY_CHAIN_ADMIN_OPEN_IDS',
  construction_admin: 'FEISHU_ACCESS_CONSTRUCTION_ADMIN_OPEN_IDS',
} as const;

const FEISHU_OAUTH_ENV_NAMES = {
  appId: 'FEISHU_APP_ID',
  appSecret: 'FEISHU_APP_SECRET',
  publicBaseUrl: 'PUBLIC_BASE_URL',
  clientBasePath: 'CLIENT_BASE_PATH',
} as const;

const FEISHU_AUTHORIZE_URL =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const FEISHU_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const FEISHU_USER_INFO_URL =
  'https://open.feishu.cn/open-apis/authen/v1/user_info';

describe('FeishuAccessService', () => {
  it.each([
    ['FEISHU_ACCESS_EDITOR_OPEN_IDS', 'editor', null],
    ['FEISHU_ACCESS_BUILDING_ADMIN_A_OPEN_IDS', 'building_admin', 'A楼'],
    ['FEISHU_ACCESS_BUILDING_ADMIN_H_OPEN_IDS', 'building_admin', 'H楼'],
    ['FEISHU_ACCESS_INVENTORY_ADMIN_B_OPEN_IDS', 'inventory_admin', 'B楼'],
    ['FEISHU_ACCESS_INVENTORY_ADMIN_H_OPEN_IDS', 'inventory_admin', 'H楼'],
    ['FEISHU_ACCESS_PURCHASE_ADMIN_OPEN_IDS', 'purchase_admin', null],
  ] as const)('maps scoped allowlist %s', (key, role, purchaseBuilding) => {
    const service = createService({ [key]: 'ou_test_scoped_person' });
    expect(service.resolvePrincipal('ou_test_scoped_person')).toEqual({
      role,
      purchaseBuilding,
    });
  });

  it('rejects mapping the same identity to multiple building scopes', () => {
    expect(() =>
      createService({
        FEISHU_ACCESS_BUILDING_ADMIN_A_OPEN_IDS: 'ou_test_scoped_person',
        FEISHU_ACCESS_BUILDING_ADMIN_B_OPEN_IDS: 'ou_test_scoped_person',
      }),
    ).toThrow('跨角色');
  });

  it.each([
    ['ou_test_admin-01', 'admin'],
    ['ou_test_duty_editor_02', 'duty_editor'],
    ['ou_test_supply_chain_03', 'supply_chain_admin'],
    ['ou_test_construction_04', 'construction_admin'],
  ] as const)('maps a trimmed %s open_id to %s', (openId, role) => {
    const service = createService({
      [FEISHU_ACCESS_ENV_NAMES.admin]: '  ou_test_admin-01  ',
      [FEISHU_ACCESS_ENV_NAMES.duty_editor]:
        ' ou_test_duty_editor_02, ou_test_duty_editor_05 ',
      [FEISHU_ACCESS_ENV_NAMES.supply_chain_admin]: 'ou_test_supply_chain_03',
      [FEISHU_ACCESS_ENV_NAMES.construction_admin]: 'ou_test_construction_04',
    });

    expect(service.resolvePrincipal(`  ${openId}  `)).toEqual({
      role,
      purchaseBuilding: null,
    });
  });

  it('reads open_id mappings through ConfigService environment fallback', () => {
    const environmentNames = Object.values(FEISHU_ACCESS_ENV_NAMES);
    const previous = new Map(
      environmentNames.map((name) => [name, process.env[name]]),
    );
    for (const name of environmentNames) delete process.env[name];
    process.env[FEISHU_ACCESS_ENV_NAMES.admin] = 'ou_test_environment_admin';

    try {
      const service = new FeishuAccessService(
        new ConfigService(),
        createHttpService(),
      );
      expect(service.resolvePrincipal('ou_test_environment_admin')).toEqual({
        role: 'admin',
        purchaseBuilding: null,
      });
    } finally {
      for (const name of environmentNames) {
        setEnvironment(name, previous.get(name));
      }
    }
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    'on_test_wrong_prefix',
    'ou_',
    'ou_test.invalid',
    `ou_${'a'.repeat(200)}`,
    'ou_test_unknown_99',
  ])('fails closed for empty, unknown, or malformed open_id %p', (openId) => {
    const service = createService({
      [FEISHU_ACCESS_ENV_NAMES.admin]: 'ou_test_admin_01',
    });

    expect(service.resolvePrincipal(openId as never)).toBeNull();
  });

  it('treats missing or blank role lists as having no mapped identities', () => {
    const service = createService({
      [FEISHU_ACCESS_ENV_NAMES.admin]: '   ',
    });

    expect(service.resolvePrincipal('ou_test_unknown_01')).toBeNull();
  });

  it.each([
    'ou_test_first,,ou_test_second',
    'ou_test_first,   ,ou_test_second',
    ',ou_test_second',
    'ou_test_first,',
  ])('rejects a configured empty list item without leaking IDs', (value) => {
    const message = captureConfigurationError({
      [FEISHU_ACCESS_ENV_NAMES.admin]: value,
    });

    expect(message).toContain(FEISHU_ACCESS_ENV_NAMES.admin);
    expect(message).toContain('空项');
    expect(message).not.toContain('ou_test_first');
    expect(message).not.toContain('ou_test_second');
  });

  it('rejects duplicate IDs in one role list without leaking the ID', () => {
    const openId = 'ou_test_duplicate_01';
    const message = captureConfigurationError({
      [FEISHU_ACCESS_ENV_NAMES.duty_editor]: `${openId}, ${openId}`,
    });

    expect(message).toContain(FEISHU_ACCESS_ENV_NAMES.duty_editor);
    expect(message).toContain('重复');
    expect(message).not.toContain(openId);
  });

  it('rejects cross-role collisions without leaking the ID', () => {
    const openId = 'ou_test_cross_role_01';
    const message = captureConfigurationError({
      [FEISHU_ACCESS_ENV_NAMES.admin]: openId,
      [FEISHU_ACCESS_ENV_NAMES.construction_admin]: openId,
    });

    expect(message).toContain('跨角色');
    expect(message).not.toContain(openId);
  });

  it('rejects a malformed configured ID without leaking the value', () => {
    const malformedOpenId = 'ou_test_malformed.value';
    const message = captureConfigurationError({
      [FEISHU_ACCESS_ENV_NAMES.supply_chain_admin]: malformedOpenId,
    });

    expect(message).toContain(FEISHU_ACCESS_ENV_NAMES.supply_chain_admin);
    expect(message).toContain('格式');
    expect(message).not.toContain(malformedOpenId);
  });

  it('rejects a non-string configuration value without leaking it', () => {
    const configuredValue = 73001;
    const message = captureConfigurationError({
      [FEISHU_ACCESS_ENV_NAMES.construction_admin]: configuredValue,
    });

    expect(message).toContain(FEISHU_ACCESS_ENV_NAMES.construction_admin);
    expect(message).toContain('类型');
    expect(message).not.toContain(String(configuredValue));
  });

  describe('OAuth configuration and authorization URL', () => {
    it('keeps OAuth configuration validation lazy for mapping-only use', () => {
      const service = createService({
        [FEISHU_ACCESS_ENV_NAMES.admin]: 'ou_test_admin_01',
      });

      expect(service.resolvePrincipal('ou_test_admin_01')).toEqual({
        role: 'admin',
        purchaseBuilding: null,
      });
    });

    it('normalizes the callback URL and uses it in the authorization URL', () => {
      const service = createService(
        createOAuthConfig({
          [FEISHU_OAUTH_ENV_NAMES.publicBaseUrl]:
            'https://portal.example.test/nantong/',
          [FEISHU_OAUTH_ENV_NAMES.clientBasePath]: '/schedule/',
        }),
      );
      const state = 'oauth_state-123456';

      expect(service.getCallbackUrl()).toBe(
        'https://portal.example.test/nantong/schedule/api/access/feishu/callback',
      );

      const authorizationUrl = new URL(service.buildAuthorizationUrl(state));
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        FEISHU_AUTHORIZE_URL,
      );
      expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
        client_id: 'cli_test_app_id',
        redirect_uri:
          'https://portal.example.test/nantong/schedule/api/access/feishu/callback',
        response_type: 'code',
        state,
      });
      expect(authorizationUrl.searchParams.has('scope')).toBe(false);
    });

    it.each([undefined, '', '   '] as const)(
      'treats optional CLIENT_BASE_PATH value %p as the root path',
      (clientBasePath) => {
        const service = createService(
          createOAuthConfig({
            [FEISHU_OAUTH_ENV_NAMES.publicBaseUrl]:
              'https://portal.example.test/',
            [FEISHU_OAUTH_ENV_NAMES.clientBasePath]: clientBasePath,
          }),
        );

        expect(service.getCallbackUrl()).toBe(
          'https://portal.example.test/api/access/feishu/callback',
        );
      },
    );

    it.each([
      [
        'https://portal.example.test/',
        '/',
        'https://portal.example.test/api/access/feishu/callback',
      ],
      [
        'https://portal.example.test/base/',
        '/',
        'https://portal.example.test/base/api/access/feishu/callback',
      ],
      [
        'https://portal.example.test/',
        '/app/',
        'https://portal.example.test/app/api/access/feishu/callback',
      ],
      [
        'https://portal.example.test/root//nested/',
        '/app//v2/',
        'https://portal.example.test/root//nested/app//v2/api/access/feishu/callback',
      ],
      [
        'https://portal.example.test/root%20folder/',
        '/client path/',
        'https://portal.example.test/root%20folder/client%20path/api/access/feishu/callback',
      ],
    ])(
      'serializes a safe callback from public base %p and client base %p',
      (publicBaseUrl, clientBasePath, expected) => {
        const service = createService(
          createOAuthConfig({
            [FEISHU_OAUTH_ENV_NAMES.publicBaseUrl]: publicBaseUrl,
            [FEISHU_OAUTH_ENV_NAMES.clientBasePath]: clientBasePath,
          }),
        );

        expect(service.getCallbackUrl()).toBe(expected);
        expect(new URL(service.getCallbackUrl()).origin).toBe(
          'https://portal.example.test',
        );
      },
    );

    it.each([
      '',
      '   ',
      'short-state-123',
      'a'.repeat(257),
      'state with spaces 1234',
      'state/with/slash-1234',
      'state.with.dot-1234',
      null,
    ])('rejects unsafe OAuth state %p', (state) => {
      const service = createService(createOAuthConfig());

      expect(() => service.buildAuthorizationUrl(state as never)).toThrow(
        expect.objectContaining({ code: 'invalid_request' }),
      );
    });

    it.each([
      [{ [FEISHU_OAUTH_ENV_NAMES.appId]: '' }],
      [{ [FEISHU_OAUTH_ENV_NAMES.appSecret]: undefined }],
      [{ [FEISHU_OAUTH_ENV_NAMES.publicBaseUrl]: '/relative' }],
      [{ [FEISHU_OAUTH_ENV_NAMES.publicBaseUrl]: 'ftp://example.test/root' }],
      [{ [FEISHU_OAUTH_ENV_NAMES.clientBasePath]: '/bad\\path' }],
    ])('reports invalid OAuth configuration safely for %p', (overrides) => {
      const secret = 'configuration-secret-must-not-leak';
      const service = createService(
        createOAuthConfig({
          [FEISHU_OAUTH_ENV_NAMES.appSecret]: secret,
          ...overrides,
        }),
      );

      const error = captureFeishuAccessError(() => service.getCallbackUrl());
      expect(error.code).toBe('configuration');
      expect(error.message).not.toContain(secret);
      const configuredValue = Object.values(overrides)[0];
      if (configuredValue !== undefined && String(configuredValue)) {
        expect(error.message).not.toContain(String(configuredValue));
      }
    });

    it.each([
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://user:user-a1ad1416@example.com/root',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root?secret=query',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root#secret-fragment',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root\r\ninjected',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root\u007finjected',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root\\injected',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/./admin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/../admin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/%2e%2e/admin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/%252e%252e/admin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/safe%2Fadmin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/safe%252Fadmin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/safe%5Cadmin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/safe%255Cadmin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/safe%0dadmin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/safe%250dadmin',
      ],
      [
        FEISHU_OAUTH_ENV_NAMES.publicBaseUrl,
        'https://portal.example.test/root/bad%2',
      ],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/./admin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/../admin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/%2e%2e/admin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/%252e%252e/admin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/safe%2Fadmin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/safe%252Fadmin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/safe%5Cadmin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/safe%255Cadmin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/safe%0aadmin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/safe%250aadmin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root\u007fadmin'],
      [FEISHU_OAUTH_ENV_NAMES.clientBasePath, '/root/bad%GG'],
    ] as const)(
      'rejects unsafe callback path configuration %s=%p',
      (environmentName, value) => {
        const service = createService(
          createOAuthConfig({ [environmentName]: value }),
        );

        const error = captureFeishuAccessError(() => service.getCallbackUrl());
        expect(error.code).toBe('configuration');
        expect(error.message).not.toContain(value);
      },
    );
  });

  describe('authorization code exchange', () => {
    it.each([
      [0, 0],
      ['0', '0'],
    ] as const)(
      'exchanges a code and resolves a mapped principal for success codes %p/%p',
      async (tokenCode, userCode) => {
        const accessToken = 'access-token-sensitive-value';
        const authorizationCode = 'authorization-code-sensitive-value';
        const httpService = createHttpService();
        httpService.axiosRef.post.mockResolvedValue({
          data: { code: tokenCode, access_token: accessToken },
        });
        httpService.axiosRef.get.mockResolvedValue({
          data: {
            code: userCode,
            data: { open_id: 'ou_test_admin_01' },
          },
        });
        const service = createService(
          createOAuthConfig({
            [FEISHU_ACCESS_ENV_NAMES.admin]: 'ou_test_admin_01',
          }),
          httpService,
        );

        await expect(
          service.exchangeAuthorizationCode(`  ${authorizationCode}  `),
        ).resolves.toEqual({ role: 'admin', purchaseBuilding: null });

        const callbackUrl =
          'https://portal.example.test/app/api/access/feishu/callback';
        expect(httpService.axiosRef.post).toHaveBeenCalledWith(
          FEISHU_TOKEN_URL,
          {
            grant_type: 'authorization_code',
            client_id: 'cli_test_app_id',
            client_secret: 'app-secret-sensitive-value',
            code: authorizationCode,
            redirect_uri: callbackUrl,
          },
          {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            timeout: 8000,
            maxRedirects: 0,
          },
        );
        expect(httpService.axiosRef.get).toHaveBeenCalledWith(
          FEISHU_USER_INFO_URL,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 8000,
            maxRedirects: 0,
          },
        );
      },
    );

    it.each([undefined, null, '', '   '])(
      'rejects an empty authorization code %p before HTTP calls',
      async (code) => {
        const httpService = createHttpService();
        const service = createService({}, httpService);

        const error = await captureRejectedFeishuAccessError(() =>
          service.exchangeAuthorizationCode(code as never),
        );
        expect(error.code).toBe('invalid_request');
        expect(httpService.axiosRef.post).not.toHaveBeenCalled();
        expect(httpService.axiosRef.get).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['token', { code: 19001, msg: 'secret upstream body' }],
      ['token', { code: '19001', access_token: 'secret access token' }],
      [
        'user',
        {
          code: 0,
          access_token: 'secret access token',
          userResponse: {
            code: 19002,
            msg: 'secret user body with ou_test_private_01',
          },
        },
      ],
    ] as const)(
      'maps a non-zero %s response to a safe upstream_rejected error',
      async (stage, response) => {
        const httpService = createHttpService();
        const authorizationCode = 'secret-authorization-code';
        const appSecret = 'secret-app-credential';
        const accessToken =
          'access_token' in response ? response.access_token : 'secret-token';
        httpService.axiosRef.post.mockResolvedValue({
          data:
            stage === 'token'
              ? response
              : { code: 0, access_token: accessToken },
        });
        if ('userResponse' in response) {
          httpService.axiosRef.get.mockResolvedValue({
            data: response.userResponse,
          });
        }
        const service = createService(
          createOAuthConfig({
            [FEISHU_OAUTH_ENV_NAMES.appSecret]: appSecret,
          }),
          httpService,
        );

        const error = await captureRejectedFeishuAccessError(() =>
          service.exchangeAuthorizationCode(authorizationCode),
        );
        expect(error.code).toBe('upstream_rejected');
        expect(error.message).not.toContain(authorizationCode);
        expect(error.message).not.toContain(appSecret);
        expect(error.message).not.toContain(accessToken);
        expect(error.message).not.toContain('ou_test_private_01');
        expect(error.message).not.toContain('secret upstream body');
        expect(error.message).not.toContain('secret user body');
      },
    );

    it.each(['network secret', 'timeout secret'])(
      'maps a token HTTP failure to a safe upstream_unavailable error: %s',
      async (sensitiveMessage) => {
        const httpService = createHttpService();
        httpService.axiosRef.post.mockRejectedValue(
          new Error(sensitiveMessage),
        );
        const service = createService(createOAuthConfig(), httpService);

        const error = await captureRejectedFeishuAccessError(() =>
          service.exchangeAuthorizationCode('secret-code-value'),
        );
        expect(error.code).toBe('upstream_unavailable');
        expect(error.message).not.toContain(sensitiveMessage);
        expect(error.message).not.toContain('secret-code-value');
        expect(httpService.axiosRef.post).toHaveBeenCalledTimes(1);
        expect(httpService.axiosRef.get).not.toHaveBeenCalled();
      },
    );

    it('maps a user-info HTTP failure to a safe upstream_unavailable error', async () => {
      const httpService = createHttpService();
      httpService.axiosRef.post.mockResolvedValue({
        data: { code: 0, access_token: 'secret-access-token' },
      });
      httpService.axiosRef.get.mockRejectedValue(
        new Error('secret refresh_token and upstream body'),
      );
      const service = createService(createOAuthConfig(), httpService);

      const error = await captureRejectedFeishuAccessError(() =>
        service.exchangeAuthorizationCode('secret-code-value'),
      );
      expect(error.code).toBe('upstream_unavailable');
      expect(error.message).not.toContain('secret-access-token');
      expect(error.message).not.toContain('refresh_token');
      expect(error.message).not.toContain('secret-code-value');
      expect(httpService.axiosRef.post).toHaveBeenCalledTimes(1);
      expect(httpService.axiosRef.get).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['token', 400, 'upstream_rejected'],
      ['token', 401, 'upstream_rejected'],
      ['token', 429, 'upstream_unavailable'],
      ['token', 500, 'upstream_unavailable'],
      ['token', 302, 'upstream_unavailable'],
      ['user', 400, 'upstream_rejected'],
      ['user', 401, 'upstream_rejected'],
      ['user', 429, 'upstream_unavailable'],
      ['user', 500, 'upstream_unavailable'],
      ['user', 302, 'upstream_unavailable'],
    ] as const)(
      'classifies a %s Axios HTTP %i response as %s without retrying or retaining secrets',
      async (stage, status, expectedCode) => {
        const authorizationCode = 'authorization-code-secret';
        const accessToken = 'access-token-secret';
        const httpService = createHttpService();
        const axiosError = createAxiosHttpError(status);
        if (stage === 'token') {
          httpService.axiosRef.post.mockRejectedValue(axiosError);
        } else {
          httpService.axiosRef.post.mockResolvedValue({
            data: { code: 0, access_token: accessToken },
          });
          httpService.axiosRef.get.mockRejectedValue(axiosError);
        }
        const service = createService(createOAuthConfig(), httpService);

        const error = await captureRejectedFeishuAccessError(() =>
          service.exchangeAuthorizationCode(authorizationCode),
        );

        expect(error.code).toBe(expectedCode);
        expectSafeError(error, [
          authorizationCode,
          accessToken,
          `transport-secret-${status}`,
          `response-secret-${status}`,
          `business-code-secret-${status}`,
          'refresh-token-secret',
          'ou_private_secret_01',
        ]);
        expect(httpService.axiosRef.post).toHaveBeenCalledTimes(1);
        expect(httpService.axiosRef.get).toHaveBeenCalledTimes(
          stage === 'user' ? 1 : 0,
        );
      },
    );

    it.each([
      [{ code: 0 }, undefined],
      [{ code: 0, data: { access_token: 'nested-secret-token' } }, undefined],
      [
        { code: 0, access_token: 'secret-access-token' },
        { code: 0, data: {} },
      ],
      [
        { code: 0, access_token: 'secret-access-token' },
        { data: { open_id: 'ou_test_admin_01' } },
      ],
    ] as const)(
      'maps missing token or user fields to a safe invalid_response error',
      async (tokenResponse, userResponse) => {
        const httpService = createHttpService();
        httpService.axiosRef.post.mockResolvedValue({ data: tokenResponse });
        if (userResponse) {
          httpService.axiosRef.get.mockResolvedValue({ data: userResponse });
        }
        const service = createService(
          createOAuthConfig({
            [FEISHU_ACCESS_ENV_NAMES.admin]: 'ou_test_admin_01',
          }),
          httpService,
        );

        const error = await captureRejectedFeishuAccessError(() =>
          service.exchangeAuthorizationCode('secret-code-value'),
        );
        expect(error.code).toBe('invalid_response');
        expect(error.message).not.toContain('secret');
        expect(error.message).not.toContain('ou_test_admin_01');
      },
    );

    it('accepts an unmapped verified identity as guest without exposing its open_id', async () => {
      const openId = 'ou_test_private_identity_01';
      const httpService = createHttpService();
      httpService.axiosRef.post.mockResolvedValue({
        data: { code: 0, access_token: 'secret-access-token' },
      });
      httpService.axiosRef.get.mockResolvedValue({
        data: { code: 0, data: { open_id: openId } },
      });
      const service = createService(createOAuthConfig(), httpService);

      const principal = await service.exchangeAuthorizationCode('secret-code-value');
      expect(principal).toEqual({
        role: 'guest', purchaseBuilding: null, feishuAppId: 'cli_test_app_id',
        accountId: `feishu-${createHash('sha256').update('cli_test_app_id' + '\0' + openId).digest('hex')}`,
      });
      expect(JSON.stringify(principal)).not.toContain(openId);
      expect(JSON.stringify(principal)).not.toContain('secret');
    });

    it.each([
      ' ou_test_admin_01 ',
      'on_test_wrong_prefix',
      'ou_',
      'ou_test.invalid',
      `ou_${'a'.repeat(200)}`,
    ])(
      'maps malformed user-info open_id %p to invalid_response',
      async (openId) => {
        const httpService = createHttpService();
        httpService.axiosRef.post.mockResolvedValue({
          data: { code: 0, access_token: 'secret-access-token' },
        });
        httpService.axiosRef.get.mockResolvedValue({
          data: { code: 0, data: { open_id: openId } },
        });
        const service = createService(
          createOAuthConfig({
            [FEISHU_ACCESS_ENV_NAMES.admin]: 'ou_test_admin_01',
          }),
          httpService,
        );

        const error = await captureRejectedFeishuAccessError(() =>
          service.exchangeAuthorizationCode('secret-code-value'),
        );
        expect(error.code).toBe('invalid_response');
        expect(error.message).not.toContain(openId);
        expect(httpService.axiosRef.post).toHaveBeenCalledTimes(1);
        expect(httpService.axiosRef.get).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('sanitizeReturnTo', () => {
    it.each([
      ['/', '/'],
      ['/monthly-schedule', '/monthly-schedule'],
      [
        '/monthly-schedule?date=2026-07-17#current',
        '/monthly-schedule?date=2026-07-17#current',
      ],
      [
        '/monthly schedule?date=2026-07-17 08:00#current section',
        '/monthly%20schedule?date=2026-07-17%2008:00#current%20section',
      ],
      [
        '/reports/file%2520name?next=%252Fday#part%2523',
        '/reports/file%2520name?next=%252Fday#part%2523',
      ],
    ])('keeps safe same-site returnTo %p', (value, expected) => {
      expect(createService({}).sanitizeReturnTo(value)).toBe(expected);
    });

    it.each([
      undefined,
      null,
      '',
      '   ',
      'monthly-schedule',
      'https://evil.example.test/path',
      '//evil.example.test/path',
      '\\evil.example.test\\path',
      '/monthly\\schedule',
      '/monthly\nschedule',
      '/monthly\u0000schedule',
      '/monthly\u007fschedule',
      '/safe/./target',
      '/safe/../target',
      '/..//evil.example.test',
      '/safe/%2e/target',
      '/safe/%2e%2e/target',
      '/safe/%252e%252e/target',
      '/safe%2Ftarget',
      '/safe%252Ftarget',
      '/safe%5Ctarget',
      '/safe%255Ctarget',
      '/safe%0dtarget',
      '/safe%250dtarget',
      '/safe%7ftarget',
      '/safe%257ftarget',
      '/safe/bad%',
      '/safe/bad%2',
      '/safe/bad%GG',
      '/safe?query=raw\r\ncontrol',
      '/safe#raw\u007fcontrol',
      {},
      [],
    ])('falls back for unsafe returnTo %p', (value) => {
      expect(createService({}).sanitizeReturnTo(value)).toBe(
        '/monthly-schedule',
      );
    });
  });
});

type HttpServiceMock = {
  axiosRef: {
    post: jest.Mock;
    get: jest.Mock;
  };
};

function createService(
  values: Record<string, unknown>,
  httpService: HttpServiceMock = createHttpService(),
): FeishuAccessService {
  return new FeishuAccessService(
    createConfigService(values),
    httpService as unknown as HttpService,
  );
}

function captureConfigurationError(values: Record<string, unknown>): string {
  try {
    createService(values);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('Expected Feishu access configuration to be rejected');
}

function createConfigService(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(name: string): T | undefined => values[name] as T | undefined,
  } as ConfigService;
}

function createHttpService(): HttpServiceMock {
  return {
    axiosRef: {
      post: jest.fn(),
      get: jest.fn(),
    },
  };
}

function createAxiosHttpError(status: number): AxiosError {
  return new AxiosError(
    `transport-secret-${status}`,
    `business-code-secret-${status}`,
    undefined,
    { request: `request-secret-${status}` },
    {
      status,
      statusText: 'Rejected',
      headers: {},
      config: {},
      data: {
        message: `response-secret-${status}`,
        code: `business-code-secret-${status}`,
        access_token: 'access-token-secret',
        refresh_token: 'refresh-token-secret',
        open_id: 'ou_private_secret_01',
      },
    } as never,
  );
}

function createOAuthConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [FEISHU_OAUTH_ENV_NAMES.appId]: 'cli_test_app_id',
    [FEISHU_OAUTH_ENV_NAMES.appSecret]: 'app-secret-sensitive-value',
    [FEISHU_OAUTH_ENV_NAMES.publicBaseUrl]: 'https://portal.example.test/',
    [FEISHU_OAUTH_ENV_NAMES.clientBasePath]: '/app/',
    ...overrides,
  };
}

function captureFeishuAccessError(action: () => unknown): FeishuAccessError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FeishuAccessError);
    return error as FeishuAccessError;
  }
  throw new Error('Expected a Feishu access error');
}

async function captureRejectedFeishuAccessError(
  action: () => Promise<unknown>,
): Promise<FeishuAccessError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(FeishuAccessError);
    return error as FeishuAccessError;
  }
  throw new Error('Expected a Feishu access error');
}

function expectSafeError(
  error: FeishuAccessError,
  sensitiveValues: readonly string[],
): void {
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(error, 'response')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(error, 'request')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(error, 'config')).toBe(false);

  const ownPropertyValues = Object.getOwnPropertyNames(error)
    .map((name) => String((error as unknown as Record<string, unknown>)[name]))
    .join('|');
  for (const sensitiveValue of sensitiveValues) {
    expect(error.message).not.toContain(sensitiveValue);
    expect(ownPropertyValues).not.toContain(sensitiveValue);
  }
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
