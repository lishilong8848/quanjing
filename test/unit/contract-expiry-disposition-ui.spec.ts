import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('contract expiry disposition UI', () => {
  const pageSource = readFileSync(
    resolve('client/src/pages/ContractManagement/index.tsx'),
    'utf8',
  );
  const dialogSource = readFileSync(
    resolve(
      'client/src/pages/ContractManagement/ContractExpiryDispositionDialog.tsx',
    ),
    'utf8',
  );

  it('adds a manual confirmation icon to every contract risk item', () => {
    expect(pageSource).toContain('ContractExpiryDispositionDialog');
    expect(pageSource).toContain('人工确认合同到期处置');
    expect(pageSource).toContain(
      'const refreshDashboardAfterMutation = useCallback',
    );
    expect(pageSource).toContain('onUpdated={refreshDashboardAfterMutation}');
  });

  it('uses unified administrator access and supports renewal or voiding', () => {
    expect(dialogSource).not.toContain('getContractAdminStatus');
    expect(dialogSource).not.toContain('loginContractAdmin');
    expect(dialogSource).not.toContain('type="password"');
    expect(dialogSource).toContain('updateContractExpiryDisposition');
    expect(dialogSource).toContain('续期截止时间');
    expect(dialogSource).toContain('到期作废');
    expect(dialogSource).toContain('type="date"');
    expect(dialogSource).toContain(
      "toast.warning('合同到期处置已同步，但看板刷新失败，请手动刷新')",
    );
    expect(dialogSource).toContain('toast.success(response.message)');
    expect(dialogSource).toMatch(
      /toast\.success\(response\.message\);\s*onSubmitted\(contract\.recordId\);\s*onOpenChange\(false\);\s*void monitorBackgroundTask\(response\.taskId, onUpdated\);/,
    );
    expect(dialogSource).not.toContain('await onUpdated()');
    expect(dialogSource).toMatch(
      /\? action === 'renew'\s*\?\s*'正在提交续期'\s*:\s*'正在提交到期作废'/,
    );
  });

  it('adds one or more payment plans to a renewal and loads people without blocking the dialog', () => {
    expect(dialogSource).toContain('getContractPaymentFollowUpOptions');
    expect(dialogSource).toContain('付款计划');
    expect(dialogSource).toContain('新增付款节点');
    expect(dialogSource).toContain('计划付款金额');
    expect(dialogSource).toContain('计划付款日期');
    expect(dialogSource).toContain('跟进人');
    expect(dialogSource).toContain('paymentPlans.map(toPaymentPlanInput)');
    expect(dialogSource).toContain('setIdempotencyKey(createRequestId())');
    expect(dialogSource).toContain('idempotencyKey,');
    expect(dialogSource).not.toContain('正在读取对应多维表字段');
  });
});
