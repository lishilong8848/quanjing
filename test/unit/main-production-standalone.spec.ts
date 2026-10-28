import { ConsoleLogger, Logger, RequestMethod } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const mockNestCreate = jest.fn();
const mockConfigureApp = jest.fn();
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockStatSync = jest.fn();
const mockCompressionMiddleware = jest.fn();
const mockCompression = jest.fn(() => mockCompressionMiddleware);
const mockActivationMiddleware = jest.fn();
const mockActivationStatus = jest.fn();
const mockActivationClose = jest.fn();
const mockActivationStop = jest.fn();
const mockActivation = { status: mockActivationStatus, close: mockActivationClose };
const mockActivationFactory = jest.fn(() => mockActivation);
const mockHttpActivationFactory = jest.fn((..._args: unknown[]) => mockActivationMiddleware);
const mockActivationMonitor = jest.fn();
const mockHttpServers = new Set<EventEmitter>();
let bootstrap: () => Promise<void>;
let createStandaloneCsrfSeedMiddleware: () => (
  request: {
    cookies: Record<string, string>;
    headers?: Record<string, string | string[] | undefined>;
    method?: string;
  },
  response: {
    locals: Record<string, unknown>;
    cookie: jest.Mock;
    clearCookie?: jest.Mock;
  },
  next: jest.Mock,
) => void;
let createApiCsrfValidationMiddleware: () => (
  request: {
    cookies?: Record<string, string>;
    headers?: Record<string, string | string[] | undefined>;
    method?: string;
    path?: string;
  },
  response: {
    status: jest.Mock;
    send: jest.Mock;
  },
  next: jest.Mock,
) => void;
let createMonthlyScheduleFormDirectLinkMiddleware: (
  clientBasePath: string,
) => (
  request: { method?: string; path?: string },
  response: { redirect: jest.Mock },
  next: jest.Mock,
) => void;

jest.mock('@nestjs/core', () => ({
  ...jest.requireActual('@nestjs/core'),
  NestFactory: {
    create: (...args: unknown[]) => mockNestCreate(...args),
  },
}));

jest.mock('@lark-apaas/fullstack-nestjs-core', () => ({
  configureApp: (...args: unknown[]) => mockConfigureApp(...args),
}));

jest.mock('compression', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockCompression(...args),
}));

