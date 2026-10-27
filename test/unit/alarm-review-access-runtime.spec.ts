import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer, Socket } from 'node:net';
import { Resolver } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { UnifiedAccessModule } from '../../server/common/access/unified-access.module';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { AccessConfigurationCardDirectory } from '../../server/common/access/access-configuration.card-directory';
import { AlarmReviewController } from '../../server/modules/bitable-sync/alarm-review.controller';
import { AlarmReviewService } from '../../server/modules/bitable-sync/alarm-review.service';
import { AlarmReviewGateway } from '../../server/modules/bitable-sync/alarm-review.gateway';
import { AlarmReviewStore, ALARM_REVIEW_LEDGER_PATH } from '../../server/modules/bitable-sync/alarm-review.store';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import { TodayOperationsAlarmService } from '../../server/modules/bitable-sync/today-operations-alarm.service';
import type { AccessRole, PrivilegedAccessPrincipal } from '../../shared/access-control.interface';
import type { AccountMutation } from '../../shared/access-configuration.interface';
import type { AlarmReviewTask } from '../../shared/today-operations-alarm-review.interface';

type Policy = { denied: number; allowedConnections: number; installedBeforeApplicationImports: boolean; environmentIsolatedBeforeApplicationImports: boolean; rejectedWrites: number };
const policy = (globalThis as typeof globalThis & { __alarmReviewRuntimeNetwork: Policy }).__alarmReviewRuntimeNetwork;
const base = '/api/bitable/alarm-human-reviews';
const deniedRoles: AccessRole[] = ['guest', 'duty_editor', 'purchase_admin', 'purchase_applicant', 'inventory_admin', 'building_admin', 'construction_admin', 'supply_chain_admin'];
const testPassword = { admin: 'synthetic-runtime-admin-123', editor: 'synthetic-runtime-editor-123' };

