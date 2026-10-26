import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThresholdStore } from '../../server/modules/threshold-management/threshold.store';
import { ThresholdAdjustmentStore } from '../../server/modules/threshold-management/threshold-adjustment.store';
import { ThresholdAdjustmentService as ActualThresholdAdjustmentService } from '../../server/modules/threshold-management/threshold-adjustment.service';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
const ThresholdAdjustmentService = withSyntheticBusinessIdentity(ActualThresholdAdjustmentService, 4);
type ThresholdAdjustmentService = ActualThresholdAdjustmentService;
import {
  parseThresholdAdjustmentAction,
  thresholdAdjustmentCard,
} from '../../server/modules/threshold-management/threshold-adjustment.card';
import { thresholdContentFingerprint } from '../../shared/threshold-bitable';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import * as config from '../../server/common/config/external-services.config';
import type { ThresholdAdjustmentContext } from '../../shared/threshold-adjustment.interface';
import type { ThresholdRecord } from '../../shared/threshold-management.interface';

const record: ThresholdRecord = {
  id: 'threshold-qa-original',
  profession: '电气',
  building: 'A楼',
  device: 'UPS',
  section: '输出',
  parameter: '电压',
  location: 'A-120',
  value: '220',
  unit: 'V',
  kind: '设定',
  enabled: '',
  note: '',
  version: 1,
  updatedAt: '',
  source: { sheet: 'UPS', cell: 'C3', originalValue: '220' },
};
const roles = [
  {
    openId: 'ou_qa_engineer',
    name: '验收工程师',
    position: '电气工程师',
    professions: ['电气'],
    buildings: ['A楼'],
  },
  {
    openId: 'ou_qa_building',
    name: '验收楼长',
    position: '设施运维示例人员001',
    professions: [],
    buildings: ['A楼'],
  },
  {
    openId: 'ou_qa_professional',
    name: '验收示例人员001',
    position: '电气示例人员001',
    professions: ['电气'],
    buildings: ['电气'],
  },
  {
    openId: 'ou_qa_manager',
    name: '验收经理',
    position: '设施运维经理',
    professions: [],
    buildings: ['H楼'],
  },
];
const context: ThresholdAdjustmentContext = {
  roles,
  engineers: [{ ...roles[0], profession: '电气' }],
};
const principal = (openId: string, role: 'admin' | 'editor' = 'editor') => ({
  role,
  purchaseBuilding: null,
  accountId: `feishu-${feishuIdentityFingerprint('qa-app', openId)}`,
});
function action(
  id: string,
  role: string,
  actor: string,
  messageId: string,
  kind: string,
  reason?: string,
) {
  return {
    event_type: 'card.action.trigger',
    operator: { open_id: actor },
    context: { open_message_id: messageId },
    action:
      reason === undefined
        ? {
            tag: 'button',
            value: {
              workflowType: 'threshold_adjustment',
              requestId: id,
              role,
              action: kind,
            },
          }
        : {
            tag: 'button',
            name: `threshold_reject_submit:${id}:${role}`,
            form_value: { threshold_rejection_reason: reason },
          },
  };
}
describe('阈值双审批、计划日期与工程师确认', () => {
  let dir: string, service: ThresholdAdjustmentService, store: ThresholdStore;
  let gateway: {
    peekContext: jest.Mock;
    readContext: jest.Mock;
    recover: jest.Mock;
    sync: jest.Mock;
  };
  let messages: {
    sendInteractiveCard: jest.Mock;
    patchInteractiveCard: jest.Mock;
  };
  let oldPath: string | undefined, sequence: number;
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T03:00:00Z'));
    jest
      .spyOn(config, 'getFeishuAuthPayload')
      .mockReturnValue({ app_id: 'qa-app', app_secret: 'qa-synthetic-only' });
    dir = mkdtempSync(join(tmpdir(), 'nt-threshold-approval-'));
    oldPath = process.env.THRESHOLD_APPROVAL_LEDGER_PATH;
    process.env.THRESHOLD_APPROVAL_LEDGER_PATH = join(dir, 'approvals.json');
    store = new ThresholdStore(join(dir, 'records.json'), [record], [], true);
    sequence = 0;
    gateway = {
      peekContext: jest.fn(() => structuredClone(context)),
      readContext: jest.fn(async () => structuredClone(context)),
      recover: jest.fn(async () => []),
      sync: jest.fn(async () => 'rec_qa_approval'),
    };
    messages = {
      sendInteractiveCard: jest.fn(async () => `om_qa_${++sequence}`),
      patchInteractiveCard: jest.fn(async () => {}),
    };
    const sync = {
      kick: jest.fn(() => {
        for (const job of store.pendingSync())
          store.finishSync(job.result.clientMutationId, { state: 'success' });
      }),
    };
    service = new ThresholdAdjustmentService(
      store,
      sync as never,
      gateway as never,
      messages as never,
    );
    jest.spyOn(service, 'kick').mockImplementation(() => {});
    await service.runPending();
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (oldPath === undefined)
      delete process.env.THRESHOLD_APPROVAL_LEDGER_PATH;
    else process.env.THRESHOLD_APPROVAL_LEDGER_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const request = () => ({
    clientMutationId: 'threshold-qa-request-0001',
    thresholdId: record.id,
    expectedVersion: 1,
    expectedContent: thresholdContentFingerprint(record),
    value: '230',
    reason: '代表性阈值调整验收',
    plannedAt: '2026-10-09T04:00:00Z',
    engineerOpenId: 'ou_qa_engineer',
  });
  async function submit() {
    const a = service.submit(request(), principal('ou_qa_engineer'));
    await service.runPending();
    return a.id;
  }
  async function approve(id: string, role: 'building' | 'professional') {
    const entry = service.ledger.get(id)!;
    const stage = entry.adjustment.stages.find((s) => s.role === role)!;
    const message = entry.messages.find(
      (m) => m.openId === stage.approver.openId,
    )!;
    return service.handleCardAction(
      action(id, role, stage.approver.openId, message.messageId, 'approve'),
    );
  }
  test('重复申请幂等，原值不改变；重复键内容不同拒绝', async () => {
    const a = service.submit(request(), principal('ou_qa_engineer'));
    expect(service.submit(request(), principal('ou_qa_engineer')).id).toBe(
      a.id,
    );
    expect(() =>
      service.submit(
        { ...request(), value: '240' },
        principal('ou_qa_engineer'),
      ),
    ).toThrow('内容');
    expect(store.list().records[0].value).toBe('220');
    expect(service.ledger.list()).toHaveLength(1);
  });
  test('管理员可以代对应工程师提交，非管理员不可代提交', () => {
    expect(
      service.submit(request(), principal('ou_qa_manager', 'admin')).engineer
        .openId,
    ).toBe('ou_qa_engineer');
    expect(() =>
      service.submit(
        { ...request(), clientMutationId: 'threshold-qa-request-0002' },
        principal('ou_qa_manager'),
      ),
    ).toThrow('代提交');
  });
  test('本地共享账号、跨楼栋工程师及旧值都不能提交', () => {
    expect(() =>
      service.submit(request(), {
        role: 'admin',
        purchaseBuilding: null,
        accountId: 'local-admin',
      }),
    ).toThrow('飞书');
    expect(() =>
      service.submit(
        { ...request(), expectedVersion: 2 },
        principal('ou_qa_engineer'),
      ),
    ).toThrow('已变化');
    gateway.peekContext.mockReturnValue({
      ...context,
      engineers: [{ ...context.engineers[0], buildings: ['B楼'] }],
    });
    expect(() =>
      service.submit(request(), principal('ou_qa_engineer')),
    ).toThrow('工程师');
  });
  test('一个角色通过不足以生效，双方并发通过也仅记录一次', async () => {
    const id = await submit();
    await approve(id, 'building');
    await service.runPending();
    expect(service.ledger.get(id)!.adjustment.state).toBe('pending');
    expect(store.list().records[0].value).toBe('220');
    await Promise.all([
      approve(id, 'professional'),
      approve(id, 'professional'),
    ]);
    await service.runPending();
    const a = service.ledger.get(id)!.adjustment;
    expect(a.state).toBe('awaiting_completion');
    expect(a.stages.filter((s) => s.decision)).toHaveLength(2);
    expect(store.list().records[0].value).toBe('220');
  });
  test('到预计时间才发送确认；已完成后原子更新，重复确认不重复更新', async () => {
    const id = await submit();
    await Promise.all([approve(id, 'building'), approve(id, 'professional')]);
    await service.runPending();
    expect(
      service.ledger.get(id)!.messages.filter((m) => m.kind === 'confirmation'),
    ).toHaveLength(0);
    jest.setSystemTime(new Date('2026-10-09T04:01:00Z'));
    await service.runPending();
    const message = service.ledger
      .get(id)!
      .messages.find((m) => m.kind === 'confirmation')!;
    await service.handleCardAction(
      action(id, 'engineer', 'ou_qa_engineer', message.messageId, 'complete'),
    );
    expect(store.list().records[0].value).toBe('220');
    await service.runPending();
    expect(store.list().records[0].value).toBe('230');
    expect(store.list().records[0].version).toBe(2);
    await service.handleCardAction(
      action(id, 'engineer', 'ou_qa_engineer', message.messageId, 'complete'),
    );
    await service.runPending();
    expect(store.list().records[0].version).toBe(2);
    expect(service.ledger.get(id)!.adjustment.state).toBe('completed');
    const manager = service.ledger
      .get(id)!
      .messages.filter((m) => m.openId === 'ou_qa_manager');
    expect(manager).toHaveLength(1);
  });
  test('尚未完成不更新，旧确认卡不能反悔覆盖；次日提醒有独立幂等键', async () => {
    const id = await submit();
    await approve(id, 'building');
    await approve(id, 'professional');
    jest.setSystemTime(new Date('2026-10-09T04:01:00Z'));
    await service.runPending();
    let message = service.ledger
      .get(id)!
      .messages.find((m) => m.kind === 'confirmation')!;
    await service.handleCardAction(
      action(
        id,
        'engineer',
        'ou_qa_engineer',
        message.messageId,
        'not_completed',
      ),
    );
    await service.runPending();
    expect(
      (
        await service.handleCardAction(
          action(
            id,
            'engineer',
            'ou_qa_engineer',
            message.messageId,
            'complete',
          ),
        )
      ).claimed,
    ).toBe(false);
    expect(store.list().records[0].value).toBe('220');
    jest.setSystemTime(new Date('2026-10-10T04:02:00Z'));
    await service.runPending();
    const reminders = service.ledger
      .get(id)!
      .messages.filter((m) => m.kind === 'confirmation');
    expect(reminders).toHaveLength(2);
    expect(new Set(reminders.map((m) => m.uuid)).size).toBe(2);
  });
  test('驳回必填原因，任一人驳回后所有审批卡终态，经理不收到驳回知会', async () => {
    const id = await submit();
    const e = service.ledger.get(id)!,
      m = e.messages.find((m) => m.openId === 'ou_qa_building')!;
    await expect(
      service.handleCardAction(
        action(id, 'building', 'ou_qa_building', m.messageId, 'reject'),
      ),
    ).rejects.toThrow('原因');
    await service.handleCardAction(
      action(
        id,
        'building',
        'ou_qa_building',
        m.messageId,
        'reject',
        '参数依据不足',
      ),
    );
    await service.runPending();
    expect(service.ledger.get(id)!.adjustment.state).toBe('rejected');
    expect(service.ledger.get(id)!.adjustment.stages[0].decision!.reason).toBe(
      '参数依据不足',
    );
    expect(
      service.ledger
        .get(id)!
        .messages.some((m) => m.openId === 'ou_qa_manager'),
    ).toBe(false);
    expect(store.list().records[0].value).toBe('220');
    const card = thresholdAdjustmentCard(
      service.ledger.get(id)!.adjustment,
      'ou_qa_building',
    );
    expect(JSON.stringify(card)).not.toContain('"callback"');
  });
  test('伪造审批人员、消息及工程师动作均拒绝', async () => {
    const id = await submit();
    const m = service.ledger.get(id)!.messages[0];
    await expect(
      service.handleCardAction(
        action(id, 'building', 'ou_qa_intruder', m.messageId, 'approve'),
      ),
    ).rejects.toThrow('不匹配');
    await expect(
      service.handleCardAction(
        action(id, 'building', 'ou_qa_building', 'om_wrong', 'approve'),
      ),
    ).rejects.toThrow('不匹配');
    await expect(
      service.handleCardAction(
        action(id, 'engineer', 'ou_qa_engineer', m.messageId, 'complete'),
      ),
    ).rejects.toThrow('权限');
  });
  test('驳回页面仅PATCH切换，不把表单作为同步raw响应', async () => {
    const id = await submit(),
      m = service.ledger
        .get(id)!
        .messages.find((m) => m.openId === 'ou_qa_building')!;
    const result = await service.handleCardAction(
      action(id, 'building', 'ou_qa_building', m.messageId, 'open_reject'),
    );
    expect(result.card).toBeUndefined();
    expect(messages.patchInteractiveCard).toHaveBeenCalledWith(
      m.messageId,
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(
      service.ledger.get(id)!.adjustment.stages.every((s) => !s.decision),
    ).toBe(true);
  });
  test('审批期间原值变化，完成确认不会覆盖他人的新阈值', async () => {
    const id = await submit();
    await approve(id, 'building');
    await approve(id, 'professional');
    jest.setSystemTime(new Date('2026-10-09T04:01:00Z'));
    await service.runPending();
    store.adoptCloud(
      [{ ...record, value: '225', version: 2 }],
      store.list().revision,
    );
    const m = service.ledger
      .get(id)!
      .messages.find((m) => m.kind === 'confirmation')!;
    await service.handleCardAction(
      action(id, 'engineer', 'ou_qa_engineer', m.messageId, 'complete'),
    );
    await service.runPending();
    expect(store.list().records[0].value).toBe('225');
    expect(service.ledger.get(id)!.adjustment.state).toBe('conflict');
  });
  test('部分发送失败后保留已有回执，重试不重复发已成功的卡', async () => {
    messages.sendInteractiveCard
      .mockImplementationOnce(async () => 'om_sent_once')
      .mockRejectedValueOnce(new Error('模拟网络故障'));
    const id = service.submit(request(), principal('ou_qa_engineer')).id;
    await service.runPending();
    expect(service.ledger.get(id)!.messages).toHaveLength(1);
    expect(service.ledger.get(id)!.adjustment.error).toContain('模拟网络');
    service.retry(id, principal('ou_qa_engineer'));
    await service.runPending();
    expect(
      messages.sendInteractiveCard.mock.calls.filter(
        (c) => c[0] === 'ou_qa_building',
      ),
    ).toHaveLength(1);
  });
  test('重启读取台账保留原决议和投递回执；损坏台账停止运行', async () => {
    const id = await submit();
    await approve(id, 'building');
    const restored = new ThresholdAdjustmentStore(join(dir, 'approvals.json'));
    expect(restored.get(id)!.adjustment.stages[0].decision?.action).toBe(
      'approve',
    );
    expect(restored.get(id)!.messages).toHaveLength(2);
    writeFileSync(join(dir, 'approvals.json'), '{broken');
    expect(() => restored.list()).toThrow('台账无效');
  });
  test('合法审批动作恢复已耗尽的同步重试，不会清除错误后永久卡住', async () => {
    const id = await submit();
    service.ledger.change(id, (e) => {
      e.attempts = 6;
      e.adjustment.syncState = 'error';
      e.adjustment.error = '模拟重试耗尽';
    });
    await approve(id, 'building');
    expect(service.ledger.get(id)!.attempts).toBe(0);
    await service.runPending();
    expect(service.ledger.get(id)!.adjustment.syncState).toBe('success');
  });
  test('完成确认已落账但参数任务尚未创建时，手动重试能恢复执行', async () => {
    const id = await submit();
    await approve(id, 'building');
    await approve(id, 'professional');
    jest.setSystemTime(new Date('2026-10-09T04:01:00Z'));
    await service.runPending();
    const receipt = service.ledger
      .get(id)!
      .messages.find((m) => m.kind === 'confirmation')!;
    await service.handleCardAction(
      action(id, 'engineer', 'ou_qa_engineer', receipt.messageId, 'complete'),
    );
    service.ledger.change(id, (e) => {
      e.adjustment.state = 'applying';
      e.adjustment.syncState = 'error';
      e.adjustment.error = '模拟创建任务前中断';
    });
    expect(() => service.retry(id, principal('ou_qa_engineer'))).not.toThrow();
    await service.runPending();
    expect(store.list().records[0].value).toBe('230');
    expect(service.ledger.get(id)!.adjustment.state).toBe('completed');
  });
  test('卡片拒绝跨角色动作，斜杠与多行原值原样保留', () => {
    expect(() =>
      parseThresholdAdjustmentAction(
        action(
          'ta-00000000-0000-4000-8000-000000000001',
          'engineer',
          'ou_qa_engineer',
          'om_qa',
          'approve',
        ),
      ),
    ).toThrow('不匹配');
    const a = service.submit(
      { ...request(), value: '/' },
      principal('ou_qa_engineer'),
    );
    expect(a.value).toBe('/');
    expect(
      JSON.stringify(
        thresholdAdjustmentCard(
          { ...a, before: { ...record, value: '单路180S\n双路600S' } },
          'ou_qa_building',
        ),
      ),
    ).toContain('单路180S');
  });
});
