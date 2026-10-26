import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import * as purchaseWorkflowSessionModule from '../../server/modules/purchase-inventory/purchase-workflow-session';
import { resolvePurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow-session';

const controllerSource = readFileSync(
  resolve('server/modules/purchase-inventory/purchase-inventory.controller.ts'),
  'utf8',
);
const moduleSource = readFileSync(
  resolve('server/modules/purchase-inventory/purchase-inventory.module.ts'),
  'utf8',
);
const workflowSessionSource = readFileSync(
  resolve('server/modules/purchase-inventory/purchase-workflow-session.ts'),
  'utf8',
);

describe('purchase workflow API contract', () => {
  it('exposes detail, approval, start, order, and receipt routes', () => {
    expect(controllerSource).toContain("@Get('workflows/:recordId')");
    expect(controllerSource).toContain("@Post('workflows/:recordId/approve')");
    expect(controllerSource).toContain("@Post('workflows/:recordId/start')");
    expect(controllerSource).toContain("@Post('workflows/:recordId/order')");
    expect(controllerSource).toContain("@Post('workflows/:recordId/receive')");
  });

  it('loads workflow detail through a read session that does not require an operator', () => {
    const detailMethod = controllerSource.slice(
      controllerSource.indexOf("@Get('workflows/:recordId')"),
      controllerSource.indexOf("@Post('workflows/:recordId/approve')"),
    );

    expect(detailMethod).toContain('getWorkflowReadSession(req)');
    expect(detailMethod).not.toContain('getWorkflowSession(req)');
  });

  it('uses only the tenant token and an explicitly configured delegated operator', () => {
    expect(
      controllerSource.match(/getWorkflowSession\(req\)/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(controllerSource).not.toContain(
      'PURCHASE_APPLICATION_SESSION_COOKIE',
    );
    expect(controllerSource).not.toContain('getOptionalSession');
    expect(controllerSource).not.toContain('PurchaseApplicationAuthService');
    expect(moduleSource).not.toContain('PurchaseApplicationAuthService');
    expect(workflowSessionSource).not.toContain('personalSession');
    expect(workflowSessionSource).not.toContain(
      "authenticationMode: 'feishu-oauth'",
    );
    expect(controllerSource).toContain('getTenantAccessTokenAsApp');
    expect(controllerSource).toContain('resolvePurchaseWorkflowSession');
    expect(workflowSessionSource).toContain(
      'PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID',
    );
    expect(workflowSessionSource).toContain(
      'PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID',
    );
  });

  it('does not expose purchase personal OAuth controller methods', () => {
    expect(controllerSource).not.toMatch(
      /\b(?:getApplicationAuthStatus|getApplicationLoginUrl|completeApplicationOAuth)\s*\(/,
    );
  });

  it('keeps order and receipt attachments separate with bounded uploads', () => {
    expect(controllerSource).toContain(
      "FilesInterceptor('paymentAttachments', 5",
    );
    expect(controllerSource).toContain("name: 'receiptPhotos'");
    expect(controllerSource).toContain("name: 'invoices'");
    expect(controllerSource).toContain('receiptPhotoTokens');
    expect(controllerSource).toContain('invoiceTokens');
  });

  it.each([
    [
      'self-test',
      "@Post('workflows/self-test')",
      "@Get('workflows/:recordId')",
    ],
    [
      'approval',
      "@Post('workflows/:recordId/approve')",
      "@Post('workflows/:recordId/start')",
    ],
    [
      'start',
      "@Post('workflows/:recordId/start')",
      "@Post('workflows/:recordId/order')",
    ],
    [
      'manual reminder',
      "@Post('workflows/reminders/:code/run')",
      'private async getWorkflowSession',
    ],
  ])(
    'rejects the legacy %s write before resolving a session or uploading files',
    (_label, methodStart, methodEnd) => {
      const method = controllerSource.slice(
        controllerSource.indexOf(methodStart),
        controllerSource.indexOf(methodEnd),
      );
      const guardIndex = method.indexOf(
        'this.workflowService.assertEnabled(requirePrincipal(req).role)',
      );
      const sessionIndex = method.indexOf('this.getWorkflowSession(req)');
      const uploadIndex = method.indexOf('this.uploadWorkflowFiles(');

      expect(guardIndex).toBeGreaterThanOrEqual(0);
      if (sessionIndex >= 0) expect(guardIndex).toBeLessThan(sessionIndex);
      if (uploadIndex >= 0) expect(guardIndex).toBeLessThan(uploadIndex);
    },
  );

  it('keeps order writeback available after the legacy workflow switch is retired', () => {
    const method = controllerSource.slice(
      controllerSource.indexOf("@Post('workflows/:recordId/order')"),
      controllerSource.indexOf("@Post('workflows/:recordId/receive')"),
    );

    expect(method).not.toContain('this.workflowService.assertEnabled(');
    expect(method).toContain('this.getWorkflowSession(req)');
    expect(method).toContain('this.uploadWorkflowFiles(');
    expect(method).toContain('this.workflowService.order(');
  });

  it('keeps receipt available after the legacy workflow switch is retired', () => {
    const method = controllerSource.slice(
      controllerSource.indexOf("@Post('workflows/:recordId/receive')"),
      controllerSource.indexOf("@Post('workflows/reminders/:code/run')"),
    );

    expect(method).not.toContain('this.workflowService.assertEnabled(');
    expect(method).toContain('this.getWorkflowSession(req)');
    expect(method).toContain('@HttpCode(HttpStatus.ACCEPTED)');
    expect(method).not.toContain('this.uploadWorkflowFiles(');
    expect(method).toContain('this.receiptTaskService.acceptReceipt(');
    expect(controllerSource).toContain(
      "@Get('workflows/receipt-tasks/:taskId')",
    );
    const receiptTaskRoute = controllerSource.slice(
      controllerSource.indexOf("@Get('workflows/receipt-tasks/:taskId')"),
      controllerSource.indexOf("@Post('workflows/reminders/:code/run')"),
    );
    expect(receiptTaskRoute).toContain(
      'this.receiptTaskService.getReceiptTaskStatus(',
    );
    expect(receiptTaskRoute).toContain('taskId,');
    expect(receiptTaskRoute).toContain('await this.getWorkflowSession(req)');
  });

  it('registers the gateway, store, service, and scheduler providers', () => {
    for (const provider of [
      'PurchaseWorkflowGateway',
      'PurchaseWorkflowStore',
      'PurchaseWorkflowService',
      'PurchaseWorkflowReceiptTaskService',
      'PurchaseWorkflowScheduler',
    ]) {
      expect(moduleSource).toContain(provider);
    }
  });
});

describe('purchase workflow delegated session', () => {
  const originalAdminOperator =
    process.env.PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID;
  const originalEditorOperator =
    process.env.PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID;
  const originalPurchaseAdmin =
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID;

  afterEach(() => {
    restoreEnvironment(
      'PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID',
      originalAdminOperator,
    );
    restoreEnvironment(
      'PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID',
      originalEditorOperator,
    );
    restoreEnvironment(
      'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
      originalPurchaseAdmin,
    );
  });

  it('fails closed with an explicit 503 when the role operator is missing', async () => {
    delete process.env.PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID;
    const getTenantAccessToken = jest.fn();

    await expect(
      resolvePurchaseWorkflowSession({
        principal: principal('editor'),
        getTenantAccessToken,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(getTenantAccessToken).not.toHaveBeenCalled();
  });

  it('keeps workflow detail readable when the role operator is missing', async () => {
    delete process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID;
    const getTenantAccessToken = jest.fn().mockResolvedValue('tenant-token');
    const resolver = (
      purchaseWorkflowSessionModule as unknown as {
        resolvePurchaseWorkflowReadSession?: (
          input: Parameters<typeof resolvePurchaseWorkflowSession>[0],
        ) => ReturnType<typeof resolvePurchaseWorkflowSession>;
      }
    ).resolvePurchaseWorkflowReadSession;

    expect(resolver).toBeDefined();
    await expect(
      resolver?.({
        principal: principal('purchase_admin'),
        getTenantAccessToken,
      }),
    ).resolves.toEqual({
      accessToken: 'tenant-token',
      openId: '',
      userName: '',
      accessRole: 'purchase_admin',
      authenticationMode: 'delegated-app',
    });
    expect(getTenantAccessToken).toHaveBeenCalledTimes(1);
  });

  it('fails closed with HTTP 503 when the configured operator open id is invalid', async () => {
    process.env.PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID =
      'not-a-feishu-open-id';
    const getTenantAccessToken = jest.fn();

    const error = await resolvePurchaseWorkflowSession({
      principal: principal('admin'),
      getTenantAccessToken,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect(getTenantAccessToken).not.toHaveBeenCalled();
  });

  it('uses the tenant token and configured real operator for an editor', async () => {
    process.env.PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID =
      'ou_editor_operator';
    const getTenantAccessToken = jest.fn().mockResolvedValue('tenant-token');

    await expect(
      resolvePurchaseWorkflowSession({
        principal: principal('editor'),
        getTenantAccessToken,
      }),
    ).resolves.toEqual({
      accessToken: 'tenant-token',
      openId: 'ou_editor_operator',
      userName: '',
      accessRole: 'editor',
      authenticationMode: 'delegated-app',
    });
    expect(getTenantAccessToken).toHaveBeenCalledTimes(1);
  });

  it('falls back to the configured purchase executor for a system administrator', async () => {
    delete process.env.PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID;
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID =
      'ou_purchase_executor';
    const getTenantAccessToken = jest.fn().mockResolvedValue('tenant-token');

    await expect(
      resolvePurchaseWorkflowSession({
        principal: principal('admin'),
        getTenantAccessToken,
      }),
    ).resolves.toEqual({
      accessToken: 'tenant-token',
      openId: 'ou_purchase_executor',
      userName: '',
      accessRole: 'admin',
      authenticationMode: 'delegated-app',
    });
    expect(getTenantAccessToken).toHaveBeenCalledTimes(1);
  });

  it('maps a purchase administrator to the configured purchase executor', async () => {
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID =
      'ou_purchase_executor';
    delete process.env.PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID;
    const getTenantAccessToken = jest.fn().mockResolvedValue('tenant-token');

    await expect(
      resolvePurchaseWorkflowSession({
        principal: principal('purchase_admin'),
        getTenantAccessToken,
      }),
    ).resolves.toEqual({
      accessToken: 'tenant-token',
      openId: 'ou_purchase_executor',
      userName: '',
      accessRole: 'purchase_admin',
      authenticationMode: 'delegated-app',
    });
    expect(getTenantAccessToken).toHaveBeenCalledTimes(1);
  });

  it('maps a Feishu supply-chain administrator to the configured purchase executor', async () => {
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID =
      'ou_purchase_executor';
    delete process.env.PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID;
    const getTenantAccessToken = jest.fn().mockResolvedValue('tenant-token');

    await expect(
      resolvePurchaseWorkflowSession({
        principal: principal('supply_chain_admin'),
        getTenantAccessToken,
      }),
    ).resolves.toEqual({
      accessToken: 'tenant-token',
      openId: 'ou_purchase_executor',
      userName: '',
      accessRole: 'supply_chain_admin',
      authenticationMode: 'delegated-app',
    });
    expect(getTenantAccessToken).toHaveBeenCalledTimes(1);
  });

  it('maps a building applicant to the purchase executor and preserves the login building', async () => {
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID =
      'ou_purchase_executor';
    const getTenantAccessToken = jest.fn().mockResolvedValue('tenant-token');

    await expect(
      resolvePurchaseWorkflowSession({
        principal: {
          role: 'purchase_applicant',
          purchaseBuilding: 'A楼',
        },
        getTenantAccessToken,
      }),
    ).resolves.toEqual({
      accessToken: 'tenant-token',
      openId: 'ou_purchase_executor',
      userName: '',
      accessRole: 'purchase_applicant',
      purchaseBuilding: 'A楼',
      authenticationMode: 'delegated-app',
    });
    expect(getTenantAccessToken).toHaveBeenCalledTimes(1);
  });
});

function principal(role: AccessPrincipal['role']): AccessPrincipal {
  return { role, purchaseBuilding: null };
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
