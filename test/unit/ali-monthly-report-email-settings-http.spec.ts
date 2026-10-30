import { Module, RequestMethod, type INestApplication, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AliMonthlyReportController } from '../../server/modules/ali-monthly-report/ali-monthly-report.controller';
import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';
import { AliMonthlyReportEmailSettingsStore } from '../../server/modules/ali-monthly-report/ali-monthly-report-email-settings.store';
import { AliMonthlyReportModule } from '../../server/modules/ali-monthly-report/ali-monthly-report.module';
import { AliMonthlyReportScheduler } from '../../server/modules/ali-monthly-report/ali-monthly-report.scheduler';
import { AliMonthlyReportTaskCoordinatorService } from '../../server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service';
import { AccessLoginRedactionMiddleware } from '../../server/common/access/access-login-redaction.middleware';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';

@Module({ controllers: [AliMonthlyReportController], providers: [AliMonthlyReportService, { provide: UnifiedAccessService, useValue: {} }] })
class MonthlyMailHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AccessLoginRedactionMiddleware).forRoutes({ path: 'api/ali-monthly-report/email-settings', method: RequestMethod.POST });
  }
}

describe('monthly mail configuration real HTTP authorization and persistence', () => {
  let app: INestApplication, base: string, directory: string, file: string;
  const secret = 'abcdefghijklmnop', trace: string[] = [], savedBase = process.env.PUBLIC_BASE_URL;
  let controlEnabled = true;
  const sessions: Record<string, any> = {
    administrator: { principal: { role: 'admin', accountId: 'synthetic-admin', purchaseBuilding: null } },
    monthlyOperator: { principal: { role: 'professional_admin', accountId: 'synthetic-operator', purchaseBuilding: null } },
    impersonation: { principal: { role: 'admin', accountId: 'synthetic-target', purchaseBuilding: null, impersonation: { actorAccountId: 'synthetic-owner' } } },
  };
  const access = { cookieName: 'synthetic_access', isAccessControlEnabled: () => controlEnabled,
    getUnrestrictedPrincipalFingerprint: () => 'synthetic-unrestricted',
    renew: (token: string) => sessions[token], readSession: (token: string) => sessions[token] || { principal: { role: 'guest' } } };
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'monthly-email-http-')); file = join(directory, 'settings.json');
    const service = new AliMonthlyReportService({} as never, new AliMonthlyReportEmailSettingsStore(file, () => 'synthetic-mail-http-encryption-secret'));
    jest.spyOn(service as any, 'resolveConfigPath').mockReturnValue('');
    jest.spyOn(service as any, 'resolveEmailAppDir').mockReturnValue(directory);
    jest.spyOn(service as any, 'getConfigFileValues').mockReturnValue({});
    jest.spyOn(service, 'sendEmail').mockRejectedValue(new Error('Real mail is prohibited in this test'));
    const module = await Test.createTestingModule({ imports: [MonthlyMailHttpModule], providers: [
      { provide: AliMonthlyReportService, useValue: service }, { provide: UnifiedAccessService, useValue: access },
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new UnifiedAccessGuard(reflector, access as never), inject: [Reflector] },
      { provide: APP_INTERCEPTOR, useValue: { intercept(context: any, next: any) { trace.push(JSON.stringify(context.switchToHttp().getRequest().body)); return next.handle(); } } },
    ] }).overrideProvider(AliMonthlyReportService).useValue(service).overrideProvider(UnifiedAccessService).useValue(access).compile();
    app = module.createNestApplication(); app.useLogger(false); await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`; process.env.PUBLIC_BASE_URL = base;
  });
  afterAll(async () => {
    await app?.close(); jest.restoreAllMocks();
    if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = savedBase;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const get = (account?: string) => fetch(base + '/api/ali-monthly-report/email-settings', { headers: account ? { Cookie: `synthetic_access=${account}` } : {} });
  const post = (account: string, body: unknown, origin = base) => fetch(base + '/api/ali-monthly-report/email-settings', {
    method: 'POST', headers: { Cookie: `synthetic_access=${account}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  it('denies anonymous, nonadministrator and impersonated administrator access even with module access', async () => {
    for (const account of [undefined, 'monthlyOperator', 'impersonation']) expect((await get(account)).status).toBe(403);
    for (const account of ['monthlyOperator', 'impersonation']) expect((await post(account, {})).status).toBe(403);
  });
  it('does not treat disabled broad access controls as authorization to configure mail', async () => {
    controlEnabled = false;
    try { expect((await get()).status).toBe(403); } finally { controlEnabled = true; }
  });
  it('saves through the actual guarded controller and encrypted store, reopens without a secret, and keeps identical retries idempotent', async () => {
    const initial = await get('administrator'); expect(initial.status).toBe(200);
    expect(initial.headers.get('cache-control')).toBe('private, no-store');
    const settings = await initial.json();
    const body = { senderEmail: 'synthetic@qq.com', authCode: secret, expectedRevision: settings.revision, clientMutationId: 'http-email-settings-001' };
    const response = await post('administrator', body); expect(response.status).toBe(201);
    const saved = await response.json(); expect(saved.success).toBe(true); expect(saved.settings.authCodeConfigured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(secret);
    const bytes = readFileSync(file, 'utf8'); expect(bytes).not.toContain(secret);
    const duplicate = await post('administrator', body); expect(duplicate.status).toBe(201);
    expect((await duplicate.json()).settings.revision).toBe(saved.settings.revision);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(await (await get('administrator')).json()).toEqual(saved.settings);
    expect(trace.join('\n')).not.toContain(secret);
  });
  it('rejects a foreign origin and stale concurrent save without changing stored settings', async () => {
    const bytes = readFileSync(file, 'utf8');
    const body = { senderEmail: 'synthetic2@qq.com', authCode: secret, expectedRevision: 'server', clientMutationId: 'http-email-settings-002' };
    expect((await post('administrator', body, 'https://foreign.example.invalid')).status).toBe(403);
    expect((await post('administrator', body)).status).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
  it('resolves the real monthly-report module with the independent store while all schedulers remain disabled', async () => {
    const store = new AliMonthlyReportEmailSettingsStore(join(directory, 'module-only.json'), () => 'synthetic-module-only-key');
    const module = await Test.createTestingModule({ imports: [AliMonthlyReportModule] })
      .overrideProvider(AliMonthlyReportEmailSettingsStore).useValue(store)
      .overrideProvider(AliMonthlyReportScheduler).useValue({})
      .overrideProvider(AliMonthlyReportTaskCoordinatorService).useValue({})
      .compile();
    try {
      expect((module.get(AliMonthlyReportService) as any).emailSettingsStore).toBe(store);
      expect(module.get(AliMonthlyReportController)).toBeInstanceOf(AliMonthlyReportController);
    } finally { await module.close(); }
  });
});
