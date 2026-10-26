import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

type HttpResult = {
  status: number;
  body: unknown;
};

type RunnerResult = {
  root: HttpResult;
  prefixed: HttpResult;
  legacyAction: HttpResult;
  managerAction: HttpResult;
  missingConfig: HttpResult;
  captures: Array<{
    url: string;
    isBuffer: boolean;
    utf8: string | null;
  }>;
  rootPayload: string;
  ledgerAction: unknown;
  managerServiceInput: unknown;
};

const marker = '__CALLBACK_HTTP_RESULT__';
let result: RunnerResult;

describe('purchase workflow callback real Nest HTTP integration', () => {
  beforeAll(() => {
    const workspace = resolve(__dirname, '../..');
    const runner = resolve(
      workspace,
      'test/helpers/purchase-workflow-card-callback-http.runner.ts',
    );
    const child = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', runner],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          TS_NODE_PROJECT: resolve(workspace, 'tsconfig.node.json'),
        },
        timeout: 120_000,
      },
    );
    expect({
      status: child.status,
      signal: child.signal,
      stderr: child.stderr,
    }).toEqual({ status: 0, signal: null, stderr: '' });
    const markerIndex = child.stdout.lastIndexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    result = JSON.parse(
      child.stdout.slice(markerIndex + marker.length).trim(),
    ) as RunnerResult;
  }, 125_000);

  it('preserves the exact callback bytes as a Buffer through real configureApp', () => {
    expect(result.root).toEqual({
      status: 200,
      body: { challenge: 'http-challenge' },
    });
    expect(result.captures[0]).toEqual({
      url: '/callbacks/feishu/purchase-card',
      isBuffer: true,
      utf8: result.rootPayload,
    });
  });

  it('keeps the callback at the fixed root path when CLIENT_BASE_PATH is set', () => {
    expect(result.root).toEqual({
      status: 200,
      body: { challenge: 'http-challenge' },
    });
    expect(result.prefixed.status).toBe(404);
  });

  it('returns HTTP 200 for a valid action only after its claim is persisted', () => {
    expect(result.legacyAction).toEqual({
      status: 200,
      body: { toast: { type: 'info', content: '审批操作已受理' } },
    });
    expect(result.ledgerAction).toMatchObject({
      key: 'approval:http-action-record',
      eventId: 'http-action-event',
      recordId: 'http-action-record',
      action: 'approve',
      actorOpenId: 'ou_http_approver',
      status: 'pending',
    });
  });

  it('returns the complete manager card with a fixed toast through real HTTP', () => {
    expect(result.managerAction).toEqual({
      status: 200,
      body: {
        toast: { type: 'info', content: '审批操作已受理' },
        card: {
          type: 'raw',
          data: {
            schema: '2.0',
            config: { enable_forward: false, update_multi: true },
            header: {
              title: { tag: 'plain_text', content: '采购申请审批' },
            },
            body: {
              elements: [
                {
                  tag: 'markdown',
                  content: '**当前状态：** 审批处理中',
                },
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '综合采购' },
                  disabled: true,
                },
              ],
            },
          },
        },
      },
    });
    expect(result.managerServiceInput).toEqual({
      kind: 'manager_action',
      eventId: 'http-manager-event',
      operatorOpenId: 'ou_http_manager',
      messageId: 'om_http_manager_message',
      action: 'choose_comprehensive',
      executionRecordId: 'http-manager-record',
    });
  });

  it('maps missing callback configuration to HTTP 503', () => {
    expect(result.missingConfig.status).toBe(503);
    expect(result.missingConfig.body).toMatchObject({
      message: 'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
    });
  });
});
