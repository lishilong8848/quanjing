import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PersonnelProfileNotificationsService } from '../../server/common/access/personnel-profile-notifications.service';
import { PersonnelProfileNotificationStore } from '../../server/common/access/personnel-profile-notification.store';
import { profileChangeResultCard } from '../../server/common/access/personnel-profile-notification.card';
import { registerCardCopyObserver } from '../../server/common/feishu-card-copy/transport';

const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const APP = 'cli_test0001';
const OPEN_ID = 'ou_applicant0000000000000000000001';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    clientMutationId: 'cmid000001',
    version: 3,
    accountId: 'feishu-applicant',
    applicantName: '张三',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T02:00:00.000Z',
    status: 'completed',
    changes: { phone: '13800000001' },
    before: { phone: '13700000000' },
    reviewerName: '李管理员',
    comment: '核对通过',
    message: '资料已更新',
    identity: 'identity-hash',
    source: {
      appId: APP,
      appToken: 'appTest',
      tableId: 'tblTest',
      recordId: 'recTest',
    },
    fields: { phone: '联系方式' },
    baseline: {},
    ...overrides,
  } as any;
}

describe('profileChangeResultCard', () => {
  it('completed 结果卡展示通过、前后值、意见与审核人，且不含操作按钮', () => {
    const card: any = profileChangeResultCard(makeRow());
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('审批结果');
    const text = JSON.stringify(card);
    expect(text).toContain('已通过，资料已更新');
    expect(text).toContain('13700000000');
    expect(text).toContain('13800000001');
    expect(text).toContain('核对通过');
    expect(text).toContain('李管理员');
    // Informational only: no action element, no button, no callback value.
    expect(card.elements.some((e: any) => e?.tag === 'action')).toBe(false);
    expect(text).not.toContain('profile_change_review');
  });

  it('rejected 结果卡展示未通过并保持红色抬头', () => {
    const card: any = profileChangeResultCard(
      makeRow({ status: 'rejected', message: undefined }),
    );
    expect(card.header.template).toBe('red');
    expect(JSON.stringify(card)).toContain('未通过');
  });
});

