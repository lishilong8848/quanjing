import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Request } from 'express';
import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';
import { AliMonthlyReportController } from '../../server/modules/ali-monthly-report/ali-monthly-report.controller';
import { AliMonthlyReportEmailSettingsStore } from '../../server/modules/ali-monthly-report/ali-monthly-report-email-settings.store';
import { AdminOnlyMetadataKey } from '../../server/common/access/unified-access.decorators';

const authCode = 'abcdefghijklmnop';
const request = { senderEmail: 'page@example.test', authCode, expectedRevision: 'server', clientMutationId: 'email-settings-001' };
const envKeys = ['ALI_MONTHLY_REPORT_QQ_EMAIL', 'QQ_EMAIL', 'ALI_MONTHLY_REPORT_QQ_AUTH_CODE', 'QQ_AUTH_CODE', 'AUTH_CODE', 'PUBLIC_BASE_URL'] as const;
describe('阿里月报发件配置与原有运行时隔离', () => {
  let directory: string;
  let file: string;
  let service: AliMonthlyReportService;
  let internals: any;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ali-email-runtime-'));
    file = join(directory, 'settings.json');
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    writeFileSync(join(directory, 'app.py'), '# Synthetic file existence only. Never executed.');
    service = new AliMonthlyReportService({} as never, new AliMonthlyReportEmailSettingsStore(file, () => 'synthetic-session-secret'));
    internals = service as any;
    jest.spyOn(internals, 'resolveConfigPath').mockReturnValue('synthetic-report-config');
    jest.spyOn(internals, 'resolveEmailAppDir').mockReturnValue(directory);
    jest.spyOn(internals, 'getConfigFileValues').mockImplementation((path: string) => path === 'synthetic-report-config' ? {
      qq_email: 'legacy@example.test', auth_code: 'qrstuvwxyzABCDEF', recipient: 'custom@example.test',
      feishu_app_id: 'synthetic-app', feishu_app_secret: 'synthetic-feishu-secret', feishu_app_token: 'synthetic-app-token',
    } : {});
    jest.spyOn(internals, 'ensurePythonDependencies').mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
    rmSync(directory, { recursive: true, force: true });
  });

  it('未保存保留原env高于文件的优先级；页面保存后即时优先，收件人与飞书参数不变', async () => {
    process.env.ALI_MONTHLY_REPORT_QQ_EMAIL = 'environment@example.test';
    process.env.ALI_MONTHLY_REPORT_QQ_AUTH_CODE = 'ENVIRONMENTCODE1';
    const before = internals.getRuntimeConfig();
    expect(before.values.QQ_EMAIL).toBe('environment@example.test');
    expect(before.values.AUTH_CODE).toBe('ENVIRONMENTCODE1');
    const result = await service.saveEmailSettings(request);
    const after = internals.getRuntimeConfig();
    expect(after.values.QQ_EMAIL).toBe(request.senderEmail);
    expect(after.values.AUTH_CODE).toBe(authCode);
    expect(after.defaultEmailRecipient).toBe(before.defaultEmailRecipient);
    expect(after.values.FEISHU_APP_ID).toBe(before.values.FEISHU_APP_ID);
    expect(result.settings).toEqual(service.getEmailSettings());
    expect(result.config.defaultEmailRecipient).toContain('custom@example.test');
    expect(JSON.stringify(result)).not.toContain(authCode);
  });

  it('旧通用QQ环境变量和文件后备顺序维持不变', () => {
    expect(service.getEmailSettings()).toMatchObject({ senderEmail: 'legacy@example.test', source: 'server' });
    process.env.QQ_EMAIL = 'generic@example.test'; process.env.AUTH_CODE = 'GENERICCODE12345';
    expect(internals.getRuntimeConfig().values).toMatchObject({ QQ_EMAIL: 'generic@example.test', AUTH_CODE: 'GENERICCODE12345' });
    process.env.QQ_AUTH_CODE = 'ALIASAUTHCODE1234';
    expect(internals.getRuntimeConfig().values.AUTH_CODE).toBe('ALIASAUTHCODE1234');
  });

  it('实际send路径将新设置交给Python env，不更换收件人、不执行SMTP', async () => {
    await service.saveEmailSettings(request);
    const python = jest.spyOn(internals, 'runPython').mockResolvedValue({ stdout: JSON.stringify({ success: true, message: 'synthetic sent', logs: ['synthetic'] }), stderr: '' });
    const response = await service.sendEmail({ year: 2026, month: 9, recipient: 'recipient@example.test', subject: 'synthetic subject' });
    expect(response.success).toBe(true);
    expect(python).toHaveBeenCalledTimes(1);
    expect(python.mock.calls[0][0]).toEqual(expect.arrayContaining(['recipient@example.test', '2026', '9', 'synthetic subject']));
    expect(python.mock.calls[0][1]).toMatchObject({ QQ_EMAIL: request.senderEmail, AUTH_CODE: authCode });
    expect((python.mock.calls[0][0] as string[])[1]).toContain('config = apply_env(app.load_config())');
  });

  it('子进程退出0时错误、成功日志、stdout/stderr均去掉当前授权码，包括JSON转义后的字符串', async () => {
    await service.saveEmailSettings(request);
    const python = jest.spyOn(internals, 'runPython').mockResolvedValue({ stdout: JSON.stringify({ success: false, error: `rejected ${authCode}` }), stderr: '' });
    const body = { year: 2026, month: 9, recipient: 'recipient@example.test' };
    await expect(service.sendEmail(body)).rejects.toThrow('rejected ***');
    python.mockResolvedValue({ stdout: JSON.stringify({ success: true, message: `message ${authCode}`, subject: authCode, recipient: authCode, logs: [`log ${authCode}`] }).replace(authCode, '\\u0061bcdefghijklmnop'), stderr: `stderr ${authCode}` });
    const success = await service.sendEmail(body);
    expect(JSON.stringify(success)).not.toContain(authCode);
    expect(success.logs).toEqual(['log ***', 'stderr ***']);
    python.mockRejectedValue(new Error(`spawn error ${authCode}`));
    await expect(service.sendEmail(body)).rejects.toThrow('spawn error ***');
  });

  it('坏页面配置阻止邮件，但保留普通配置、报表生成及通知流程', async () => {
    writeFileSync(file, '{broken managed mail settings');
    const config = await service.getConfig();
    expect(config.emailConfigurationIssue).toContain('邮件发件配置不可用');
    expect(config.defaultEmailRecipient).toContain('custom@example.test');
    const python = jest.spyOn(internals, 'runPython');
    await expect(service.sendEmail({ year: 2026, month: 9, recipient: 'recipient@example.test' })).rejects.toThrow('邮件发件配置不可用');
    expect(python).not.toHaveBeenCalled();
    const generated = { success: true, year: 2026, month: 9, files: [], logs: [], reportType: 'alarm_analysis' };
    const report = jest.spyOn(internals, 'runReport').mockResolvedValue(generated);
    jest.spyOn(internals, 'attachFeishuNotification').mockImplementation((_runtime: unknown, value: unknown) => value);
    expect(await service.generate({ reportType: 'alarm_analysis', year: 2026, month: 9 })).toEqual(generated);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][3].values.FEISHU_APP_ID).toBe('synthetic-app');
  });
});

