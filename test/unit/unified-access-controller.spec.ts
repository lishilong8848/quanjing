import { HttpModule, HttpService } from '@nestjs/axios';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  GLOBAL_MODULE_METADATA,
  MODULE_METADATA,
} from '@nestjs/common/constants';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const testRouteDecorator =
    () =>
    (target: unknown, _context?: unknown, descriptor?: PropertyDescriptor) =>
      descriptor ?? target;

  return {
    ...actual,
    Get: testRouteDecorator,
    Header: testRouteDecorator,
    Post: testRouteDecorator,
  };
});

jest.mock('../../server/modules/duty-schedule/duty-schedule.module', () => ({
  DutyScheduleModule: class DutyScheduleModule {},
}));
jest.mock('../../server/modules/bitable-sync/bitable-sync.module', () => ({
  BitableSyncModule: class BitableSyncModule {},
}));
jest.mock('../../server/modules/operations-kb/operations-kb.module', () => ({
  OperationsKbModule: class OperationsKbModule {},
}));
jest.mock(
  '../../server/modules/ali-monthly-report/ali-monthly-report.module',
  () => ({ AliMonthlyReportModule: class AliMonthlyReportModule {} }),
);
jest.mock(
  '../../server/modules/purchase-inventory/purchase-inventory.module',
  () => ({ PurchaseInventoryModule: class PurchaseInventoryModule {} }),
);
jest.mock(
  '../../server/modules/inventory-management/inventory-management.module',
  () => ({ InventoryManagementModule: class InventoryManagementModule {} }),
);
jest.mock(
  '../../server/modules/contract-management/contract-management.module',
  () => ({ ContractManagementModule: class ContractManagementModule {} }),
);
jest.mock(
  '../../server/modules/equipment-patrol/equipment-patrol-execution.module',
  () => ({
    EquipmentPatrolExecutionModule: class EquipmentPatrolExecutionModule {},
  }),
);
jest.mock('../../server/modules/view/view.module', () => ({
  ViewModule: class ViewModule {},
}));

import { AppModule } from '../../server/app.module';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { PublicAccessMetadataKey } from '../../server/common/access/unified-access.decorators';
import {
  FeishuAccessError,
  FeishuAccessService,
} from '../../server/common/access/feishu-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { UnifiedAccessModule } from '../../server/common/access/unified-access.module';
import {
  ACCESS_SESSION_TTL_MS,
  UnifiedAccessService,
} from '../../server/common/access/unified-access.service';

const NOW = Date.UTC(2026, 6, 14, 9, 30, 0);
const COOKIE_NAME = 'vnet_access_session';
const FEISHU_STATE_COOKIE_NAME = 'vnet_feishu_oauth_state';
const FEISHU_RETURN_TO_COOKIE_NAME = 'vnet_feishu_oauth_return_to';
const OAUTH_COOKIE_TTL_MS = 5 * 60 * 1000;
const PRINCIPAL_FINGERPRINT = 'f'.repeat(43);
const UNRESTRICTED_PRINCIPAL_FINGERPRINT = 'u'.repeat(43);

