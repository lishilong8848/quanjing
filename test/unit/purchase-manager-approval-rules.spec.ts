import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  buildPurchaseManagerApprovalPatch,
  isManagerApprovalTargetApplied,
} from '../../server/modules/purchase-inventory/purchase-manager-approval.rules';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const purchaser = {
  openId: 'ou_purchase_admin',
  name: '采购管理员',
  positions: ['采购管理'],
  buildings: [],
};

describe('purchase manager approval Base rules', () => {
  it('builds the exact comprehensive procurement patch', () => {
    expect(
      buildPurchaseManagerApprovalPatch(record(), {
        choice: 'comprehensive',
        rejectionReason: '',
        purchaser,
      }),
    ).toEqual({
      '1️⃣物品采购方式': '综合采购',
      采购人: [{ id: 'ou_purchase_admin' }],
      库房确认: true,
      采购流程: '审批通过（待下单）',
      驳回原因: '',
    });
  });

  it('maps building self-procurement to the Base option 需求自采', () => {
    expect(
      buildPurchaseManagerApprovalPatch(record(), {
        choice: 'building_self',
        rejectionReason: '',
        purchaser: {
          ...purchaser,
          openId: 'ou_building_supervisor',
          name: 'H楼主管',
        },
      }),
    ).toEqual({
      '1️⃣物品采购方式': '需求自采',
      采购人: [{ id: 'ou_building_supervisor' }],
      库房确认: true,
      采购流程: '审批通过（待下单）',
      驳回原因: '',
    });
  });

  it('requires and trims a rejection reason', () => {
    expect(
      buildPurchaseManagerApprovalPatch(record(), {
        choice: 'reject',
        rejectionReason: '  超出本次采购范围  ',
      }),
    ).toEqual({
      '1️⃣物品采购方式': '驳回',
      采购流程: '驳回申请',
      驳回原因: '超出本次采购范围',
    });

    expect(() =>
      buildPurchaseManagerApprovalPatch(record(), {
        choice: 'reject',
        rejectionReason: '   ',
      }),
    ).toThrow(BadRequestException);
  });

  it('allows the manager to override an application-prefilled method in the decision pre-state', () => {
    const prefilled = record({ purchaseMethod: '需求自采' });

    expect(
      buildPurchaseManagerApprovalPatch(prefilled, {
        choice: 'comprehensive',
        rejectionReason: '',
        purchaser,
      }),
    ).toMatchObject({
      '1️⃣物品采购方式': '综合采购',
      采购流程: '审批通过（待下单）',
    });
  });

  it('rejects an unexpected conflicting reason even in the decision pre-state', () => {
    expect(() =>
      buildPurchaseManagerApprovalPatch(
        record({ rejectionReason: '历史驳回原因' }),
        {
          choice: 'comprehensive',
          rejectionReason: '',
          purchaser,
        },
      ),
    ).toThrow(ConflictException);
  });

  it('normalizes only the pre-state reason while checking for a conflict', () => {
    expect(
      buildPurchaseManagerApprovalPatch(
        record({ rejectionReason: ' 预算信息不完整 ' }),
        {
          choice: 'reject',
          rejectionReason: '预算信息不完整',
        },
      ),
    ).toEqual({
      '1️⃣物品采购方式': '驳回',
      采购流程: '驳回申请',
      驳回原因: '预算信息不完整',
    });
  });

  it('treats an exact rejected target after the pre-state as idempotent', () => {
    const applied = record({
      status: '驳回申请',
      purchaseMethod: '驳回',
      rejectionReason: '预算信息不完整',
    });
    const input = {
      choice: 'reject' as const,
      rejectionReason: '预算信息不完整',
    };

    expect(isManagerApprovalTargetApplied(applied, input)).toBe(true);
    expect(buildPurchaseManagerApprovalPatch(applied, input)).toEqual({
      '1️⃣物品采购方式': '驳回',
      采购流程: '驳回申请',
      驳回原因: '预算信息不完整',
    });
  });

  it.each([
    ['missing reason', undefined],
    ['different reason', '另一条驳回原因'],
    ['same trimmed text with different raw whitespace', ' 预算信息不完整 '],
  ])(
    'does not overwrite a rejected record with %s',
    (_label, rejectionReason) => {
      const existing = record({
        status: '驳回申请',
        purchaseMethod: '驳回',
        rejectionReason,
      });

      expect(
        isManagerApprovalTargetApplied(existing, {
          choice: 'reject',
          rejectionReason: '预算信息不完整',
        }),
      ).toBe(false);
      expect(() =>
        buildPurchaseManagerApprovalPatch(existing, {
          choice: 'reject',
          rejectionReason: '预算信息不完整',
        }),
      ).toThrow(ConflictException);
    },
  );

  it('rejects any non-exact method or workflow state after leaving the pre-state', () => {
    expect(() =>
      buildPurchaseManagerApprovalPatch(
        record({
          status: '审批通过（待下单）',
          purchaseMethod: '需求自采',
          rejectionReason: '',
        }),
        {
          choice: 'comprehensive',
          rejectionReason: '',
          purchaser,
        },
      ),
    ).toThrow(ConflictException);

    expect(() =>
      buildPurchaseManagerApprovalPatch(
        record({
          status: '下单完成（待签收）',
          purchaseMethod: '综合采购',
          rejectionReason: '',
        }),
        {
          choice: 'comprehensive',
          rejectionReason: '',
          purchaser,
        },
      ),
    ).toThrow(ConflictException);
  });

  it('requires a stable purchaser and verifies it in the idempotent target', () => {
    expect(() =>
      buildPurchaseManagerApprovalPatch(record(), {
        choice: 'comprehensive',
        rejectionReason: '',
      }),
    ).toThrow('未找到可分配的采购人');

    const applied = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: purchaser.openId,
      purchaserName: purchaser.name,
      warehouseConfirmed: true,
    });
    const decision = {
      choice: 'comprehensive' as const,
      rejectionReason: '',
      purchaser,
    };
    expect(isManagerApprovalTargetApplied(applied, decision)).toBe(true);
    expect(
      isManagerApprovalTargetApplied(
        { ...applied, purchaserOpenId: 'ou_other' },
        decision,
      ),
    ).toBe(false);
  });
});

function record(
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId: 'rec_execution_1',
    requestCode: 'CG-001',
    status: '未开始（待审批）',
    itemName: '接触器',
    building: 'H楼',
    requesterOpenId: 'ou_requester',
    requesterName: '需求人',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '综合采购',
    requestedQuantity: 3,
    actualQuantity: null,
    actualAmount: null,
    approvalCompleted: false,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    receiptConfirmed: false,
    signer: '',
    receiptTime: null,
    receiptPhotoTokens: [],
    invoiceTokens: [],
    rejectionReason: '',
    ...overrides,
  };
}
