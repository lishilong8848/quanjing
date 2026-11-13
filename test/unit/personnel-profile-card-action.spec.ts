import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as Lark from '@larksuiteoapi/node-sdk';
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  runHotfixInitialization: jest.fn(async (_owner: any, start: () => void) =>
    start(),
  ),
  cancelHotfixInitialization: jest.fn(async () => {}),
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
}));
import {
  PersonnelProfileCardActionService,
  parseProfileReviewCard,
} from '../../server/common/access/personnel-profile-card-action.service';
import { PersonnelProfileCardActionStore } from '../../server/common/access/personnel-profile-card-action.store';
import { PersonnelProfileNotificationStore } from '../../server/common/access/personnel-profile-notification.store';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const requestId = '11111111-1111-1111-1111-111111111111';
const payload = (decision = 'approve') => ({
  event_type: 'card.action.trigger',
  operator: { open_id: 'ou_admin' },
  context: { open_message_id: 'om_original' },
  action: {
    tag: 'button',
    ...(decision === 'reject'
      ? {
          name: 'profile_change_reject',
          form_value: { rejection_reason: '合成驳回原因' },
        }
      : {}),
    value: {
      workflowType: 'profile_change',
      action: 'profile_change_review',
      requestId,
      expectedVersion: 1,
      decision,
    },
  },
});
describe('durable direct profile card review', () => {
  let root: string,
    handler: PersonnelProfileCardActionService,
    store: PersonnelProfileCardActionStore,
    deliveries: PersonnelProfileNotificationStore,
    config: any,
    changes: any,
    notifications: any,
    feedback: any,
    state: any,
    account: any,
    committed: boolean;
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.NANTONG_HOTFIX_SMOKE_MODE = 'false';
    process.env.FEISHU_APP_ID = 'cli_synthetic';
    root = mkdtempSync(join(realpathSync(tmpdir()), 'profile-card-action-'));
    store = new PersonnelProfileCardActionStore(join(root, 'actions.json'));
    deliveries = new PersonnelProfileNotificationStore(
      join(root, 'notifications.json'),
    );
    account = {
      id: 'feishu-admin',
      kind: 'feishu',
      appId: 'cli_synthetic',
      identityHash: hash('cli_synthetic\0ou_admin'),
      role: 'admin',
      enabled: true,
      version: 1,
    };
    config = {
      snapshot: () => ({ accounts: [account] }),
      currentPrincipal: jest.fn(() => ({
        accountId: account.id,
        role: account.role,
        authorizationVersion: account.version,
      })),
      canUseFeishuBusinessIdentity: jest.fn(() => true),
    };
    state = { status: 'pending', version: 1 };
    committed = false;
    changes = {
      assertCardReview: jest.fn(() => state),
      hasCardReviewReceipt: jest.fn(() => committed),
      review: jest.fn(async () => {
        committed = true;
        state = { status: 'approved', version: 2 };
        return state;
      }),
    };
    notifications = { wake: jest.fn() };
    feedback = { enqueueLateFailure: jest.fn(async () => {}) };
    handler = new PersonnelProfileCardActionService(
      config,
      changes,
      {} as any,
      notifications,
      feedback,
    );
    Object.assign(handler as any, {
      store,
      deliveryStore: deliveries,
      active: true,
    });
    deliveries.update((s) => {
      s.jobs[requestId] = {
        requestId,
        appId: 'cli_synthetic',
        createdAt: Date.now(),
        recipientAccountIds: [account.id],
        recipientsResolved: true,
        deliveries: [
          {
            accountId: account.id,
            openId: 'ou_admin',
            uuid: 'a'.repeat(40),
            messageId: 'om_original',
            status: 'sent',
            attempts: 1,
            nextAttemptAt: 0,
            syncedVersion: 1,
            approveAvailable: true,
          } as any,
        ],
      };
    });
  });
  afterEach(async () => {
    await handler.onModuleDestroy();
    for (const k of [
      'NODE_ENV',
      'NANTONG_HOTFIX_SMOKE_MODE',
      'FEISHU_APP_ID',
    ]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (resolve(dirname(root)) !== resolve(realpathSync(tmpdir())))
      throw new Error('outside temp');
    rmSync(root, { recursive: true });
    jest.clearAllMocks();
  });
  it('quickly persists acceptance without waiting for business review', async () => {
    let release!: (v: any) => void;
    changes.review.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const response = handler.handle(payload());
    expect(response.toast.content).toContain('已受理');
    expect(response.toast.content).not.toContain('已更新');
    expect(Object.keys(store.read().tasks)).toHaveLength(1);
    const work = handler.flush();
    while (!release) await new Promise((r) => setImmediate(r));
    expect(Object.values(store.read().tasks)[0].status).toBe('running');
    release({ status: 'approved' });
    await work;
    expect(Object.values(store.read().tasks)[0].status).toBe('completed');
  });
  it('deduplicates repeated clicks and excludes a competing opposite decision', async () => {
    handler.handle(payload());
    handler.handle({ ...payload(), event_id: 'retry' });
    expect(() => handler.handle(payload('reject'))).toThrow('已有审核操作');
    await handler.flush();
    expect(changes.review).toHaveBeenCalledTimes(1);
    expect(changes.review.mock.calls[0][1].clientMutationId).toBe(
      Object.keys(store.read().tasks)[0],
    );
  });
  it('rejects missing or mirrored message IDs even for administrators', () => {
    expect(() => handler.handle({ ...payload(), context: {} })).toThrow(
      '原卡片',
    );
    expect(() =>
      handler.handle({ ...payload(), context: { open_message_id: 'om_copy' } }),
    ).toThrow('只读副本');
    expect(changes.review).not.toHaveBeenCalled();
  });
  it('does not let an operator forge another administrator identity in value', () => {
    const p = payload();
    (p.action.value as any).operator = 'ou_admin';
    expect(() => handler.handle(p)).toThrow('按钮已失效');
    account.role = 'guest';
    expect(() => handler.handle(payload())).toThrow('管理员');
  });
  it('rejects self-linked users and stale versions before enqueue', () => {
    changes.assertCardReview.mockImplementation(() => {
      throw new ForbiddenException('不能审核本人或关联账号');
    });
    expect(() => handler.handle(payload())).toThrow('关联账号');
    changes.assertCardReview.mockReturnValue({ status: 'pending', version: 2 });
    expect(() => handler.handle(payload())).toThrow('申请已变化');
  });
  it('requires a complete original preview for approve but still permits reject', () => {
    deliveries.update((s) => {
      (s.jobs[requestId].deliveries[0] as any).approveAvailable = false;
    });
    expect(() => handler.handle(payload())).toThrow('预览尚未完整');
    expect(handler.handle(payload('reject')).toast.content).toContain('已受理');
  });
  it('does not claim source write success when the request has already progressed', () => {
    state = { status: 'writing', version: 4 };
    expect(handler.handle(payload()).toast.content).toContain('已处理');
    expect(changes.review).not.toHaveBeenCalled();
    expect(notifications.wake).toHaveBeenCalled();
  });
  it('bounds transient failures before review to three attempts', async () => {
    handler.handle(payload());
    config.currentPrincipal.mockImplementation(() => {
      throw new ServiceUnavailableException('temporary');
    });
    for (let i = 0; i < 3; i++) {
      store.update((s) => {
        for (const t of Object.values(s.tasks)) t.nextAttemptAt = 0;
      });
      await handler.flush();
    }
    const job = Object.values(store.read().tasks)[0];
    expect(job.attempts).toBe(3);
    expect(job.status).toBe('failed');
    expect(changes.review).not.toHaveBeenCalled();
    expect(feedback.enqueueLateFailure).toHaveBeenCalledTimes(1);
  });
  it('reconciles an already committed original review before checking changed actor permissions', async () => {
    handler.handle(payload());
    committed = true;
    account.version = 2;
    await handler.flush();
    expect(changes.review).not.toHaveBeenCalled();
    expect(Object.values(store.read().tasks)[0].status).toBe('completed');
  });
  it('does not requeue failed old actions over another accepted decision', () => {
    handler.handle(payload());
    store.update((s) => {
      Object.values(s.tasks)[0].status = 'failed';
    });
    handler.handle(payload('reject'));
    expect(() => handler.handle(payload())).toThrow('已有审核操作');
  });
  it('routes the actual SDK flattened event without a new HTTP endpoint', async () => {
    const no = { isEnabled: () => false } as any;
    const router = new FeishuCardActionRouter(
      no,
      no,
      no,
      {} as any,
      no,
      no,
      no,
      undefined,
      config,
      undefined,
      undefined,
      undefined,
      handler,
    );
    const dispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.error,
    }).register({
      'card.action.trigger': (data: any) => router.handle(data),
    } as never);
    const raw = payload();
    const result = await dispatcher.invoke(
      {
        schema: '2.0',
        header: {
          event_id: 'evt_profile_synthetic',
          event_type: 'card.action.trigger',
          app_id: 'cli_synthetic',
        },
        event: {
          operator: raw.operator,
          context: raw.context,
          action: raw.action,
        },
      },
      { needCheck: false },
    );
    expect(result.toast.content).toContain('已受理');
    await handler.flush();
    expect(changes.review).toHaveBeenCalledTimes(1);
  });
  it('replays a durable running job after a process restart using the original mutation', async () => {
    handler.handle(payload('reject'));
    store.update((s) => {
      Object.values(s.tasks)[0].status = 'running';
    });
    const restored = new PersonnelProfileCardActionService(
      config,
      changes,
      {} as any,
      notifications,
      feedback,
    );
    Object.assign(restored as any, {
      store: new PersonnelProfileCardActionStore(store.filePath),
      deliveryStore: deliveries,
      active: true,
    });
    await restored.flush();
    expect(changes.review.mock.calls[0][1].decision).toBe('reject');
    expect(Object.values(store.read().tasks)[0].status).toBe('completed');
    await restored.onModuleDestroy();
  });
  it('reports a deferred source-identity refusal only after durable acceptance without changing global feedback filters', async () => {
    handler.handle(payload());
    changes.review.mockRejectedValue(
      new ForbiddenException('不能审核关联身份'),
    );
    await handler.flush();
    expect(Object.values(store.read().tasks)[0].status).toBe('failed');
    expect(feedback.enqueueLateFailure).toHaveBeenCalledTimes(1);
    const error = feedback.enqueueLateFailure.mock.calls[0][2];
    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe('资料审核未完成，请在平台核对或联系管理员');
    expect(Object.values(store.read().tasks)[0].error).toBe('不能审核关联身份');
  });
  it('does not send a deferred error notification for an unaccepted forged card', () => {
    expect(() =>
      handler.handle({
        ...payload(),
        context: { open_message_id: 'om_mirror' },
      }),
    ).toThrow();
    expect(feedback.enqueueLateFailure).not.toHaveBeenCalled();
    expect(Object.keys(store.read().tasks)).toHaveLength(0);
  });
  it('returns a legacy processing card with no actions only after durable acceptance', () => {
    const response = handler.handle(payload());
    expect(Object.keys(store.read().tasks)).toHaveLength(1);
    expect(response.card?.type).toBe('raw');
    const card = response.card!.data as any;
    expect(card.schema).toBeUndefined();
    expect(card.body).toBeUndefined();
    expect(card.elements[0]).toMatchObject({
      tag: 'div',
      text: { tag: 'plain_text' },
    });
    expect(JSON.stringify(card)).not.toContain('profile_change_review');
    expect(JSON.stringify(card)).not.toContain('138');
    expect(JSON.stringify(card)).toContain('正在核对');
    expect(handler.handle(payload()).card).toEqual(response.card);
  });
  it('shows the actual terminal status and never calls approval complete for writing', () => {
    state = { status: 'writing', version: 2 };
    expect(JSON.stringify(handler.handle(payload()).card)).toContain(
      '资料同步中',
    );
    state = { status: 'rejected', version: 2 };
    expect(JSON.stringify(handler.handle(payload()).card)).toContain('已驳回');
  });
  it('requires a rejection reason and carries it into the exact original review', async () => {
    const bad = payload('reject');
    bad.action.form_value!.rejection_reason = '  ';
    expect(() => handler.handle(bad)).toThrow('驳回原因');
    handler.handle(payload('reject'));
    await handler.flush();
    expect(changes.review.mock.calls[0][1].comment).toBe('合成驳回原因');
  });
  it('invalidates only the original known message for restoring pending controls after a deferred failure', async () => {
    handler.handle(payload());
    changes.review.mockRejectedValue(new ForbiddenException('关联身份'));
    await handler.flush();
    const d = deliveries.read().jobs[requestId].deliveries[0];
    expect(d.messageId).toBe('om_original');
    expect(d.status).toBe('queued');
    expect(d.syncedVersion).toBeUndefined();
    expect(notifications.wake).toHaveBeenCalled();
  });
  it('retries only original-card synchronization if notification persistence failed after a committed review', async () => {
    handler.handle(payload());
    const update = jest.spyOn(deliveries, 'update');
    update.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    await handler.flush();
    const job = Object.values(store.read().tasks)[0];
    expect(job.status).toBe('completed');
    expect(job.cardRefreshPending).toBe(true);
    expect(changes.review).toHaveBeenCalledTimes(1);
    await handler.flush();
    expect(changes.review).toHaveBeenCalledTimes(1);
    expect(
      Object.values(store.read().tasks)[0].cardRefreshPending,
    ).toBeUndefined();
  });
  it('routes a reject form from the actual SDK to profile review instead of purchase', async () => {
    const no = { isEnabled: () => false } as any;
    const router = new FeishuCardActionRouter(
      no,
      no,
      no,
      {} as any,
      no,
      no,
      no,
      undefined,
      config,
      undefined,
      undefined,
      undefined,
      handler,
    );
    const dispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.error,
    }).register({
      'card.action.trigger': (data: any) => router.handle(data),
    } as never);
    const raw = payload('reject');
    const result = await dispatcher.invoke(
      {
        schema: '2.0',
        header: {
          event_id: 'evt_profile_reject_synthetic',
          event_type: 'card.action.trigger',
          app_id: 'cli_synthetic',
        },
        event: {
          operator: raw.operator,
          context: raw.context,
          action: raw.action,
        },
      },
      { needCheck: false },
    );
    expect(result.card.data.schema).toBeUndefined();
    expect(result.card.data.elements[0].tag).toBe('div');
    await handler.flush();
    expect(changes.review.mock.calls[0][1].comment).toBe('合成驳回原因');
  });
});
