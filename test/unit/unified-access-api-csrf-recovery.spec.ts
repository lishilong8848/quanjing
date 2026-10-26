jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  getAccessSession,
  loginAccess,
  logoutAccess,
} from '../../client/src/api';
import type {
  AccessLoginRequest,
  AccessSessionResponse,
} from '../../shared/access-control.interface';

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  'document',
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalClientBasePath = process.env.CLIENT_BASE_PATH;
const fetchMock = jest.fn();

function installBrowserCsrfState(
  readCookieToken: () => string,
  windowToken: string,
): { csrfToken: string } {
  const windowState = { csrfToken: windowToken };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() {
        const token = readCookieToken();
        return token ? `suda-csrf-token=${token}; theme=light` : 'theme=light';
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: windowState,
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: fetchMock,
  });
  return windowState;
}

function restoreBrowserGlobals(): void {
  for (const [name, descriptor] of [
    ['document', originalDocument],
    ['window', originalWindow],
    ['fetch', originalFetch],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

function browserResponse(status: number, data: unknown): Response {
  return {
    status,
    text: jest
      .fn()
      .mockResolvedValue(typeof data === 'string' ? data : JSON.stringify(data)),
  } as unknown as Response;
}

function editorSession(): AccessSessionResponse {
  return {
    role: 'editor',
    purchaseBuilding: null,
    expiresAt: 1_784_680_000_000,
    principalFingerprint: 'synthetic-test',
    capabilities: {
      canEdit: true,
      canDelete: false,
      canForceRefresh: true,
      canAccessContracts: false,
    },
  };
}

describe('unified access API CSRF recovery', () => {
  const request: AccessLoginRequest = {
    accountType: 'editor',
    password: 'test-only-editor-password',
  };

  beforeEach(() => {
    fetchMock.mockReset();
    (axiosForBackend as jest.Mock).mockReset();
    delete process.env.CLIENT_BASE_PATH;
  });

  afterEach(() => {
    restoreBrowserGlobals();
    if (originalClientBasePath === undefined) {
      delete process.env.CLIENT_BASE_PATH;
    } else {
      process.env.CLIENT_BASE_PATH = originalClientBasePath;
    }
    jest.useRealTimers();
  });

  it('uses a direct browser request with the current CSRF cookie', async () => {
    const token = 'a'.repeat(43);
    installBrowserCsrfState(() => token, token);
    const session = editorSession();
    fetchMock.mockResolvedValue(browserResponse(200, session));

    await expect(loginAccess(request)).resolves.toEqual(session);

    expect(fetchMock).toHaveBeenCalledWith('/api/access/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: expect.anything(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Suda-Csrf-Token': token,
      },
      body: JSON.stringify(request),
    });
    expect(axiosForBackend).not.toHaveBeenCalled();
  });

  it('does not replay login after a CSRF 403 and tells the user to refresh', async () => {
    const oldToken = 'b'.repeat(43);
    installBrowserCsrfState(() => oldToken, oldToken);
    fetchMock.mockResolvedValue(browserResponse(403, 'Forbidden，csrf token not match.'));
    await expect(loginAccess(request)).rejects.toMatchObject({
      response: { status: 403, data: { message: '登录页面已过期，请刷新页面后重试。' } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(axiosForBackend).not.toHaveBeenCalled();
  });
  it('surfaces invalid credentials without retrying', async () => {
    const token = 'd'.repeat(43);
    installBrowserCsrfState(() => token, token);
    fetchMock.mockResolvedValue(
      browserResponse(401, { message: '登录凭据无效' }),
    );

    await expect(loginAccess(request)).rejects.toMatchObject({
      response: {
        status: 401,
        data: { message: '登录凭据无效' },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(axiosForBackend).not.toHaveBeenCalled();
  });

  it('does not retry a non-CSRF authorization failure', async () => {
    const token = 'e'.repeat(43);
    installBrowserCsrfState(() => token, token);
    fetchMock.mockResolvedValue(
      browserResponse(403, { message: 'forbidden' }),
    );

    await expect(loginAccess(request)).rejects.toMatchObject({
      response: { status: 403 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(axiosForBackend).not.toHaveBeenCalled();
  });

  it('uses the configured client base path for direct access requests', async () => {
    process.env.CLIENT_BASE_PATH = '/operations/';
    const token = 'f'.repeat(43);
    installBrowserCsrfState(() => token, token);
    const session = editorSession();
    fetchMock.mockResolvedValue(browserResponse(200, session));

    await expect(loginAccess(request)).resolves.toEqual(session);

    expect(fetchMock).toHaveBeenCalledWith(
      '/operations/api/access/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('aborts a stalled login chain and surfaces a retryable timeout', async () => {
    jest.useFakeTimers();
    const token = 'g'.repeat(43);
    installBrowserCsrfState(() => token, token);
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const pending = expect(loginAccess(request)).rejects.toMatchObject({
      response: {
        status: 408,
        data: { message: expect.stringContaining('超时') },
      },
    });
    await jest.advanceTimersByTimeAsync(10_000);

    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the initial session request', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: editorSession(),
      headers: {},
    });

    await expect(getAccessSession()).resolves.toEqual(editorSession());

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/access/session',
      method: 'GET',
      timeout: 10_000,
    });
  });

  it('bounds logout so a stalled mutation cannot block later login', async () => {
    const guestSession: AccessSessionResponse = {
      ...editorSession(),
      role: 'guest',
      expiresAt: null,
    };
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: guestSession });

    await expect(logoutAccess()).resolves.toEqual(guestSession);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/access/logout',
      method: 'POST',
      timeout: 10_000,
    });
  });
});
