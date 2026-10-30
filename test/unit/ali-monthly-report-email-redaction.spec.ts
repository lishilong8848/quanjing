import { inspect } from 'node:util';
import { Body, Controller, Module, Post, RequestMethod, type INestApplication, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { AccessLoginRedactionMiddleware } from '../../server/common/access/access-login-redaction.middleware';

describe('monthly mail settings request privacy', () => {
  const middleware = new AccessLoginRedactionMiddleware();
  function redact(body: unknown, url = '/api/ali-monthly-report/email-settings') {
    const request = { body, originalUrl: url };
    const next = jest.fn();
    middleware.use(request as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    return request.body as Record<string, unknown>;
  }
  it('retains usable values for validation but hides them from normal JSON and logger inspection', () => {
    const body = redact({ senderEmail: 'synthetic@example.test', authCode: 'abcdefghijklmnop', expectedRevision: 'revision', clientMutationId: 'test-save' });
    expect(body.senderEmail).toBe('synthetic@example.test');
    expect(body.authCode).toBe('abcdefghijklmnop');
    expect(Object.getOwnPropertyNames(body)).toContain('authCode');
    for (const serialized of [JSON.stringify(body), inspect(body)]) {
      expect(serialized).not.toContain('abcdefghijklmnop');
      expect(serialized).not.toContain('synthetic@example.test');
    }
    expect(JSON.parse(JSON.stringify(body))).toEqual({ expectedRevision: 'revision', clientMutationId: 'test-save' });
  });
  it.each([null, ['abcdefghijklmnop'], { unexpectedCredential: 'abcdefghijklmnop' }])('rejects malformed bodies without logging the supplied content', input => {
    const body = redact(input);
    expect(body.invalidFields).toBe(true);
    expect(inspect(body)).not.toContain('abcdefghijklmnop');
  });
  it('protects the mounted base path and query string while preserving blank-code omission', () => {
    const body = redact({ senderEmail: 'synthetic@example.test', expectedRevision: 'revision', clientMutationId: 'test-save' }, '/platform/api/ali-monthly-report/email-settings?ignored=1');
    expect(Object.hasOwn(body, 'authCode')).toBe(false);
    expect(body.senderEmail).toBe('synthetic@example.test');
    expect(JSON.stringify(body)).not.toContain('synthetic@example.test');
  });
  it('keeps the existing login-password redaction behavior', () => {
    const body = redact({ employeeName: 'Synthetic', password: 'not-a-real-password', accountType: 'external' }, '/api/access/login');
    expect(body.password).toBe('not-a-real-password');
    expect(JSON.stringify(body)).not.toContain('not-a-real-password');
  });
});

@Controller('api/ali-monthly-report')
class EmailSettingsRedactionProbe {
  @Post('email-settings')
  save(@Body() body: Record<string, unknown>) {
    return { codeReachedHandler: body.authCode === 'abcdefghijklmnop', senderReachedHandler: body.senderEmail === 'synthetic@example.test' };
  }
}
@Module({ controllers: [EmailSettingsRedactionProbe] })
class EmailSettingsRedactionModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AccessLoginRedactionMiddleware).forRoutes({ path: 'api/ali-monthly-report/email-settings', method: RequestMethod.POST });
  }
}

describe('monthly mail settings actual HTTP trace boundary', () => {
  let app: INestApplication, base: string;
  const logs: string[] = [];
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [EmailSettingsRedactionModule], providers: [{
      provide: APP_INTERCEPTOR,
      useValue: { intercept(context: { switchToHttp: () => { getRequest: () => { body: unknown } } }, next: { handle: () => unknown }) {
        logs.push(JSON.stringify(context.switchToHttp().getRequest().body));
        return next.handle();
      } },
    }] }).compile();
    app = module.createNestApplication(); app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app?.close(); });
  it.each(['/api/ali-monthly-report/email-settings', '/api/ali-monthly-report/email-settings/'])('redacts %s before request tracing while allowing the handler to use the secret', async route => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderEmail: 'synthetic@example.test', authCode: 'abcdefghijklmnop', expectedRevision: 'server', clientMutationId: 'synthetic-request' }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ codeReachedHandler: true, senderReachedHandler: true });
    expect(logs.at(-1)).not.toContain('abcdefghijklmnop');
    expect(logs.at(-1)).not.toContain('synthetic@example.test');
    expect(JSON.parse(logs.at(-1)!)).toEqual({ expectedRevision: 'server', clientMutationId: 'synthetic-request' });
  });
});
