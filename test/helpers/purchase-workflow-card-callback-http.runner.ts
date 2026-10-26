import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ExpressAdapter,
  type NestExpressApplication,
} from '@nestjs/platform-express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { PurchaseWorkflowCallbackController } from '../../server/modules/purchase-inventory/purchase-workflow-callback.controller';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';

type HttpResult = {
  status: number;
  body: unknown;
};

type RawBodyCapture = {
  url: string;
  isBuffer: boolean;
  utf8: string | null;
};

type ScenarioResult = {
  root: HttpResult;
  prefixed: HttpResult;
  legacyAction: HttpResult;
  managerAction: HttpResult;
  missingConfig: HttpResult;
  captures: RawBodyCapture[];
  rootPayload: string;
  ledgerAction: unknown;
  managerServiceInput: unknown;
};

const managerCard = {
  schema: '2.0',
  config: { enable_forward: false, update_multi: true },
  header: {
    title: { tag: 'plain_text', content: '采购申请审批' },
  },
  body: {
    elements: [
      { tag: 'markdown', content: '**当前状态：** 审批处理中' },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '综合采购' },
        disabled: true,
      },
    ],
  },
};

const silentLogger = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
};

async function main() {
  const mainModule = loadBootstrapWithStubAppModule();
  const result = await runScenario(mainModule.bootstrap);

  process.stdout.write(`\n__CALLBACK_HTTP_RESULT__${JSON.stringify(result)}\n`);
}

function loadBootstrapWithStubAppModule(): { bootstrap: () => Promise<void> } {
  const appModulePath = require.resolve('../../server/app.module');
  const previous = require.cache[appModulePath];
  const stub = {
    id: appModulePath,
    filename: appModulePath,
    loaded: true,
    exports: { AppModule: class CallbackHttpTestAppModule {} },
    children: [],
    paths: module.paths,
    parent: module,
    require,
  } as unknown as NodeModule;
  require.cache[appModulePath] = stub;
  try {
    return require('../../server/main') as { bootstrap: () => Promise<void> };
  } finally {
    if (previous) require.cache[appModulePath] = previous;
    else delete require.cache[appModulePath];
  }
}

