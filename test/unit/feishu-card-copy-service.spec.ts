import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuCardCopyService } from '../../server/common/feishu-card-copy/card-copy.service';
import { FeishuCardCopyModule } from '../../server/common/feishu-card-copy/card-copy.module';
import { FeishuCardMirrorStore } from '../../server/common/feishu-card-copy/mirror.store';
import { observedCardPost, observedCardPatch, isReadonlyCopyCallback } from '../../server/common/feishu-card-copy/transport';
import { additionalReadonlyCardLedger, additionalReadonlyCardTargets } from '../../server/common/feishu-card-copy/targets';
import { runHotfixInitialization } from '../../server/common/hotfix-runtime-activation';

jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  runHotfixInitialization: jest.fn(async (_owner, callback) => callback()),
  cancelHotfixInitialization: jest.fn(async () => {}),
}));

describe('card copy activation isolation (no application or real transport)', () => {
  const previousEnv = process.env;
  let dir: string, file: string, http: any, configuration: any, service: FeishuCardCopyService, account: any;
  const appId = 'cli_synthetic', recipient = 'ou_synthetic_copy', name = '合成人员';
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'card-copy-activation-')); file = join(dir, 'mirror.json');
    process.env = { ...previousEnv, NODE_ENV: 'production', FEISHU_APP_ID: appId, FEISHU_APP_SECRET: '',
      FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: recipient, FEISHU_CARD_READONLY_COPY_NAME: name,
      FEISHU_CARD_READONLY_COPY_LEDGER_PATH: file, ACCESS_CONFIGURATION_FILE: join(dir, 'configuration.json'), NANTONG_HOTFIX_SMOKE_MODE: 'false' };
    delete process.env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS;
    account = { id: 'synthetic-account', version: 1, kind: 'feishu', appId, name, identityHash: createHash('sha256').update(`${appId}\0${recipient}`).digest('hex'), enabled: true, personnelActive: true };
    configuration = { snapshot: jest.fn(() => ({ accounts: [account] })), currentPrincipal: jest.fn(() => ({ accountId: account.id })) };
    configuration.isCurrentReadonlyCardRecipient = jest.fn((target: any) => {
      const matches = configuration.snapshot().accounts.filter((row: any) => row.kind === 'feishu' && row.appId === target.appId &&
        row.identityHash === target.identityHash && row.name === target.name && row.enabled && !row.deleted && !row.reactivationRequired && !row.permissionsRevoked && row.personnelActive !== false);
      return matches.length === 1 && !!configuration.currentPrincipal(matches[0].id, matches[0].version);
    });
    http = { axiosRef: { post: jest.fn(() => { throw new Error('No real authentication or copy delivery allowed'); }), patch: jest.fn(), delete: jest.fn() } };
    service = new FeishuCardCopyService(http, configuration);
  });
  afterEach(async () => { await service.onModuleDestroy(); process.env = previousEnv; jest.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
  async function source(messageId = 'om_synthetic_original') {
    const original = { post: jest.fn(async () => ({ status: 200, data: { code: 0, data: { message_id: messageId } } })) };
    await observedCardPost(original as never, 'synthetic', 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      msg_type: 'interactive', receive_id: 'ou_original', content: JSON.stringify({ elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Synthetic card' } }] }),
    }, {});
    return original;
  }
  const groups = () => new FeishuCardMirrorStore(file, { appId, recipientOpenId: recipient }).read().groups;
  it.each(['1', 'true', 'ON', 'yes'])('never registers or writes in production smoke mode %s', async mode => {
    process.env.NANTONG_HOTFIX_SMOKE_MODE = mode;
    await service.onModuleInit(); await source();
    expect(runHotfixInitialization).not.toHaveBeenCalled(); expect(existsSync(file)).toBe(false); expect(jest.getTimerCount()).toBe(0); expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it.each(['test', 'development'])('cannot start from inherited enabled settings in %s', async mode => {
    process.env.NODE_ENV = mode; await service.onModuleInit(); await source();
    expect(existsSync(file)).toBe(false); expect(runHotfixInitialization).not.toHaveBeenCalled();
  });
  it('keeps original delivery available when disabled or target app is inconsistent', async () => {
    process.env.FEISHU_CARD_READONLY_COPY_ENABLED = 'false'; await service.onModuleInit();
    process.env.FEISHU_CARD_READONLY_COPY_ENABLED = 'true'; process.env.FEISHU_CARD_READONLY_COPY_APP_ID = 'cli_wrong'; await service.onModuleInit();
    const original = await source(); expect(original.post).toHaveBeenCalledTimes(1); expect(existsSync(file)).toBe(false);
  });
  it('rejects ledger collisions without writing the existing configuration path', async () => {
    process.env.FEISHU_CARD_READONLY_COPY_LEDGER_PATH = process.env.ACCESS_CONFIGURATION_FILE;
    await service.onModuleInit(); expect(existsSync(process.env.ACCESS_CONFIGURATION_FILE!)).toBe(false); expect(runHotfixInitialization).not.toHaveBeenCalled();
  });
  it('enrolls only the unique active exact identity without changing permissions or sending inline', async () => {
    const before = JSON.stringify(account); await service.onModuleInit(); await source();
    expect(Object.keys(groups())).toHaveLength(1); expect(JSON.stringify(account)).toBe(before);
    expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(configuration.currentPrincipal).toHaveBeenCalledWith(account.id, account.version);
  });
  it.each(['enabled', 'deleted', 'reactivationRequired', 'permissionsRevoked', 'personnelActive', 'name', 'identityHash', 'appId'])('fails closed on target %s change', async field => {
    await service.onModuleInit(); account[field] = ['enabled', 'personnelActive'].includes(field) ? false : ['name', 'identityHash', 'appId'].includes(field) ? 'changed' : true;
    await source(); expect(Object.keys(groups())).toHaveLength(0); expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it('rejects ambiguous accounts and revoked current principal', async () => {
    await service.onModuleInit(); configuration.snapshot.mockReturnValue({ accounts: [account, { ...account, id: 'duplicate' }] });
    await source('om_ambiguous'); configuration.snapshot.mockReturnValue({ accounts: [account] }); configuration.currentPrincipal.mockReturnValue(null);
    await source('om_revoked'); expect(Object.keys(groups())).toHaveLength(0);
  });
  it.each(['FEISHU_APP_ID', 'FEISHU_CARD_READONLY_COPY_APP_ID', 'FEISHU_CARD_READONLY_COPY_OPEN_ID', 'FEISHU_CARD_READONLY_COPY_NAME', 'FEISHU_CARD_READONLY_COPY_ENABLED', 'NODE_ENV', 'NANTONG_HOTFIX_SMOKE_MODE'])('pauses existing observer after runtime change to %s', async key => {
    await service.onModuleInit(); process.env[key] = key === 'NANTONG_HOTFIX_SMOKE_MODE' ? 'true' : 'changed';
    await source(); expect(Object.keys(groups())).toHaveLength(0); expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it('registers a singleton provider and removes timer/observer on shutdown', async () => {
    expect(Reflect.getMetadata('providers', FeishuCardCopyModule)).toContain(FeishuCardCopyService);
    await service.onModuleInit(); expect(jest.getTimerCount()).toBe(1); await service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0); await source(); expect(Object.keys(groups())).toHaveLength(0);
  });

  const extraId = 'ou_synthetic_second';
  function addSecond() {
    const second = { ...account, id: 'second-account', name: '合成第二人', identityHash: createHash('sha256').update(`${appId}\0${extraId}`).digest('hex') };
    configuration.snapshot.mockImplementation(() => ({ accounts: [account, second] }));
    process.env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS = JSON.stringify([{ name: second.name, openId: extraId }]);
    return second;
  }
  const extraFile = () => additionalReadonlyCardLedger(file, appId, extraId);
  const extraGroups = () => new FeishuCardMirrorStore(extraFile(), { appId, recipientOpenId: extraId }).read().groups;
  function fakeTransport() {
    process.env.FEISHU_APP_SECRET = 'synthetic-secret';
    http.axiosRef.post.mockImplementation(async (url: string, body: any) => ({ status: 200, data: url.includes('/auth/')
      ? { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
      : { code: 0, data: { message_id: `om_copy_${body.receive_id}` } } }));
    http.axiosRef.patch.mockResolvedValue({ status: 200, data: { code: 0 } });
  }
  const copyCalls = () => http.axiosRef.post.mock.calls.filter(([url]: [string]) => url.includes('/im/v1/messages'));
  it('sends one readonly copy to each person and synchronizes updates and callback guards for both', async () => {
    addSecond(); fakeTransport(); await service.onModuleInit(); await source(); await source('om_other_original');
    await jest.advanceTimersByTimeAsync(5000);
    expect(http.axiosRef.post.mock.calls.filter(([url]: [string]) => url.includes('/auth/'))).toHaveLength(1);
    expect(copyCalls().map(([,body]: any[]) => body.receive_id).sort()).toEqual([recipient, extraId].sort());
    expect(new Set(copyCalls().map(([,body]: any[]) => body.uuid)).size).toBe(2);
    for (const [, body] of copyCalls()) { expect(body.content).toContain('只读抄送'); expect(body.content).not.toMatch(/"button"|"callback"/); }
    expect(isReadonlyCopyCallback({ context: { open_message_id: `om_copy_${recipient}` } })).toBe(true);
    expect(isReadonlyCopyCallback({ context: { open_message_id: `om_copy_${extraId}` } })).toBe(true);
    const patch = { patch: jest.fn(async () => ({ status: 200, data: { code: 0 } })) };
    await observedCardPatch(patch as never, 'synthetic', 'https://open.feishu.cn/open-apis/im/v1/messages/om_synthetic_original', {
      content: JSON.stringify({ elements: [{ tag: 'div', text: { tag: 'plain_text', content: '审批完成' } }] }),
    }, {});
    await jest.advanceTimersByTimeAsync(5000);
    expect(http.axiosRef.patch).toHaveBeenCalledTimes(2);
    expect(http.axiosRef.patch.mock.calls.every(([,body]: any[]) => body.content.includes('审批完成'))).toBe(true);
    expect(copyCalls()).toHaveLength(2);
  });
  it('keeps the original recipient working when added settings or the added ledger are damaged', async () => {
    addSecond(); writeFileSync(extraFile(), 'broken-ledger'); fakeTransport();
    await service.onModuleInit(); await source(); await jest.advanceTimersByTimeAsync(5000);
    expect(copyCalls().map(([,body]: any[]) => body.receive_id)).toEqual([recipient]);
    expect(readFileSync(extraFile(),'utf8')).toBe('broken-ledger');
  });
  it('keeps the second recipient working when the original ledger is damaged', async () => {
    addSecond(); writeFileSync(file, 'broken-original'); fakeTransport();
    await service.onModuleInit(); await source(); await jest.advanceTimersByTimeAsync(5000);
    expect(copyCalls().map(([,body]: any[]) => body.receive_id)).toEqual([extraId]);
    expect(readFileSync(file,'utf8')).toBe('broken-original');
  });
  it('does not replay the first recipient history when the new recipient is added on restart', async () => {
    await service.onModuleInit(); await source(); const originalBytes=readFileSync(file);
    await service.onModuleDestroy(); addSecond(); service=new FeishuCardCopyService(http, configuration);
    await service.onModuleInit();
    expect(readFileSync(file).equals(originalBytes)).toBe(true); expect(existsSync(extraFile())).toBe(false);
    const patch={patch:jest.fn(async()=>({status:200,data:{code:0}}))};
    await observedCardPatch(patch as never,'synthetic','https://open.feishu.cn/open-apis/im/v1/messages/om_synthetic_original',{content:JSON.stringify({elements:[]})},{});
    expect(Object.keys(extraGroups())).toHaveLength(0);
    await source('om_new_card'); expect(Object.keys(extraGroups())).toHaveLength(1);
  });
  it('isolates ineligible recipients without granting permissions or disabling the other copy', async () => {
    const second=addSecond(); await service.onModuleInit(); second.enabled=false; await source('om_first_only');
    expect(Object.keys(groups())).toHaveLength(1); expect(Object.keys(extraGroups())).toHaveLength(0);
    second.enabled=true; account.enabled=false; await source('om_second_only');
    expect(Object.keys(extraGroups())).toHaveLength(1); expect(account.enabled).toBe(false);
  });
  it('deduplicates additional identities and the primary recipient', async () => {
    const second=addSecond();
    process.env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS=JSON.stringify([{name,openId:recipient},{name:second.name,openId:extraId},{name:second.name,openId:extraId}]);
    fakeTransport(); await service.onModuleInit(); await source(); await jest.advanceTimersByTimeAsync(5000); expect(copyCalls()).toHaveLength(2);
  });
  it('retries only the throttled recipient and retains the successful original copy', async () => {
    addSecond(); fakeTransport(); const normal=http.axiosRef.post.getMockImplementation(); let limited=true;
    http.axiosRef.post.mockImplementation(async(url:string,body:any)=> body.receive_id===extraId&&limited
      ? {status:429,data:{code:99991400}} : normal(url,body));
    await service.onModuleInit(); await source(); await jest.advanceTimersByTimeAsync(5000);
    limited=false; await jest.advanceTimersByTimeAsync(60000);
    expect(copyCalls().filter(([,body]:any[])=>body.receive_id===recipient)).toHaveLength(1);
    const retried=copyCalls().filter(([,body]:any[])=>body.receive_id===extraId); expect(retried).toHaveLength(2);
    expect(retried[0][1].uuid).toBe(retried[1][1].uuid);
  });
  it('invalid additional settings pause only added recipients', async () => {
    addSecond(); await service.onModuleInit(); process.env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS='not-json'; await source();
    expect(Object.keys(groups())).toHaveLength(1); expect(Object.keys(extraGroups())).toHaveLength(0);
  });
  it('coalesces a failed token request and clears it for a subsequent retry', async () => {
    process.env.FEISHU_APP_SECRET = 'synthetic-secret';
    let rejectToken!: (error: Error) => void;
    http.axiosRef.post.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectToken = reject; }));
    const first = (service as any).accessToken(appId), second = (service as any).accessToken(appId);
    expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    const settled = Promise.allSettled([first, second]); rejectToken(new Error('synthetic auth failure'));
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    http.axiosRef.post.mockResolvedValueOnce({ data: { code: 0, tenant_access_token: 'synthetic-retry-token', expire: 7200 } });
    await expect((service as any).accessToken(appId)).resolves.toBe('synthetic-retry-token');
    expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
  });
  it('does not retain a late token after shutdown', async () => {
    process.env.FEISHU_APP_SECRET = 'synthetic-secret';
    let resolveToken!: (response: unknown) => void;
    http.axiosRef.post.mockImplementationOnce(() => new Promise(resolve => { resolveToken = resolve; }));
    const pending = (service as any).accessToken(appId);
    await service.onModuleDestroy();
    resolveToken({ data: { code: 0, tenant_access_token: 'synthetic-late-token', expire: 7200 } });
    await pending;
    expect((service as any).token).toBeUndefined();
    expect((service as any).tokenRequest).toBeUndefined();
  });
});

describe('explicit additional copy identities',()=>{
  it('parses and deduplicates a bounded recipient list',()=>{
    expect(additionalReadonlyCardTargets(undefined)).toEqual([]);
    expect(additionalReadonlyCardTargets('[{"name":" 合成人员 ","openId":"ou_one"},{"name":"合成人员","openId":"ou_one"}]')).toEqual([{name:'合成人员',openId:'ou_one'}]);
  });
  it.each(['null','{}','[{}]','[{"name":"a","openId":"oc_group"}]','[{"name":"a","openId":"ou_one","path":"anything"}]','[{"name":"a","openId":"ou_one"},{"name":"b","openId":"ou_one"}]'])('rejects malformed or ambiguous identities: %s',raw=>{
    expect(()=>additionalReadonlyCardTargets(raw)).toThrow();
  });
});
