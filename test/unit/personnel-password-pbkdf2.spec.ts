import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validAccessPasswordHash, matchesAccessPassword } from '../../server/common/access/access-password';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword, verifyAccessPassword } from '../../server/common/access/unified-access.service';

const password = 'synthetic-personnel-only';
const salt = Buffer.from('synthetic-salt01');
const encoded = (input = password) => `pbkdf2_sha256$600000$${salt.toString('base64url')}==$${pbkdf2Sync(input, salt, 600000, 32, 'sha256').toString('base64url')}=`;
let hash: string;
beforeAll(() => { hash = encoded(); expect(hash).toBe('pbkdf2_sha256$600000$c3ludGhldGljLXNhbHQwMQ==$tRp4SWf7QflxAZlTdzPAL178vJ_1ed16q0cwXmeTiFA='); });

describe('人员表PBKDF2格式兼容', () => {
  it('认识四段哈希，正确密码通过，错误密码和摘要文本不能登录', async () => {
    expect(validAccessPasswordHash(hash)).toBe(true);
    expect(await verifyAccessPassword(password, hash)).toBe(true);
    expect(await matchesAccessPassword(password, hash)).toBe(true);
    expect(await verifyAccessPassword('synthetic-wrong', hash)).toBe(false);
    expect(await verifyAccessPassword(hash, hash)).toBe(false);
  });
  it('标准base64和URL安全base64均符合Python参考解码规则', async () => {
    const standard = hash.split('$').map((part, index) => index < 2 ? part : part.replace(/-/g, '+').replace(/_/g, '/')).join('$');
    expect(validAccessPasswordHash(standard)).toBe(true);
    expect(await verifyAccessPassword(password, standard)).toBe(true);
  });
  it('拒绝参数篡改、坏padding、缺段和错误盐/摘要长度', async () => {
    const parts = hash.split('$');
    const invalid = [hash.replace('600000', '600001'), hash.replace('600000', '0600000'), hash.replace('pbkdf2_sha256', 'pbkdf2_sha1'),
      `${hash}$extra`, hash.slice(0, -1), hash.replace(parts[2], Buffer.alloc(15).toString('base64')),
      hash.replace(parts[3], Buffer.alloc(31).toString('base64')), hash.replace(parts[2], 'not valid')];
    for (const value of invalid) {
      expect(validAccessPasswordHash(value)).toBe(false);
      expect(await verifyAccessPassword(password, value)).toBe(false);
    }
  });
  it('密码按Unicode字符限制1至128，拒绝空值、129字符及坏Unicode', async () => {
    const unicode = '😀'.repeat(128), unicodeHash = encoded(unicode);
    expect(await verifyAccessPassword(unicode, unicodeHash)).toBe(true);
    for (const value of ['', 'a'.repeat(129), '😀'.repeat(129), '\ud800']) expect(await verifyAccessPassword(value, hash)).toBe(false);
  });
  it('计算不阻塞事件循环，原本地scrypt密码仍可用', async () => {
    let completed = false;
    const verifying = verifyAccessPassword(password, hash).then(value => { completed = true; return value; });
    let yielded = false;
    await new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
    expect(yielded).toBe(true);
    expect(completed).toBe(false);
    expect(await verifying).toBe(true);
    expect(await verifyAccessPassword('synthetic-local-only', hashAccessPassword('synthetic-local-only'))).toBe(true);
  });
});

describe('PBKDF2目录同步与实际姓名登录', () => {
  const original = { ...process.env };
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-personnel-pbkdf2-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(root, 'configuration.json');
    process.env.FEISHU_APP_ID = 'cli_a9d1c9fe9d381cee';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-only');
  });
  afterEach(() => { process.env = { ...original }; rmSync(root, { recursive: true, force: true }); });
  const build = (value: string) => buildExternalEmployeeCredentials([{ record_id: 'recPBKDFTest', fields: { 姓名: '哈希验收员工', 密码: value, '离职/异动情况': false } }], process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic');
  it('存储原摘要、不二次哈希；同步幂等；配置和磁盘不泄露明文', async () => {
    const people = await build(hash);
    expect(people[0]).toMatchObject({ active: true, passwordHash: hash });
    const configuration = new AccessConfigurationService();
    const snapshot = { appId: process.env.FEISHU_APP_ID!, people: [], employees: [], snapshotAt: Date.now(), personnelComplete: true, externalEmployees: people };
    await configuration.synchronizePersonnel(snapshot);
    const account = configuration.snapshot().accounts.find(item => item.loginMethod === 'personnel-password')!;
    const access = new UnifiedAccessService(configuration);
    const login = await access.login({ employeeName: account.name, password }, 'synthetic-source');
    expect(login.principal).toMatchObject({ accountId: account.id, displayName: account.name });
    await configuration.synchronizePersonnel({ ...snapshot, snapshotAt: Date.now() });
    expect(configuration.snapshot().accounts.find(item => item.id === account.id)?.version).toBe(account.version);
    expect(access.readSession(login.token).principal.accountId).toBe(account.id);
    expect(JSON.stringify(configuration.snapshot())).not.toContain(hash);
    expect(readFileSync(process.env.ACCESS_CONFIGURATION_FILE!, 'utf8')).not.toContain(password);
  });
  it('损坏的算法格式不作为明文退化，离职账号没有凭据', async () => {
    for (const value of [hash.replace('600000', '600001'), 'pbkdf2_sha256$broken', 'argon2$unsupported', ` ${hash}`, `\n${hash}`]) {
      const people = await build(value);
      expect(people[0]).toMatchObject({ active: false });
      expect(people[0].passwordHash).toBeUndefined();
    }
    const people = await buildExternalEmployeeCredentials([{ record_id: 'recPBKDFTest', fields: { 姓名: '哈希验收员工', 密码: hash, '离职/异动情况': true } }], process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic');
    expect(people[0]).toMatchObject({ active: false });
    expect(people[0].passwordHash).toBeUndefined();
  });
});
