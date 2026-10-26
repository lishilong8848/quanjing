import './runtime-env';

import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, Logger, RequestMethod } from '@nestjs/common';
import { configureApp } from '@lark-apaas/fullstack-nestjs-core';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { __express as hbsExpressEngine } from 'hbs';
import compression from 'compression';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { staticAssetCacheControl } from './common/static-asset-cache';
import { currentHotfixActivation } from './common/hotfix-runtime-activation';
import { createHotfixActivationMiddleware } from './common/hotfix-http-activation';
import { startHotfixActivationMonitor } from './common/hotfix-activation-monitor';
import { readStrictCookie, type StrictCookieResult } from './common/access/unified-access.guard';

const STANDALONE_CSRF_COOKIE = 'suda-csrf-token';
export const FIRST_PARTY_CSRF_COOKIE_NAME = '__Host-suda-csrf-token';
const STANDALONE_CSRF_HEADER = 'x-suda-csrf-token';
const STANDALONE_CSRF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FEISHU_OAUTH_CSRF_EXEMPT_PATHS = new Set([
  '/access/feishu/authorize',
  '/access/feishu/callback',
]);

type CsrfSeedRequest = Request & {
  cookies?: Record<string, string>;
  csrfToken?: string;
};

function isValidStandaloneCsrfToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^[A-Za-z0-9_-]{43}$/.test(value) || /^[a-f0-9]{40}-\d{10}$/.test(value))
  );
}

