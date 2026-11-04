jest.mock('../../server/common/hotfix-runtime-activation', () => ({ runHotfixInitialization: async (_owner: unknown, work: () => unknown) => work(), cancelHotfixInitialization: async () => undefined }));

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callbackFailureIdentity, FeishuCardCallbackFeedbackService } from '../../server/common/feishu-card-callback-feedback.service';
import { FeishuCardCallbackFeedbackStore } from '../../server/common/feishu-card-callback-feedback.store';

const APP = 'cli_synthetic_feedback', OPEN = 'ou_synthetic_feedback';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const payload = (event = 'evt_synthetic_1', note = 'SYNTHETIC_PRIVATE_VALUE') => ({ event_type: 'card.action.trigger', event_id: event, token: 'SYNTHETIC_CALLBACK_TOKEN',
  operator: { open_id: OPEN }, context: { open_message_id: 'om_synthetic_original' }, action: { tag: 'button', value: { action: 'approve', recordId: 'rec_synthetic' }, form_value: { note } } });

describe('late callback failure hints use only an isolated notification outbox', () => {
  let folder: string, file: string, previous: NodeJS.ProcessEnv, service: FeishuCardCallbackFeedbackService, store: FeishuCardCallbackFeedbackStore;
  let accounts: any[], http: any, configuration: any, receipts: Map<string, string>;
  beforeEach(async () => {
    previous = { ...process.env }; jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-02T07:00:00Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    folder = fs.mkdtempSync(join(tmpdir(), 'callback-feedback-')); file = join(folder, 'feishu-card-callback-feedback.json');
    Object.assign(process.env, { NODE_ENV: 'production', FEISHU_APP_ID: APP, FEISHU_APP_SECRET: 'SYNTHETIC_APP_SECRET',
      FEISHU_CARD_ACTION_CONSUMER_PROFILE: 'production', ACCESS_CONFIGURATION_FILE: join(folder, 'configuration.json') });
    delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    accounts = [{ kind: 'feishu', appId: APP, identityHash: digest(APP + '\0' + OPEN), name: 'SYNTHETIC_ACTOR', enabled: true }];
    configuration = { snapshot: () => ({ accounts }), isCurrentReadonlyCardRecipient: (target: any) => accounts.some(account => account.appId === target.appId && account.identityHash === target.identityHash &&
      account.name === target.name && account.enabled && !account.deleted && !account.permissionsRevoked && !account.reactivationRequired && account.personnelActive !== false) };
    receipts = new Map();
    http = { axiosRef: { post: jest.fn(async (url: string, body: any) => {
      if (url.endsWith('/internal')) return { status: 200, data: { code: 0, tenant_access_token: 'SYNTHETIC_ACCESS_TOKEN', expire: 3600 } };
      if (!receipts.has(body.uuid)) receipts.set(body.uuid, 'om_synthetic_hint_' + (receipts.size + 1));
      return { status: 200, data: { code: 0, data: { message_id: receipts.get(body.uuid) } } };
    }) } };
    service = make(); store = new FeishuCardCallbackFeedbackStore(file); await service.onModuleInit();
  });
  function make() { return new FeishuCardCallbackFeedbackService(http, configuration); }
  const posts = (http: any) => http.axiosRef.post.mock.calls.filter((call: any[]) => call[0].endsWith('/messages'));
  afterEach(async () => {
    await service.onModuleDestroy(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); process.env = previous;
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('does not create or replay unrelated business tasks on startup', async () => {
    await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(store.read().jobs).toEqual({}); expect(fs.existsSync(file)).toBe(false);
  });
  it('persists one generic read-only hint, without input fields, passwords, tokens or any callback button', async () => {
    await service.enqueueLateFailure(payload(), 'leave', new Error('SYNTHETIC_RAW_ERROR_WITH_SECRET'));
    expect(http.axiosRef.post).not.toHaveBeenCalled();
    const bytes = fs.readFileSync(file, 'utf8');
    for (const secret of ['SYNTHETIC_PRIVATE_VALUE', 'SYNTHETIC_CALLBACK_TOKEN', 'SYNTHETIC_RAW_ERROR_WITH_SECRET', 'rec_synthetic']) expect(bytes).not.toContain(secret);
    await service.flush(); expect(posts(http)).toHaveLength(1);
    const content = posts(http)[0][1].content;
    expect(content).toContain('卡片操作待核对'); expect(content).not.toMatch(/callback|button|form_value|rec_synthetic|SYNTHETIC_PRIVATE/u);
    expect(Object.values(store.read().jobs)[0]).toMatchObject({ status: 'sent', messageId: 'om_synthetic_hint_1', attempts: 1 });
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });
  it('deduplicates changed event IDs/tokens, canonical property order and restart', async () => {
    await service.enqueueLateFailure(payload('evt_first'), 'purchase', new Error('network'));
    const other = payload('evt_second'); other.token = 'SYNTHETIC_OTHER_TOKEN'; other.action.value = { recordId: 'rec_synthetic', action: 'approve' };
    await service.enqueueLateFailure(other, 'purchase', new Error('again')); await service.flush();
    await service.onModuleDestroy(); service = make(); await service.onModuleInit();
    await service.enqueueLateFailure(payload('evt_third'), 'purchase', new Error('again')); await service.flush();
    expect(posts(http)).toHaveLength(1); expect(Object.keys(store.read().jobs)).toHaveLength(1);
  });
  it.each([400, 401, 403])('does not notify an invalid or forbidden callback (%s)', async status => {
    const { HttpException } = await import('@nestjs/common');
    await service.enqueueLateFailure(payload(), 'leave', new HttpException('SYNTHETIC_ERROR', status));
    await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(store.read().jobs).toEqual({});
  });
  it.each(['enabled', 'deleted', 'permissionsRevoked', 'reactivationRequired', 'personnelActive'])('checks %s again before dispatch', async property => {
    await service.enqueueLateFailure(payload(), 'overtime', new Error('network'));
    accounts[0][property] = property === 'enabled' || property === 'personnelActive' ? false : true;
    await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(Object.values(store.read().jobs)[0].status).toBe('cancelled');
  });
  it('refuses unknown actors, ambiguous actors, changed applications and invalid identities', async () => {
    accounts = []; await service.enqueueLateFailure(payload(), 'leave', new Error('network'));
    await service.enqueueLateFailure({}, 'leave', new Error('network')); await service.enqueueLateFailure(payload(), 'invented_kind', new Error('network'));
    expect(store.read().jobs).toEqual({});
    accounts = [{ kind: 'feishu', appId: APP, identityHash: digest(APP + '\0' + OPEN), name: 'SYNTHETIC_ACTOR', enabled: true }];
    await service.enqueueLateFailure(payload(), 'leave', new Error('network')); process.env.FEISHU_APP_ID = 'cli_synthetic_other_app';
    await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(Object.values(store.read().jobs)[0].status).toBe('cancelled');
  });
  it('rechecks eligibility after slow token retrieval and never sends after revocation', async () => {
    let release!: (result: unknown) => void;
    http.axiosRef.post.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await service.enqueueLateFailure(payload(), 'leave', new Error('network'));
    const work = service.flush(); await Promise.resolve(); accounts[0].permissionsRevoked = true;
    release({ data: { code: 0, tenant_access_token: 'SYNTHETIC_TOKEN', expire: 3600 } }); await work;
    expect(posts(http)).toHaveLength(0);
  });
  it('uses one per-job delivery lock across service instances', async () => {
    let release!: (result: unknown) => void;
    http.axiosRef.post.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await service.enqueueLateFailure(payload(), 'leave', new Error('network'));
    const first = service.flush(); await Promise.resolve();
    const second = make(); await second.onModuleInit(); await second.flush();
    release({ data: { code: 0, tenant_access_token: 'SYNTHETIC_TOKEN', expire: 3600 } }); await first; await second.onModuleDestroy();
    expect(posts(http)).toHaveLength(1); expect(receipts.size).toBe(1);
  });
  it('retries unknown delivery only with its exact UUID, then retains confirmed receipt across restart', async () => {
    const original = http.axiosRef.post.getMockImplementation(); let lost = true;
    http.axiosRef.post.mockImplementation(async (url: string, body: any) => {
      const response = await original(url, body);
      if (url.endsWith('/messages') && lost) { lost = false; throw new Error('network result lost'); }
      return response;
    });
    await service.enqueueLateFailure(payload(), 'leave', new Error('network')); await service.flush();
    expect(Object.values(store.read().jobs)[0].status).toBe('sending');
    await service.onModuleDestroy(); service = make(); await service.onModuleInit(); jest.setSystemTime(Date.now() + 31_000); await service.flush();
    expect(posts(http)).toHaveLength(2); expect(receipts.size).toBe(1); expect(new Set(posts(http).map((row: any[]) => row[1].uuid)).size).toBe(1);
    expect(Object.values(store.read().jobs)[0].status).toBe('sent');
  });
  it('does not create a second message if receipt persistence fails after the remote send', async () => {
    const original = http.axiosRef.post.getMockImplementation(); let failReceipt = true;
    http.axiosRef.post.mockImplementation(async (url: string, body: any) => {
      const response = await original(url, body);
      if (url.endsWith('/messages') && failReceipt) { failReceipt = false; jest.spyOn(require('node:fs'), 'renameSync').mockImplementationOnce(() => { throw new Error('receipt disk interruption'); }); }
      return response;
    });
    await service.enqueueLateFailure(payload(), 'leave', new Error('network')); await service.flush();
    expect(Object.values(store.read().jobs)[0].status).toBe('sending');
    jest.setSystemTime(Date.now() + 31_000); await service.flush(); expect(receipts.size).toBe(1);
    expect(Object.values(store.read().jobs)[0].status).toBe('sent');
  });
  it('recovers a dead process delivery lock while never taking over a live peer lock', async () => {
    await service.enqueueLateFailure(payload(), 'leave', new Error('network')); const id = Object.keys(store.read().jobs)[0];
    fs.writeFileSync(file + '.' + id + '.lock', JSON.stringify({ version: 1, pid: 99_999_999, token: 'synthetic-dead-owner' }));
    await service.flush(); expect(posts(http)).toHaveLength(1); expect(Object.values(store.read().jobs)[0].status).toBe('sent');
  });
  it('does not blindly resend an unknown result outside the deduplication window', async () => {
    await service.enqueueLateFailure(payload(), 'leave', new Error('network'));
    store.update(state => { const job = Object.values(state.jobs)[0]; job.status = 'sending'; job.attempts = 1; job.firstAttemptAt = Date.now() - 301_000; });
    await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(Object.values(store.read().jobs)[0].status).toBe('attention');
  });
  it('requires a successful HTTP status as well as a complete API receipt', async () => {
    const original = http.axiosRef.post.getMockImplementation();
    http.axiosRef.post.mockImplementation(async (url: string, body: any) => {
      const response = await original(url, body);
      return url.endsWith('/messages') ? { ...response, status: 503 } : response;
    });
    await service.enqueueLateFailure(payload(), 'leave', new Error('network')); await service.flush();
    expect(Object.values(store.read().jobs)[0].status).toBe('sending');
  });
  it('accepts the verified HTTP parser identity without storing its input', async () => {
    await service.enqueueLateFailure({ kind: 'manager_action', operatorOpenId: OPEN, messageId: 'om_synthetic_http', action: 'choose_comprehensive', eventId: 'evt_http', updateToken: 'PRIVATE_HTTP_TOKEN' }, 'purchase', new Error('network'));
    await service.flush(); expect(posts(http)).toHaveLength(1); expect(fs.readFileSync(file, 'utf8')).not.toContain('PRIVATE_HTTP_TOKEN');
  });
  it('rejects altered recipients or delivery UUIDs rather than replaying a damaged ledger', async () => {
    await service.enqueueLateFailure(payload(), 'leave', new Error('network'));
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace(OPEN, 'ou_synthetic_forged')); expect(() => store.read()).toThrow();
    fs.writeFileSync(file, original); const state = JSON.parse(original); Object.values<any>(state.jobs)[0].uuid = 'a'.repeat(40);
    fs.writeFileSync(file, JSON.stringify(state)); await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it('limits repeated unknown sends without losing the stable UUID', async () => {
    const original = http.axiosRef.post.getMockImplementation();
    http.axiosRef.post.mockImplementation(async (url: string, body: any) => { if (url.endsWith('/messages')) throw new Error('SYNTHETIC_PRIVATE_ERROR'); return original(url, body); });
    await service.enqueueLateFailure(payload(), 'leave', new Error('network'));
    for (let index = 0; index < 5; index++) { await service.flush(); jest.setSystemTime(Date.now() + 31_000); }
    expect(posts(http)).toHaveLength(3); expect(Object.values(store.read().jobs)[0].status).toBe('attention');
    expect(JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls)).not.toContain('SYNTHETIC_PRIVATE_ERROR');
  });
  it('partial failure does not resend a successful peer', async () => {
    const other = payload('evt_other'); other.operator.open_id = 'ou_synthetic_peer'; other.context.open_message_id = 'om_synthetic_peer_original';
    accounts.push({ ...accounts[0], identityHash: digest(APP + '\0ou_synthetic_peer') });
    const original = http.axiosRef.post.getMockImplementation(); let failed = false;
    http.axiosRef.post.mockImplementation(async (url: string, body: any) => { if (url.endsWith('/messages') && body.receive_id === 'ou_synthetic_peer' && !failed) { failed = true; throw new Error('temporary'); } return original(url, body); });
    await service.enqueueLateFailure(payload(), 'leave', new Error('network')); await service.enqueueLateFailure(other, 'leave', new Error('network')); await service.flush();
    jest.setSystemTime(Date.now() + 31_000); await service.flush();
    expect(posts(http).filter((row: any[]) => row[1].receive_id === OPEN)).toHaveLength(1); expect(receipts.size).toBe(2);
  });
  it('fails closed on corrupt state or a lost atomic rename and never dispatches an uncommitted job', async () => {
    const rename = jest.spyOn(require('node:fs'), 'renameSync').mockImplementationOnce(() => { throw new Error('SYNTHETIC_DISK_FAILURE'); });
    await expect(service.enqueueLateFailure(payload(), 'leave', new Error('network'))).rejects.toThrow('SYNTHETIC_DISK_FAILURE'); rename.mockRestore();
    await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(store.read().jobs).toEqual({});
    await service.enqueueLateFailure(payload(), 'leave', new Error('network')); const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, before.replace('"queued"', '"bogus!"')); await service.flush();
    expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(() => store.read()).toThrow(ServiceUnavailableException);
  });
  it.each(['development', 'smoke', 'disabled', 'local-test'])('never initializes outbound delivery in %s mode', async mode => {
    await service.onModuleDestroy();
    if (mode === 'development') process.env.NODE_ENV = 'development';
    else if (mode === 'smoke') process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true';
    else process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = mode;
    service = make(); await service.onModuleInit(); await service.enqueueLateFailure(payload(), 'leave', new Error('network')); await service.flush();
    expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(store.read().jobs).toEqual({});
  });
  it('distinguishes another actor, message or changed action while ignoring only volatile delivery metadata', () => {
    const first = callbackFailureIdentity(payload(), 'leave', APP)!;
    const changed = payload(); changed.action.value.action = 'reject';
    expect(callbackFailureIdentity(changed, 'leave', APP)?.id).not.toBe(first.id);
    const another = payload(); another.operator.open_id = 'ou_synthetic_another';
    expect(callbackFailureIdentity(another, 'leave', APP)?.id).not.toBe(first.id);
    expect(callbackFailureIdentity(payload('evt_another'), 'leave', APP)?.id).toBe(first.id);
  });
});
