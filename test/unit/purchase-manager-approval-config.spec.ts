jest.mock('../../server/common/config/external-services.config', () => ({
  readEnv: jest.fn((name: string) => process.env[name] || ''),
}));

import { ServiceUnavailableException } from '@nestjs/common';
import {
  isPurchaseManagerApprovalEnabled,
  readPurchaseManagerApprover,
  readPurchaseManagerCallbackAuthorization,
} from '../../server/modules/purchase-inventory/purchase-manager-approval.config';

const originalEnv = { ...process.env };

describe('purchase manager approval configuration', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'false',
      PURCHASE_MANAGER_APPROVER_OPEN_ID: '',
      PURCHASE_MANAGER_APPROVER_NAME: '',
      PURCHASE_WORKFLOW_APPROVER_OPEN_IDS: '',
      FEISHU_ACCESS_ADMIN_OPEN_IDS: '',
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses the dedicated manager open id without inspecting fallback lists', () => {
    process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_manager_01';
    process.env.PURCHASE_MANAGER_APPROVER_NAME = '  机房经理  ';
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = 'invalid legacy id';
    process.env.FEISHU_ACCESS_ADMIN_OPEN_IDS = 'invalid admin id';

    expect(readPurchaseManagerApprover()).toEqual({
      openId: 'ou_manager_01',
      name: '机房经理',
    });
  });

  it('falls back only to the unique intersection of legacy approvers and admins', () => {
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS =
      'ou_legacy_01,ou_manager_01,ou_manager_01';
    process.env.FEISHU_ACCESS_ADMIN_OPEN_IDS =
      'ou_admin_01,ou_manager_01,ou_manager_01';

    expect(readPurchaseManagerApprover()).toEqual({
      openId: 'ou_manager_01',
      name: '示例人员020',
    });
  });

  it.each([
    ['zero candidates', 'ou_legacy_01', 'ou_admin_01'],
    [
      'multiple candidates',
      'ou_manager_01,ou_manager_02',
      'ou_manager_01,ou_manager_02',
    ],
  ])(
    'rejects fallback configuration with %s',
    (_label, legacyApprovers, admins) => {
      process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = legacyApprovers;
      process.env.FEISHU_ACCESS_ADMIN_OPEN_IDS = admins;

      expect(() => readPurchaseManagerApprover()).toThrow(
        ServiceUnavailableException,
      );
    },
  );

  it.each([
    ['dedicated', 'PURCHASE_MANAGER_APPROVER_OPEN_ID', 'secret.manager/id'],
    ['legacy fallback', 'PURCHASE_WORKFLOW_APPROVER_OPEN_IDS', 'bad legacy id'],
    ['admin fallback', 'FEISHU_ACCESS_ADMIN_OPEN_IDS', 'bad admin id'],
  ])(
    'rejects an invalid %s open id without echoing its value',
    (_label, environmentName, invalidValue) => {
      process.env[environmentName] = invalidValue;
      if (environmentName !== 'PURCHASE_MANAGER_APPROVER_OPEN_ID') {
        process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS ||= 'ou_manager_01';
        process.env.FEISHU_ACCESS_ADMIN_OPEN_IDS ||= 'ou_manager_01';
      }

      let caught: unknown;
      try {
        readPurchaseManagerApprover();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect(String((caught as Error).message)).not.toContain(invalidValue);
    },
  );

  it('uses an independent feature flag instead of the legacy workflow flag', () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    expect(isPurchaseManagerApprovalEnabled()).toBe(true);

    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    expect(isPurchaseManagerApprovalEnabled()).toBe(false);
  });

  it('keeps legacy and manager callback allowlists in distinct fields', () => {
    process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_manager_01';
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS =
      'ou_legacy_01,ou_legacy_02,ou_legacy_01';

    const authorization = readPurchaseManagerCallbackAuthorization();

    expect(authorization).toEqual({
      legacyApproverOpenIds: ['ou_legacy_01', 'ou_legacy_02'],
      managerApproverOpenId: 'ou_manager_01',
    });
    expect(authorization.legacyApproverOpenIds).not.toContain(
      authorization.managerApproverOpenId,
    );
    expect(authorization).not.toHaveProperty('approverOpenIds');
  });
});
