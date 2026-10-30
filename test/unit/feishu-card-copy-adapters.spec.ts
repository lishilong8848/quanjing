// No application/module bootstrap. Every gateway uses a fake HTTP instance and
// observer; unexpected native outbound requests fail before leaving this process.
jest.mock('node:http', () => ({ ...jest.requireActual('node:http'), request: () => { throw new Error('Unexpected native outbound HTTP'); }, get: () => { throw new Error('Unexpected native outbound HTTP'); } }));
jest.mock('node:https', () => ({ ...jest.requireActual('node:https'), request: () => { throw new Error('Unexpected native outbound HTTPS'); }, get: () => { throw new Error('Unexpected native outbound HTTPS'); } }));
jest.mock('../../server/common/feishu-card-copy/transport', () => ({
  observedCardPost: jest.fn((http, _source, url, body, config) => http.post(url, body, config)),
  observedCardPatch: jest.fn((http, _source, url, body, config) => http.patch(url, body, config)),
  observedCardTokenUpdate: jest.fn((http, _source, url, body, config) => http.post(url, body, config)),
  observeCardCallbackResult: jest.fn(async () => undefined),
  isReadonlyCopyCallback: jest.fn(() => false),
}));
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  getTenantAccessToken: jest.fn(async () => 'synthetic-token'),
}));
import { observedCardPost, observedCardPatch, observedCardTokenUpdate, observeCardCallbackResult, isReadonlyCopyCallback } from '../../server/common/feishu-card-copy/transport';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { InventoryOutboundApprovalGateway } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.gateway';
import { InventoryWorkflowGateway } from '../../server/modules/inventory-management/inventory-workflow.gateway';
import { LeaveWorkflowGateway } from '../../server/modules/leave-workflow/leave-workflow.gateway';
import { OvertimeWorkflowGateway } from '../../server/modules/overtime-workflow/overtime-workflow.gateway';
import { ContractWorkflowGateway } from '../../server/modules/contract-management/contract-workflow.gateway';
import { TodayOperationsAnomalyGateway } from '../../server/modules/bitable-sync/today-operations-anomaly.gateway';
import { DailyOperationsPatrolGateway } from '../../server/modules/duty-schedule/daily-operations-patrol.gateway';
import { AttendanceAutomationFeishuGateway } from '../../server/modules/duty-schedule/attendance-automation-feishu.gateway';
import { DutyScreenshotService } from '../../server/modules/duty-schedule/duty-screenshot.service';
import { WeatherWarningNotificationService } from '../../server/modules/weather-warning/weather-warning-notification.service';
import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { PurchaseWorkflowCallbackController } from '../../server/modules/purchase-inventory/purchase-workflow-callback.controller';
import { currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const recipient = 'ou_synthetic', messageId = 'om_synthetic_card';
const uuid = '00000000-0000-4000-8000-000000000001';
const card = { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: '合成卡片' } }, body: { elements: [] } };
function stub<T>(type: { prototype: T }) {
  const http = { post: jest.fn(async () => ({ status: 200, data: { code: 0, data: { message_id: messageId } } })), patch: jest.fn(async () => ({ status: 200, data: { code: 0 } })) };
  const instance: any = Object.create(type.prototype);
  instance.httpService = { axiosRef: http };
  instance.getTenantAccessToken = jest.fn(async () => 'synthetic-token');
  instance.recipientOpenId = () => recipient; instance.chatId = () => 'oc_synthetic';
  return { instance, http };
}
const sendCases = [
  ['purchase', PurchaseWorkflowGateway, (x: any) => x.sendInteractiveCard(recipient, card, uuid)],
  ['inventory-outbound', InventoryOutboundApprovalGateway, (x: any) => x.sendInteractiveCard(recipient, card, uuid)],
  ['inventory', InventoryWorkflowGateway, (x: any) => x.sendInteractiveCard(recipient, card)],
  ['leave', LeaveWorkflowGateway, (x: any) => x.sendInteractiveCard(recipient, card, 'synthetic-business')],
  ['overtime', OvertimeWorkflowGateway, (x: any) => x.sendInteractiveCard(recipient, card, 'synthetic-business')],
  ['contract', ContractWorkflowGateway, (x: any) => x.sendInteractiveCard(recipient, card, uuid)],
  ['today-operations', TodayOperationsAnomalyGateway, (x: any) => x.sendInteractiveCard(card, 'synthetic-anomaly')],
  ['daily-patrol', DailyOperationsPatrolGateway, (x: any) => x.sendCard(card, '2026-10-30', 'synthetic-delivery')],
  ['attendance', AttendanceAutomationFeishuGateway, (x: any) => x.sendCard(recipient, card, 'synthetic-delivery')],
  ['duty-screenshot', DutyScreenshotService, (x: any) => x.sendCardMessage('synthetic-token', recipient, card, 'open_id', uuid)],
  ['weather', WeatherWarningNotificationService, (x: any) => x.sendInteractiveCard('synthetic-token', recipient, card, uuid)],
  ['ali-monthly-report', AliMonthlyReportService, (x: any) => x.sendFeishuMessage('synthetic-token', recipient, 'interactive', JSON.stringify(card), uuid, 'open_id')],
] as const;

