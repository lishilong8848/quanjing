import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  availablePaymentActions,
  initialPaymentAction,
  pendingPlanAmount,
} from '../../client/src/pages/ContractManagement/contract-payment-follow-up.logic';

const unpaidPlan = {
  recordId: 'rec_payment',
  label: 'HT-001 一期',
  period: '一期',
  plannedAmount: 1000,
  actualAmount: 200,
  paymentDate: '2026-07-20',
  status: '未付款',
  ownerOpenId: 'ou_owner',
  ownerName: '合同负责人',
};

describe('contract payment follow-up dialog', () => {
  it('enables actions only when matching payment records exist', () => {
    expect(availablePaymentActions([])).toEqual({
      create: true,
      adjust: false,
      confirm: false,
      noPaymentRequired: true,
    });
    expect(availablePaymentActions([unpaidPlan])).toEqual({
      create: true,
      adjust: true,
      confirm: true,
      noPaymentRequired: false,
    });
    expect(
      availablePaymentActions([{ ...unpaidPlan, status: '已付款' }]),
    ).toEqual({
      create: true,
      adjust: true,
      confirm: false,
      noPaymentRequired: false,
    });
  });

  it('defaults missing plans to create and unpaid plans to confirmation', () => {
    expect(initialPaymentAction('missing_plan', [])).toBe('create');
    expect(initialPaymentAction('unpaid_plan', [unpaidPlan])).toBe('confirm');
  });

  it('defaults confirmation amount to the unpaid balance', () => {
    expect(pendingPlanAmount(unpaidPlan)).toBe(800);
    expect(
      pendingPlanAmount({
        ...unpaidPlan,
        actualAmount: 1200,
      }),
    ).toBe(0);
  });

  it('renders Base-backed payment actions plus an instant no-payment-required option', () => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../client/src/pages/ContractManagement/ContractPaymentFollowUpDialog.tsx',
      ),
      'utf8',
    );
    expect(source).toContain('新增付款计划');
    expect(source).toContain('调整付款计划');
    expect(source).toContain('付款确认');
    expect(source).toContain('无需付款');
    expect(source).toContain('handleNoPaymentRequired');
    expect(source).toContain('onNoPaymentRequired');
    expect(source).toContain('item.planCount !== 0');
    expect(source).toMatch(
      /handleNoPaymentRequired[\s\S]*onOpenChange\(false\)[\s\S]*onNoPaymentRequired/,
    );
    expect(source).toContain('付款周期');
    expect(source).toContain('计划付款金额');
    expect(source).toContain('计划付款日期');
    expect(source).toContain('实际付款金额');
    expect(source).toContain('付款日期');
    expect(source).toContain('跟进人');
    expect(source).not.toContain('getContractAdminStatus');
    expect(source).not.toContain('loginContractAdmin');
    expect(source).not.toContain('type="password"');
    expect(source).toContain('getContractPaymentFollowUpOptions');
    expect(source).toContain('createContractPaymentPlan');
    expect(source).toContain('adjustContractPaymentPlan');
    expect(source).toContain('confirmContractPaymentPlan');
    expect(source.match(/plannedPaymentDate: paymentDate/g)).toHaveLength(2);
    expect(source).toContain('createFixedPaymentFollowUpOptions');
    expect(source).toContain('selectedPlan.plannedPaymentDate');
    expect(source).toContain('可先查看表单');
    expect(source).not.toContain('正在读取付款计划多维表字段');
    expect(source).not.toContain('付款计划字段读取失败');
    expect(source).toContain('付款计划动态选项同步失败');
    expect(source).toContain('dynamicOptionsReady');
    expect(source).toContain('!dynamicOptionsReady');
    expect(source).toMatch(
      /onOpenChange\(false\);\s*void Promise\.resolve\(onCompleted\(\)\)\.catch\(/,
    );
    expect(source).not.toContain('await onCompleted()');
    expect(source).toMatch(
      /\{busy\s*\?\s*'正在提交付款操作'\s*:\s*action === 'create'/,
    );
  });

  it('reuses one idempotency key while retrying the same create draft', () => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../client/src/pages/ContractManagement/ContractPaymentFollowUpDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('createIdempotencyKey');
    expect(source).toContain('idempotencyKey: createIdempotencyKey');
    expect(source).not.toContain('idempotencyKey: crypto.randomUUID()');
  });

  it('refreshes the dashboard in the background after a successful mutation', () => {
    const pageSource = readFileSync(
      resolve(__dirname, '../../client/src/pages/ContractManagement/index.tsx'),
      'utf8',
    );

    expect(pageSource).toContain('refreshDashboardAfterMutation');
    expect(pageSource).toContain(
      'const refreshDashboardAfterMutation = useCallback(() => {',
    );
    expect(pageSource).toContain('void loadDashboard(true)');
    expect(pageSource).not.toContain(
      'const refreshed = await loadDashboard(true)',
    );
    expect(pageSource).toContain('if (!refreshed)');
    expect(pageSource).toContain('看板刷新失败');
  });

  it('keeps optimistic no-payment-required state across stale dashboard responses and rolls back precisely', () => {
    const pageSource = readFileSync(
      resolve(__dirname, '../../client/src/pages/ContractManagement/index.tsx'),
      'utf8',
    );

    expect(pageSource).toContain('hiddenNoPaymentRequiredRef');
    expect(pageSource).toContain('pendingNoPaymentRequiredRef');
    expect(pageSource).toMatch(
      /for \(const recordId of hiddenNoPaymentRequiredRef\.current\)[\s\S]*applyNoPaymentRequired/,
    );
    expect(pageSource).toMatch(
      /const optimistic = applyNoPaymentRequired[\s\S]*setDashboard\(optimistic\.dashboard\)[\s\S]*await markContractNoPaymentRequired/,
    );
    expect(pageSource).toContain('rollbackNoPaymentRequired');
    expect(pageSource).toContain('已恢复该合同卡片');
  });
});