jest.mock('../../server/app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('../../server/runtime-env', () => ({}));
jest.mock('../../server/common/hotfix-runtime-activation', () => ({ currentHotfixActivation: () => mockActivationFactory() }));
jest.mock('../../server/common/hotfix-http-activation', () => ({ createHotfixActivationMiddleware: (...args: unknown[]) => mockHttpActivationFactory(...args) }));
jest.mock('../../server/common/hotfix-activation-monitor', () => ({ startHotfixActivationMonitor: (...args: unknown[]) => mockActivationMonitor(...args) }));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

function createMockApp() {
  const httpServer = new EventEmitter(); mockHttpServers.add(httpServer);
  return {
    enableShutdownHooks: jest.fn(),
    disable: jest.fn(),
    set: jest.fn(),
    useStaticAssets: jest.fn(),
    setBaseViewsDir: jest.fn(),
    setViewEngine: jest.fn(),
    engine: jest.fn(),
    use: jest.fn(),
    useBodyParser: jest.fn(),
    setGlobalPrefix: jest.fn(),
    useLogger: jest.fn(),
    init: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockImplementation(async () => { httpServer.emit('close'); }),
    getHttpServer: jest.fn(() => httpServer),
    listen: jest.fn().mockResolvedValue(undefined),
  };
}

describe('production standalone bootstrap', () => {
  const originalEnv = process.env;

  beforeAll(async () => {
    mockNestCreate.mockResolvedValue(createMockApp());
    ({
      bootstrap,
      createStandaloneCsrfSeedMiddleware,
      createApiCsrfValidationMiddleware,
      createMonthlyScheduleFormDirectLinkMiddleware,
    } = require('../../server/main') as {
      bootstrap: () => Promise<void>;
      createStandaloneCsrfSeedMiddleware: typeof createStandaloneCsrfSeedMiddleware;
      createApiCsrfValidationMiddleware: typeof createApiCsrfValidationMiddleware;
      createMonthlyScheduleFormDirectLinkMiddleware: typeof createMonthlyScheduleFormDirectLinkMiddleware;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockActivationStatus.mockReturnValue({ phase: 'active' });
    mockActivationClose.mockResolvedValue(undefined);
    mockActivationStop.mockResolvedValue(undefined);
    mockActivationMonitor.mockResolvedValue({ stop: mockActivationStop });
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      SERVER_HOST: 'localhost',
      SERVER_PORT: '3000',
    };
    delete process.env.SUDA_DATABASE_URL;
    delete process.env.HTTPS_KEY_PATH;
    delete process.env.HTTPS_CERT_PATH;
    delete process.env.HTTPS_CA_PATH;
    delete process.env.CLIENT_BASE_PATH;
    delete process.env.LOCAL_ACCESS_COOKIE_SECURE;
    delete process.env.LOCAL_ACCESS_TRUST_PROXY;

    mockConfigureApp.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '<head><script>window.__platform__ = JSON.parse(\'{{{__platform__}}}\'); window.csrfToken = "{{csrfToken}}";</script></head>',
    );
    mockStatSync.mockReturnValue({ mtimeMs: 1_783_100_000_000 });

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const httpServer of mockHttpServers) httpServer.emit('close');
    mockHttpServers.clear();
    await Promise.resolve();
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('installs the trusted HTTP guard before parsers and initializes hooks before monitoring and listening', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true'; process.env.CLIENT_BASE_PATH = '/tenant';
    const app = createMockApp(); mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    expect(mockHttpActivationFactory).toHaveBeenCalledWith(mockActivation, '/tenant/api');
    expect(app.use.mock.calls[0]).toEqual([mockActivationMiddleware]);
    expect(app.use.mock.invocationCallOrder[0]).toBeLessThan(app.useBodyParser.mock.invocationCallOrder[0]);
    expect(app.init).toHaveBeenCalledTimes(1);
    expect(app.init.mock.invocationCallOrder[0]).toBeLessThan(mockActivationMonitor.mock.invocationCallOrder[0]);
    expect(mockActivationMonitor.mock.invocationCallOrder[0]).toBeLessThan(app.listen.mock.invocationCallOrder[0]);
  });

  it('releases activation monitoring when the real HTTP server closes', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp(); mockNestCreate.mockResolvedValue(app); await bootstrap();
    app.getHttpServer().emit('close'); await Promise.resolve();
    expect(mockActivationStop).toHaveBeenCalledTimes(1);
  });

  it('closes the application and gate when native initialization fails without listening', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp(); app.init.mockRejectedValue(new Error('synthetic initialization failure'));
    mockNestCreate.mockResolvedValue(app);
    await expect(bootstrap()).rejects.toThrow('synthetic initialization failure');
    expect(app.listen).not.toHaveBeenCalled(); expect(app.close).toHaveBeenCalledTimes(1);
    expect(mockActivationClose).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid release proof before constructing the Nest application', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true'; mockActivationStatus.mockReturnValue({ phase: 'failed' });
    await expect(bootstrap()).rejects.toThrow('HOTFIX_INVALID_RELEASE_PROOF');
    expect(mockNestCreate).not.toHaveBeenCalled();
  });

  it('enables raw request body capture without dropping existing bootstrap options', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    mockNestCreate.mockResolvedValue(createMockApp());

    await bootstrap();

    expect(mockNestCreate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        abortOnError: true,
        rawBody: true,
      }),
    );
  });

  it('registers raw JSON before framework setup and excludes the fixed callback from the global prefix', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    process.env.CLIENT_BASE_PATH = '/app/test/';
    process.env.BODY_SIZE_LIMIT = '2mb';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await bootstrap();

    expect(app.useBodyParser).toHaveBeenCalledWith('json', { limit: '2mb' });
    expect(app.setGlobalPrefix).toHaveBeenCalledWith('/app/test', {
      exclude: [
        {
          path: 'callbacks/feishu/purchase-card',
          method: RequestMethod.POST,
        },
      ],
    });
    expect(app.useBodyParser.mock.invocationCallOrder[0]).toBeLessThan(
      mockConfigureApp.mock.invocationCallOrder[0],
    );
    expect(mockConfigureApp.mock.invocationCallOrder[0]).toBeLessThan(
      app.setGlobalPrefix.mock.invocationCallOrder[0],
    );
  });

  it('starts without a database and logs an explicit standalone warning', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await expect(bootstrap()).resolves.toBeUndefined();

    expect(app.listen).toHaveBeenCalledWith(3000, 'localhost');
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringMatching(/production standalone/i),
    );
  });

  it('uses a local startup error logger after framework setup in standalone production', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp();
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockNestCreate.mockResolvedValue(app);
    app.listen.mockImplementation(async () => {
      const localLogger = app.useLogger.mock.calls.at(-1)?.[0];
      expect(localLogger).toBeInstanceOf(ConsoleLogger);
      localLogger.error('isolated initialization failure');
    });
    await bootstrap();
    expect(mockConfigureApp.mock.invocationCallOrder[0]).toBeLessThan(
      app.useLogger.mock.invocationCallOrder[0],
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('isolated initialization failure'),
    );
  });

  it('does not replace the platform logger for database-backed production', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    expect(app.useLogger).not.toHaveBeenCalled();
  });

  it('refuses to start without a database when Datapass is still enabled', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';

    await expect(bootstrap()).rejects.toThrow(
      /FORCE_FRAMEWORK_DISABLE_DATAPASS/,
    );

    expect(mockNestCreate).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it.each([undefined, 'invalid-switch'])(
    'refuses to start without a database when the Datapass switch is %s',
    async (datapassValue) => {
      if (datapassValue === undefined) {
        delete process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS;
      } else {
        process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = datapassValue;
      }

      await expect(bootstrap()).rejects.toThrow(
        /FORCE_FRAMEWORK_DISABLE_DATAPASS/,
      );

      expect(mockNestCreate).not.toHaveBeenCalled();
    },
  );

  it('disables the Express x-powered-by response header', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await bootstrap();

    expect(app.disable).toHaveBeenCalledWith('x-powered-by');
  });

  it('compresses production responses before static assets and API handlers', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await bootstrap();

    expect(mockCompression).toHaveBeenCalledWith({ threshold: 1024 });
    expect(app.use).toHaveBeenCalledWith(mockCompressionMiddleware);
    expect(
      app.use.mock.invocationCallOrder[
        app.use.mock.calls.findIndex(
          ([middleware]) => middleware === mockCompressionMiddleware,
        )
      ],
    ).toBeLessThan(app.useStaticAssets.mock.invocationCallOrder[0]);
  });

  it('caches hashed chunks immutably and revalidates entry scripts', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const options = app.useStaticAssets.mock.calls[0][1] as {
      setHeaders: (
        response: { setHeader: jest.Mock; removeHeader: jest.Mock },
        assetPath: string,
      ) => void;
    };

    const chunkResponse = {
      setHeader: jest.fn(),
      removeHeader: jest.fn(),
    };
    options.setHeaders(
      chunkResponse,
      'D:\\app\\dist\\client\\chunks\\3668.e3568dd2.js',
    );
    expect(chunkResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=31536000, immutable',
    );

    const entryResponse = {
      setHeader: jest.fn(),
      removeHeader: jest.fn(),
    };
    options.setHeaders(entryResponse, 'D:\\app\\dist\\client\\main.js');
    expect(entryResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=0, must-revalidate',
    );
    expect(entryResponse.removeHeader).toHaveBeenCalledWith('Pragma');
    expect(entryResponse.removeHeader).toHaveBeenCalledWith('Expires');
  });

  it('restores trust proxy to false after framework configuration', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    mockConfigureApp.mockImplementationOnce(async (configuredApp) => {
      configuredApp.set('trust proxy', true);
    });

    await bootstrap();

    expect(app.set).toHaveBeenNthCalledWith(1, 'trust proxy', true);
    expect(app.set).toHaveBeenNthCalledWith(2, 'trust proxy', false);
  });

  it('installs CSRF compatibility after framework configuration in production database mode', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await bootstrap();

    expect(app.use).toHaveBeenCalledTimes(7);
    expect(mockConfigureApp.mock.invocationCallOrder[0]).toBeLessThan(
      app.use.mock.invocationCallOrder[1],
    );
    const compatibilityMiddleware = app.use.mock.calls[1][0] as ReturnType<
      typeof createStandaloneCsrfSeedMiddleware
    >;
    const existingToken = 'a'.repeat(43);
    const request = {
      cookies: { 'suda-csrf-token': existingToken },
      headers: {},
      method: 'GET',
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };

    compatibilityMiddleware(request, response, jest.fn());

    expect(request.headers['x-suda-csrf-token']).toBe(existingToken);
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('installs the application-level CSRF validator on every production API route', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await bootstrap();

    expect(app.use.mock.calls[2][0]).toBe('/api');
    expect(app.use.mock.calls[2][1]).toEqual(expect.any(Function));
  });

  it.each([
    ['', '/monthly-schedule/apply/leave', '/monthly-schedule?form=leave'],
    [
      '/app/base',
      '/app/base/monthly-schedule/apply/overtime',
      '/app/base/monthly-schedule?form=overtime',
    ],
  ])(
    'redirects the form direct link under base path %s to the stable monthly schedule entry',
    (clientBasePath, path, expectedTarget) => {
      const middleware =
        createMonthlyScheduleFormDirectLinkMiddleware(clientBasePath);
      const response = { redirect: jest.fn() };
      const next = jest.fn();

      middleware({ method: 'GET', path }, response, next);

      expect(response.redirect).toHaveBeenCalledWith(302, expectedTarget);
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('installs the CSRF validator under a normalized client base path', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    process.env.CLIENT_BASE_PATH = '/app/supply-chain/';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await bootstrap();

    expect(app.use.mock.calls[2][0]).toBe('/app/supply-chain/api');
    expect(app.use.mock.calls[2][1]).toEqual(expect.any(Function));
  });

  it('does not seed a missing CSRF cookie in production database mode', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const compatibilityMiddleware = app.use.mock.calls[1][0] as ReturnType<
      typeof createStandaloneCsrfSeedMiddleware
    >;
    const request = { cookies: {}, headers: {}, method: 'GET' };
    const response = {
      locals: {},
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    compatibilityMiddleware(request, response, jest.fn());

    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.clearCookie).not.toHaveBeenCalled();
    expect(request.headers['x-suda-csrf-token']).toBeUndefined();
    expect(request.cookies).toEqual({});
    expect(response.locals).not.toHaveProperty('csrfToken');
  });

  it('clears a malformed framework CSRF cookie so the next page request can recover', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const compatibilityMiddleware = app.use.mock.calls[1][0] as ReturnType<
      typeof createStandaloneCsrfSeedMiddleware
    >;
    const request = {
      cookies: { 'suda-csrf-token': 'not-a-valid-token' },
      headers: {},
      method: 'GET',
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    compatibilityMiddleware(request, response, jest.fn());

    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith(
      'suda-csrf-token',
      expect.objectContaining({ path: '/', secure: true }),
    );
    expect(request.cookies).not.toHaveProperty('suda-csrf-token');
    expect(request.headers['x-suda-csrf-token']).toBeUndefined();
    expect(response.locals).not.toHaveProperty('csrfToken');
  });

  it('does not supply a CSRF header to an unsafe request in production database mode', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const compatibilityMiddleware = app.use.mock.calls[1][0] as ReturnType<
      typeof createStandaloneCsrfSeedMiddleware
    >;
    const request = {
      cookies: { 'suda-csrf-token': 'a'.repeat(43) },
      headers: {},
      method: 'POST',
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };

    compatibilityMiddleware(request, response, jest.fn());

    expect(request.headers['x-suda-csrf-token']).toBeUndefined();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('does not install CSRF compatibility middleware during development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);

    await bootstrap();

    expect(app.use).toHaveBeenCalledTimes(3);
  });

  it('delegates database-mode SPA page requests to the platform view controller', async () => {
    process.env.SUDA_DATABASE_URL = 'postgres://database.example/app';
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const fallback = app.use.mock.calls[app.use.mock.calls.length - 1][0] as (
      request: { method: string; path: string },
      response: {
        locals: Record<string, unknown>;
        type: jest.Mock;
        send: jest.Mock;
      },
      next: jest.Mock,
    ) => void;
    const response = {
      locals: {},
      type: jest.fn(),
      send: jest.fn(),
    };
    response.type.mockReturnValue(response);
    const next = jest.fn();

    fallback({ method: 'GET', path: '/contract-management' }, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.type).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });

  it.each([
    ['', '/attendance-anomaly-follow-up'],
    ['', '/attendance-anomaly-follow-up/'],
    ['/tenant', '/tenant/attendance-anomaly-follow-up'],
    ['/tenant', '/tenant/attendance-anomaly-follow-up/'],
  ])('lets the signed follow-up controller handle %s %s before the SPA', async (basePath, path) => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    process.env.CLIENT_BASE_PATH = basePath;
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const fallback = app.use.mock.calls.at(-1)![0];
    const response = { locals: {}, type: jest.fn(), send: jest.fn() };
    const next = jest.fn();

    fallback({ method: 'GET', path }, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.send).not.toHaveBeenCalled();
    expect(response.type).not.toHaveBeenCalled();
  });

  it('passes the CSRF token from response locals into every standalone runtime location', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const fallback = app.use.mock.calls[app.use.mock.calls.length - 1][0] as (
      request: { method: string; path: string },
      response: {
        locals: { csrfToken: string };
        setHeader: jest.Mock;
        type: jest.Mock;
        send: jest.Mock;
      },
      next: jest.Mock,
    ) => void;
    const response = {
      locals: { csrfToken: 'csrf-token' },
      setHeader: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    response.type.mockReturnValue(response);

    fallback({ method: 'GET', path: '/schedule' }, response, jest.fn());

    const html = response.send.mock.calls[0][0] as string;
    expect(html).toContain('"csrfToken":"csrf-token"');
    expect(html).not.toContain('{{csrfToken}}');
    expect(html.match(/csrf-token/g) ?? []).toHaveLength(3);
    expect(html).toContain('window.csrfToken = "csrf-token";');
  });

  it('prevents caching standalone HTML that contains a CSRF token', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const fallback = app.use.mock.calls[app.use.mock.calls.length - 1][0] as (
      request: { method: string; path: string },
      response: {
        locals: { csrfToken: string };
        setHeader: jest.Mock;
        type: jest.Mock;
        send: jest.Mock;
      },
      next: jest.Mock,
    ) => void;
    const response = {
      locals: { csrfToken: 'csrf-token' },
      setHeader: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    response.type.mockReturnValue(response);

    fallback(
      { method: 'GET', path: '/construction-management' },
      response,
      jest.fn(),
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
  });

  it('adds a content-derived build version to standalone client script URLs', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const indexHtml =
      '<head></head><body><script defer src="/main.js"></script><script defer src="/polyfills.js"></script></body>';
    const mainBundle = 'bundle-version-2';
    mockReadFileSync.mockImplementation((path: unknown) =>
      String(path).replace(/\\/g, '/').endsWith('/main.js')
        ? mainBundle
        : indexHtml,
    );
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const fallback = app.use.mock.calls[app.use.mock.calls.length - 1][0] as (
      request: { method: string; path: string },
      response: {
        locals: Record<string, unknown>;
        setHeader: jest.Mock;
        type: jest.Mock;
        send: jest.Mock;
      },
      next: jest.Mock,
    ) => void;
    const response = {
      locals: { csrfToken: 'csrf-token' },
      setHeader: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    response.type.mockReturnValue(response);

    fallback(
      { method: 'GET', path: '/risk-inspection-dashboard' },
      response,
      jest.fn(),
    );

    const html = response.send.mock.calls[0][0] as string;
    const expectedVersion = createHash('sha256')
      .update(mainBundle)
      .digest('hex')
      .slice(0, 16);
    expect(html).toContain(`src="/main.js?v=${expectedVersion}"`);
    expect(html).toContain(`src="/polyfills.js?v=${expectedVersion}"`);
  });

  it('renders a non-empty versioned VNET favicon in standalone HTML', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    mockReadFileSync.mockReturnValue(
      '<head><link rel="icon" type="image/svg+xml" href="{{appAvatar}}"></head>',
    );
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const fallback = app.use.mock.calls[app.use.mock.calls.length - 1][0] as (
      request: { method: string; path: string },
      response: {
        locals: Record<string, unknown>;
        setHeader: jest.Mock;
        type: jest.Mock;
        send: jest.Mock;
      },
      next: jest.Mock,
    ) => void;
    const response = {
      locals: { csrfToken: 'csrf-token' },
      setHeader: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    response.type.mockReturnValue(response);

    fallback({ method: 'GET', path: '/monthly-schedule' }, response, jest.fn());

    const html = response.send.mock.calls[0][0] as string;
    expect(html).toContain('href="/favicon.svg?v=20260815"');
    expect(html).not.toContain('{{appAvatar}}');
    expect(html).not.toMatch(/rel="icon"[^>]+href=""/);
  });

  it('injects the newly seeded standalone token into the first rendered page', async () => {
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'true';
    const app = createMockApp();
    mockNestCreate.mockResolvedValue(app);
    await bootstrap();
    const seed = app.use.mock.calls[1][0] as ReturnType<
      typeof createStandaloneCsrfSeedMiddleware
    >;
    const fallback = app.use.mock.calls[app.use.mock.calls.length - 1][0] as (
      request: { method: string; path: string },
      response: {
        locals: Record<string, unknown>;
        setHeader: jest.Mock;
        type: jest.Mock;
        send: jest.Mock;
      },
      next: jest.Mock,
    ) => void;
    const request = {
      cookies: {},
      method: 'GET',
      path: '/contract-management',
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
      setHeader: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    response.type.mockReturnValue(response);

    seed(request as never, response as never, jest.fn());
    fallback(request, response, jest.fn());

    const token = response.cookie.mock.calls[0][1] as string;
    const html = response.send.mock.calls[0][0] as string;
    expect(response.locals.csrfToken).toBe(token);
    expect(html).toContain(`"csrfToken":"${token}"`);
    expect(html).toContain(`window.csrfToken = "${token}";`);
  });

  it('seeds a client-readable CSRF cookie over standalone HTTP', () => {
    const middleware = createStandaloneCsrfSeedMiddleware();
    const request = { cookies: {}, protocol: 'http', secure: false };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };
    const next = jest.fn();

    middleware(request, response, next);

    expect(response.cookie).toHaveBeenCalledTimes(1);
    const [cookieName, token, options] = response.cookie.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(cookieName).toBe('suda-csrf-token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options).toEqual({
      httpOnly: false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
      sameSite: 'strict',
      secure: false,
    });
    expect(request.cookies['suda-csrf-token']).toBe(token);
    expect(response.locals.csrfToken).toBe(token);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('marks the standalone CSRF cookie secure for a direct HTTPS request', () => {
    const middleware = createStandaloneCsrfSeedMiddleware();
    const request = { cookies: {}, protocol: 'https', secure: true };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };

    middleware(request, response, jest.fn());

    expect(response.cookie).toHaveBeenCalledWith(
      'suda-csrf-token',
      expect.any(String),
      expect.objectContaining({
        sameSite: 'none',
        secure: true,
        partitioned: true,
      }),
    );
  });

  it('marks the standalone CSRF cookie secure behind an explicitly trusted HTTPS proxy', () => {
    process.env.LOCAL_ACCESS_TRUST_PROXY = 'true';
    const middleware = createStandaloneCsrfSeedMiddleware();
    const request = {
      cookies: {},
      headers: { 'x-forwarded-proto': 'https' },
      protocol: 'http',
      secure: false,
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };

    middleware(request, response, jest.fn());

    expect(response.cookie).toHaveBeenCalledWith(
      'suda-csrf-token',
      expect.any(String),
      expect.objectContaining({
        sameSite: 'none',
        secure: true,
        partitioned: true,
      }),
    );
  });

  it('reuses an existing valid CSRF cookie without resetting it', () => {
    const middleware = createStandaloneCsrfSeedMiddleware();
    const existingToken = 'a'.repeat(43);
    const request = {
      cookies: { 'suda-csrf-token': existingToken },
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };
    const next = jest.fn();

    middleware(request, response, next);

    expect(response.cookie).not.toHaveBeenCalled();
    expect(request.cookies['suda-csrf-token']).toBe(existingToken);
    expect(response.locals.csrfToken).toBe(existingToken);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('normalizes a framework-seeded CSRF cookie for a secure iframe navigation', () => {
    const middleware = createStandaloneCsrfSeedMiddleware();
    const existingToken = `${'a'.repeat(40)}-1783785600`;
    const request = {
      cookies: { 'suda-csrf-token': existingToken },
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'sec-fetch-dest': 'iframe',
      },
      method: 'GET',
      protocol: 'https',
      secure: true,
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };

    middleware(request, response, jest.fn());

    expect(response.cookie).toHaveBeenCalledWith(
      'suda-csrf-token',
      existingToken,
      {
        httpOnly: false,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/',
        sameSite: 'none',
        secure: true,
        partitioned: true,
      },
    );
    expect(response.locals.csrfToken).toBe(existingToken);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'supplies the validated CSRF token to a safe %s request without an explicit header',
    (method) => {
      const middleware = createStandaloneCsrfSeedMiddleware();
      const existingToken = 'a'.repeat(43);
      const request = {
        cookies: { 'suda-csrf-token': existingToken },
        headers: {},
        method,
      };
      const response = {
        locals: {},
        cookie: jest.fn(),
      };

      middleware(request, response, jest.fn());

      expect(request.headers['x-suda-csrf-token']).toBe(existingToken);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'does not supply a CSRF header to an unsafe %s request',
    (method) => {
      const middleware = createStandaloneCsrfSeedMiddleware();
      const request = {
        cookies: { 'suda-csrf-token': 'a'.repeat(43) },
        headers: {},
        method,
      };
      const response = {
        locals: {},
        cookie: jest.fn(),
      };

      middleware(request, response, jest.fn());

      expect(request.headers['x-suda-csrf-token']).toBeUndefined();
    },
  );

  it('reuses the CSRF token format already issued by the framework', () => {
    const middleware = createStandaloneCsrfSeedMiddleware();
    const frameworkToken = `${'a'.repeat(40)}-1783785600`;
    const request = {
      cookies: { 'suda-csrf-token': frameworkToken },
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };
    const next = jest.fn();

    middleware(request, response, next);

    expect(response.cookie).not.toHaveBeenCalled();
    expect(request.cookies['suda-csrf-token']).toBe(frameworkToken);
    expect(response.locals.csrfToken).toBe(frameworkToken);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rotates a malformed cookie before exposing a token to the page', () => {
    const middleware = createStandaloneCsrfSeedMiddleware();
    const untrustedToken = '</script><script>alert(1)</script>';
    const request = {
      cookies: { 'suda-csrf-token': untrustedToken },
    };
    const response = {
      locals: {},
      cookie: jest.fn(),
    };
    const next = jest.fn();

    middleware(request, response, next);

    const replacement = response.cookie.mock.calls[0][1] as string;
    expect(replacement).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replacement).not.toBe(untrustedToken);
    expect(request.cookies['suda-csrf-token']).toBe(replacement);
    expect(response.locals.csrfToken).toBe(replacement);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing cookie', {}, { 'x-suda-csrf-token': 'a'.repeat(43) }],
    ['missing header', { 'suda-csrf-token': 'a'.repeat(43) }, {}],
    [
      'mismatched token',
      { 'suda-csrf-token': 'a'.repeat(43) },
      { 'x-suda-csrf-token': 'b'.repeat(43) },
    ],
    [
      'malformed token',
      { 'suda-csrf-token': 'not-valid' },
      { 'x-suda-csrf-token': 'not-valid' },
    ],
    [
      'duplicate header',
      { 'suda-csrf-token': 'a'.repeat(43) },
      { 'x-suda-csrf-token': ['a'.repeat(43), 'a'.repeat(43)] },
    ],
  ])('rejects an API request with a %s', (_label, cookies, headers) => {
    const middleware = createApiCsrfValidationMiddleware();
    const request = { cookies, headers };
    const response = {
      status: jest.fn(),
      send: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const next = jest.fn();

    middleware(request, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.send).toHaveBeenCalledWith(
      expect.stringContaining('Forbidden'),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['/access/feishu/authorize', '/access/feishu/callback'])(
    'allows the exact Feishu OAuth GET %s without a CSRF token',
    (path) => {
      const middleware = createApiCsrfValidationMiddleware();
      const response = {
        status: jest.fn(),
        send: jest.fn(),
      };
      response.status.mockReturnValue(response);
      const next = jest.fn();

      middleware(
        {
          cookies: {},
          headers: {},
          method: 'GET',
          path,
        },
        response,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.status).not.toHaveBeenCalled();
      expect(response.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['POST', '/access/feishu/authorize'],
    ['POST', '/access/feishu/callback'],
    ['GET', '/access/feishu/authorize/'],
    ['GET', '/access/feishu/callback/extra'],
    ['GET', '/access/feishu/callback-other'],
  ])(
    'does not exempt the near-match Feishu OAuth request %s %s',
    (method, path) => {
      const middleware = createApiCsrfValidationMiddleware();
      const response = {
        status: jest.fn(),
        send: jest.fn(),
      };
      response.status.mockReturnValue(response);
      const next = jest.fn();

      middleware(
        {
          cookies: {},
          headers: {},
          method,
          path,
        },
        response,
        next,
      );

      expect(response.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['standalone', 'a'.repeat(43)],
    ['framework', `${'a'.repeat(40)}-1783785600`],
  ])('accepts matching %s CSRF tokens', (_label, token) => {
    const middleware = createApiCsrfValidationMiddleware();
    const response = {
      status: jest.fn(),
      send: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const next = jest.fn();

    middleware(
      {
        cookies: { 'suda-csrf-token': token },
        headers: { 'x-suda-csrf-token': token },
      },
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });

  it('bridges a safe standalone request through seed and validation', () => {
    const seed = createStandaloneCsrfSeedMiddleware();
    const middleware = createApiCsrfValidationMiddleware();
    const request = { cookies: {}, headers: {}, method: 'GET' };
    const response = {
      locals: {},
      cookie: jest.fn(),
      status: jest.fn(),
      send: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const next = jest.fn();

    seed(request, response, jest.fn());
    middleware(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('does not bridge a missing header into an unsafe standalone request', () => {
    const seed = createStandaloneCsrfSeedMiddleware();
    const middleware = createApiCsrfValidationMiddleware();
    const request = { cookies: {}, headers: {}, method: 'POST' };
    const response = {
      locals: {},
      cookie: jest.fn(),
      status: jest.fn(),
      send: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const next = jest.fn();

    seed(request, response, jest.fn());
    middleware(request, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
