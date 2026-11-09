import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { InventoryManagementItem, WarehouseBuilding } from '../../shared/inventory-management.interface';
import { InventoryStocktakeReminderService } from '../../server/modules/inventory-management/inventory-stocktake-reminder.service';
import { InventoryStocktakeService } from '../../server/modules/inventory-management/inventory-stocktake.service';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import { sanitizeReadonlyCard } from '../../server/common/feishu-card-copy/readonly-card';
import * as activation from '../../server/common/hotfix-runtime-activation';

describe('monthly inventory stocktake Feishu reminders', () => {
  let directory: string;
  let now: number;
  const month = '2026-11';
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nt-stocktake-reminder-'));
    now = Date.parse('2026-11-01T09:00:00+08:00');
    jest.useFakeTimers({ now });
  });
  afterEach(() => {
    jest.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  function setup() {
    const path = join(directory, 'stocktake.json');
    const store = new InventoryStocktakeStore(path);
    const sheets = new InventoryStocktakeService(store, {} as never, {} as never);
    const recipients = jest.fn(async (_building: string, _force: boolean) => [{ openId: 'ou_a', name: '合成库房管理人' }]);
    const access = jest.fn((id: string, _appId: string): AccessPrincipal | null => id === 'ou_unconfigured' ? null : { role: 'admin', purchaseBuilding: null });
    const sender = jest.fn(async (_id: string, _card: Record<string, unknown>, _uuid: string, _event: string) => 'om_synthetic');
    const runtime = { enabled: () => true, now: () => now, appId: () => 'cli_synthetic', publicBaseUrl: () => 'https://www.example.test:3001/nantong' };
    const createService = () => new InventoryStocktakeReminderService(
      new InventoryStocktakeStore(path), { resolveNotificationRecipients: recipients } as never,
      { feishuPrincipal: access } as never, { sendInteractiveCard: sender } as never, runtime,
    );
    const generate = (building: WarehouseBuilding, sheetMonth = month) => {
      jest.setSystemTime(now);
      const items = [
        { recordId: `${building}-one`, sku: 'A', building, quantity: 3, name: '接头', location: '库房1', unit: '个', specialty: '电气' },
        { recordId: `${building}-two`, sku: 'B', building, quantity: 7, name: '夹具', location: '库房2', unit: '个', specialty: '弱电' },
      ] as InventoryManagementItem[];
      sheets.generateMissing(sheetMonth, building, { items, movements: [] });
    };
    return { store, recipients, access, sender, runtime, generate, createService };
  }

  it('sends only after each building has a persisted complete plan and links directly to its authorized stocktake view', async () => {
    const { store, recipients, sender, generate, createService } = setup();
    const service = createService();
    await service.runPending(month);
    expect(recipients).not.toHaveBeenCalled();
    generate('A楼');
    generate('B楼');
    store.update(state => { delete state.sheets.find(sheet => sheet.building === 'B楼')!.review; return true; });
    const before = store.read().sheets;
    await service.runPending(month);
    expect(recipients).toHaveBeenCalledTimes(1);
    expect(recipients).toHaveBeenCalledWith('A楼', true);
    expect(sender).toHaveBeenCalledTimes(1);
    const [recipient, rawCard, , logicalId] = sender.mock.calls[0];
    expect(recipient).toBe('ou_a');
    expect(logicalId).toBe('stocktake:2026-11:A楼:initial');
    const card = rawCard as { elements: Array<{ actions?: Array<{ url: string }> }> };
    const serialized = JSON.stringify(card);
    const planned = before.find(sheet => sheet.building === 'A楼')!;
    expect(serialized).toContain(`盘点数量：重点抽盘 ${planned.lines.length} 项 / 库存核盘 ${planned.review!.lines.length} 项`);
    expect(serialized).toContain('截止日期：2026-11-30');
    const url = new URL(card.elements.at(-1)!.actions![0].url);
    expect(url.pathname).toBe('/nantong/inventory-management');
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'stocktake', action: 'execute', scope: 'sample', month, building: 'A楼' });
    expect(JSON.stringify(sanitizeReadonlyCard(card).card)).not.toMatch(/https:\/\/|前往库存盘点|"button"/);
    expect(store.read().sheets).toEqual(before);
    await createService().runPending(month);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('retries only unconfirmed recipient sends with the original UUID and blocks an exhausted unknown receipt', async () => {
    const { store, recipients, sender, generate, createService } = setup();
    generate('A楼');
    recipients.mockResolvedValue([{ openId: 'ou_a', name: '甲' }, { openId: 'ou_b', name: '乙' }, { openId: 'ou_b', name: '乙' }]);
    sender.mockResolvedValueOnce('om_a').mockRejectedValueOnce(new Error('offline lost receipt')).mockResolvedValueOnce('om_b');
    const service = createService();
    expect(service.runPending(month)).toBe(service.runPending(month));
    await service.runPending(month);
    expect(store.read().reminderBatches?.[0].deliveries.map(row => row.messageId)).toEqual(['om_a', null]);
    now += 5 * 60_000;
    await createService().runPending(month);
    expect(sender.mock.calls.map(call => call[0])).toEqual(['ou_a', 'ou_b', 'ou_b']);
    expect(sender.mock.calls[1][2]).toBe(sender.mock.calls[2][2]);

    generate('B楼');
    recipients.mockResolvedValue([{ openId: 'ou_a', name: '甲' }]);
    sender.mockRejectedValueOnce(new Error('offline ambiguous'));
    await service.runPending(month);
    now += 55 * 60_000;
    await createService().runPending(month);
    expect(sender).toHaveBeenCalledTimes(4);
    expect(store.read().reminderBatches?.find(batch => batch.building === 'B楼')?.deliveries[0].needsReview).toBe(true);
  });

  it('resumes a partial routing pass after a restart and projects counts to the recipient scope', async () => {
    const { store, recipients, access, sender, generate, createService } = setup();
    generate('A楼');
    recipients.mockResolvedValue([{ openId: 'ou_a', name: '甲' }, { openId: 'ou_b', name: '乙' }]);
    access.mockImplementationOnce(() => ({ role: 'admin', purchaseBuilding: null })).mockImplementationOnce(() => { throw new Error('synthetic process boundary'); });
    await expect(createService().runPending(month)).rejects.toThrow('synthetic process boundary');
    expect(store.read().reminderBatches?.[0]).toMatchObject({ routingComplete: false });
    access.mockImplementation(() => ({
      role: 'building_admin', purchaseBuilding: 'A楼',
      personalRules: [{ id: 'blocked-specialty', effect: 'deny', module: 'stocktake', actions: ['read'], buildings: ['A楼'], specialties: ['弱电'] }],
    }));
    await createService().runPending(month);
    expect(sender.mock.calls.map(call => call[0])).toEqual(['ou_a', 'ou_b']);
    const planned = store.read().sheets[0];
    const sample = planned.lines.filter(line => line.inventory.specialty === '电气').length;
    const review = planned.review!.lines.filter(line => line.inventory.specialty === '电气').length;
    expect(JSON.stringify(sender.mock.calls[1][1])).toContain(`盘点数量：重点抽盘 ${sample} 项 / 库存核盘 ${review} 项`);
  });

  it('coalesces late initial delivery with the current Monday, skips finished buildings and previous Mondays, and sends one current reminder', async () => {
    const { store, sender, generate, createService } = setup();
    generate('A楼');
    generate('B楼');
    now = Date.parse('2026-11-09T09:00:00+08:00');
    await createService().runPending(month);
    await createService().runPending(month);
    expect(sender.mock.calls.map(call => call[3])).toEqual(['stocktake:2026-11:A楼:initial', 'stocktake:2026-11:B楼:initial']);
    store.update(state => {
      const sheet = state.sheets.find(row => row.building === 'B楼')!;
      sheet.status = 'completed';
      sheet.review!.status = 'completed';
      return true;
    });
    now = Date.parse('2026-11-24T08:00:00+08:00');
    await createService().runPending(month);
    await createService().runPending(month);
    expect(sender.mock.calls.map(call => call[3])).toEqual(['stocktake:2026-11:A楼:initial', 'stocktake:2026-11:B楼:initial', 'stocktake:2026-11:A楼:2026-11-23']);
  });

  it('records a routing block, sends only to an authorized replacement and ignores previous months', async () => {
    const { store, recipients, access, sender, generate, createService } = setup();
    generate('A楼');
    recipients.mockRejectedValueOnce(new Error('warehouse directory source unavailable')).mockResolvedValueOnce([{ openId: 'ou_unconfigured', name: '禁用账号' }]);
    await createService().runPending('2026-10');
    expect(recipients).not.toHaveBeenCalled();
    await createService().runPending(month);
    expect(store.read().reminderBatches?.[0].routingError).toBe('recipients-unavailable');
    now += 5 * 60_000;
    await createService().runPending(month);
    expect(store.read().reminderBatches?.[0].routingError).toBe('no-authorized-recipient');
    expect(access).toHaveBeenCalledWith('ou_unconfigured', 'cli_synthetic');
    expect(sender).not.toHaveBeenCalled();
    now += 5 * 60_000;
    await createService().runPending(month);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(store.read().reminderBatches?.[0]).toMatchObject({ routingError: null, routingComplete: true });
  });

  it('coalesces an initial push on a Monday that is also the first day of the month', async () => {
    const { sender, generate, createService } = setup();
    const mondayMonth = '2026-06';
    now = Date.parse('2026-06-01T02:29:00+08:00');
    generate('A楼', mondayMonth);
    await createService().runPending(mondayMonth);
    expect(sender).not.toHaveBeenCalled();
    now = Date.parse('2026-06-01T02:30:00+08:00');
    await createService().runPending(mondayMonth);
    now = Date.parse('2026-06-01T09:00:00+08:00');
    await createService().runPending(mondayMonth);
    expect(sender.mock.calls.map(call => call[3])).toEqual(['stocktake:2026-06:A楼:initial']);
  });

  it('does not read the outbox or send real cards before production activation', async () => {
    const { store, recipients, access, sender } = setup();
    const read = jest.spyOn(store, 'read').mockImplementation(() => { throw new Error('inactive reminder attempted to read'); });
    const gate = jest.spyOn(activation, 'currentHotfixActivation').mockReturnValue({ isAcceptingNewWork: () => false } as never);
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const service = new InventoryStocktakeReminderService(store, { resolveNotificationRecipients: recipients } as never,
        { feishuPrincipal: access } as never, { sendInteractiveCard: sender } as never);
      await service.runPending(month);
      expect(read).not.toHaveBeenCalled();
      expect(sender).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});