describe('UnifiedAccessController', () => {
  let service: {
    cookieName: string;
    login: jest.Mock;
    readSessionIdentity: jest.Mock;
    impersonationReturnContext: jest.Mock;
    renew: jest.Mock;
    issueTrustedSession: jest.Mock;
    configurationReadiness: jest.Mock;
    isAccessControlEnabled: jest.Mock;
    getUnrestrictedPrincipalFingerprint: jest.Mock;
  };
  let feishu: {
    buildAuthorizationUrl: jest.Mock;
    sanitizeReturnTo: jest.Mock;
    exchangeAuthorizationCode: jest.Mock;
  };
  let controller: UnifiedAccessController;
  let response: Pick<
    Response,
    'cookie' | 'clearCookie' | 'setHeader' | 'redirect'
  >;
  let dateNow: jest.SpyInstance<number, []>;

  beforeEach(() => {
    dateNow = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    service = {
      cookieName: COOKIE_NAME,
      login: jest.fn(),
      readSessionIdentity: jest.fn().mockReturnValue({
        principal: { role: 'guest', purchaseBuilding: null },
        expiresAt: null,
        principalFingerprint: null,
      }),
      impersonationReturnContext: jest.fn().mockReturnValue(undefined),
      renew: jest.fn().mockReturnValue(null),
      issueTrustedSession: jest.fn(),
      isAccessControlEnabled: jest.fn().mockReturnValue(true),
      getUnrestrictedPrincipalFingerprint: jest
        .fn()
        .mockReturnValue(UNRESTRICTED_PRINCIPAL_FINGERPRINT),
      configurationReadiness: jest.fn().mockReturnValue({
        core: true,
        inventory: true,
        purchase: true,
        construction: true,
      }),
    };
    feishu = {
      buildAuthorizationUrl: jest.fn(
        (state: string) =>
          `https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=${state}`,
      ),
      sanitizeReturnTo: jest.fn(sanitizeReturnToForTest),
      exchangeAuthorizationCode: jest.fn(),
    };
    controller = new UnifiedAccessController(service as never, feishu as never);
    response = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      setHeader: jest.fn(),
      redirect: jest.fn(),
    } as never;
    delete process.env.LOCAL_ACCESS_COOKIE_SECURE;
    delete process.env.LOCAL_ACCESS_TRUST_PROXY;
    delete process.env.LOCAL_ACCESS_DEPLOYMENT_ID;
    delete process.env.CLIENT_BASE_PATH;
  });

  afterEach(() => {
    dateNow.mockRestore();
    delete process.env.LOCAL_ACCESS_COOKIE_SECURE;
    delete process.env.LOCAL_ACCESS_TRUST_PROXY;
    delete process.env.LOCAL_ACCESS_DEPLOYMENT_ID;
    delete process.env.CLIENT_BASE_PATH;
  });

  it('awaits login, preserves password whitespace, sets the root cookie, and omits token', async () => {
    service.login.mockResolvedValue({
      token: 'private-session-token',
      principal: { role: 'editor', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    const result = await controller.login(
      {
        accountType: 'editor',
        password: '  sample credential  ',
      } as never,
      makeRequest({ ip: '127.0.0.7' }),
      response as Response,
    );

    expect(service.login).toHaveBeenCalledWith(
      {
        accountType: 'editor',
        password: '  sample credential  ',
      },
      '127.0.0.7',
    );
    expect(response.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'private-session-token',
      {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
        expires: new Date(NOW + ACCESS_SESSION_TTL_MS),
        maxAge: ACCESS_SESSION_TTL_MS,
      },
    );
    expect(result).toEqual({
      role: 'editor',
      purchaseBuilding: null,
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
      capabilities: {
        canEdit: true,
        canDelete: false,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-session-token');
    expect(JSON.stringify(result)).not.toContain('sample credential');
  });

  it('accepts a password-only unified login and lets the service resolve the role', async () => {
    service.login.mockResolvedValue({
      token: 'private-session-token',
      principal: { role: 'admin', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    const result = await controller.login(
      { password: 'test-unified-credential' } as never,
      makeRequest(),
      response as Response,
    );

    expect(service.login).toHaveBeenCalledWith(
      { password: 'test-unified-credential' },
      '127.0.0.1',
    );
    expect(result.role).toBe('admin');
  });

  it('uses an iframe-compatible partitioned session cookie over HTTPS', async () => {
    service.login.mockResolvedValue({
      token: 'private-session-token',
      principal: { role: 'editor', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    await controller.login(
      { accountType: 'editor', password: 'test-only-credential' },
      makeRequest({ secure: true, protocol: 'https' }),
      response as Response,
    );

    expect(response.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'private-session-token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
        partitioned: true,
      }),
    );
  });

  it.each(['duty_editor', 'supply_chain_admin'] as const)(
    'rejects the Feishu-only %s identity from local password login',
    async (accountType) => {
      await expect(
        controller.login(
          {
            accountType,
            password: 'test-only-feishu-identity-P6R2',
          } as never,
          makeRequest(),
          response as Response,
        ),
      ).rejects.toMatchObject({ status: 400 });

      expect(service.login).not.toHaveBeenCalled();
    },
  );

  it('accepts construction administrator local password login', async () => {
    service.login.mockResolvedValue({
      token: 'construction-session-token',
      principal: { role: 'construction_admin', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    const result = await controller.login(
      {
        accountType: 'construction_admin',
        password: 'test-only-construction-credential-P6R2',
      },
      makeRequest(),
      response as Response,
    );

    expect(service.login).toHaveBeenCalledWith(
      {
        accountType: 'construction_admin',
        password: 'test-only-construction-credential-P6R2',
      },
      '127.0.0.1',
    );
    expect(result.role).toBe('construction_admin');
  });

  it('rejects the retired contract administrator identity before password validation', async () => {
    await expect(
      controller.login(
        {
          accountType: 'contract_admin',
          password: 'test-shared-contract-credential',
        } as never,
        makeRequest(),
        response as Response,
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(service.login).not.toHaveBeenCalled();
  });

  it('expires the legacy purchase cookie on login, session, and logout', async () => {
    service.login.mockResolvedValue({
      token: 'test-session-token',
      principal: { role: 'purchase_admin', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    await controller.login(
      {
        accountType: 'purchase_admin',
        password: 'test-only-purchase-cookie-P8Q2',
      } as never,
      makeRequest(),
      response as Response,
    );
    controller.session(makeRequest(), response as Response);
    controller.logout(makeRequest(), response as Response);

    const clearCookieCalls = (response.clearCookie as jest.Mock).mock.calls;
    const legacyCookieCalls = clearCookieCalls.filter(
      ([name]) => name === 'purchase_application_user_session',
    );
    const accessCookieCalls = clearCookieCalls.filter(
      ([name]) => name === COOKIE_NAME,
    );

    expect(legacyCookieCalls).toHaveLength(3);
    expect(legacyCookieCalls).toEqual(
      Array.from({ length: 3 }, () => [
        'purchase_application_user_session',
        {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          secure: false,
          maxAge: 0,
        },
      ]),
    );
    expect(accessCookieCalls).toHaveLength(1);
  });

  it.each([
    undefined,
    null,
    {},
    { accountType: 'editor', password: '' },
    { accountType: 'editor', password: 1234 },
    { accountType: 'editor', password: 'x'.repeat(257) },
  ])('rejects malformed login payload %p with 400', async (body) => {
    await expect(
      controller.login(body as never, makeRequest(), response as Response),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.login).not.toHaveBeenCalled();
  });

  it('does not trim a whitespace-only password before delegating validation', async () => {
    service.login.mockResolvedValue({
      token: 'token',
      principal: { role: 'editor', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    await controller.login(
      { accountType: 'editor', password: ' ' },
      makeRequest(),
      response as Response,
    );

    expect(service.login).toHaveBeenCalledWith(
      { accountType: 'editor', password: ' ' },
      '127.0.0.1',
    );
  });

  it('passes through authentication errors from the service', async () => {
    const error = new UnauthorizedException('invalid test credential');
    service.login.mockRejectedValue(error);

    await expect(
      controller.login(
        { accountType: 'editor', password: 'wrong-test-credential' },
        makeRequest(),
        response as Response,
      ),
    ).rejects.toBe(error);
  });

  it('uses the socket address when Express request.ip is unavailable', async () => {
    service.login.mockResolvedValue({
      token: 'token',
      principal: { role: 'editor', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    await controller.login(
      { accountType: 'editor', password: 'sample credential' },
      makeRequest({ ip: '', remoteAddress: '10.0.0.9' }),
      response as Response,
    );

    expect(service.login).toHaveBeenCalledWith(
      { accountType: 'editor', password: 'sample credential' },
      '10.0.0.9',
    );
  });

  it.each([
    [
      'guest',
      null,
      {
        canEdit: false,
        canDelete: false,
        canForceRefresh: false,
        canAccessContracts: false,
      },
    ],
    [
      'editor',
      NOW + ACCESS_SESSION_TTL_MS,
      {
        canEdit: true,
        canDelete: false,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
    [
      'admin',
      NOW + ACCESS_SESSION_TTL_MS,
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: true,
      },
    ],
    [
      'purchase_admin',
      NOW + ACCESS_SESSION_TTL_MS,
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: true,
      },
    ],
    [
      'duty_editor',
      NOW + ACCESS_SESSION_TTL_MS,
      {
        canEdit: true,
        canDelete: false,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
    [
      'supply_chain_admin',
      NOW + ACCESS_SESSION_TTL_MS,
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: true,
      },
    ],
    [
      'construction_admin',
      NOW + ACCESS_SESSION_TTL_MS,
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
  ] as const)('returns consistent %s capabilities', (role, expiresAt, caps) => {
    if (role !== 'guest') {
      service.readSessionIdentity.mockReturnValue({
        principal: { role, purchaseBuilding: null },
        expiresAt,
        principalFingerprint: role === 'guest' ? null : PRINCIPAL_FINGERPRINT,
      });
    }

    const result = controller.session(
      makeRequest({ cookie: `${COOKIE_NAME}=old-token` }),
      response as Response,
    );

    expect(result).toEqual({
      role,
      purchaseBuilding: null,
      expiresAt,
      principalFingerprint: role === 'guest' ? null : PRINCIPAL_FINGERPRINT,
      capabilities: caps,
    });
    expect(JSON.stringify(result)).not.toContain(`${role}-token`);
  });

  it('reads a valid session without rotating its access cookie', () => {
    service.readSessionIdentity.mockReturnValue({
      principal: { role: 'admin', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });

    const result = controller.session(
      makeRequest({ cookie: `other=x; ${COOKIE_NAME}=old-token` }),
      response as Response,
    );

    expect(service.readSessionIdentity).toHaveBeenCalledWith('old-token', NOW);
    expect(response.cookie).not.toHaveBeenCalled();
    expect(result.role).toBe('admin');
  });

  it('cannot restore a stale privileged cookie after logout', () => {
    service.readSessionIdentity.mockReturnValue({
      principal: { role: 'admin', purchaseBuilding: null },
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      principalFingerprint: PRINCIPAL_FINGERPRINT,
    });
    const staleSessionResponse = {
      ...response,
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    } as Response;
    const logoutResponse = {
      ...response,
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    } as Response;

    const staleSession = controller.session(
      makeRequest({ cookie: `${COOKIE_NAME}=old-admin-token` }),
      staleSessionResponse,
    );
    const loggedOut = controller.logout(makeRequest(), logoutResponse);

    expect(staleSession.role).toBe('admin');
    expect(staleSessionResponse.cookie).not.toHaveBeenCalled();
    expect(logoutResponse.clearCookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
    expect(loggedOut.role).toBe('guest');
  });

  it('marks the session response as private and non-cacheable', () => {
    const setHeader = jest.fn();
    const nonCachingResponse = {
      ...response,
      setHeader,
    } as Response;

    controller.session(makeRequest(), nonCachingResponse);

    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
  });

  it('reports the active access schema and aggregate configuration readiness without secrets', () => {
    const deploymentId = 'e89a4d52-4885-4ba1-a4bb-28c31f4cd830';
    process.env.LOCAL_ACCESS_DEPLOYMENT_ID = deploymentId;
    const result = controller.runtime(response as Response);
    delete process.env.LOCAL_ACCESS_DEPLOYMENT_ID;

    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(service.configurationReadiness).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      schemaVersion: 3,
      supportsInventoryAdministrator: true,
      accessControlEnabled: true,
      deploymentId,
      configuration: {
        core: true,
        inventory: true,
        purchase: true,
        construction: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/password|secret|hash|token/i);
  });

  it('returns anonymous administrator access for session and logout when access control is disabled', () => {
    service.isAccessControlEnabled.mockReturnValue(false);

    const session = controller.session(makeRequest(), response as Response);
    const logout = controller.logout(makeRequest(), response as Response);
    const runtime = controller.runtime(response as Response);
    const expected = {
      role: 'admin',
      purchaseBuilding: null,
      expiresAt: null,
      principalFingerprint: UNRESTRICTED_PRINCIPAL_FINGERPRINT,
      capabilities: {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: true,
      },
    };

    expect(session).toEqual(expected);
    expect(logout).toEqual(expected);
    expect(runtime.accessControlEnabled).toBe(false);
    expect(service.readSessionIdentity).not.toHaveBeenCalled();
    expect(service.renew).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false,
    });
  });

  it('does not expose an invalid deployment identifier', () => {
    process.env.LOCAL_ACCESS_DEPLOYMENT_ID = 'not-a-public-deployment-id';
    expect(controller.runtime(response as Response).deploymentId).toBeNull();
    delete process.env.LOCAL_ACCESS_DEPLOYMENT_ID;
  });

  it.each([
    ['plain HTTP', {}, false, false],
    ['direct HTTPS', { secure: true, protocol: 'https' }, false, true],
    ['trusted HTTPS proxy', { forwardedProto: 'https' }, true, true],
  ] as const)(
    'starts Feishu authorization over %s with one-time state cookies',
    (_label, requestOptions, trustProxy, expectedSecure) => {
      if (trustProxy) process.env.LOCAL_ACCESS_TRUST_PROXY = 'true';

      controller.feishuAuthorize(
        '/monthly-schedule?view=week#today',
        makeRequest(requestOptions),
        response as Response,
      );

      expect(feishu.sanitizeReturnTo).toHaveBeenCalledWith(
        '/monthly-schedule?view=week#today',
      );
      const authorizationState = feishu.buildAuthorizationUrl.mock.calls[0][0];
      expect(authorizationState).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.cookie).toHaveBeenNthCalledWith(
        1,
        FEISHU_STATE_COOKIE_NAME,
        authorizationState,
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: expectedSecure,
          expires: new Date(NOW + OAUTH_COOKIE_TTL_MS),
          maxAge: OAUTH_COOKIE_TTL_MS,
        },
      );
      expect(response.cookie).toHaveBeenNthCalledWith(
        2,
        FEISHU_RETURN_TO_COOKIE_NAME,
        '/monthly-schedule?view=week#today',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: expectedSecure,
        }),
      );
      expect(response.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'no-store',
      );
      expect(response.redirect).toHaveBeenCalledWith(
        302,
        `https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=${authorizationState}`,
      );
    },
  );

  it.each([
    [
      'plain HTTP',
      new FeishuAccessError('configuration'),
      'configuration_error',
      {},
      false,
      {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      },
    ],
    [
      'direct HTTPS',
      new Error('upstream secret must not escape'),
      'unavailable',
      { secure: true, protocol: 'https' },
      true,
      {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
        partitioned: true,
      },
    ],
  ] as const)(
    'fails closed over %s when authorization URL construction throws',
    (
      _label,
      error,
      status,
      requestOptions,
      expectedSecure,
      expectedAccessCookieOptions,
    ) => {
      feishu.buildAuthorizationUrl.mockImplementation(() => {
        throw error;
      });

      controller.feishuAuthorize(
        '/monthly-schedule?view=week#today',
        makeRequest(requestOptions),
        response as Response,
      );

      if (expectedSecure) {
        expect(response.cookie).toHaveBeenCalledTimes(1);
        expect(response.cookie).toHaveBeenCalledWith('__Host-vnet_access_session', 'logged-out',
          expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 1000 }));
      } else {
        expect(response.cookie).not.toHaveBeenCalled();
      }
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_STATE_COOKIE_NAME,
        expect.objectContaining({
          sameSite: 'lax',
          path: '/',
          secure: expectedSecure,
        }),
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_RETURN_TO_COOKIE_NAME,
        expect.objectContaining({
          sameSite: 'lax',
          path: '/',
          secure: expectedSecure,
        }),
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        COOKIE_NAME,
        expectedAccessCookieOptions,
      );
      expect(response.redirect).toHaveBeenCalledWith(
        302,
        `/monthly-schedule?view=week&feishu_auth=${status}#today`,
      );
      expect(
        JSON.stringify((response.redirect as jest.Mock).mock.calls),
      ).not.toContain('upstream secret');
    },
  );

  it('exchanges a valid callback once, issues a trusted session, and preserves return query and hash', async () => {
    const principal = {
      role: 'duty_editor',
      purchaseBuilding: null,
    } as const;
    feishu.exchangeAuthorizationCode.mockResolvedValue(principal);
    service.issueTrustedSession.mockReturnValue({
      token: 'private-session-token',
      principal,
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
    });

    await controller.feishuCallback(
      {
        code: 'private-authorization-code',
        state: 'callback-state-value-1234567890',
      },
      makeRequest({
        cookie: oauthCookies(
          'callback-state-value-1234567890',
          '/monthly-schedule?view=week&feishu_auth=stale#today',
        ),
      }),
      response as Response,
    );

    expect(feishu.exchangeAuthorizationCode).toHaveBeenCalledWith(
      'private-authorization-code',
    );
    expect(service.issueTrustedSession).toHaveBeenCalledWith(principal, NOW);
    expect(response.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'private-session-token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      }),
    );
    expect(response.clearCookie).toHaveBeenCalledWith(
      FEISHU_STATE_COOKIE_NAME,
      expect.objectContaining({ sameSite: 'lax', path: '/' }),
    );
    expect(response.clearCookie).toHaveBeenCalledWith(
      FEISHU_RETURN_TO_COOKIE_NAME,
      expect.objectContaining({ sameSite: 'lax', path: '/' }),
    );
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      '/monthly-schedule?view=week&feishu_auth=success#today',
    );
    expect(
      JSON.stringify((response.redirect as jest.Mock).mock.calls),
    ).not.toMatch(/private-(authorization-code|session-token)/);
  });

  it('prefixes the browser return target with the configured client base path', async () => {
    process.env.CLIENT_BASE_PATH = '/nantong/';
    const principal = {
      role: 'construction_admin',
      purchaseBuilding: null,
    } as const;
    feishu.exchangeAuthorizationCode.mockResolvedValue(principal);
    service.issueTrustedSession.mockReturnValue({
      token: 'private-session-token',
      principal,
      expiresAt: NOW + ACCESS_SESSION_TTL_MS,
    });

    await controller.feishuCallback(
      {
        code: 'private-authorization-code',
        state: 'callback-state-value-1234567890',
      },
      makeRequest({
        cookie: oauthCookies(
          'callback-state-value-1234567890',
          '/construction-management?view=active#today',
        ),
      }),
      response as Response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      302,
      '/nantong/construction-management?view=active&feishu_auth=success#today',
    );
  });

  it.each([
    '//evil.example.test',
    'https://evil.example.test',
    '/safe/../evil',
    '/safe/%252e%252e/evil',
    '/safe/%252f/evil',
  ])(
    'does not use unsafe CLIENT_BASE_PATH %p in a browser redirect',
    async (clientBasePath) => {
      process.env.CLIENT_BASE_PATH = clientBasePath;

      await controller.feishuCallback(
        {
          error: 'access_denied',
          state: 'callback-state-value-1234567890',
        },
        makeRequest({
          cookie: oauthCookies(
            'callback-state-value-1234567890',
            '/monthly-schedule',
          ),
        }),
        response as Response,
      );

      expect(response.redirect).toHaveBeenCalledWith(
        302,
        '/monthly-schedule?feishu_auth=cancelled',
      );
      expect(JSON.stringify(response.redirect.mock.calls)).not.toContain(
        'evil.example.test',
      );
    },
  );

  it.each([
    ['direct HTTPS', { secure: true, protocol: 'https' }, false],
    ['trusted HTTPS proxy', { forwardedProto: 'https' }, true],
  ] as const)(
    'uses secure callback cookies over %s',
    async (_label, requestOptions, trustProxy) => {
      if (trustProxy) process.env.LOCAL_ACCESS_TRUST_PROXY = 'true';
      const principal = {
        role: 'supply_chain_admin',
        purchaseBuilding: null,
      } as const;
      feishu.exchangeAuthorizationCode.mockResolvedValue(principal);
      service.issueTrustedSession.mockReturnValue({
        token: 'private-session-token',
        principal,
        expiresAt: NOW + ACCESS_SESSION_TTL_MS,
      });

      await controller.feishuCallback(
        {
          code: 'private-authorization-code',
          state: 'callback-state-value-1234567890',
        },
        makeRequest({
          ...requestOptions,
          cookie: oauthCookies(
            'callback-state-value-1234567890',
            '/monthly-schedule',
          ),
        }),
        response as Response,
      );

      expect(response.cookie).toHaveBeenCalledWith(
        COOKIE_NAME,
        'private-session-token',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'none',
          path: '/',
          secure: true,
          partitioned: true,
        }),
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_STATE_COOKIE_NAME,
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: true,
        },
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_RETURN_TO_COOKIE_NAME,
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: true,
        },
      );
    },
  );

  it.each([
    ['configuration', 'configuration_error'],
    ['invalid_request', 'code_invalid'],
    ['upstream_unavailable', 'unavailable'],
    ['upstream_rejected', 'rejected'],
    ['invalid_response', 'invalid_response'],
    ['identity_not_allowed', 'identity_not_allowed'],
  ] as const)(
    'maps Feishu callback error %s to %s',
    async (errorCode, status) => {
      feishu.exchangeAuthorizationCode.mockRejectedValue(
        new FeishuAccessError(errorCode),
      );

      await controller.feishuCallback(
        {
          code: 'private-authorization-code',
          state: 'callback-state-value-1234567890',
        },
        makeRequest({
          cookie: oauthCookies(
            'callback-state-value-1234567890',
            '/monthly-schedule',
          ),
        }),
        response as Response,
      );

      expect(response.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: false,
      });
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_STATE_COOKIE_NAME,
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: false,
        },
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_RETURN_TO_COOKIE_NAME,
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: false,
        },
      );
      expect(response.redirect).toHaveBeenCalledWith(
        302,
        `/monthly-schedule?feishu_auth=${status}`,
      );
    },
  );

  it('maps unknown callback errors to unavailable without leaking details', async () => {
    feishu.exchangeAuthorizationCode.mockRejectedValue(
      new Error('private upstream failure detail'),
    );

    await controller.feishuCallback(
      {
        code: 'private-authorization-code',
        state: 'callback-state-value-1234567890',
      },
      makeRequest({
        cookie: oauthCookies(
          'callback-state-value-1234567890',
          '/monthly-schedule',
        ),
      }),
      response as Response,
    );

    expect(response.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false,
    });
    expect(response.clearCookie).toHaveBeenCalledWith(
      FEISHU_STATE_COOKIE_NAME,
      {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: false,
      },
    );
    expect(response.clearCookie).toHaveBeenCalledWith(
      FEISHU_RETURN_TO_COOKIE_NAME,
      {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: false,
      },
    );
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      '/monthly-schedule?feishu_auth=unavailable',
    );
    expect(
      JSON.stringify((response.redirect as jest.Mock).mock.calls),
    ).not.toContain('private upstream failure');
  });

  it.each([
    ['direct HTTPS', { secure: true, protocol: 'https' }, false],
    ['trusted HTTPS proxy', { forwardedProto: 'https' }, true],
  ] as const)(
    'clears secure callback cookies when the provider fails over %s',
    async (_label, requestOptions, trustProxy) => {
      if (trustProxy) process.env.LOCAL_ACCESS_TRUST_PROXY = 'true';

      await controller.feishuCallback(
        {
          error: 'provider_error',
          state: 'callback-state-value-1234567890',
        },
        makeRequest({
          ...requestOptions,
          cookie: oauthCookies(
            'callback-state-value-1234567890',
            '/monthly-schedule',
          ),
        }),
        response as Response,
      );

      expect(feishu.exchangeAuthorizationCode).not.toHaveBeenCalled();
      expect(service.issueTrustedSession).not.toHaveBeenCalled();
      expect(response.cookie).toHaveBeenCalledTimes(1);
      expect(response.cookie).toHaveBeenCalledWith('__Host-vnet_access_session', 'logged-out',
        expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 1000 }));
      expect(response.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
        partitioned: true,
      });
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_STATE_COOKIE_NAME,
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: true,
        },
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        FEISHU_RETURN_TO_COOKIE_NAME,
        {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: true,
        },
      );
      expect(response.redirect).toHaveBeenCalledWith(
        302,
        '/monthly-schedule?feishu_auth=cancelled',
      );
    },
  );

  it.each([
    [
      'missing query state',
      { code: 'code' },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'state_invalid',
    ],
    [
      'missing state cookie',
      { code: 'code', state: 'callback-state-value-1234567890' },
      '',
      'state_invalid',
    ],
    [
      'empty state cookie value',
      { code: 'code', state: 'callback-state-value-1234567890' },
      oauthCookies('', '/monthly-schedule'),
      'state_invalid',
    ],
    [
      'duplicate state cookie',
      { code: 'code', state: 'callback-state-value-1234567890' },
      `${FEISHU_STATE_COOKIE_NAME}=callback-state-value-1234567890; ${FEISHU_STATE_COOKIE_NAME}=duplicate; ${FEISHU_RETURN_TO_COOKIE_NAME}=%2Fmonthly-schedule`,
      'state_invalid',
    ],
    [
      'mismatched state',
      { code: 'code', state: 'other-state-value-12345678901234' },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'state_invalid',
    ],
    [
      'array state',
      {
        code: 'code',
        state: ['callback-state-value-1234567890'],
      },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'state_invalid',
    ],
    [
      'empty state',
      { code: 'code', state: '' },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'state_invalid',
    ],
    [
      'provider cancellation',
      {
        error: 'access_denied',
        state: 'callback-state-value-1234567890',
      },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'cancelled',
    ],
    [
      'arbitrary provider error',
      {
        error: 'provider_error',
        state: 'callback-state-value-1234567890',
      },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'cancelled',
    ],
    [
      'array provider error',
      {
        error: ['access_denied'],
        code: 'code',
        state: 'callback-state-value-1234567890',
      },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'code_invalid',
    ],
    [
      'missing code',
      { state: 'callback-state-value-1234567890' },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'code_invalid',
    ],
    [
      'array code',
      {
        code: ['code'],
        state: 'callback-state-value-1234567890',
      },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'code_invalid',
    ],
    [
      'empty code',
      { code: '   ', state: 'callback-state-value-1234567890' },
      oauthCookies('callback-state-value-1234567890', '/monthly-schedule'),
      'code_invalid',
    ],
  ] as const)(
    'rejects callback with %s and only consumes cookies for a matching OAuth attempt',
    async (_label, query, cookie, status) => {
      await controller.feishuCallback(
        query as never,
        makeRequest({ cookie }),
        response as Response,
      );

      expect(feishu.exchangeAuthorizationCode).not.toHaveBeenCalled();
      expect(service.issueTrustedSession).not.toHaveBeenCalled();
      if (status === 'state_invalid') {
        expect(response.clearCookie).not.toHaveBeenCalled();
        expect(response.cookie).not.toHaveBeenCalled();
      } else {
        expect(response.clearCookie).toHaveBeenCalledWith(FEISHU_STATE_COOKIE_NAME, expect.anything());
        expect(response.clearCookie).toHaveBeenCalledWith(FEISHU_RETURN_TO_COOKIE_NAME, expect.anything());
        expect(response.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.anything());
      }
      expect(response.redirect).toHaveBeenCalledWith(
        302,
        expect.stringContaining(`feishu_auth=${status}`),
      );
    },
  );

  it('uses the default return target when the callback cookie is unavailable', async () => {
    await controller.feishuCallback(
      {
        error: 'access_denied',
        state: 'callback-state-value-1234567890',
      },
      makeRequest({
        cookie: `${FEISHU_STATE_COOKIE_NAME}=callback-state-value-1234567890`,
      }),
      response as Response,
    );

    expect(feishu.sanitizeReturnTo).toHaveBeenCalledWith(undefined);
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      '/monthly-schedule?feishu_auth=cancelled',
    );
  });

  it('treats a malformed session cookie as guest without throwing', () => {
    const result = controller.session(
      makeRequest({ cookie: `${COOKIE_NAME}=%E0%A4%A` }),
      response as Response,
    );

    expect(result.role).toBe('guest');
    expect(service.readSessionIdentity).toHaveBeenCalledWith(undefined, NOW);
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('logout clears a root cookie with matching security attributes', () => {
    const result = controller.logout(makeRequest(), response as Response);

    expect(response.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false,
    });
    expect(result).toEqual({
      role: 'guest',
      purchaseBuilding: null,
      expiresAt: null,
      principalFingerprint: null,
      capabilities: {
        canEdit: false,
        canDelete: false,
        canForceRefresh: false,
        canAccessContracts: false,
      },
    });
  });

  it('marks all access entry points as explicitly public', () => {
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        UnifiedAccessController.prototype.runtime,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        UnifiedAccessController.prototype.login,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        UnifiedAccessController.prototype.session,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        UnifiedAccessController.prototype.logout,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        UnifiedAccessController.prototype.feishuAuthorize,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        UnifiedAccessController.prototype.feishuCallback,
      ),
    ).toBe(true);
  });
});