async function runScenario(
  bootstrap: () => Promise<void>,
): Promise<ScenarioResult> {
  const directory = await mkdtemp(join(tmpdir(), 'purchase-callback-http-'));
  const ledgerPath = join(directory, 'ledger.json');
  const captures: RawBodyCapture[] = [];
  let managerServiceInput: unknown = null;
  const managerService = {
    async runAcceptedTasks() { return { processed: 1, failed: 0 }; },
    async handleManagerCardAction(input: unknown) {
      managerServiceInput = input;
      return managerCard;
    },
  };
  const captureInterceptor = {
    intercept(context: ExecutionContext, next: CallHandler) {
      const request = context.switchToHttp().getRequest<{
        originalUrl: string;
        rawBody?: unknown;
      }>();
      captures.push({
        url: request.originalUrl,
        isBuffer: Buffer.isBuffer(request.rawBody),
        utf8: Buffer.isBuffer(request.rawBody)
          ? request.rawBody.toString('utf8')
          : null,
      });
      return next.handle();
    },
  };
  const ledgerStore = new PurchaseWorkflowStore(ledgerPath);
  const moduleRef = await Test.createTestingModule({
    controllers: [PurchaseWorkflowCallbackController],
    providers: [
      {
        provide: PurchaseWorkflowStore,
        useValue: ledgerStore,
      },
      { provide: AccessConfigurationService, useValue: { canUseFeishuBusinessIdentity: () => true } },
      { provide: PurchaseWorkflowService, useValue: { acceptApprovalCardAction: (input: Parameters<PurchaseWorkflowStore['claimCardAction']>[0]) => ledgerStore.claimCardAction(input) } },
      {
        provide: PurchaseManagerApprovalService,
        useValue: managerService,
      },
      {
        provide: APP_INTERCEPTOR,
        useValue: captureInterceptor,
      },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(
    new ExpressAdapter(),
    { rawBody: true },
  );
  app.useLogger(false);

  const originalGet = app.get.bind(app);
  app.get = ((token: unknown, options?: unknown) => {
    if (
      typeof token === 'function' &&
      (token as { name?: string }).name === 'AppLogger'
    ) {
      return silentLogger;
    }
    return originalGet(token as never, options as never);
  }) as typeof app.get;

  configureEnvironment();
  const factory = NestFactory as unknown as {
    create: (...args: unknown[]) => Promise<NestExpressApplication>;
  };
  const originalCreate = factory.create;
  factory.create = async () => app;

  try {
    await bootstrap();
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const challenge = {
      type: 'url_verification',
      token: 'http-verification-token',
      challenge: 'http-challenge',
    };
    const rootPayload = JSON.stringify(challenge);
    const root = await postJson(
      port,
      '/callbacks/feishu/purchase-card',
      rootPayload,
    );
    const prefixed = await postJson(
      port,
      '/app/test/callbacks/feishu/purchase-card',
      rootPayload,
    );
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = 'ou_http_approver';
    const legacyAction = await postJson(
      port,
      '/callbacks/feishu/purchase-card',
      JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'http-action-event',
          event_type: 'card.action.trigger',
          token: 'http-verification-token',
        },
        event: {
          operator: { open_id: 'ou_http_approver' },
          action: {
            value: {
              version: 1,
              action: 'approve',
              executionRecordId: 'http-action-record',
            },
          },
        },
      }),
    );
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = '';
    process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_http_manager';
    const managerAction = await postJson(
      port,
      '/callbacks/feishu/purchase-card',
      JSON.stringify({
        schema: '2.0',
        header: {
          event_id: 'http-manager-event',
          event_type: 'card.action.trigger',
          token: 'http-verification-token',
        },
        event: {
          operator: { open_id: 'ou_http_manager' },
          action: {
            tag: 'button',
            value: {
              version: 2,
              action: 'choose_comprehensive',
              executionRecordId: 'http-manager-record',
            },
          },
          context: { open_message_id: 'om_http_manager_message' },
        },
      }),
    );
    let ledgerAction: unknown = null;
    try {
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
        cardActions?: unknown[];
      };
      ledgerAction = ledger.cardActions?.[0] || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    delete process.env.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN;
    const missingConfig = await postJson(
      port,
      '/callbacks/feishu/purchase-card',
      rootPayload,
    );

    return {
      root,
      prefixed,
      legacyAction,
      managerAction,
      missingConfig,
      captures,
      rootPayload,
      ledgerAction,
      managerServiceInput,
    };
  } finally {
    factory.create = originalCreate;
    try {
      await app.close();
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  }
}

function configureEnvironment() {
  process.env.FEISHU_APP_ID = 'cli_synthetic_purchase_callback';
  process.env.NODE_ENV = 'development';
  process.env.SERVER_HOST = '127.0.0.1';
  process.env.SERVER_PORT = '0';
  process.env.SUDA_DATABASE_URL = 'postgres://callback-test/database';
  process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';
  process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
  process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
  process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = '';
  process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = '';
  process.env.CLIENT_BASE_PATH = '/app/test';
  process.env.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN =
    'http-verification-token';
  delete process.env.FEISHU_PURCHASE_CARD_ENCRYPT_KEY;
  delete process.env.BODY_SIZE_LIMIT;
  delete process.env.FORCE_AUTHN_INNERAPI_DOMAIN;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.HTTPS_KEY_PATH;
  delete process.env.HTTPS_CERT_PATH;
  delete process.env.HTTPS_CA_PATH;
}

async function postJson(
  port: number,
  path: string,
  rawBody: string,
): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep non-JSON response text for diagnostics.
  }
  return { status: response.status, body };
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
