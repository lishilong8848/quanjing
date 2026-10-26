import {
  Controller,
  type CallHandler,
  type ExecutionContext,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestInterceptor,
  type NestModule,
  Post,
  RequestMethod,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { Observable } from 'rxjs';
import {
  ACCESS_LOGIN_MIDDLEWARE_PATH,
  AccessLoginRedactionMiddleware,
} from '../../server/common/access/access-login-redaction.middleware';

class LoginRedactionProbeController {
  login(): { ok: true } {
    return { ok: true };
  }
}

class LoginRedactionProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AccessLoginRedactionMiddleware)
      .forRoutes({
        path: ACCESS_LOGIN_MIDDLEWARE_PATH,
        method: RequestMethod.POST,
      });
  }
}

Controller('api/access')(LoginRedactionProbeController);
const loginProbeDescriptor = Object.getOwnPropertyDescriptor(
  LoginRedactionProbeController.prototype,
  'login',
);
if (!loginProbeDescriptor) throw new Error('Missing login probe method');
Post('login')(
  LoginRedactionProbeController.prototype,
  'login',
  loginProbeDescriptor,
);
Module({ controllers: [LoginRedactionProbeController] })(
  LoginRedactionProbeModule,
);

describe('AccessLoginRedactionMiddleware', () => {
  const middleware = new AccessLoginRedactionMiddleware();

  it('keeps the password readable by the controller but out of JSON logs', () => {
    const body = { password: 'test-sensitive-value', remember: true };
    const request = {
      body,
    };
    const next = jest.fn();

    middleware.use(
      request as never,
      {} as never,
      next,
    );

    expect(request.body).not.toBe(body);
    expect(request.body.password).toBe('test-sensitive-value');
    expect(JSON.stringify(request.body)).toBe('{}');
    expect(JSON.stringify(body)).toBe(
      '{"password":"test-sensitive-value","remember":true}',
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('redacts a non-configurable password without mutating the source body', () => {
    const body = { accountType: 'admin' } as Record<string, unknown>;
    Object.defineProperty(body, 'password', {
      configurable: false,
      enumerable: true,
      value: 'test-sensitive-value',
      writable: false,
    });
    const request = { body };
    const next = jest.fn();

    middleware.use(
      request as never,
      {} as never,
      next,
    );

    expect(request.body.password).toBe('test-sensitive-value');
    expect(JSON.stringify(request.body)).toBe('{"accountType":"admin"}');
    expect(JSON.stringify(body)).toContain('test-sensitive-value');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('AccessLoginRedactionMiddleware Nest routing', () => {
  let app: INestApplication;
  let port: number;
  const capturedBodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const captureInterceptor: NestInterceptor = {
      intercept(
        context: ExecutionContext,
        next: CallHandler,
      ): Observable<unknown> {
        capturedBodies.push(context.switchToHttp().getRequest().body);
        return next.handle();
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [LoginRedactionProbeModule],
      providers: [
        {
          provide: APP_INTERCEPTOR,
          useValue: captureInterceptor,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(['/api/access/login', '/api/access/login/'])(
    'redacts the password on %s before interceptors can log it',
    async (path) => {
      const before = capturedBodies.length;
      await postJson(port, path, {
        accountType: 'admin',
        password: 'test-sensitive-value',
      });

      expect(capturedBodies).toHaveLength(before + 1);
      const body = capturedBodies.at(-1);
      expect(body?.password).toBe('test-sensitive-value');
      expect(JSON.stringify(body)).toBe('{"accountType":"admin"}');
    },
  );
});

function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<number> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-length': Buffer.byteLength(payload),
          'content-type': 'application/json',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode || 0));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}