describe('月报发件设置仅限真实管理员且保存要求同源', () => {
  const makeRequest = (origin?: string, extra = {}) => ({ protocol: 'https', get: (name: string) => name === 'host' ? 'portal.example.test:3001' : '', headers: { cookie: 'vnet_access=test-token', ...(origin ? { origin } : {}), ...extra } }) as unknown as Request;
  const service = { getEmailSettings: jest.fn(() => ({ source: 'server' })), saveEmailSettings: jest.fn(async () => ({ success: true })) };
  const access = { cookieName: 'vnet_access', readSession: jest.fn() };
  const controller = new AliMonthlyReportController(service as never, access as never);
  let oldUrl: string | undefined;
  beforeEach(() => { oldUrl = process.env.PUBLIC_BASE_URL; delete process.env.PUBLIC_BASE_URL; jest.clearAllMocks(); });
  afterEach(() => { if (oldUrl === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = oldUrl; });

  it('GET与POST都保留固定管理员路由标记', () => {
    expect(Reflect.getMetadata(AdminOnlyMetadataKey, controller.getEmailSettings)).toBe(true);
    expect(Reflect.getMetadata(AdminOnlyMetadataKey, controller.saveEmailSettings)).toBe(true);
  });
  it.each([{ role: 'guest' }, { role: 'professional' }, { role: 'admin', impersonation: { target: 'someone' } }])('拒绝非管理员或代登录 %#', principal => {
    access.readSession.mockReturnValue({ principal });
    expect(() => controller.getEmailSettings(makeRequest())).toThrow('管理员');
    expect(() => controller.saveEmailSettings(makeRequest('https://portal.example.test:3001'), request)).toThrow('管理员');
    expect(service.saveEmailSettings).not.toHaveBeenCalled();
  });
  it.each([undefined, 'https://attacker.example.test', 'null'])('拒绝缺少或错误origin %s', origin => {
    access.readSession.mockReturnValue({ principal: { role: 'admin' } });
    expect(() => controller.saveEmailSettings(makeRequest(origin), request)).toThrow('本站');
    expect(service.saveEmailSettings).not.toHaveBeenCalled();
  });
  it('匹配origin仍拒绝cross-site，正确请求沿用cookie管理员', async () => {
    access.readSession.mockReturnValue({ principal: { role: 'admin' } });
    expect(() => controller.saveEmailSettings(makeRequest('https://portal.example.test:3001', { 'sec-fetch-site': 'cross-site' }), request)).toThrow('本站');
    expect(await controller.saveEmailSettings(makeRequest('https://portal.example.test:3001'), request)).toEqual({ success: true });
    expect(access.readSession).toHaveBeenCalledWith('test-token');
  });
});