function normalizeClientBasePath(value: string | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export function createMonthlyScheduleFormDirectLinkMiddleware(
  clientBasePath: string,
) {
  const redirects = new Map([
    [
      `${clientBasePath}/monthly-schedule/apply/leave`,
      `${clientBasePath}/monthly-schedule?form=leave`,
    ],
    [
      `${clientBasePath}/monthly-schedule/apply/overtime`,
      `${clientBasePath}/monthly-schedule?form=overtime`,
    ],
  ]);

  return (req: Request, res: Response, next: NextFunction) => {
    const target = req.method === 'GET' ? redirects.get(req.path) : undefined;
    if (!target) {
      next();
      return;
    }

    res.redirect(302, target);
  };
}

function isSecureCookieRequest(request: Request): boolean {
  if (
    request.secure ||
    request.protocol === 'https' ||
    Boolean((request.socket as { encrypted?: boolean } | undefined)?.encrypted)
  ) {
    return true;
  }
  if (environmentFlag('LOCAL_ACCESS_COOKIE_SECURE')) return true;
  if (!environmentFlag('LOCAL_ACCESS_TRUST_PROXY')) return false;

  const forwarded = request.headers?.['x-forwarded-proto'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (
    String(first || '')
      .split(',')[0]
      .trim()
      .toLowerCase() === 'https'
  );
}

function environmentFlag(name: string): boolean {
  return (
    String(process.env[name] || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function isStandaloneHtmlNavigation(request: CsrfSeedRequest): boolean {
  if (!SAFE_HTTP_METHODS.has(request.method?.toUpperCase() ?? '')) return false;

  const rawDestination = request.headers?.['sec-fetch-dest'];
  const destination = String(
    Array.isArray(rawDestination) ? rawDestination[0] : rawDestination || '',
  )
    .trim()
    .toLowerCase();
  if (destination === 'document' || destination === 'iframe') return true;

  const rawAccept = request.headers?.accept;
  const accept = String(
    Array.isArray(rawAccept) ? rawAccept[0] : rawAccept || '',
  ).toLowerCase();
  return accept.includes('text/html');
}

export function createStandaloneCsrfSeedMiddleware(seedMissingToken = true) {
  return (req: CsrfSeedRequest, res: Response, next: NextFunction) => {
    const cookie = readRequestCsrfCookie(req);
    const existingToken = cookie.value;
    const hasValidToken = isValidStandaloneCsrfToken(existingToken);
    const htmlNavigation = isStandaloneHtmlNavigation(req);
    const unsafeRequest = !!req.method && !SAFE_HTTP_METHODS.has(req.method.toUpperCase());
    if (!hasValidToken && ((!seedMissingToken && !htmlNavigation) || unsafeRequest)) {
      if (cookie.present) {
        const cookies = { ...(req.cookies ?? {}) };
        delete cookies[STANDALONE_CSRF_COOKIE];
        req.cookies = cookies;
        if (!unsafeRequest) {
          res.clearCookie(STANDALONE_CSRF_COOKIE, {
            path: '/', sameSite: 'none', secure: true, partitioned: true,
          });
          if (isSecureCookieRequest(req)) {
            res.clearCookie(FIRST_PARTY_CSRF_COOKIE_NAME, {
              path: '/', sameSite: 'lax', secure: true,
            });
          }
        }
      }
      next();
      return;
    }
    const token = hasValidToken
      ? existingToken
      : randomBytes(32).toString('base64url');
    req.cookies = {
      ...(req.cookies ?? {}),
      [STANDALONE_CSRF_COOKIE]: token,
    };
    req.csrfToken = token;
    res.locals.csrfToken = token;
    if (
      SAFE_HTTP_METHODS.has(req.method?.toUpperCase() ?? '') &&
      req.headers?.[STANDALONE_CSRF_HEADER] === undefined
    ) {
      req.headers = req.headers ?? {};
      req.headers[STANDALONE_CSRF_HEADER] = token;
    }
    if (
      !hasValidToken ||
      htmlNavigation
    ) {
      const secure = isSecureCookieRequest(req);
      res.cookie(STANDALONE_CSRF_COOKIE, token, {
        httpOnly: false,
        maxAge: STANDALONE_CSRF_MAX_AGE_MS,
        path: '/',
        sameSite: secure ? 'none' : 'strict',
        secure,
        ...(secure ? { partitioned: true } : {}),
      });
      if (secure) {
        res.cookie(FIRST_PARTY_CSRF_COOKIE_NAME, token, {
          httpOnly: false, maxAge: STANDALONE_CSRF_MAX_AGE_MS,
          path: '/', sameSite: 'lax', secure: true,
        });
      }
    }
    next();
  };
}

function readRequestCsrfCookie(req: CsrfSeedRequest): StrictCookieResult {
  const rawHeader = req.headers?.cookie;
  if (rawHeader !== undefined) {
    if (typeof rawHeader !== 'string') return { present: true };
    const firstParty = readStrictCookie(rawHeader, FIRST_PARTY_CSRF_COOKIE_NAME);
    return firstParty.present ? firstParty : readStrictCookie(rawHeader, STANDALONE_CSRF_COOKIE);
  }
  // Preserve framework/test requests without a raw header, never override an actual header.
  const firstParty = req.cookies?.[FIRST_PARTY_CSRF_COOKIE_NAME];
  const legacy = req.cookies?.[STANDALONE_CSRF_COOKIE];
  const value = firstParty !== undefined ? firstParty : legacy;
  return value === undefined ? { present: false } : { present: true, value };
}

export function createApiCsrfValidationMiddleware() {
  return (req: CsrfSeedRequest, res: Response, next: NextFunction) => {
    if (
      req.method?.toUpperCase() === 'GET' &&
      FEISHU_OAUTH_CSRF_EXEMPT_PATHS.has(req.path)
    ) {
      next();
      return;
    }

    const cookie = readRequestCsrfCookie(req);
    const cookieToken = SAFE_HTTP_METHODS.has(req.method?.toUpperCase() ?? '')
      ? req.csrfToken ?? cookie.value
      : cookie.value;
    const rawHeaderToken = req.headers?.[STANDALONE_CSRF_HEADER];
    if (Array.isArray(rawHeaderToken)) {
      res.status(403).send('Forbidden，csrf token header must be singular.');
      return;
    }
    const headerToken = rawHeaderToken;

    if (!isValidStandaloneCsrfToken(cookieToken)) {
      res
        .status(403)
        .send('Forbidden，csrf token not found or invalid in cookie.');
      return;
    }
    if (!isValidStandaloneCsrfToken(headerToken)) {
      res
        .status(403)
        .send('Forbidden，csrf token not found or invalid in header.');
      return;
    }
    if (cookieToken !== headerToken) {
      res.status(403).send('Forbidden，csrf token not match.');
      return;
    }
    next();
  };
}

export async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';
  const clientBasePath = normalizeClientBasePath(process.env.CLIENT_BASE_PATH);
  const apiMountPath = `${clientBasePath}/api`;
  const host = process.env.SERVER_HOST || 'localhost';
  const port = Number(process.env.SERVER_PORT || '3000');
  const logger = new Logger('Bootstrap');
  const httpsOptions = getHttpsOptions();
  const protocol = httpsOptions ? 'https' : 'http';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  const configuredAuthnInnerApiDomain =
    process.env.FORCE_AUTHN_INNERAPI_DOMAIN?.trim();
  const localHostForUrl = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host;
  const localBaseUrl = `${protocol}://${localHostForUrl}:${port}`;

  if (!configuredAuthnInnerApiDomain) {
    process.env.FORCE_AUTHN_INNERAPI_DOMAIN = localBaseUrl;
  } else if (publicBaseUrl && isLoopbackUrl(configuredAuthnInnerApiDomain)) {
    process.env.FORCE_AUTHN_INNERAPI_DOMAIN = configuredAuthnInnerApiDomain;
  }

  const hasDatabaseUrl = Boolean(process.env.SUDA_DATABASE_URL?.trim());
  if (
    !hasDatabaseUrl &&
    process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS !== 'true'
  ) {
    const message =
      'Refusing to start without SUDA_DATABASE_URL unless FORCE_FRAMEWORK_DISABLE_DATAPASS=true';
    logger.error(message);
    throw new Error(message);
  }
  if (isProduction && !hasDatabaseUrl) {
    logger.warn(
      'Production standalone mode active: SUDA_DATABASE_URL is empty and Datapass is disabled.',
    );
  }

  const activation = currentHotfixActivation();
  if (activation.status().phase === 'failed') throw new Error('HOTFIX_INVALID_RELEASE_PROOF');
  if (activation.status().phase === 'closed') throw new Error('HOTFIX_ACTIVATION_CLOSED');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
    rawBody: true,
    ...(httpsOptions ? { httpsOptions } : {}),
  });
  let activationMonitor: Awaited<ReturnType<typeof startHotfixActivationMonitor>> | undefined;
  let activationClosing: Promise<void> | undefined;
  const stopActivation = () => {
    process.removeListener('SIGINT', onShutdown);
    process.removeListener('SIGTERM', onShutdown);
    activationClosing ??= activationMonitor?.stop() ?? activation.close();
    return activationClosing;
  };
  const onShutdown = () => {
    void stopActivation().catch(() => logger.error('HOTFIX_ACTIVATION_SHUTDOWN_FAILED'));
  };
  // Close the gate synchronously before Nest begins native provider destruction.
  process.prependOnceListener('SIGINT', onShutdown);
  process.prependOnceListener('SIGTERM', onShutdown);
  app.getHttpServer().once('close', onShutdown);
  app.enableShutdownHooks();
  app.use(createHotfixActivationMiddleware(activation, apiMountPath));
  app.disable('x-powered-by');
  app.useBodyParser('json', {
    limit: process.env.BODY_SIZE_LIMIT || '1mb',
  });
  await configureApp(app, {
    disableSwagger: true,
  });
  if (isProduction && !hasDatabaseUrl) {
    // The platform logger is silent outside development; standalone startup errors must remain local and visible.
    app.useLogger(
      new ConsoleLogger('Bootstrap', { logLevels: ['error', 'warn'] }),
    );
  }
  app.setGlobalPrefix(clientBasePath, {
    exclude: [
      {
        path: 'callbacks/feishu/purchase-card',
        method: RequestMethod.POST,
      },
    ],
  });
  app.set('trust proxy', false);
  if (isProduction) {
    app.use(createStandaloneCsrfSeedMiddleware(!hasDatabaseUrl));
    app.use(apiMountPath, createApiCsrfValidationMiddleware());
    app.use(compression({ threshold: 1024 }));
    app.use(createMonthlyScheduleFormDirectLinkMiddleware(clientBasePath));
  }

  // 注册视图引擎, 渲染 client 目录下的 html 文件
  const clientDir = join(process.cwd(), 'dist/client');
  const standaloneAssetVersions = new Map<string, string>();
  app.useStaticAssets(clientDir, {
    index: false,
    setHeaders: (res, assetPath) => {
      res.setHeader(
        'Cache-Control',
        staticAssetCacheControl(assetPath),
      );
      res.removeHeader('Pragma');
      res.removeHeader('Expires');
    },
  });
  app.setBaseViewsDir(clientDir);
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  app.use((req, res, next) => {
    const path = req.path;
    const ok = { code: 0, success: true };

    if (path.includes('/current_server_timestamp')) {
      const timestamp = Date.now();
      const timestampNs = String(BigInt(timestamp) * BigInt(1_000_000));
      res.json({
        ...ok,
        data: {
          timestamp,
          timestampNs,
          serverTimestamp: timestamp,
          server_timestamp: timestamp,
          currentServerTimestamp: timestamp,
          current_server_timestamp: timestamp,
        },
        timestamp,
        serverTimestamp: timestamp,
        server_timestamp: timestamp,
        currentServerTimestamp: timestamp,
        current_server_timestamp: timestamp,
      });
      return;
    }

    if (
      path.includes('/observability/logs/collect') ||
      path.includes('/observability/traces/collect') ||
      path.includes('/observability/metrics/collect')
    ) {
      res.json({ ...ok, data: null });
      return;
    }

    if (path.includes('/get_published')) {
      res.json({ ...ok, data: { appPublished: null, published: false } });
      return;
    }

    if (path.includes('/tenant_info')) {
      res.json({ ...ok, data: {} });
      return;
    }

    if (
      path.includes('/permission/user-points') ||
      path.includes('/permissions/roles')
    ) {
      res.json({ ...ok, data: [] });
      return;
    }

    if (path.includes('/account/login/user')) {
      res.json({ ...ok, data: null });
      return;
    }

    next();
  });

  app.use((req, res, next) => {
    if (hasDatabaseUrl) {
      next();
      return;
    }

    if (
      req.method !== 'GET' ||
      req.path === apiMountPath ||
      req.path.startsWith(`${apiMountPath}/`) ||
      extname(req.path)
    ) {
      next();
      return;
    }

    const indexPath = resolveClientIndexPath(
      clientDir,
      clientBasePath,
      req.path,
    );
    if (!existsSync(indexPath)) {
      next();
      return;
    }

    const csrfToken =
      typeof res.locals?.csrfToken === 'string' ? res.locals.csrfToken : '';
    let assetVersion = standaloneAssetVersions.get(indexPath);
    if (!assetVersion) {
      assetVersion = resolveStandaloneAssetVersion(indexPath);
      standaloneAssetVersions.set(indexPath, assetVersion);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res
      .type('html')
      .send(renderStandaloneIndex(indexPath, csrfToken, assetVersion));
  });

  try {
    await app.init();
    if (activation.status().phase === 'closed') throw new Error('HOTFIX_ACTIVATION_CLOSED');
    activationMonitor = await startHotfixActivationMonitor(activation, reason => logger.error(reason));
    await app.listen(port, host);
  } catch (error) {
    await stopActivation();
    await app.close();
    throw error;
  }
  logger.log(`Server running on ${protocol}://${host}:${port}`);
  logger.log(`API endpoints ready at ${protocol}://${host}:${port}/api`);
}

export function resolveClientIndexPath(
  clientDir: string,
  clientBasePath: string,
  requestPath: string,
): string {
  const confirmationPath = `${clientBasePath}/overtime-confirmation`;
  const normalizedRequestPath = requestPath.replace(/\/+$/u, '');
  return normalizedRequestPath === confirmationPath
    ? join(clientDir, 'overtime-confirmation', 'index.html')
    : join(clientDir, 'index.html');
}

export function resolveStandaloneAssetVersion(indexPath: string): string {
  const mainBundle = readFileSync(join(dirname(indexPath), 'main.js'));
  return createHash('sha256').update(mainBundle).digest('hex').slice(0, 16);
}

export function renderStandaloneIndex(
  indexPath: string,
  csrfToken: string,
  assetVersion: string,
) {
  const appName = '世纪互联-南通基地';
  const standaloneFaviconPath = '/favicon.svg?v=20260815';
  const platform = {
    csrfToken,
    userId: '',
    appId: '',
    appName,
    appAvatar: standaloneFaviconPath,
    appDescription: appName,
    loginUrl: '',
    userType: '',
    environment: 'online',
    showBadge: false,
    appPublished: null,
  };

  const standaloneRuntime = [
    '<script>',
    `window.csrfToken = ${serializeInlineJson(csrfToken)};`,
    'window.collectEvent = window.collectEvent || function () {};',
    'window.slardar = window.slardar || { config: function () {}, init: function () {}, start: function () {}, sendEvent: function () {} };',
    '</script>',
  ].join('');

  return readFileSync(indexPath, 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (script) => {
      if (script.includes('slardarScript') || script.includes('teaScript')) {
        return '';
      }

      return script;
    })
    .replace(/<script[^>]+performance\.iife\.js[^>]*><\/script>/g, '')
    .replace(
      /{{{__platform__}}}/g,
      serializeInlineJson(platform).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    )
    .replace(/{{csrfToken}}/g, serializeInlineJson(csrfToken).slice(1, -1))
    .replace(/{{userId}}/g, '')
    .replace(/{{tenantId}}/g, '')
    .replace(/{{appId}}/g, '')
    .replace(/{{environment}}/g, 'online')
    .replace(/{{appName}}/g, appName)
    .replace(/{{appDescription}}/g, appName)
    .replace(/{{{appAvatar}}}/g, standaloneFaviconPath)
    .replace(/{{appAvatar}}/g, standaloneFaviconPath)
    .replace(
      /(<script\b[^>]*\bsrc=["'][^"']*\/(?:main|polyfills)\.js)(["'])/g,
      `$1?v=${assetVersion}$2`,
    )
    .replace('</head>', `${standaloneRuntime}</head>`);
}

function serializeInlineJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function getHttpsOptions():
  | { key: Buffer; cert: Buffer; ca?: Buffer }
  | undefined {
  const keyPath = process.env.HTTPS_KEY_PATH?.trim();
  const certPath = process.env.HTTPS_CERT_PATH?.trim();
  const caPath = process.env.HTTPS_CA_PATH?.trim();

  if (!keyPath && !certPath) {
    return undefined;
  }
  if (!keyPath || !certPath) {
    throw new Error('HTTPS_KEY_PATH 和 HTTPS_CERT_PATH 必须同时配置');
  }

  const resolvedKeyPath = resolve(process.cwd(), keyPath);
  const resolvedCertPath = resolve(process.cwd(), certPath);
  if (!existsSync(resolvedKeyPath)) {
    throw new Error(`HTTPS 私钥文件不存在：${resolvedKeyPath}`);
  }
  if (!existsSync(resolvedCertPath)) {
    throw new Error(`HTTPS 证书文件不存在：${resolvedCertPath}`);
  }

  const options: { key: Buffer; cert: Buffer; ca?: Buffer } = {
    key: readFileSync(resolvedKeyPath),
    cert: readFileSync(resolvedCertPath),
  };

  if (caPath) {
    const resolvedCaPath = resolve(process.cwd(), caPath);
    if (!existsSync(resolvedCaPath)) {
      throw new Error(`HTTPS CA 文件不存在：${resolvedCaPath}`);
    }
    options.ca = readFileSync(resolvedCaPath);
  }

  return options;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    const message =
      error instanceof Error && error.message
        ? error.message.replace(/[\r\n\t]/gu, ' ').slice(0, 500)
        : 'unknown startup error';
    console.error(`[FATAL] Application startup failed: ${message}`);
    process.exitCode = 1;
  });
}