describe('applicant result notification delivery', () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'nt-profile-result-'));
    process.env.NODE_ENV = 'production';
    process.env.FEISHU_APP_ID = APP;
    process.env.FEISHU_APP_SECRET = 'secret';
    process.env.ACCESS_CONFIGURATION_FILE = join(
      dir,
      'access-configuration.json',
    );
    delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  function makeService(row: any) {
    const posts: Array<{ url: string; body: any }> = [];
    const post = jest.fn(async (url: string, body: any) => {
      posts.push({ url, body });
      if (url.includes('tenant_access_token'))
        return {
          status: 200,
          data: { code: 0, tenant_access_token: 't-token', expire: 7200 },
        } as any;
      return {
        status: 200,
        data: { code: 0, data: { message_id: 'om_result_' + posts.length } },
      } as any;
    });
    const http: any = { axiosRef: { post } };
    const account = {
      id: row.accountId,
      kind: 'feishu',
      appId: APP,
      role: 'guest',
      version: 1,
      name: row.applicantName,
      enabled: true,
      deleted: false,
      permissionsRevoked: false,
      personnelActive: true,
      openId: OPEN_ID,
      identityHash: digest(`${APP}\0${OPEN_ID}`),
    };
    const configuration: any = { snapshot: () => ({ accounts: [account] }) };
    const directory: any = {
      read: async () => ({ appId: APP, personnelComplete: true, people: [] }),
    };
    const archive: any = {
      read: async () => ({
        appId: APP,
        appToken: row.source.appToken,
        tableId: row.source.tableId,
        records: [
          { record_id: row.source.recordId, fields: { '飞书 open_id': OPEN_ID } },
        ],
      }),
    };
    const requests: any = { read: () => ({ requests: { [row.id]: row } }) };
    const service = new PersonnelProfileNotificationsService(
      http,
      configuration,
      directory,
      archive,
      requests,
    );
    (service as any).stopped = false;
    (service as any).store = new PersonnelProfileNotificationStore(
      join(dir, 'personnel-profile-notifications.json'),
    );
    (service as any).resultStore = new PersonnelProfileNotificationStore(
      join(dir, 'personnel-profile-result-notifications.json'),
    );
    (service as any).resultStore.update((state: any) => {
      state.resultNotificationsStartedAt = Date.parse(row.updatedAt);
    });
    const messagePosts = () =>
      posts.filter((p) => p.url.includes('/im/v1/messages'));
    return { service, account, post, posts, messagePosts };
  }

  it('completed 申请向申请人 open_id 发送一张结果卡并记为 sent', async () => {
    const row = makeRow();
    const { service, messagePosts } = makeService(row);
    await (service as any).drainResults();
    const sent = messagePosts();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.receive_id).toBe(OPEN_ID);
    expect(sent[0].body.msg_type).toBe('interactive');
    expect(JSON.parse(sent[0].body.content).header.template).toBe('green');
    const job = (service as any).resultStore.read().jobs[row.id];
    expect(job.deliveries[0].status).toBe('sent');
    expect(job.deliveries[0].messageId).toMatch(/^om_/);
  });

  it('rejected 申请同样发送结果卡（未通过）', async () => {
    const row = makeRow({ status: 'rejected', message: undefined });
    const { service, messagePosts } = makeService(row);
    await (service as any).drainResults();
    const sent = messagePosts();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body.content).header.template).toBe('red');
  });

  it('重复 flush 幂等：同一申请只发送一次结果卡', async () => {
    const row = makeRow();
    const { service, messagePosts } = makeService(row);
    await (service as any).drainResults();
    await (service as any).drainResults();
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(1);
  });

  it('申请人结果卡不进入抄送服务', async () => {
    const delivered = jest.fn();
    const unregister = registerCardCopyObserver({
      delivered, reserveUpdate: jest.fn(), updated: jest.fn(),
      isCopyMessage: jest.fn(), diagnostic: jest.fn(),
    });
    try {
      const { service, messagePosts } = makeService(makeRow());
      await (service as any).drainResults();
      expect(messagePosts()).toHaveLength(1);
      expect(delivered).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('不补发首次启用前已结束的申请，重启保留截止点', async () => {
    const row = makeRow();
    const { service, messagePosts } = makeService(row);
    const resultFile = join(dir, 'personnel-profile-result-notifications.json');
    (service as any).resultStore.update((state: any) => {
      state.resultNotificationsStartedAt = Date.parse(row.updatedAt) + 1;
    });
    (service as any).resultStore = new PersonnelProfileNotificationStore(resultFile);
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
    expect((service as any).resultStore.read().jobs).toEqual({});
  });

  it('前一百条无法投递时，后面的有效申请仍会登记发送', async () => {
    const row = makeRow({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    const { service, messagePosts } = makeService(row);
    const requests: Record<string, any> = { [row.id]: row };
    for (let index = 0; index < 100; index++) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      requests[id] = makeRow({ id, accountId: 'other-applicant' });
    }
    (service as any).requests.read = () => ({ requests });
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(1);
  });

  it('获取令牌期间账号被禁用时取消投递', async () => {
    const { service, account, post, messagePosts } = makeService(makeRow());
    post.mockImplementationOnce(async () => {
      account.enabled = false;
      return { status: 200, data: { code: 0, tenant_access_token: 't-token', expire: 7200 } };
    });
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
    const [job]: any[] = Object.values((service as any).resultStore.read().jobs);
    expect(job.deliveries[0].status).toBe('cancelled');
  });

  it('申请档案已关联另一个飞书账号时不发送结果', async () => {
    const row = makeRow();
    const { service, messagePosts } = makeService(row);
    (service as any).archive.read = async () => ({
      appId: APP, appToken: row.source.appToken, tableId: row.source.tableId,
      records: [{ record_id: row.source.recordId, fields: { '飞书 open_id': 'ou_other' } }],
    });
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
  });

  it('同一 Open ID 已持有原审批卡时不增发结果卡', async () => {
    const row = makeRow();
    const { service, messagePosts } = makeService(row);
    (service as any).store.update((state: any) => {
      state.jobs[row.id] = {
        requestId: row.id, appId: APP, createdAt: Date.now(),
        recipientAccountIds: [row.accountId], recipientsResolved: true,
        deliveries: [{
          accountId: row.accountId, openId: OPEN_ID, uuid: 'b'.repeat(40),
          attempts: 1, nextAttemptAt: 0, status: 'sent', messageId: 'om_review', syncedVersion: 1,
        }],
      };
    });
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
  });

  it('重试使用相同 UUID 和快照，超过去重时限只记录待核对', async () => {
    const row = makeRow();
    const { service, post, messagePosts } = makeService(row);
    const failures: Array<{ uuid: string; content: string }> = [];
    const failSend = async (_url: string, body: any) => {
      failures.push(body);
      throw new Error('confirmation lost');
    };
    const regularPost = post.getMockImplementation()!;
    post.mockImplementationOnce(regularPost).mockImplementationOnce(failSend);
    await (service as any).drainResults();
    const resultFile = join(dir, 'personnel-profile-result-notifications.json');
    const store = new PersonnelProfileNotificationStore(resultFile);
    (service as any).resultStore = store;
    store.update((state) => { state.jobs[row.id].deliveries[0].nextAttemptAt = 0; });
    row.comment = '之后读取到的内容不得改变首发快照';
    post.mockImplementationOnce(failSend);
    await (service as any).drainResults();
    expect(failures).toHaveLength(2);
    expect(failures[1]).toEqual(failures[0]);
    store.update((state) => {
      const entry = state.jobs[row.id].deliveries[0];
      entry.nextAttemptAt = 0;
      entry.firstAttemptAt = Date.now() - 6 * 60000;
    });
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
    expect(post).toHaveBeenCalledTimes(3);
    expect(store.read().jobs[row.id].deliveries[0].status).toBe('attention');
  });

  it('pending（非终态）申请不发送结果卡', async () => {
    const row = makeRow({ status: 'pending' });
    const { service, messagePosts } = makeService(row);
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
  });

  it('申请人无一致飞书身份时跳过推送，不报错、不影响结果', async () => {
    const row = makeRow();
    const { service, messagePosts } = makeService(row);
    // Break the identity hash so the open_id cannot be verified as the applicant.
    (service as any).configuration.snapshot = () => ({
      accounts: [
        {
          id: row.accountId,
          kind: 'feishu',
          appId: APP,
          role: 'guest',
          version: 1,
          name: row.applicantName,
          enabled: true,
          deleted: false,
          permissionsRevoked: false,
          personnelActive: true,
          openId: OPEN_ID,
          identityHash: digest(`${APP}\0ou_someone_else`),
        },
      ],
    });
    await (service as any).drainResults();
    expect(messagePosts()).toHaveLength(0);
  });

  it('发送未确认时不记为 sent，保留可重试的待核对状态', async () => {
    const row = makeRow();
    const posts: Array<{ url: string; body: any }> = [];
    const post = jest.fn(async (url: string) => {
      posts.push({ url, body: {} });
      if (url.includes('tenant_access_token'))
        return {
          status: 200,
          data: { code: 0, tenant_access_token: 't-token', expire: 7200 },
        } as any;
      return { status: 200, data: { code: 99991663, msg: 'rate limit' } } as any;
    });
    const http: any = { axiosRef: { post } };
    const account = {
      id: row.accountId,
      kind: 'feishu',
      appId: APP,
      role: 'guest',
      version: 1,
      name: row.applicantName,
      enabled: true,
      deleted: false,
      permissionsRevoked: false,
      personnelActive: true,
      openId: OPEN_ID,
      identityHash: digest(`${APP}\0${OPEN_ID}`),
    };
    const service = new PersonnelProfileNotificationsService(
      http,
      { snapshot: () => ({ accounts: [account] }) } as any,
      { read: async () => ({ appId: APP, personnelComplete: true, people: [] }) } as any,
      {
        read: async () => ({
          appId: APP,
          appToken: row.source.appToken,
          tableId: row.source.tableId,
          records: [
            { record_id: row.source.recordId, fields: { '飞书 open_id': OPEN_ID } },
          ],
        }),
      } as any,
      { read: () => ({ requests: { [row.id]: row } }) } as any,
    );
    (service as any).stopped = false;
    (service as any).store = new PersonnelProfileNotificationStore(
      join(dir, 'personnel-profile-notifications.json'),
    );
    (service as any).resultStore = new PersonnelProfileNotificationStore(
      join(dir, 'personnel-profile-result-notifications.json'),
    );
    (service as any).resultStore.update((state: any) => {
      state.resultNotificationsStartedAt = Date.parse(row.updatedAt);
    });
    await (service as any).drainResults();
    const job = (service as any).resultStore.read().jobs[row.id];
    expect(job.deliveries[0].status).not.toBe('sent');
    expect(job.deliveries[0].messageId).toBeUndefined();
    expect(job.deliveries[0].errorCode).toBe('RESULT_CARD_SEND_PENDING');
  });
});