describe('explicit card transport adapters', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each(sendCases)('%s preserves original card receiver/content and message result', async (source, type, send) => {
    const { instance, http } = stub(type as any);
    await expect(send(instance)).resolves.toBe(messageId);
    expect(observedCardPost).toHaveBeenCalledTimes(1);
    expect(observedCardPost).toHaveBeenCalledWith(http, source, expect.stringContaining('/im/v1/messages'), expect.objectContaining({ receive_id: source === 'daily-patrol' ? 'oc_synthetic' : recipient, msg_type: 'interactive', content: JSON.stringify(card) }), expect.any(Object));
    const [, , url, body, config] = (observedCardPost as jest.Mock).mock.calls[0];
    expect(http.post).toHaveBeenCalledWith(url, body, config);
    expect(config.headers.Authorization).toBe('Bearer synthetic-token');
    expect(http.post).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['purchase', PurchaseWorkflowGateway, 'updateInteractiveCard'], ['inventory-outbound', InventoryOutboundApprovalGateway, 'patchInteractiveCard'],
    ['leave', LeaveWorkflowGateway, 'patchInteractiveCard'], ['overtime', OvertimeWorkflowGateway, 'patchInteractiveCard'],
    ['today-operations', TodayOperationsAnomalyGateway, 'patchInteractiveCard'], ['daily-patrol', DailyOperationsPatrolGateway, 'updateCard'],
  ] as const)('%s observes message updates without replacing original PATCH contents', async (source, type, method) => {
    const { instance, http } = stub(type as any); await instance[method](messageId, card);
    expect(observedCardPatch).toHaveBeenCalledWith(http, source, expect.stringContaining(messageId), { content: JSON.stringify(card) }, expect.any(Object));
    const [, , url, body, config] = (observedCardPatch as jest.Mock).mock.calls[0]; expect(http.patch).toHaveBeenCalledWith(url, body, config);
    expect(http.patch).toHaveBeenCalledTimes(1); expect(http.post).not.toHaveBeenCalled();
  });
  it('token update supplies the original message to the pre-request observer and preserves the response checks', async () => {
    const { instance, http } = stub(PurchaseWorkflowGateway); await instance.updateInteractiveCardAfterCallback('c-synthetic', card, messageId);
    expect(http.post).toHaveBeenCalledWith('https://open.feishu.cn/open-apis/interactive/v1/card/update', { token: 'c-synthetic', card }, expect.any(Object));
    expect(observedCardTokenUpdate).toHaveBeenCalledWith(http, 'purchase', 'https://open.feishu.cn/open-apis/interactive/v1/card/update', { token: 'c-synthetic', card }, expect.any(Object), messageId); expect(observedCardPost).not.toHaveBeenCalled();
    jest.clearAllMocks(); http.post.mockResolvedValueOnce({ status: 200, data: { code: 1 } } as never);
    await expect(instance.updateInteractiveCardAfterCallback('c-synthetic', card, messageId)).rejects.toThrow();
    expect(observedCardTokenUpdate).toHaveBeenCalledTimes(1);
  });
  it('keeps token updates without an original message compatible, without inventing an association', async () => {
    const { instance, http } = stub(PurchaseWorkflowGateway); await instance.updateInteractiveCardAfterCallback('c-synthetic', card);
    expect(observedCardTokenUpdate).toHaveBeenCalledWith(http, 'purchase', expect.any(String), { token: 'c-synthetic', card }, expect.any(Object), undefined);
  });
  it('does not intercept contract text messages', async () => {
    const { instance, http } = stub(ContractWorkflowGateway); await instance.sendText(recipient, '合成通知', uuid);
    expect(http.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ msg_type: 'text', receive_id: recipient, uuid }), expect.any(Object));
    expect(observedCardPost).not.toHaveBeenCalled();
  });
});

