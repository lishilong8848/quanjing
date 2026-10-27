import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from '@larksuiteoapi/node-sdk';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { buildPurchaseBatchReceiptCard } from '../../server/modules/purchase-inventory/purchase-batch-fulfillment-card';

type CardFrame = {
  headers: Array<{ key: string; value: string }>;
  payload: Uint8Array;
};

type TestableWsClient = {
  eventDispatcher: EventDispatcher;
  handleEventData(frame: CardFrame): Promise<void>;
  sendMessage(frame: CardFrame): void;
};

describe('Feishu card callback WebSocket SDK compatibility', () => {
  it('patches both runtime bundles after install and pins the audited SDK', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve('package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const postinstall = readFileSync(
      resolve('scripts/postinstall.mjs'),
      'utf8',
    );

    expect(packageJson.dependencies['@larksuiteoapi/node-sdk']).toBe('1.73.0');
    expect(postinstall).toContain("packageJson.version !== '1.73.0'");
    expect(postinstall).toContain("'lib/index.js', 'es/index.js'");
    expect(postinstall).toContain(
      'type !== MessageType.event && type !== MessageType.card',
    );
  });

  it.each(['lib/index.js', 'es/index.js'])(
    'accepts card frames in %s',
    (bundle) => {
      const source = readFileSync(
        resolve('node_modules/@larksuiteoapi/node-sdk', bundle),
        'utf8',
      );
      expect(source).toContain(
        'if (type !== MessageType.event && type !== MessageType.card)',
      );
      expect(source).not.toContain('if (type !== MessageType.event)');
    },
  );

  it('dispatches a card frame and returns a 200 response containing the toast', async () => {
    const callbackResponse = {
      toast: { type: 'info', content: '审批操作已受理' },
      card: {
        type: 'raw',
        data: {
          schema: '2.0',
          header: { title: { tag: 'plain_text', content: '审批已处理' } },
          body: { elements: [] },
        },
      },
    };
    const handler = jest.fn().mockResolvedValue(callbackResponse);
    const dispatcher = new EventDispatcher({
      loggerLevel: LoggerLevel.error,
    }).register({
      'card.action.trigger': handler,
    });
    const client = new WSClient({
      appId: 'cli_0000000000000000',
      appSecret: 'test-only-secret',
      autoReconnect: false,
      loggerLevel: LoggerLevel.error,
    });
    const runtime = client as unknown as TestableWsClient;
    const sentFrames: CardFrame[] = [];
    runtime.eventDispatcher = dispatcher;
    runtime.sendMessage = (frame) => sentFrames.push(frame);

    try {
      await runtime.handleEventData({
        headers: [
          { key: 'message_id', value: 'om_test_card_callback' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' },
          { key: 'type', value: 'card' },
          { key: 'trace_id', value: 'trace_test_card_callback' },
        ],
        payload: new TextEncoder().encode(
          JSON.stringify({
            schema: '2.0',
            header: {
              event_id: 'evt_test_card_callback',
              event_type: 'card.action.trigger',
            },
            event: {
              operator: { open_id: 'ou_test_approver' },
              context: { open_message_id: 'om_test_card_callback' },
              action: {
                tag: 'button',
                value: {
                  version: 1,
                  action: 'approve',
                  recordId: 'rec_test_overtime',
                },
              },
            },
          }),
        ),
      });
    } finally {
      client.close({ force: true });
    }

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'card.action.trigger',
        operator: { open_id: 'ou_test_approver' },
      }),
    );
    expect(sentFrames).toHaveLength(1);
    const response = JSON.parse(
      new TextDecoder().decode(sentFrames[0]?.payload),
    ) as { code: number; data: string };
    expect(response.code).toBe(200);
    expect(
      JSON.parse(Buffer.from(response.data, 'base64').toString('utf8')),
    ).toEqual(callbackResponse);
  });

  it('patches the real receipt editor only after the WebSocket ACK', async () => {
    const originalManagerOpenId = process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID;
    process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_purchase_manager';
    const order: string[] = [];
    const receiptRecordId = 'rec_test_receipt_navigation';
    const receiptCard = buildPurchaseBatchReceiptCard(
      {
        approvalBatchId: 'purchase-application-task-1',
        requesterOpenId: 'ou_purchase_requester',
        requesterName: '申请人',
        building: 'H楼',
        requestCode: 'CG260921-601',
        items: [
          {
            executionRecordId: receiptRecordId,
            title: 'U盘',
            specification: '金属防水',
            requestedQuantity: '5',
            actualQuantity: 5,
            unit: '个',
            requestedAmount: '300.00',
            actualAmount: 300,
            purchaserName: '采购管理员',
            receiptState: 'waiting',
            signerName: '',
            receiptTime: null,
            receiptPhotoCount: 1,
            invoiceCount: 0,
          },
        ],
      },
      { selectedRecordId: receiptRecordId },
    );
    const disabledWorkflow = { isEnabled: jest.fn().mockReturnValue(false) };
    const managerService = {
      isEnabled: jest.fn().mockReturnValue(true),
      handlePurchaseBatchFulfillmentCardAction: jest
        .fn()
        .mockResolvedValue({ claimed: false, card: receiptCard }),
      patchPurchaseBatchFulfillmentCardView: jest
        .fn()
        .mockImplementation(async () => {
          order.push('patch:start');
        }),
      runPendingTasks: jest.fn().mockResolvedValue(undefined),
    };
    const router = new FeishuCardActionRouter(
      disabledWorkflow as never,
      disabledWorkflow as never,
      disabledWorkflow as never,
      { claimCardAction: jest.fn() } as never,
      managerService as never,
      disabledWorkflow as never,
      disabledWorkflow as never,
    );
    const dispatcher = new EventDispatcher({
      loggerLevel: LoggerLevel.error,
    }).register({
      'card.action.trigger': (payload: unknown) => router.handle(payload),
    });
    const client = new WSClient({
      appId: 'cli_0000000000000000',
      appSecret: 'test-only-secret',
      autoReconnect: false,
      loggerLevel: LoggerLevel.error,
    });
    const runtime = client as unknown as TestableWsClient;
    const sentFrames: CardFrame[] = [];
    runtime.eventDispatcher = dispatcher;
    runtime.sendMessage = (frame) => {
      order.push('ws:ack');
      sentFrames.push(frame);
    };

    try {
      await runtime.handleEventData({
        headers: [
          { key: 'message_id', value: 'om_test_receipt_navigation' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' },
          { key: 'type', value: 'card' },
          { key: 'trace_id', value: 'trace_test_receipt_navigation' },
        ],
        payload: new TextEncoder().encode(
          JSON.stringify({
            schema: '2.0',
            header: {
              event_id: 'evt_test_receipt_navigation',
              event_type: 'card.action.trigger',
            },
            event: {
              token: 'c-receipt-sdk-01',
              operator: { open_id: 'ou_purchase_requester' },
              context: { open_message_id: 'om_test_receipt_navigation' },
              action: {
                tag: 'button',
                value: {
                  version: 4,
                  workflowType: 'purchase_batch_fulfillment',
                  role: 'requester',
                  action: 'open_receipt',
                  approvalBatchId: 'purchase-application-task-1',
                  executionRecordId: receiptRecordId,
                },
              },
            },
          }),
        ),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      client.close({ force: true });
      if (originalManagerOpenId === undefined) {
        delete process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID;
      } else {
        process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = originalManagerOpenId;
      }
    }

    expect(order).toEqual(['ws:ack', 'patch:start']);
    expect(sentFrames).toHaveLength(1);
    const acknowledgement = JSON.parse(
      new TextDecoder().decode(sentFrames[0]?.payload),
    ) as { code: number; data: string };
    expect(acknowledgement.code).toBe(200);
    expect(JSON.stringify(receiptCard)).toContain('"tag":"form"');
    expect(JSON.stringify(receiptCard)).toContain('"tag":"select_person"');
    expect(JSON.stringify(receiptCard)).toContain('"form_action_type":"submit"');
    expect(
      JSON.parse(Buffer.from(acknowledgement.data, 'base64').toString('utf8')),
    ).toEqual({
      toast: { type: 'info', content: '请填写签收信息' },
    });
    expect(
      managerService.handlePurchaseBatchFulfillmentCardAction,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'purchase_batch_fulfillment_action',
        action: 'open_receipt',
        operatorOpenId: 'ou_purchase_requester',
        messageId: 'om_test_receipt_navigation',
      }),
    );
    expect(
      managerService.patchPurchaseBatchFulfillmentCardView,
    ).toHaveBeenCalledWith(
      'om_test_receipt_navigation',
      receiptCard,
      'c-receipt-sdk-01',
    );
  });

  it('exports an idempotent patch contract that can run twice offline', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'feishu-card-sdk-patch-'));
    const sdkRoot = join(
      fixtureRoot,
      'node_modules',
      '@larksuiteoapi',
      'node-sdk',
    );
    const original = 'if (type !== MessageType.event) {\nreturn;\n}';
    try {
      writeFixture(join(sdkRoot, 'package.json'), '{"version":"1.73.0"}');
      writeFixture(join(sdkRoot, 'lib/index.js'), original);
      writeFixture(join(sdkRoot, 'es/index.js'), original);

      const postinstallUrl = pathToFileURL(
        resolve('scripts/postinstall.mjs'),
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          [
            `import { patchFeishuCardCallbackFrames } from ${JSON.stringify(postinstallUrl)};`,
            `const root = ${JSON.stringify(fixtureRoot)};`,
            'patchFeishuCardCallbackFrames({ rootDir: root });',
            'patchFeishuCardCallbackFrames({ rootDir: root });',
          ].join('\n'),
        ],
        { encoding: 'utf8' },
      );

      expect({ status: child.status, stderr: child.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(child.stdout.match(/compatibility: READY/gu)).toHaveLength(2);
      for (const bundle of ['lib/index.js', 'es/index.js']) {
        const source = readFileSync(join(sdkRoot, bundle), 'utf8');
        expect(source).toContain(
          'if (type !== MessageType.event && type !== MessageType.card)',
        );
        expect(source).not.toContain('if (type !== MessageType.event)');
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

function writeFixture(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}
