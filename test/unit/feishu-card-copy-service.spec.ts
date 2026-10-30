import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuCardCopyService } from '../../server/common/feishu-card-copy/card-copy.service';
import { FeishuCardCopyModule } from '../../server/common/feishu-card-copy/card-copy.module';
import { FeishuCardMirrorStore } from '../../server/common/feishu-card-copy/mirror.store';
import { observedCardPost } from '../../server/common/feishu-card-copy/transport';
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
    account = { id: 'synthetic-account', version: 1, kind: 'feishu', appId, name, identityHash: createHash('sha256').update(`${appId}\0${recipient}`).digest('hex'), enabled: true, personnelActive: true };
    configuration = { snapshot: jest.fn(() => ({ accounts: [account] })), currentPrincipal: jest.fn(() => ({ accountId: account.id })) };
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
});