describe('transport registration and explicit source coverage', () => {
  it('reserves each token update before dispatch and keeps its reservation when responses arrive out of order', async () => {
    const transport = jest.requireActual<typeof import('../../server/common/feishu-card-copy/transport')>('../../server/common/feishu-card-copy/transport');
    const events: string[] = [], responses: Array<(value: unknown) => void> = [];
    const updated = jest.fn(async (_id, _card, operation) => { events.push(`capture:${operation.sequence}`); });
    let sequence = 0;
    const unregister = transport.registerCardCopyObserver({
      delivered: jest.fn(async () => undefined),
      reserveUpdate: jest.fn(async () => { const operation = { sequence: ++sequence }; events.push(`reserve:${sequence}`); return operation; }),
      updated, isCopyMessage: () => false, diagnostic: jest.fn(),
    });
    try {
      const http = { post: jest.fn(() => { events.push(`post:${responses.length + 1}`); return new Promise((resolveResponse) => responses.push(resolveResponse)); }) };
      const first = transport.observedCardTokenUpdate(http as never, 'purchase', 'https://open.feishu.cn/open-apis/interactive/v1/card/update', { token: 'c-private-first', card }, {}, messageId);
      await Promise.resolve();
      const second = transport.observedCardTokenUpdate(http as never, 'purchase', 'https://open.feishu.cn/open-apis/interactive/v1/card/update', { token: 'c-private-second', card: { ...card, terminal: true } }, {}, messageId);
      await Promise.resolve();
      expect(events).toEqual(['reserve:1', 'post:1', 'reserve:2', 'post:2']);
      responses[1]({ status: 200, data: { code: 0 } }); await second;
      responses[0]({ status: 200, data: { code: 0 } }); await first;
      expect(events.slice(4)).toEqual(['capture:2', 'capture:1']);
      expect(updated.mock.calls.map(([id, value, operation]) => ({ id, value, operation }))).toEqual([
        { id: messageId, value: { ...card, terminal: true }, operation: { sequence: 2 } },
        { id: messageId, value: card, operation: { sequence: 1 } },
      ]);
      expect(JSON.stringify(updated.mock.calls)).not.toContain('c-private');
    } finally { unregister(); }
  });

  it('every currently declared interactive IM sender in runtime modules uses the explicit adapter', () => {
    const root = resolve(__dirname, '../../server/modules');
    const expected = [
      'purchase-inventory/purchase-workflow.gateway.ts', 'inventory-outbound-approval/inventory-outbound-approval.gateway.ts',
      'inventory-management/inventory-workflow.gateway.ts', 'leave-workflow/leave-workflow.gateway.ts',
      'overtime-workflow/overtime-workflow.gateway.ts', 'contract-management/contract-workflow.gateway.ts',
      'bitable-sync/today-operations-anomaly.gateway.ts', 'duty-schedule/daily-operations-patrol.gateway.ts',
      'duty-schedule/attendance-automation-feishu.gateway.ts', 'duty-schedule/duty-screenshot.service.ts',
      'weather-warning/weather-warning-notification.service.ts', 'ali-monthly-report/ali-monthly-report.service.ts',
    ].sort();
    const detected: string[] = [];
    function visit(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const source = readFileSync(full, 'utf8');
          if (source.includes('/im/v1/messages') && /['"]interactive['"]/.test(source)) {
            detected.push(relative(root, full).replace(/\\/g, '/'));
            expect(source).toMatch(/observedCardPost\(this\.httpService\.axiosRef,/);
          }
        }
      }
    }
    visit(root); expect(detected.sort()).toEqual(expected);
  });
});

describe('readonly-copy callback boundaries', () => {
  beforeEach(() => { jest.clearAllMocks(); (isReadonlyCopyCallback as jest.Mock).mockReturnValue(false); });
  afterEach(() => jest.restoreAllMocks());
  it('websocket router rejects a copied message before classification or workflow execution', async () => {
    jest.spyOn(currentHotfixActivation(), 'isAcceptingNewWork').mockReturnValue(true);
    const router: any = new FeishuCardActionRouter({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const dispatch = jest.spyOn(router, 'dispatch'); (isReadonlyCopyCallback as jest.Mock).mockReturnValue(true);
    expect(await router.handle({ copy: true })).toMatchObject({ toast: { type: 'error', content: expect.stringContaining('只读') } });
    expect(dispatch).not.toHaveBeenCalled(); expect(observeCardCallbackResult).not.toHaveBeenCalled();
  });
  it('HTTP callback rejects explicit copied payload before any workflow method', () => {
    const workflow = { acceptApprovalCardAction: jest.fn() };
    const controller: any = new PurchaseWorkflowCallbackController({} as never, undefined, undefined, undefined, workflow as never);
    (isReadonlyCopyCallback as jest.Mock).mockReturnValue(true);
    expect(() => controller.handlePurchaseCardCallback({ rawBody: Buffer.from('{"copy":true}') })).toThrow('只读');
    expect(workflow.acceptApprovalCardAction).not.toHaveBeenCalled(); expect(observeCardCallbackResult).not.toHaveBeenCalled();
  });
  it('HTTP post-auth execution observes original legal results but never a rejected operation', async () => {
    const controller: any = new PurchaseWorkflowCallbackController({} as never);
    const identity = { kind: 'manager_action', eventId: 'synthetic-event', messageId }, result = { toast: { type: 'info', content: 'accepted' }, card: { type: 'raw', data: card } };
    await expect(controller.execute(identity, async () => result)).resolves.toBe(result);
    expect(observeCardCallbackResult).toHaveBeenCalledWith('purchase', identity, result);
    jest.clearAllMocks(); const denied = new Error('synthetic unauthorized');
    await expect(controller.execute({ ...identity, eventId: 'second-event' }, async () => { throw denied; })).rejects.toBe(denied);
    expect(observeCardCallbackResult).not.toHaveBeenCalled();
  });
});
