import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AliMonthlyReportEmailSettingsStore, EMAIL_SETTINGS_UNAVAILABLE } from '../../server/modules/ali-monthly-report/ali-monthly-report-email-settings.store';

const senderEmail = 'sender@example.test';
const authCode = 'abcdefghijklmnop';
const fallback = { senderEmail: 'legacy@example.test', authCode: 'qrstuvwxyzABCDEF' };
const request = { senderEmail, authCode, expectedRevision: 'server', clientMutationId: 'mutation-email-001' };
describe('本项目月报发件配置的加密持久化', () => {
  let directory: string;
  let file: string;
  let store: AliMonthlyReportEmailSettingsStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ali-email-settings-'));
    file = join(directory, 'email-settings.json');
    store = new AliMonthlyReportEmailSettingsStore(file, () => 'synthetic-encryption-key-only');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('未保存时只读旧配置，不创建文件或返回凭据', () => {
    const resolved = store.resolve(fallback);
    expect(resolved.authCode).toBe(fallback.authCode);
    expect(resolved.settings).toEqual({ senderEmail: fallback.senderEmail, authCodeConfigured: true, source: 'server', revision: 'server', updatedAt: null, canSave: true });
    expect(existsSync(file)).toBe(false);
    expect(JSON.stringify(resolved.settings)).not.toContain(fallback.authCode);
  });

  it('保存后可用新实例解密重读，磁盘和安全DTO不暴露授权码或摘要', async () => {
    const saved = await store.save(request, fallback);
    const bytes = readFileSync(file, 'utf8');
    expect(bytes).not.toContain(authCode);
    expect(bytes).not.toContain(fallback.authCode);
    expect(saved).toMatchObject({ senderEmail, authCodeConfigured: true, source: 'page', canSave: true });
    expect(saved.revision).not.toBe('server');
    expect(Object.keys(saved).sort()).toEqual(['authCodeConfigured', 'canSave', 'revision', 'senderEmail', 'source', 'updatedAt']);
    expect(new AliMonthlyReportEmailSettingsStore(file, () => 'synthetic-encryption-key-only').resolve(fallback)).toMatchObject({ senderEmail, authCode });
    expect(readdirSync(directory)).toEqual(['email-settings.json']);
  });

  it('页面配置优先于后续变化的服务器邮箱和授权码', async () => {
    await store.save(request, fallback);
    expect(store.resolve({ senderEmail: 'changed@example.test', authCode: 'DIFFERENToldCODE' })).toMatchObject({ senderEmail, authCode });
  });

  it.each([undefined, '', '   '])('相同邮箱授权码留空（%s）时保留当前已保存凭据', async value => {
    const saved = await store.save(request, fallback);
    await store.save({ senderEmail, authCode: value, expectedRevision: saved.revision, clientMutationId: 'mutation-keep-code' }, fallback);
    expect(store.resolve(fallback).authCode).toBe(authCode);
  });

  it('第一次保存同一旧邮箱可保留旧授权码，而更换邮箱不能偷用旧码', async () => {
    await expect(store.save({ ...request, authCode: '', senderEmail: 'other@example.test' }, fallback)).rejects.toThrow('更换发件邮箱');
    await store.save({ ...request, authCode: '', senderEmail: fallback.senderEmail }, fallback);
    expect(store.resolve(fallback).authCode).toBe(fallback.authCode);
  });

  it('更换已保存邮箱必须输入新码', async () => {
    const saved = await store.save(request, fallback);
    await expect(store.save({ senderEmail: 'other@example.test', expectedRevision: saved.revision, clientMutationId: 'mutation-other-email' }, fallback)).rejects.toThrow('更换发件邮箱');
    expect(store.resolve(fallback).settings.revision).toBe(saved.revision);
  });

  it('两个管理员从未保存版本同时保存只允许第一个成功', async () => {
    const results = await Promise.allSettled([store.save(request, fallback), store.save({ ...request, clientMutationId: 'mutation-email-002' }, fallback)]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') expect(results[1].reason.getStatus()).toBe(409);
  });

  it('响应丢失后跨实例相同请求重试不改变版本或加密文件', async () => {
    const first = await store.save(request, fallback);
    const bytes = readFileSync(file, 'utf8');
    const again = await new AliMonthlyReportEmailSettingsStore(file, () => 'synthetic-encryption-key-only').save(request, fallback);
    expect(again).toEqual(first);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    await expect(store.save({ ...request, authCode: 'ABCDEFGHijklmnop' }, fallback)).rejects.toThrow('请求标识');
  });

  it('缺少密钥可读取原服务器状态但不能保存，不降为明文', async () => {
    const noKey = new AliMonthlyReportEmailSettingsStore(file, () => '');
    expect(noKey.resolve(fallback)).toMatchObject({ authCode: fallback.authCode, settings: { source: 'server', canSave: false } });
    expect(noKey.resolve(fallback).blockingIssue).toBeUndefined();
    await expect(noKey.save(request, fallback)).rejects.toThrow('安全保存密钥');
    expect(existsSync(file)).toBe(false);
  });

  it.each(['broken-json', 'changed-ciphertext', 'changed-sender', 'changed-revision', 'wrong-key'])('损坏或解密失败(%s)只报安全错误、不回退旧邮箱', async scenario => {
    await store.save(request, fallback);
    const original = JSON.parse(readFileSync(file, 'utf8'));
    if (scenario === 'broken-json') writeFileSync(file, '{broken');
    if (scenario === 'changed-ciphertext') { original.encryptedAuthCode.ciphertext = Buffer.alloc(16).toString('base64'); writeFileSync(file, JSON.stringify(original)); }
    if (scenario === 'changed-sender') { original.senderEmail = 'attacker@example.test'; writeFileSync(file, JSON.stringify(original)); }
    if (scenario === 'changed-revision') { original.revision = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; writeFileSync(file, JSON.stringify(original)); }
    const selected = scenario === 'wrong-key' ? new AliMonthlyReportEmailSettingsStore(file, () => 'another-synthetic-key') : store;
    const before = readFileSync(file, 'utf8');
    expect(selected.resolve(fallback)).toMatchObject({ senderEmail: '', authCode: '', blockingIssue: EMAIL_SETTINGS_UNAVAILABLE, settings: { canSave: false } });
    await expect(selected.save({ ...request, clientMutationId: 'different-mutation' }, fallback)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('已读过的页面配置被删除时不静默回退', async () => {
    await store.save(request, fallback);
    unlinkSync(file);
    expect(store.resolve(fallback).blockingIssue).toBe(EMAIL_SETTINGS_UNAVAILABLE);
  });

  it('相对路径及硬链接被拒绝，不改原文件', async () => {
    const relative = new AliMonthlyReportEmailSettingsStore('relative.json', () => 'synthetic-key');
    expect(relative.resolve(fallback).blockingIssue).toBe(EMAIL_SETTINGS_UNAVAILABLE);
    await expect(relative.save(request, fallback)).rejects.toThrow(EMAIL_SETTINGS_UNAVAILABLE);
    await store.save(request, fallback);
    const original = readFileSync(file, 'utf8');
    linkSync(file, join(directory, 'alias.json'));
    expect(store.resolve(fallback).blockingIssue).toBe(EMAIL_SETTINGS_UNAVAILABLE);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('未确认的锁不能被删除或跨过', async () => {
    writeFileSync(`${file}.lock`, '{}');
    await expect(store.save(request, fallback)).rejects.toThrow('正在保存');
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('{}');
  });

  it('接受脱敏中间件保留的非枚举邮箱/授权码，拒绝非枚举未知字段', async () => {
    const body = { expectedRevision: 'server', clientMutationId: 'mutation-redacted' } as typeof request;
    Object.defineProperties(body, { senderEmail: { value: senderEmail }, authCode: { value: authCode } });
    await store.save(body, fallback);
    expect(store.resolve(fallback).authCode).toBe(authCode);
    const invalid = { ...request };
    Object.defineProperty(invalid, 'invalidFields', { value: true });
    await expect(store.save(invalid, fallback)).rejects.toThrow('请求格式无效');
  });

  it.each([null, [], { ...request, authCode: 'bad' }, { ...request, senderEmail: 'bad\n@example.test' }, { ...request, authCode: null }, { ...request, recipient: 'unexpected@example.test' }])('拒绝无效字段且不创建文件 %#', async value => {
    await expect(store.save(value as never, fallback)).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});
