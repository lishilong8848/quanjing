jest.mock(
  '@server/common/config/external-services.config',
  () => ({ readEnv: jest.fn(() => '') }),
  { virtual: true },
);

import {
  InventoryWorkflowScheduler,
  INVENTORY_WORKFLOW_DEFINITIONS,
  nextShanghaiDailyRunAt,
} from '../../server/modules/inventory-management/inventory-workflow.scheduler';
import { readEnv } from '@server/common/config/external-services.config';

describe('inventory workflow scheduler', () => {
  it('calculates the same Shanghai daily trigger time before and after the anchor', () => {
    expect(
      nextShanghaiDailyRunAt(new Date('2026-07-11T05:00:00.000Z'), 14, 0).toISOString(),
    ).toBe('2026-07-11T06:00:00.000Z');
    expect(
      nextShanghaiDailyRunAt(new Date('2026-07-11T07:00:00.000Z'), 14, 0).toISOString(),
    ).toBe('2026-07-12T06:00:00.000Z');
  });

  it('keeps all original workflow IDs and trigger labels in the program definition', () => {
    expect(INVENTORY_WORKFLOW_DEFINITIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'purchase_backfill',
          originalWorkflowId: 'wkfVO1VuyKNEpeUu',
          manualInboundReplaced: true,
        }),
        expect.objectContaining({
          code: 'purchase_h',
          originalWorkflowId: 'wkfEyMWQNPu1DzNY',
          manualInboundReplaced: true,
        }),
        expect.objectContaining({
          code: 'purchase_abcde',
          originalWorkflowId: 'wkfkDnGZxvnq9YEx',
          manualInboundReplaced: true,
        }),
        expect.objectContaining({
          code: 'item_confirmation',
          originalWorkflowId: 'wkfqrw3uP9Mo9Amg',
        }),
      ]),
    );
  });

  it('reports purchase inbound automation as replaced while keeping item confirmation enabled', async () => {
    (readEnv as jest.Mock).mockImplementation((name: string) =>
      name === 'FEISHU_WAREHOUSE_WORKFLOW_ENABLED'
        ? 'true'
        : name === 'FEISHU_WAREHOUSE_WORKFLOW_CUTOVER_AT'
          ? '2026-07-01T00:00:00+08:00'
          : '',
    );
    const workflowService = {
      listRecentLogs: jest.fn().mockResolvedValue([]),
      isRunning: jest.fn().mockReturnValue(false),
      getLastRun: jest.fn().mockReturnValue(null),
    };
    const scheduler = new InventoryWorkflowScheduler(workflowService as never);

    const status = await scheduler.getStatus();

    for (const code of ['purchase_h', 'purchase_backfill', 'purchase_abcde']) {
      expect(status.workflows.find((item) => item.code === code)).toMatchObject({
        enabled: false,
        nextRunAt: null,
        scheduleLabel: '已改为库房人工确认',
      });
    }
    expect(
      status.workflows.find((item) => item.code === 'item_confirmation'),
    ).toMatchObject({ enabled: true });
  });
});