describe('UnifiedAccessModule registration', () => {
  it('wires Feishu HTTP and configuration access while retaining the existing global guard', async () => {
    expect(
      Reflect.getMetadata(GLOBAL_MODULE_METADATA, UnifiedAccessModule),
    ).toBe(true);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, UnifiedAccessModule),
    ).toContain(UnifiedAccessController);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, UnifiedAccessModule),
    ).toContain(UnifiedAccessService);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, UnifiedAccessModule),
    ).toContain(FeishuAccessService);
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, UnifiedAccessModule),
    ).toContain(HttpModule);
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      UnifiedAccessModule,
    );
    const resolvedImports = await Promise.all(imports);
    expect(resolvedImports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module: ConfigModule,
        }),
      ]),
    );

    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      UnifiedAccessModule,
    );
    expect(providers).toContain(UnifiedAccessService);
    expect(providers).toContain(FeishuAccessService);
    expect(providers).toContain(UnifiedAccessGuard);
    expect(providers).toContainEqual({
      provide: APP_GUARD,
      useExisting: UnifiedAccessGuard,
    });
  });

  it('compiles the real module with controller HTTP and configuration dependencies', async () => {
    const constructorMetadata = [
      [FeishuAccessService, [ConfigService, HttpService]],
      [UnifiedAccessController, [UnifiedAccessService, FeishuAccessService]],
      [UnifiedAccessGuard, [Reflector, UnifiedAccessService]],
    ] as const;
    const previousMetadata = constructorMetadata.map(([target]) =>
      Reflect.getMetadata('design:paramtypes', target),
    );

    // Root ts-jest uses client compiler options, so restore metadata emitted by tsconfig.node.json.
    constructorMetadata.forEach(([target, dependencies]) => {
      Reflect.defineMetadata('design:paramtypes', dependencies, target);
    });

    let moduleRef: TestingModule | undefined;
    try {
      moduleRef = await Test.createTestingModule({
        imports: [UnifiedAccessModule],
      }).compile();

      expect(moduleRef.get(ConfigService)).toBeInstanceOf(ConfigService);
      expect(moduleRef.get(HttpService)).toBeInstanceOf(HttpService);
      expect(moduleRef.get(FeishuAccessService)).toBeInstanceOf(
        FeishuAccessService,
      );
      expect(moduleRef.get(UnifiedAccessController)).toBeInstanceOf(
        UnifiedAccessController,
      );
    } finally {
      await moduleRef?.close();
      constructorMetadata.forEach(([target], index) => {
        const previous = previousMetadata[index];
        if (previous === undefined) {
          Reflect.deleteMetadata('design:paramtypes', target);
          return;
        }
        Reflect.defineMetadata('design:paramtypes', previous, target);
      });
    }
  });

  it('loads unified access before platform and business modules in AppModule', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule);

    expect(imports[0]).toBe(UnifiedAccessModule);
  });
});

function makeRequest(
  options: {
    ip?: string;
    remoteAddress?: string;
    cookie?: string;
    secure?: boolean;
    protocol?: string;
    forwardedProto?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.forwardedProto) {
    headers['x-forwarded-proto'] = options.forwardedProto;
  }
  return {
    ip: options.ip ?? '127.0.0.1',
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    secure: options.secure ?? false,
    protocol: options.protocol ?? 'http',
  } as Request;
}

function oauthCookies(state: string, returnTo: string): string {
  return `${FEISHU_STATE_COOKIE_NAME}=${encodeURIComponent(
    state,
  )}; ${FEISHU_RETURN_TO_COOKIE_NAME}=${encodeURIComponent(returnTo)}`;
}

function sanitizeReturnToForTest(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//')
    ? value
    : '/monthly-schedule';
}
