import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryBatchCardService } from '../../server/modules/inventory-outbound-approval/inventory-batch-card.service';
import { inventoryNotificationBatchId } from '../../server/modules/inventory-outbound-approval/inventory-batch-notification-id';

const batchId = 'a'.repeat(32);
const recipient = 'ou_recipient';
const item = (id: string) => ({
  id, name: `物品${id}`, sku: `A-${id}`, specification: '型号 X',
  quantity: 2, unit: '件', building: 'A楼', location: 'A-1F-01', status: '已入库',
});

describe('inventory batch card', () => {
  let directory: string;
  let path: string;
  let gateway: { sendInteractiveCard: jest.Mock; patchInteractiveCard: jest.Mock };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'inventory-batch-card-'));
    path = join(directory, 'ledger.json');
    gateway = {
      sendInteractiveCard: jest.fn().mockResolvedValue('om_batch_card'),
      patchInteractiveCard: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('recognizes only canonical batch mutation identifiers', () => {
    expect(inventoryNotificationBatchId(`inventory_batch_inbound_${batchId}_1`, 'inbound')).toBe(batchId);
    expect(inventoryNotificationBatchId(`inventory_batch_inbound_${batchId}_1`, 'outbound')).toBeNull();
    expect(inventoryNotificationBatchId('ordinary-id', 'inbound')).toBeNull();
  });

  it('sends one card and patches it as later items finish, including after restart', async () => {
    const first = new InventoryBatchCardService(gateway as never, path);
    expect(await first.upsert('inbound', batchId, recipient, item('rec_1'))).toBe('om_batch_card');
    const restarted = new InventoryBatchCardService(gateway as never, path);
    expect(await restarted.upsert('inbound', batchId, recipient, item('rec_2'))).toBe('om_batch_card');
    await restarted.flushPending();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_batch_card', expect.objectContaining({
      header: expect.objectContaining({ title: { tag: 'plain_text', content: '批量入库完成' } }),
    }));
    const patchedCard = gateway.patchInteractiveCard.mock.calls.at(-1)?.[1];
    const content = patchedCard.body.elements.map((element: { content?: string }) => element.content || '').join('\n').replace(/\\/gu, '');
    expect(content).toContain('物品rec_1');
    expect(content).toContain('物品rec_2');
    const ledger = JSON.parse(await readFile(path, 'utf8')) as Array<{ messageId: string; items: unknown[] }>;
    expect(ledger[0]).toMatchObject({ messageId: 'om_batch_card', items: [item('rec_1'), item('rec_2')] });
  });

  it('retries an uncertain send with the same persisted Feishu UUID', async () => {
    gateway.sendInteractiveCard.mockRejectedValueOnce(new Error('network timeout'));
    const first = new InventoryBatchCardService(gateway as never, path);
    await expect(first.upsert('outbound', batchId, recipient, { ...item('rec_1'), status: '已出库' })).rejects.toThrow('network timeout');
    const restarted = new InventoryBatchCardService(gateway as never, path);
    expect(await restarted.upsert('outbound', batchId, recipient, { ...item('rec_1'), status: '已出库' })).toBe('om_batch_card');
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(gateway.sendInteractiveCard.mock.calls[0][2]).toBe(gateway.sendInteractiveCard.mock.calls[1][2]);
  });

  it('keeps one actionable outbound card while each item reaches its own terminal state', async () => {
    const service = new InventoryBatchCardService(gateway as never, path);
    const first = { ...item('rec_1'), status: '待审批', approvalVersion: 1 };
    const second = { ...item('rec_2'), status: '待审批', approvalVersion: 1 };
    const firstMessage = await service.upsert('outbound', batchId, recipient, first);
    const secondMessage = await service.upsert('outbound', batchId, recipient, second);
    await service.flushPending();
    expect(firstMessage).toBe(secondMessage);
    const pending = await service.render('outbound', batchId, recipient);
    expect(JSON.stringify(pending)).toContain('批量出库待审批');
    expect(JSON.stringify(pending)).toContain('open_reject');
    expect(JSON.stringify(pending)).toContain('rec_1');
    expect(JSON.stringify(pending)).toContain('rec_2');
    await service.upsert('outbound', batchId, recipient, { ...first, status: '已出库' });
    await service.flushPending();
    const updated = await service.render('outbound', batchId, recipient);
    const actions = JSON.stringify(updated);
    expect(actions).toContain('已出库');
    expect(actions).toContain('rec_2');
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
  });

  it('patches items accepted while the first card is still being sent', async () => {
    let finishSend!: (value: string) => void;
    gateway.sendInteractiveCard.mockReturnValueOnce(new Promise<string>((resolve) => { finishSend = resolve; }));
    const service = new InventoryBatchCardService(gateway as never, path);
    const first = service.upsert('inbound', batchId, recipient, item('rec_1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = service.upsert('inbound', batchId, recipient, item('rec_2'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishSend('om_batch_card');
    await Promise.all([first, second]);
    await service.flushPending();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gateway.patchInteractiveCard.mock.calls.at(-1)?.[1]).replace(/\\/gu, '')).toContain('rec_2');
  });

  it('persists callback state and reuses the validated original message without sending a replacement card', async () => {
    let finish!: () => void;
    gateway.patchInteractiveCard.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const service = new InventoryBatchCardService(gateway as never, path);
    const response = await service.stageForCallback('outbound', batchId, recipient,
      { ...item('rec_1'), status: '同步中', approvalVersion: 1 }, 'om_original_approval');
    expect(JSON.stringify(response)).toContain('同步中');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved[0]).toMatchObject({ messageId: 'om_original_approval', items: [{ id: 'rec_1', status: '同步中' }] });
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    const flush = service.flushPending();
    while (!finish) await new Promise<void>(resolve => setImmediate(resolve));
    finish();
    await flush;
    await new Promise<void>(resolve => setImmediate(resolve));
    await service.flushPending();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    const reopened = new InventoryBatchCardService(gateway as never, path);
    await reopened.stageForCallback('outbound', batchId, recipient,
      { ...item('rec_1'), status: '同步中', approvalVersion: 1 }, 'om_original_approval');
    await new Promise<void>(resolve => setImmediate(resolve));
    await reopened.flushPending();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
  });

  it('recovers a callback batch PATCH after failure without sending another approval message', async () => {
    gateway.patchInteractiveCard.mockRejectedValueOnce(new Error('synthetic unknown patch result'));
    const service = new InventoryBatchCardService(gateway as never, path);
    await expect(service.stageForCallback('outbound', batchId, recipient,
      { ...item('rec_1'), status: '同步中', approvalVersion: 1 }, 'om_original_approval')).resolves.toBeDefined();
    await new Promise<void>(resolve => setImmediate(resolve));
    await service.flushPending();
    const pending = JSON.parse(await readFile(path, 'utf8'));
    const reopened = new InventoryBatchCardService(gateway as never, path);
    await reopened.flushPending();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(pending[0].messageId).toBe('om_original_approval');
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(path, 'utf8'))[0]).toMatchObject({ sentRevision: 1, revision: 1, messageId: 'om_original_approval' });
  });

  it('binds a validated original message to an existing blank receipt atomically and never sends another card', async () => {
    const value = { ...item('rec_1'), status: '待审批', approvalVersion: 1 };
    await writeFile(path, JSON.stringify([{ key: `outbound:${batchId}:${recipient}`, kind: 'outbound', batchId,
      recipientOpenId: recipient, deliveryUuid: 'synthetic-stable-uuid', items: [value], revision: 1, sentRevision: 0 }]));
    const service = new InventoryBatchCardService(gateway as never, path);
    await service.stageForCallback('outbound', batchId, recipient, value, 'om_validated_original');
    await new Promise<void>(resolve => setImmediate(resolve));
    await service.flushPending();
    const restarted = new InventoryBatchCardService(gateway as never, path);
    await restarted.stageForCallback('outbound', batchId, recipient, value, 'om_validated_original');
    await new Promise<void>(resolve => setImmediate(resolve));
    await restarted.flushPending();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledWith('om_validated_original', expect.any(Object));
    expect(JSON.parse(await readFile(path, 'utf8'))[0]).toMatchObject({ messageId: 'om_validated_original', deliveryUuid: 'synthetic-stable-uuid' });
  });

  it.each([0, 180_000])('refuses an uncertain send receipt even when its lease is %sms old, including after restart', async age => {
    const value = { ...item('rec_1'), status: '待审批', approvalVersion: 1 };
    const bytes = JSON.stringify([{ key: `outbound:${batchId}:${recipient}`, kind: 'outbound', batchId,
      recipientOpenId: recipient, deliveryUuid: 'synthetic-stable-uuid', items: [value], revision: 1, sentRevision: 0,
      inFlight: { kind: 'send', at: Date.now() - age, revision: 1 } }]);
    await writeFile(path, bytes);
    for (let attempt = 0; attempt < 2; attempt++) {
      const service = new InventoryBatchCardService(gateway as never, path);
      await expect(service.stageForCallback('outbound', batchId, recipient, value, 'om_validated_original')).rejects.toThrow('发送结果待核对');
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
  });

  it('does not replace a different existing receipt with a callback source message', async () => {
    const value = { ...item('rec_1'), status: '待审批', approvalVersion: 1 };
    const bytes = JSON.stringify([{ key: `outbound:${batchId}:${recipient}`, kind: 'outbound', batchId,
      recipientOpenId: recipient, deliveryUuid: 'synthetic-stable-uuid', messageId: 'om_other_receipt', items: [value], revision: 1, sentRevision: 1 }]);
    await writeFile(path, bytes);
    const service = new InventoryBatchCardService(gateway as never, path);
    await expect(service.stageForCallback('outbound', batchId, recipient, value, 'om_validated_original')).rejects.toThrow('回执不一致');
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(gateway.patchInteractiveCard).not.toHaveBeenCalled();
  });

  it('rejects a conflicting terminal result for the same item', async () => {
    const service = new InventoryBatchCardService(gateway as never, path);
    await service.upsert('outbound', batchId, recipient, { ...item('rec_1'), status: '已出库' });
    await expect(service.upsert('outbound', batchId, recipient, { ...item('rec_1'), status: '已驳回' }))
      .rejects.toThrow('批量通知终态与已持久化内容冲突');
  });

  it('keeps a maximum size outbound approval card inside the gateway limit', async () => {
    const service = new InventoryBatchCardService(gateway as never, path);
    for (let index = 1; index <= 50; index += 1) {
      await service.upsert('outbound', batchId, recipient, {
        ...item(`rec_${index}`), name: '物品'.repeat(20), specification: '型号'.repeat(30),
        location: 'H-2F-226储存间01-OF', status: '待审批', approvalVersion: 1,
      });
    }
    await service.flushPending();
    const card = await service.render('outbound', batchId, recipient);
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(30 * 1024);
  });
});