describe('real access module × alarm review HTTP ownership', () => {
  let app: INestApplication | undefined;
  let directory = '', url = '', adminCookie = '', deniedBaseline = 0;
  let access: UnifiedAccessService, configuration: AccessConfigurationService, reviews: AlarmReviewService;
  let savedEnvironment: NodeJS.ProcessEnv;
  let failSync = false;
  let sequence = 0;
  const gateway = {
    preflight: async () => {}, resolveResponsibleUserId: async () => 'syntheticUser123',
    syncRecord: async (_id: string, outcome: string, _user: string, _version: string, reply?: string) => {
      if (failSync) throw new BadRequestException('合成同步失败');
      return { 人工复核结果: outcome, 复核回复: reply || '', 复核责任人: [{ id: 'syntheticUser123', name: '合成责任人' }] };
    },
  };
  function note(value: object): void {
    const file = process.env.ALARM_REVIEW_RUNTIME_OBSERVATIONS;
    const root = resolve(__dirname, '../../output/release-next-after-20261005-182903');
    if (!file || dirname(resolve(file)) !== root) throw new Error('Runtime observation path rejected');
    appendFileSync(file, JSON.stringify(value) + '\n');
  }
  function cookie(token: string) { return `${access.cookieName}=${token}`; }
  function owner(role: 'admin' | 'editor') {
    const principal = configuration.localTargets().find(target => target.principal.role === role)!.principal;
    return access.issueTrustedSession(principal);
  }
  function payload() {
    sequence += 1;
    return { recordIds: [`recSynthetic${sequence}`], outcome: '自定义回复', customReply: '合成复核说明', responsibleRecordId: 'recSyntheticPerson', clientMutationId: `alarm-review-runtime-${String(sequence).padStart(8, '0')}` };
  }
  async function request(path: string, loginCookie = '', body?: object) {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET',
      headers: { ...(loginCookie ? { cookie: loginCookie } : {}), ...(body ? { 'content-type': 'application/json', origin: url } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000), redirect: 'error' });
    return { status: response.status, body: await response.json() };
  }
  async function accepted(loginCookie: string) {
    const response = await request(base, loginCookie, payload());
    expect(response.status).toBe(201);
    return response.body as AlarmReviewTask;
  }
  async function deniedEndpoints(loginCookie: string, task: AlarmReviewTask) {
    for (const [path, body] of [
      [`${base}/people`, undefined], [base, payload()], [`${base}/${task.id}`, undefined],
      [`${base}/mutation/${task.clientMutationId}`, undefined], [`${base}/${task.id}/retry`, {}],
    ] as const) {
      const result = await request(path, loginCookie, body);
      expect(result.status === 401 || result.status === 403).toBe(true);
    }
  }
  async function ownedEndpoints(loginCookie: string, task: AlarmReviewTask) {
    expect((await request(`${base}/${task.id}`, loginCookie)).status).toBe(200);
    const recovered = await request(`${base}/mutation/${task.clientMutationId}`, loginCookie);
    expect(recovered.status).toBe(200);
    expect(recovered.body.id === task.id).toBe(true);
    expect((await request(`${base}/${task.id}/retry`, loginCookie, {})).status).toBe(201);
  }
  async function accountChange(values: Partial<AccountMutation> = {}) {
    const result = await request('/api/access/configuration/accounts', adminCookie, {
      clientMutationId: `runtime-account-${String(++sequence).padStart(8, '0')}`, expectedRevision: configuration.snapshot().revision,
      id: 'local-editor-all', kind: 'local', name: '合成子管理员', role: 'editor', building: null, enabled: true, ...values,
    });
    expect(result.status).toBe(201);
  }
  async function passwordLogin(password: string) {
    const response = await fetch(url + '/api/access/login', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
      body: JSON.stringify({ password }), signal: AbortSignal.timeout(5000), redirect: 'error' });
    expect(response.status).toBe(201);
    const setCookie = response.headers.getSetCookie().find(value => value.startsWith(access.cookieName + '='));
    const result = await response.json();
    expect(Boolean(setCookie)).toBe(true);
    return { cookie: setCookie!.split(';')[0], fingerprint: result.principalFingerprint as string };
  }
  beforeEach(async () => {
    savedEnvironment = { ...process.env };
    deniedBaseline = policy.denied;
    failSync = false;
    directory = mkdtempSync(join(tmpdir(), 'alarm-review-cross-auth-'));
    // Do not inherit real external credentials, grant IDs, proxies or account hashes.
    const evidence = { ALARM_REVIEW_RUNTIME_CACHE: process.env.ALARM_REVIEW_RUNTIME_CACHE, ALARM_REVIEW_RUNTIME_RESULT: process.env.ALARM_REVIEW_RUNTIME_RESULT, ALARM_REVIEW_RUNTIME_OBSERVATIONS: process.env.ALARM_REVIEW_RUNTIME_OBSERVATIONS };
    process.env = { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'].filter(key => savedEnvironment[key]).map(key => [key, savedEnvironment[key]])), ...evidence,
      NODE_ENV: 'test', LOCAL_ACCESS_CONTROL_ENABLED: 'true', ACCESS_CONFIGURATION_FILE: join(directory, 'configuration.json'),
      LOCAL_ACCESS_SESSION_SECRET: randomBytes(32).toString('base64'), LOCAL_ADMIN_PASSWORD_HASH: hashAccessPassword(testPassword.admin),
      LOCAL_EDITOR_PASSWORD_HASH: hashAccessPassword(testPassword.editor), FEISHU_APP_ID: 'cli_synthetic_runtime', FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false' };
    const module = await Test.createTestingModule({ imports: [UnifiedAccessModule], controllers: [AlarmReviewController], providers: [
      AlarmReviewService, AlarmReviewStore, { provide: ALARM_REVIEW_LEDGER_PATH, useValue: join(directory, 'ledger.json') },
      { provide: AlarmReviewGateway, useValue: gateway },
      { provide: BitableSyncService, useValue: { getCachedActivePersonnelDirectory: async () => ({ personnel: [{ recordId: 'recSyntheticPerson', name: '合成责任人', openId: 'ou_synthetic123', buildings: ['A'], position: '合成工程师' }] }) } },
      { provide: TodayOperationsAlarmService, useValue: { patchHumanReview: () => {} } },
    ] }).overrideProvider(AccessConfigurationDirectory).useValue({ read: async () => ({ appId: 'cli_synthetic_runtime', people: [], snapshotAt: Date.now() }), assertKnown: async () => {} })
      .overrideProvider(AccessConfigurationCardDirectory).useValue({ read: async () => ({ members: [] }) }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    process.env.PUBLIC_BASE_URL = url;
    access = app.get(UnifiedAccessService); configuration = app.get(AccessConfigurationService); reviews = app.get(AlarmReviewService);
    adminCookie = cookie(owner('admin').token);
    expect(access.isAccessControlEnabled()).toBe(true);
    expect(policy.installedBeforeApplicationImports).toBe(true);
    expect(policy.environmentIsolatedBeforeApplicationImports).toBe(true);
    expect(policy.rejectedWrites).toBe(0);
  });
  afterEach(async () => {
    const ownedDirectory = directory;
    const endpoint = url ? new URL(url) : null;
    let cleanup = 'not-complete';
    try {
      try { await app?.close(); } finally { app = undefined; }
      if (endpoint) {
        const probe = createServer();
        try {
          await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(Number(endpoint.port), '127.0.0.1', done); });
        } finally { if (probe.listening) await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done())); }
      }
      const tempRoot = realpathSync(tmpdir());
      if (dirname(realpathSync(ownedDirectory)) !== tempRoot || !basename(ownedDirectory).startsWith('alarm-review-cross-auth-') || lstatSync(ownedDirectory).isSymbolicLink()) throw new Error('Cleanup ownership rejected');
      const entries = readdirSync(ownedDirectory);
      if (entries.some(name => !['configuration.json', 'ledger.json'].includes(name))) throw new Error('Cleanup rejected unknown file or lock residue');
      for (const name of entries) {
        const file = join(ownedDirectory, name), stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Cleanup rejected non-ordinary file');
        unlinkSync(file);
      }
      rmdirSync(ownedDirectory);
      expect(existsSync(ownedDirectory)).toBe(false);
      cleanup = 'app-closed-port-rebound-files-unlinked-directory-removed';
      expect(policy.denied === deniedBaseline).toBe(true);
      expect(policy.rejectedWrites).toBe(0);
    } finally {
      try {
        note({ case: expect.getState().currentTestName, cleanup,
          directorySha256: createHash('sha256').update(ownedDirectory).digest('hex'),
          ...(cleanup === 'not-complete' ? { ownedTemporaryDirectory: ownedDirectory } : {}),
          unexpectedNetworkDenials: policy.denied - deniedBaseline, rejectedWrites: policy.rejectedWrites });
      } finally { process.env = { ...savedEnvironment }; directory = ''; url = ''; }
    }
  });

  it('rejects external and ambiguous transport targets before services can connect', async () => {
    await expect(fetch('http://example.invalid/')).rejects.toThrow('RUNTIME_TEST_NETWORK_POLICY_REJECTED');
    await expect(fetch('http://localhost:9/')).rejects.toThrow('RUNTIME_TEST_NETWORK_POLICY_REJECTED');
    const socket = new Socket();
    try { expect(() => socket.connect({ port: 9 })).toThrow('RUNTIME_TEST_NETWORK_POLICY_REJECTED'); } finally { socket.destroy(); }
    expect(() => new Resolver().resolve4('example.invalid', () => {})).toThrow('RUNTIME_TEST_NETWORK_POLICY_REJECTED');
    expect(() => httpsRequest('https://example.invalid/')).toThrow('RUNTIME_TEST_NETWORK_POLICY_REJECTED');
    expect(policy.denied - deniedBaseline).toBe(5);
    deniedBaseline = policy.denied;
  });
  it.each(['admin', 'editor'] as const)('admits %s via real APP_GUARD with a durable nonempty owner', async role => {
    const session = owner(role), loginCookie = cookie(session.token);
    const task = await accepted(loginCookie);
    const ledger = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8'));
    expect(typeof ledger.tasks[0].principal === 'string' && ledger.tasks[0].principal.length > 0).toBe(true);
    expect(ledger.tasks[0].principal === session.principalFingerprint).toBe(true);
    expect((await request(`${base}/people`, loginCookie)).status).toBe(200);
    await ownedEndpoints(loginCookie, task);
  });
  it.each(deniedRoles)('denies all five review endpoints for %s without new tasks', async role => {
    const task = await accepted(adminCookie);
    const loginCookie = role === 'guest' ? '' : cookie(access.issueTrustedSession({ role, purchaseBuilding: ['inventory_admin', 'building_admin', 'purchase_applicant'].includes(role) ? 'A楼' : null } as PrivilegedAccessPrincipal).token);
    await deniedEndpoints(loginCookie, task);
    expect(JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8')).tasks.length).toBe(1);
  });
  it('renew preserves recover/status/retry ownership after a synthetic sync failure', async () => {
    const session = owner('editor'), task = await accepted(cookie(session.token));
    failSync = true; await reviews.processReady();
    expect(reviews.status(task.id, 'editor', session.principalFingerprint).items[0].state).toBe('error');
    const renewed = access.renew(session.token, Date.now() + 1)!;
    expect(renewed.principalFingerprint === session.principalFingerprint).toBe(true);
    await ownedEndpoints(cookie(renewed.token), task);
    failSync = false; await reviews.processReady();
    expect((await request(`${base}/${task.id}`, cookie(renewed.token))).body.items[0].state).toBe('success');
  });
  it.each(['disable', 'demote', 'password'] as const)('%s rejects old cookies while accepted work remains independent', async mode => {
    const session = owner('editor'), oldCookie = cookie(session.token), task = await accepted(oldCookie);
    await accountChange(mode === 'disable' ? { enabled: false } : mode === 'demote' ? { role: 'purchase_admin' } : { password: 'synthetic-changed-runtime-123' });
    await deniedEndpoints(oldCookie, task);
    expect(access.renew(session.token) === null).toBe(true);
    await reviews.processReady();
    const ledger = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8'));
    expect(ledger.tasks[0].items[0].state).toBe('success');
    expect(ledger.tasks.length).toBe(1);
  });
  it('the first account change rejects unmapped legacy cookies without revoking managed admin', async () => {
    const legacy = new UnifiedAccessService().issueTrustedSession({ role: 'editor', purchaseBuilding: null });
    const legacyCookie = cookie(legacy.token), task = await accepted(legacyCookie);
    await accountChange();
    await deniedEndpoints(legacyCookie, task);
    expect((await request(`${base}/people`, adminCookie)).status).toBe(200);
  });
  it('card-only rule changes preserve the existing cookie and owned task', async () => {
    const session = owner('editor'), loginCookie = cookie(session.token), task = await accepted(loginCookie);
    const result = await request('/api/access/configuration/card-roles', adminCookie, { clientMutationId: 'runtime-card-00000001', expectedRevision: 0, code: 'contract_notify', building: null, members: [] });
    expect(result.status).toBe(201);
    expect(configuration.snapshot().cardRules.length).toBe(1);
    expect(access.renew(session.token)?.principalFingerprint === session.principalFingerprint).toBe(true);
    await ownedEndpoints(loginCookie, task);
  });
  it('real password re-login creates a new family and cannot inherit the old task', async () => {
    const first = await passwordLogin(testPassword.editor), task = await accepted(first.cookie);
    const second = await passwordLogin(testPassword.editor);
    expect(Boolean(first.fingerprint) && Boolean(second.fingerprint) && first.fingerprint !== second.fingerprint).toBe(true);
    for (const [path, body] of [[`${base}/${task.id}`, undefined], [`${base}/mutation/${task.clientMutationId}`, undefined], [`${base}/${task.id}/retry`, {}]] as const) {
      expect((await request(path, second.cookie, body)).status).toBe(403);
    }
    await ownedEndpoints(first.cookie, task);
  });
});
